/**
 * Acceptance test for the metric semantics, run against the real
 * `@opentelemetry/sdk-metrics` provider with an in-memory exporter (the OTLP
 * path, not a fake meter): an attribute set that varies with the value would
 * produce frozen/phantom series, so the test asserts exactly one
 * `probe.success` data point per probe per collection cycle with no
 * `error.code` attribute, the sentinel status code and the heartbeat gauge.
 */
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { OTelSetMeter } from "./OTelContext";
import { MetricsInit, pruneProbeResults, recordProbeResult } from "./Metrics";
import { ProbeResult } from "./ProbeTypes";

const SERVICE_ID = "synthetic-monitor";

interface ExportedPoint {
  metric: string;
  attributes: Record<string, string | number | boolean>;
  value: number;
}

interface TestMeter {
  setAsCurrent(): void;
  collect(): Promise<ExportedPoint[]>;
  shutdown(): Promise<void>;
}

/**
 * Mirrors `@devopsplaybook.io/otel-utils` StandardMeter: observable gauges
 * keep their key, counters are exported as `${SERVICE_ID}.${key}`.
 */
function testMeter(): TestMeter {
  const exporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 3600 * 1000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  const meter = provider.getMeter(`${SERVICE_ID}:test`);
  const meterAdapter = {
    createObservableGauge: (
      key: string,
      callback: (observableResult: unknown) => void,
      description?: string,
    ) => {
      const gauge = meter.createObservableGauge(
        key,
        description ? { description } : undefined,
      );
      gauge.addCallback(callback);
      return gauge;
    },
    createCounter: (key: string) => meter.createCounter(`${SERVICE_ID}.${key}`),
  };
  return {
    setAsCurrent: () => OTelSetMeter(meterAdapter as never),
    collect: async () => {
      exporter.reset();
      await provider.forceFlush();
      return flatten(exporter.getMetrics());
    },
    shutdown: () => provider.shutdown(),
  };
}

function flatten(resourceMetrics: ResourceMetrics[]): ExportedPoint[] {
  const points: ExportedPoint[] = [];
  for (const resourceMetric of resourceMetrics) {
    for (const scopeMetric of resourceMetric.scopeMetrics) {
      for (const metric of scopeMetric.metrics) {
        const data = metric as unknown as {
          descriptor: { name: string };
          dataPoints: Array<{
            attributes: Record<string, string | number | boolean>;
            value: number;
          }>;
        };
        for (const point of data.dataPoints) {
          points.push({
            metric: data.descriptor.name,
            attributes: point.attributes,
            value: point.value,
          });
        }
      }
    }
  }
  return points;
}

function pointsOf(points: ExportedPoint[], metric: string): ExportedPoint[] {
  return points.filter((point) => point.metric === metric);
}

function result(overrides: Partial<ProbeResult>): ProbeResult {
  return {
    probeName: "cloudphotomanager",
    probeType: "http",
    success: true,
    durationMs: 12,
    statusCode: 200,
    time: Date.now(),
    ...overrides,
  };
}

