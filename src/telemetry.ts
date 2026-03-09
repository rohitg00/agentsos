import { initSDK } from "./shared/config.js";
import { metrics } from "@opentelemetry/api";

const { registerFunction, registerTrigger } = initSDK("telemetry");

const meter = metrics.getMeter("agentos");

let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();

function collectWorkerMetrics() {
  const mem = process.memoryUsage();
  const currentCpu = process.cpuUsage(lastCpuUsage);
  const elapsed = (Date.now() - lastCpuTime) * 1000;
  const cpuPercent = elapsed > 0 ? ((currentCpu.user + currentCpu.system) / elapsed) * 100 : 0;
  lastCpuUsage = process.cpuUsage();
  lastCpuTime = Date.now();

  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memoryRss: mem.rss,
    memoryHeapUsed: mem.heapUsed,
    memoryHeapTotal: mem.heapTotal,
    uptimeSeconds: process.uptime(),
  };
}

meter.createObservableGauge("agentos.cpu.percent", {
  description: "CPU usage percentage",
}).addCallback((obs) => {
  const m = collectWorkerMetrics();
  obs.observe(m.cpuPercent);
});

meter.createObservableGauge("agentos.memory.rss", {
  description: "Resident set size in bytes",
}).addCallback((obs) => {
  obs.observe(process.memoryUsage.rss());
});

registerFunction(
  {
    id: "telemetry::summary",
    description: "Return OTel metrics summary",
    metadata: { category: "telemetry" },
  },
  async () => {
    const snapshot = collectWorkerMetrics();
    return {
      ...snapshot,
      collectedAt: new Date().toISOString(),
    };
  },
);

registerFunction(
  {
    id: "telemetry::dashboard",
    description: "Metrics dashboard (OTel-backed)",
    metadata: { category: "telemetry" },
  },
  async () => {
    const snapshot = collectWorkerMetrics();
    const lines = [
      `CPU Usage: ${snapshot.cpuPercent}%`,
      `Memory RSS: ${(snapshot.memoryRss / 1024 / 1024).toFixed(1)} MB`,
      `Heap Used: ${(snapshot.memoryHeapUsed / 1024 / 1024).toFixed(1)} MB`,
      `Uptime: ${snapshot.uptimeSeconds.toFixed(0)} s`,
    ];
    return {
      text: lines.join("\n"),
      data: snapshot,
    };
  },
);

registerTrigger({
  type: "http",
  function_id: "telemetry::summary",
  config: { api_path: "api/metrics", http_method: "GET" },
});

registerTrigger({
  type: "http",
  function_id: "telemetry::dashboard",
  config: { api_path: "api/metrics/summary", http_method: "GET" },
});
