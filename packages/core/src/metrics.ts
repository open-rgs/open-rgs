// Tiny in-process Prometheus exposition. Zero deps. Enough for the
// standard RGS observability cuts; if you need something fancier
// (push gateway, OTEL exporter) wrap this or roll your own around the
// public registry.

export interface LabelMap { readonly [k: string]: string }

export interface Counter {
  inc(value?: number, labels?: LabelMap): void;
}
export interface Gauge {
  set(value: number, labels?: LabelMap): void;
  inc(value?: number, labels?: LabelMap): void;
  dec(value?: number, labels?: LabelMap): void;
}
export interface Histogram {
  /** Record one observation. */
  observe(value: number, labels?: LabelMap): void;
  /** Convenience: time `fn` and observe its duration in seconds. */
  time<T>(fn: () => Promise<T> | T, labels?: LabelMap): Promise<T>;
}

interface Metric {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  expose(): string;
}

/** A registry holds many metrics + serialises them to Prometheus text. */
export class Registry {
  private metrics = new Map<string, Metric>();

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.register(new CounterImpl(name, help, labelNames));
  }
  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.register(new GaugeImpl(name, help, labelNames));
  }
  histogram(
    name: string,
    help: string,
    buckets: readonly number[] = DEFAULT_BUCKETS,
    labelNames: readonly string[] = [],
  ): Histogram {
    return this.register(new HistogramImpl(name, help, labelNames, buckets));
  }

  /** Prometheus exposition format. */
  expose(): string {
    const out: string[] = [];
    for (const m of this.metrics.values()) {
      out.push(`# HELP ${m.name} ${m.help}`);
      out.push(`# TYPE ${m.name} ${m.type}`);
      out.push(m.expose());
    }
    return out.join("\n") + "\n";
  }

  private register<T extends Counter | Gauge | Histogram>(m: T & Metric): T {
    if (this.metrics.has(m.name)) {
      throw new Error(`Metric '${m.name}' already registered`);
    }
    this.metrics.set(m.name, m);
    return m;
  }
}

/** Standard latency buckets in seconds, sized for RGS workloads
 *  (sub-ms math, up to several seconds for unhealthy platform calls). */
export const DEFAULT_BUCKETS: readonly number[] = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

// --- Implementations -------------------------------------------------------

function labelKey(labels: LabelMap | undefined, names: readonly string[]): string {
  if (!names.length) return "";
  const l = labels ?? {};
  return names.map(n => `${n}=${JSON.stringify(l[n] ?? "")}`).join(",");
}

function renderLabels(key: string): string {
  if (!key) return "";
  // labelKey returns name=jsonValue,name=jsonValue; turn into {name="value",...}
  const parts = key.split(",").map(kv => {
    const eq = kv.indexOf("=");
    return `${kv.slice(0, eq)}=${kv.slice(eq + 1)}`;
  });
  return `{${parts.join(",")}}`;
}

class CounterImpl implements Counter, Metric {
  readonly type = "counter" as const;
  private values = new Map<string, number>();
  constructor(public readonly name: string, public readonly help: string, private readonly labelNames: readonly string[]) {}

  inc(value = 1, labels?: LabelMap): void {
    const k = labelKey(labels, this.labelNames);
    this.values.set(k, (this.values.get(k) ?? 0) + value);
  }

  expose(): string {
    const out: string[] = [];
    for (const [k, v] of this.values) {
      out.push(`${this.name}${renderLabels(k)} ${v}`);
    }
    if (out.length === 0) out.push(`${this.name} 0`);
    return out.join("\n");
  }
}

class GaugeImpl implements Gauge, Metric {
  readonly type = "gauge" as const;
  private values = new Map<string, number>();
  constructor(public readonly name: string, public readonly help: string, private readonly labelNames: readonly string[]) {}

  set(value: number, labels?: LabelMap): void {
    this.values.set(labelKey(labels, this.labelNames), value);
  }
  inc(value = 1, labels?: LabelMap): void {
    const k = labelKey(labels, this.labelNames);
    this.values.set(k, (this.values.get(k) ?? 0) + value);
  }
  dec(value = 1, labels?: LabelMap): void {
    this.inc(-value, labels);
  }

  expose(): string {
    const out: string[] = [];
    for (const [k, v] of this.values) {
      out.push(`${this.name}${renderLabels(k)} ${v}`);
    }
    if (out.length === 0) out.push(`${this.name} 0`);
    return out.join("\n");
  }
}

interface HistogramSeries {
  bucketCounts: number[];   // parallel to buckets; cumulative on expose()
  sum: number;
  count: number;
}

class HistogramImpl implements Histogram, Metric {
  readonly type = "histogram" as const;
  private series = new Map<string, HistogramSeries>();
  constructor(
    public readonly name: string,
    public readonly help: string,
    private readonly labelNames: readonly string[],
    private readonly buckets: readonly number[],
  ) {}

  observe(value: number, labels?: LabelMap): void {
    const k = labelKey(labels, this.labelNames);
    let s = this.series.get(k);
    if (!s) {
      s = { bucketCounts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    s.sum += value;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) s.bucketCounts[i]! += 1;
    }
  }

  async time<T>(fn: () => Promise<T> | T, labels?: LabelMap): Promise<T> {
    const start = performance.now();
    try {
      return await Promise.resolve(fn());
    } finally {
      this.observe((performance.now() - start) / 1000, labels);
    }
  }

  expose(): string {
    const out: string[] = [];
    for (const [k, s] of this.series) {
      const labelsRendered = renderLabels(k);
      // Per Prom spec, bucket counts are cumulative-le. We already
      // incremented every bucket whose le >= value at observe time,
      // so these are ready to print as-is.
      for (let i = 0; i < this.buckets.length; i++) {
        const le = this.buckets[i]!;
        const merged = mergeLabels(labelsRendered, `le="${le}"`);
        out.push(`${this.name}_bucket${merged} ${s.bucketCounts[i]}`);
      }
      const inf = mergeLabels(labelsRendered, `le="+Inf"`);
      out.push(`${this.name}_bucket${inf} ${s.count}`);
      out.push(`${this.name}_sum${labelsRendered} ${s.sum}`);
      out.push(`${this.name}_count${labelsRendered} ${s.count}`);
    }
    if (out.length === 0) {
      // Always emit something so scrapers don't think the metric vanished.
      for (const b of this.buckets) out.push(`${this.name}_bucket{le="${b}"} 0`);
      out.push(`${this.name}_bucket{le="+Inf"} 0`);
      out.push(`${this.name}_sum 0`);
      out.push(`${this.name}_count 0`);
    }
    return out.join("\n");
  }
}

function mergeLabels(rendered: string, extra: string): string {
  if (!rendered) return `{${extra}}`;
  return `${rendered.slice(0, -1)},${extra}}`;
}