describe("Metrics (real sdk-metrics provider)", () => {
  let meter: TestMeter;
  let now: number;

  beforeEach(() => {
    pruneProbeResults(new Set());
    now = Date.now();
    meter = testMeter();
    meter.setAsCurrent();
    MetricsInit({ PROBE_LOCATION: "home" }, () => now);
  });

  afterEach(async () => {
    await meter.shutdown();
  });

  it("exports exactly one probe.success series per probe through a failure and a recovery", async () => {
    recordProbeResult(result({ success: true }));
    const initial = await meter.collect();
    const initialSuccess = pointsOf(initial, "probe.success");
    expect(initialSuccess).toHaveLength(1);
    expect(initialSuccess[0].value).toBe(1);
    expect(initialSuccess[0].attributes).toEqual({
      "probe.name": "cloudphotomanager",
      "probe.type": "http",
      "probe.location": "home",
    });

    recordProbeResult(
      result({
        success: false,
        statusCode: undefined,
        errorCode: "connect_refused",
      }),
    );
    const failure = await meter.collect();
    const failureSuccess = pointsOf(failure, "probe.success");
    expect(failureSuccess).toHaveLength(1);
    expect(failureSuccess[0].value).toBe(0);
    expect(failureSuccess[0].attributes).toEqual({
      "probe.name": "cloudphotomanager",
      "probe.type": "http",
      "probe.location": "home",
    });
    // The failure reason must not appear on the gauge: it belongs to the counter.
    expect(failureSuccess[0].attributes["error.code"]).toBeUndefined();

    recordProbeResult(result({ success: true }));
    const recovery = await meter.collect();
    const recoverySuccess = pointsOf(recovery, "probe.success");
    expect(recoverySuccess).toHaveLength(1);
    expect(recoverySuccess[0].value).toBe(1);
    expect(recoverySuccess[0].attributes["error.code"]).toBeUndefined();
  });

  it("carries the failure reason on the cumulative counter", async () => {
    recordProbeResult(result({ success: true }));
    recordProbeResult(
      result({ success: false, errorCode: "connect_refused" }),
    );
    recordProbeResult(result({ success: true }));
    recordProbeResult(
      result({ success: false, statusCode: undefined, errorCode: "timeout" }),
    );

    const counter = pointsOf(
      await meter.collect(),
      `${SERVICE_ID}.probe.runs.total`,
    );
    expect(counter).toHaveLength(3);
    const byLabel = (attributes: Partial<ExportedPoint["attributes"]>) =>
      counter.find((point) =>
        Object.entries(attributes).every(
          ([key, value]) => point.attributes[key] === value,
        ),
      );
    expect(
      byLabel({ result: "success" })?.value,
    ).toBe(2);
    expect(
      byLabel({ result: "failure", "error.code": "connect_refused" })?.value,
    ).toBe(1);
    expect(byLabel({ result: "failure", "error.code": "timeout" })?.value).toBe(
      1,
    );
  });

  it("exports the status-code sentinel 0 while an endpoint is unreachable", async () => {
    recordProbeResult(result({ success: true, statusCode: 200 }));
    expect(
      pointsOf(await meter.collect(), "probe.http.status_code")[0].value,
    ).toBe(200);

    recordProbeResult(
      result({
        success: false,
        statusCode: undefined,
        errorCode: "connect_refused",
      }),
    );
    const outage = pointsOf(
      await meter.collect(),
      "probe.http.status_code",
    );
    expect(outage).toHaveLength(1);
    expect(outage[0].value).toBe(0);

    recordProbeResult(result({ success: true, statusCode: 200 }));
    const recovered = pointsOf(
      await meter.collect(),
      "probe.http.status_code",
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0].value).toBe(200);
  });

  it("never emits probe.http.status_code for non-http probes", async () => {
    recordProbeResult(
      result({ probeName: "db", probeType: "tcp", statusCode: undefined }),
    );
    expect(
      pointsOf(await meter.collect(), "probe.http.status_code"),
    ).toHaveLength(0);
  });

  it("heartbeat gauge grows while no new result arrives", async () => {
    recordProbeResult(result({ time: now - 1000 }));
    const first = pointsOf(
      await meter.collect(),
      "probe.last_result_age_seconds",
    );
    expect(first).toHaveLength(1);
    expect(first[0].value).toBe(1);

    now += 5000;
    const second = pointsOf(
      await meter.collect(),
      "probe.last_result_age_seconds",
    );
    expect(second).toHaveLength(1);
    expect(second[0].value).toBe(6);

    recordProbeResult(result({ time: now }));
    const afterRun = pointsOf(
      await meter.collect(),
      "probe.last_result_age_seconds",
    );
    expect(afterRun).toHaveLength(1);
    expect(afterRun[0].value).toBe(0);
  });
});
