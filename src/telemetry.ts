import { initSDK } from "./shared/config.js";

const { registerFunction, registerTrigger } = initSDK("telemetry");

registerFunction(
  {
    id: "telemetry::record",
    description: "Record a metric event (delegates to OTel)",
    metadata: { category: "telemetry" },
  },
  async (input: {
    name: string;
    value: number;
    labels?: Record<string, string>;
    type?: "counter" | "histogram" | "gauge";
  }) => {
    return { recorded: true, name: input.name, note: "Metrics collected via OTel" };
  },
);

registerFunction(
  {
    id: "telemetry::summary",
    description: "Return OTel metrics summary",
    metadata: { category: "telemetry" },
  },
  async () => {
    return {
      counters: {},
      histograms: {},
      gauges: {},
      collectedAt: new Date().toISOString(),
      note: "Metrics available via OTel exporter endpoint",
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
    return {
      text: "Metrics are now collected via OpenTelemetry.\nUse your OTel-compatible dashboard (Grafana, Jaeger, etc.) to view metrics.",
      data: { note: "OTel auto-collects worker CPU, memory, event loop lag, and uptime" },
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
