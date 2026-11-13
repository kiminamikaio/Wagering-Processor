const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

type MetricLabels = Record<string, string>;

interface Histogram {
  count: number;
  sum: number;
  buckets: number[];
}

function labelsKey(labels: MetricLabels): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function formatLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels);
  return entries.length === 0
    ? ""
    : `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Map<string, { labels: MetricLabels; value: number }>>();
  private readonly histograms = new Map<string, Map<string, { labels: MetricLabels; value: Histogram }>>();

  increment(name: string, labels: MetricLabels = {}, amount = 1): void {
    const family = this.counters.get(name) ?? new Map();
    const key = labelsKey(labels);
    const current = family.get(key);
    family.set(key, { labels, value: (current?.value ?? 0) + amount });
    this.counters.set(name, family);
  }

  recordTransaction(
    status: string,
    type: string,
    channel: string,
    durationSeconds: number,
  ): void {
    this.increment("wager_transactions_total", { status, type, channel });
    this.observe("transaction_processing_duration_seconds", { channel }, durationSeconds);
  }

  observe(name: string, labels: MetricLabels, value: number): void {
    const family = this.histograms.get(name) ?? new Map();
    const key = labelsKey(labels);
    const existing = family.get(key)?.value ?? {
      count: 0,
      sum: 0,
      buckets: HISTOGRAM_BUCKETS.map(() => 0),
    };
    existing.count += 1;
    existing.sum += value;
    HISTOGRAM_BUCKETS.forEach((bucket, index) => {
      if (value <= bucket) {
        existing.buckets[index] += 1;
      }
    });
    family.set(key, { labels, value: existing });
    this.histograms.set(name, family);
  }

  counterValue(name: string, labels: MetricLabels = {}): number {
    return this.counters.get(name)?.get(labelsKey(labels))?.value ?? 0;
  }

  render(gauges: Readonly<Record<string, number>> = {}): string {
    const lines: string[] = [];
    for (const [name, family] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const { labels, value } of family.values()) {
        lines.push(`${name}${formatLabels(labels)} ${value}`);
      }
    }
    for (const [name, family] of this.histograms) {
      lines.push(`# TYPE ${name} histogram`);
      for (const { labels, value } of family.values()) {
        HISTOGRAM_BUCKETS.forEach((bucket, index) => {
          lines.push(
            `${name}_bucket${formatLabels({ ...labels, le: String(bucket) })} ${value.buckets[index]}`,
          );
        });
        lines.push(`${name}_bucket${formatLabels({ ...labels, le: "+Inf" })} ${value.count}`);
        lines.push(`${name}_sum${formatLabels(labels)} ${value.sum}`);
        lines.push(`${name}_count${formatLabels(labels)} ${value.count}`);
      }
    }
    for (const [name, value] of Object.entries(gauges)) {
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }
}

export const metricsRegistry = new MetricsRegistry();
