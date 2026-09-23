import { OTelSetMeter } from "./OTelContext";
import { MetricsInit, pruneProbeResults, recordProbeResult } from "./Metrics";
import { ProbeResult } from "./ProbeTypes";

interface ObservedPoint {
  value: number;
  attributes: Record<string, string>;
}

interface CapturedGauge {
  key: string;
  collect: () => ObservedPoint[];
}

interface CounterCall {
  value: number;
  attributes: Record<string, string>;
}

function fakeMeter(): {
  gauges: Map<string, CapturedGauge>;
  counters: Map<string, CounterCall[]>;
  meter: unknown;
} {
  const gauges = new Map<string, CapturedGauge>();
  const counters = new Map<string, CounterCall[]>();
  const meter = {
    createObservableGauge: (
      key: string,
      callback: (observableResult: unknown) => void,
    ) => {
      const points: ObservedPoint[] = [];
      gauges.set(key, {
        key,
        collect: () => {
          points.length = 0;
          callback({
            observe: (value: number, attributes: Record<string, string>) => {
              points.push({ value, attributes });
            },
          });
          return points;
        },
      });
      return {};
    },
    createCounter: (key: string) => {
      counters.set(key, []);
      return {
        add: (value: number, attributes: Record<string, string>) => {
          counters.get(key).push({ value, attributes });
        },
      };
    },
  };
  return { gauges, counters, meter };
}

function makeResult(overrides: Partial<ProbeResult>): ProbeResult {
  return {
    probeName: "web",
    probeType: "http",
    success: true,
    durationMs: 120,
    statusCode: 200,
    time: Date.now(),
    ...overrides,
  };
}

