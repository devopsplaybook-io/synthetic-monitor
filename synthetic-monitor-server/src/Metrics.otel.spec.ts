/**
 * Acceptance test for the metric semantics, run against the real
 * `@opentelemetry/sdk-metrics` provider with an in-memory exporter (the OTLP
 * path, not a fake meter): an attribute set that varies with the value would
 * produce frozen/phantom series, so the test asserts exactly one
 * `probe.success` data point per probe per collection cycle with no
 * `error.code` attribute, the sentinel status code and no removed metrics.
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
 * Mirrors the observable-gauge behavior of `@devopsplaybook.io/otel-utils`.
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

  beforeEach(() => {
    pruneProbeResults(new Set());
    meter = testMeter();
    meter.setAsCurrent();
    MetricsInit({ PROBE_LOCATION: "home" });
  });

  afterEach(async () => {
    await meter.shutdown();
  });

  it("does not export either removed metric", async () => {
    recordProbeResult(result({ success: false, errorCode: "timeout" }));

    const exported = await meter.collect();

    expect(pointsOf(exported, "synthetic-monitor.probe.runs.total")).toEqual([]);
    expect(pointsOf(exported, "probe.last_result_age_seconds")).toEqual([]);
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
    // The failure reason must not appear on the gauge.
    expect(failureSuccess[0].attributes["error.code"]).toBeUndefined();

    recordProbeResult(result({ success: true }));
    const recovery = await meter.collect();
    const recoverySuccess = pointsOf(recovery, "probe.success");
    expect(recoverySuccess).toHaveLength(1);
    expect(recoverySuccess[0].value).toBe(1);
    expect(recoverySuccess[0].attributes["error.code"]).toBeUndefined();
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
});
