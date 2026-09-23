import { Counter } from "@opentelemetry/api";
import { OTelMeter } from "./OTelContext";
import { ProbeResult } from "./ProbeTypes";

// Mutable last-result state written by the scheduler pipeline and read by the
// observable gauge callbacks on every OTel collection cycle.
const lastResults = new Map<string, ProbeResult>();

let probeLocation = "";
let runsCounter: Counter | undefined;

export function recordProbeResult(result: ProbeResult): void {
  lastResults.set(result.probeName, result);
  const attributes: Record<string, string> = {
    ...probeAttributes(result),
    result: result.success ? "success" : "failure",
  };
  if (!result.success) {
    attributes["error.code"] = result.errorCode ?? "unknown";
  }
  runsCounter?.add(1, attributes);
}

/**
 * Drop last results of probes that are no longer configured (hot reload:
 * removed or renamed probes must stop reporting series).
 */
export function pruneProbeResults(activeNames: Set<string>): void {
  for (const name of Array.from(lastResults.keys())) {
    if (!activeNames.has(name)) {
      lastResults.delete(name);
    }
  }
}

export function getLastProbeResults(): ProbeResult[] {
  return Array.from(lastResults.values());
}

/**
 * Gauge labels are a fixed set per probe: an attribute that varies with the
 * value (`error.code` on failures only) would make the OTel SDK re-export the
 * previous value under a new card as a frozen series, contradicting the live
 * one. Failure reasons therefore live on the counter, not on the gauges.
 */
function probeAttributes(result: ProbeResult): Record<string, string> {
  const attributes: Record<string, string> = {
    "probe.name": result.probeName,
    "probe.type": result.probeType,
  };
  if (probeLocation) {
    attributes["probe.location"] = probeLocation;
  }
  return attributes;
}

/**
 * Register the observable gauges and the outcome counter once at startup. The
 * gauge callbacks iterate the live last-result map, so hot-reloaded probes
 * appear and disappear without re-registering anything. Low-cardinality
 * discipline: labels carry only the probe name, type, location and (`result`,
 * `error.code` on the counter) — never URLs, hosts or ids.
 */
export function MetricsInit(
  config: { PROBE_LOCATION: string },
  now: () => number = Date.now,
): void {
  probeLocation = config.PROBE_LOCATION;

  runsCounter = OTelMeter().createCounter("probe.runs.total");

  OTelMeter().createObservableGauge(
    "probe.success",
    (observableResult) => {
      for (const result of lastResults.values()) {
        observableResult.observe(result.success ? 1 : 0, probeAttributes(result));
      }
    },
    "1 if the probe succeeded, 0 otherwise",
  );

  OTelMeter().createObservableGauge(
    "probe.duration",
    (observableResult) => {
      for (const result of lastResults.values()) {
        observableResult.observe(
          parseFloat((result.durationMs / 1000).toFixed(3)),
          probeAttributes(result),
        );
      }
    },
    "Probe round-trip duration in seconds",
  );

  OTelMeter().createObservableGauge(
    "probe.http.status_code",
    (observableResult) => {
      for (const result of lastResults.values()) {
        if (result.probeType === "http") {
          // 0 means "no response received"; never observing it would keep a
          // stale status (e.g. a flat 200) visible during an outage.
          observableResult.observe(
            result.statusCode ?? 0,
            probeAttributes(result),
          );
        }
      }
    },
    "HTTP response status code of the last probe run (0 when no response was received)",
  );

  OTelMeter().createObservableGauge(
    "probe.dns.lookup_time",
    (observableResult) => {
      for (const result of lastResults.values()) {
        if (result.probeType === "dns") {
          observableResult.observe(
            parseFloat((result.durationMs / 1000).toFixed(3)),
            probeAttributes(result),
          );
        }
      }
    },
    "DNS resolution time of the last probe run in seconds",
  );

  OTelMeter().createObservableGauge(
    "probe.tls.cert_remaining_days",
    (observableResult) => {
      for (const result of lastResults.values()) {
        if (result.certRemainingDays !== undefined) {
          observableResult.observe(
            result.certRemainingDays,
            probeAttributes(result),
          );
        }
      }
    },
    "Days remaining before the TLS certificate of the probed endpoint expires",
  );

  OTelMeter().createObservableGauge(
    "probe.last_result_age_seconds",
    (observableResult) => {
      for (const result of lastResults.values()) {
        observableResult.observe(
          Math.max(0, Math.floor((now() - result.time) / 1000)),
          probeAttributes(result),
        );
      }
    },
    "Seconds since the last completed run of the probe (heartbeat: grows when the probe stops reporting)",
  );
}