describe("Metrics", () => {
  let gauges: Map<string, CapturedGauge>;
  let counters: Map<string, CounterCall[]>;

  beforeEach(() => {
    pruneProbeResults(new Set());
    const fake = fakeMeter();
    gauges = fake.gauges;
    counters = fake.counters;
    OTelSetMeter(fake.meter as never);
    MetricsInit({ PROBE_LOCATION: "home" });
  });

  it("registers the documented probe gauges and the outcome counter once", () => {
    expect(Array.from(gauges.keys())).toEqual([
      "probe.success",
      "probe.duration",
      "probe.http.status_code",
      "probe.dns.lookup_time",
      "probe.tls.cert_remaining_days",
      "probe.last_result_age_seconds",
    ]);
    expect(Array.from(counters.keys())).toEqual(["probe.runs.total"]);
  });

  it("reports the last result of each probe with a stable attribute set", () => {
    recordProbeResult(makeResult({ probeName: "web", success: true }));
    recordProbeResult(
      makeResult({
        probeName: "db",
        probeType: "tcp",
        success: false,
        statusCode: undefined,
        errorCode: "connect_refused",
      }),
    );

    const success = gauges.get("probe.success").collect();
    expect(success).toHaveLength(2);
    expect(success.find((p) => p.attributes["probe.name"] === "web")).toMatchObject({
      value: 1,
      attributes: {
        "probe.name": "web",
        "probe.type": "http",
        "probe.location": "home",
      },
    });
    expect(
      success.find((p) => p.attributes["probe.name"] === "db"),
    ).toMatchObject({
      value: 0,
      attributes: {
        "probe.name": "db",
        "probe.type": "tcp",
        "probe.location": "home",
      },
    });
    // The failure reason must never be an attribute of a gauge: an attribute
    // set that varies with the value leaves phantom series behind.
    for (const point of success) {
      expect(point.attributes["error.code"]).toBeUndefined();
    }
  });

  it("counts probe runs by outcome and failure reason", () => {
    recordProbeResult(makeResult({ probeName: "web", success: true }));
    recordProbeResult(
      makeResult({
        probeName: "web",
        success: false,
        statusCode: undefined,
        errorCode: "connect_refused",
      }),
    );

    expect(counters.get("probe.runs.total")).toEqual([
      {
        value: 1,
        attributes: {
          "probe.name": "web",
          "probe.type": "http",
          "probe.location": "home",
          result: "success",
        },
      },
      {
        value: 1,
        attributes: {
          "probe.name": "web",
          "probe.type": "http",
          "probe.location": "home",
          result: "failure",
          "error.code": "connect_refused",
        },
      },
    ]);
  });

  it("reports error.code=unknown on the counter when the result carries none", () => {
    recordProbeResult(
      makeResult({ probeName: "web", success: false, errorCode: undefined }),
    );
    expect(counters.get("probe.runs.total")[0].attributes["error.code"]).toBe(
      "unknown",
    );
  });

  it("omits probe.location when unset", () => {
    const fake = fakeMeter();
    OTelSetMeter(fake.meter as never);
    MetricsInit({ PROBE_LOCATION: "" });
    recordProbeResult(makeResult({ probeName: "web" }));
    const points = fake.gauges.get("probe.success").collect();
    expect(points[0].attributes["probe.location"]).toBeUndefined();
  });

  it("reports status code 0 for http probes that received no response", () => {
    recordProbeResult(
      makeResult({
        probeName: "web",
        success: false,
        statusCode: undefined,
        errorCode: "timeout",
      }),
    );
    recordProbeResult(
      makeResult({
        probeName: "db",
        probeType: "tcp",
        statusCode: undefined,
      }),
    );

    const status = gauges.get("probe.http.status_code").collect();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      value: 0,
      attributes: { "probe.name": "web", "probe.type": "http" },
    });
  });

  it("reports the age of the last result as a heartbeat", () => {
    const lastResultTime = 1000000;
    recordProbeResult(makeResult({ probeName: "web", time: lastResultTime }));

    const fake = fakeMeter();
    OTelSetMeter(fake.meter as never);
    MetricsInit({ PROBE_LOCATION: "home" }, () => lastResultTime + 4200);

    const points = fake.gauges.get("probe.last_result_age_seconds").collect();
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      value: 4,
      attributes: { "probe.name": "web", "probe.location": "home" },
    });
  });

  it("never reports a negative heartbeat age", () => {
    const lastResultTime = 1000000;
    recordProbeResult(makeResult({ probeName: "web", time: lastResultTime }));

    const fake = fakeMeter();
    OTelSetMeter(fake.meter as never);
    MetricsInit({ PROBE_LOCATION: "home" }, () => lastResultTime - 5000);

    expect(
      fake.gauges.get("probe.last_result_age_seconds").collect()[0].value,
    ).toBe(0);
  });

  it("reports dns lookup time only for dns probes", () => {
    recordProbeResult(makeResult({ probeName: "resolver", probeType: "dns", statusCode: undefined, durationMs: 250 }));
    recordProbeResult(makeResult({ probeName: "web", probeType: "http" }));
    const points = gauges.get("probe.dns.lookup_time").collect();
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      value: 0.25,
      attributes: { "probe.name": "resolver", "probe.type": "dns" },
    });
  });

  it("reports tls certificate remaining days", () => {
    recordProbeResult(
      makeResult({
        probeName: "tlscheck",
        probeType: "tls",
        statusCode: undefined,
        certRemainingDays: 12,
      }),
    );
    const points = gauges.get("probe.tls.cert_remaining_days").collect();
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ value: 12 });
  });

  it("prunes removed probes on hot reload without re-registering gauges", () => {
    recordProbeResult(makeResult({ probeName: "old" }));
    recordProbeResult(makeResult({ probeName: "web" }));

    pruneProbeResults(new Set(["web"]));

    const points = gauges.get("probe.success").collect();
    expect(points).toHaveLength(1);
    expect(points[0].attributes["probe.name"]).toBe("web");
    expect(gauges.get("probe.success")).toBeDefined();
  });
});
