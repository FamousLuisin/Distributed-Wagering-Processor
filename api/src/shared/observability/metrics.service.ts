import { Injectable } from '@nestjs/common';

type Labels = Record<string, string>;
type MetricType = 'counter' | 'gauge' | 'histogram';

interface MetricDefinition {
  help: string;
  type: MetricType;
  samples: Map<string, { labels: Labels; value: number }>;
  histograms: Map<
    string,
    { labels: Labels; count: number; sum: number; buckets: Map<number, number> }
  >;
  buckets: number[];
}

@Injectable()
export class MetricsService {
  private readonly definitions = new Map<string, MetricDefinition>();

  increment(name: string, help: string, labels: Labels = {}, amount = 1): void {
    const metric = this.getMetric(name, help, 'counter');
    const key = this.labelKey(labels);
    const sample = metric.samples.get(key) ?? { labels, value: 0 };
    sample.value += amount;
    metric.samples.set(key, sample);
  }

  setGauge(
    name: string,
    help: string,
    value: number,
    labels: Labels = {},
  ): void {
    const metric = this.getMetric(name, help, 'gauge');
    metric.samples.set(this.labelKey(labels), { labels, value });
  }

  observe(
    name: string,
    help: string,
    value: number,
    labels: Labels = {},
    buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  ): void {
    const metric = this.getMetric(name, help, 'histogram', buckets);
    const key = this.labelKey(labels);
    let sample = metric.histograms.get(key);
    if (!sample) {
      sample = {
        labels,
        count: 0,
        sum: 0,
        buckets: new Map(buckets.map((bound) => [bound, 0])),
      };
      metric.histograms.set(key, sample);
    }
    sample.count += 1;
    sample.sum += value;
    for (const bound of buckets) {
      if (value <= bound)
        sample.buckets.set(bound, (sample.buckets.get(bound) ?? 0) + 1);
    }
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const [name, metric] of this.definitions) {
      lines.push(`# HELP ${name} ${this.escapeHelp(metric.help)}`);
      lines.push(`# TYPE ${name} ${metric.type}`);
      if (metric.type === 'histogram') {
        for (const sample of metric.histograms.values()) {
          for (const bound of metric.buckets) {
            lines.push(
              `${name}_bucket${this.formatLabels({ ...sample.labels, le: String(bound) })} ${sample.buckets.get(bound) ?? 0}`,
            );
          }
          lines.push(
            `${name}_bucket${this.formatLabels({ ...sample.labels, le: '+Inf' })} ${sample.count}`,
          );
          lines.push(
            `${name}_sum${this.formatLabels(sample.labels)} ${sample.sum}`,
          );
          lines.push(
            `${name}_count${this.formatLabels(sample.labels)} ${sample.count}`,
          );
        }
      } else {
        for (const sample of metric.samples.values()) {
          lines.push(
            `${name}${this.formatLabels(sample.labels)} ${sample.value}`,
          );
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private getMetric(
    name: string,
    help: string,
    type: MetricType,
    buckets: number[] = [],
  ): MetricDefinition {
    const current = this.definitions.get(name);
    if (current) {
      if (current.type !== type)
        throw new Error(`Metric ${name} was registered as ${current.type}`);
      return current;
    }
    const metric: MetricDefinition = {
      help,
      type,
      samples: new Map(),
      histograms: new Map(),
      buckets: [...buckets].sort((a, b) => a - b),
    };
    this.definitions.set(name, metric);
    return metric;
  }

  private labelKey(labels: Labels): string {
    return Object.entries(labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
  }

  private formatLabels(labels: Labels): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    return `{${entries.map(([key, value]) => `${key}="${this.escapeLabel(value)}"`).join(',')}}`;
  }

  private escapeLabel(value: string): string {
    return value
      .replaceAll('\\', '\\\\')
      .replaceAll('\n', '\\n')
      .replaceAll('"', '\\"');
  }

  private escapeHelp(value: string): string {
    return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
  }
}
