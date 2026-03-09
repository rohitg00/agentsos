import { metrics } from "@opentelemetry/api";

type MetricType = "counter" | "histogram" | "gauge";

const meter = metrics.getMeter("agentos");

const instrumentCache = new Map<string, any>();

function getOrCreate(name: string, factory: () => any): any {
  let instrument = instrumentCache.get(name);
  if (!instrument) {
    instrument = factory();
    instrumentCache.set(name, instrument);
  }
  return instrument;
}

export function recordMetric(
  name: string,
  value: number,
  labels: Record<string, string>,
  type: MetricType = "counter",
): void {
  try {
    if (type === "counter") {
      getOrCreate(name, () => meter.createCounter(name)).add(value, labels);
    } else if (type === "histogram") {
      getOrCreate(name, () => meter.createHistogram(name)).record(value, labels);
    } else if (type === "gauge") {
      getOrCreate(name, () => meter.createUpDownCounter(name)).add(value, labels);
    }
  } catch {}
}
