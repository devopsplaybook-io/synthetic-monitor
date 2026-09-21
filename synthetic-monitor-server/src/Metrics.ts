import { OTelMeter } from "./OTelContext";
import { ProbeResult } from "./ProbeTypes";

// Mutable last-result state written by the scheduler pipeline and read by the
// observable gauge callbacks on every OTel collection cycle.
const lastResults = new Map<string, ProbeResult>();

let probeLocation = "";

export function recordProbeResult(result: ProbeResult): void {
  lastResults.set(result.probeName, result);
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

function probeAttributes(result: ProbeResult): Record<string, string> {
  const attributes: Record<string, string> = {
    "probe.name": result.probeName,
    "probe.type": result.probeType,
  };
  if (result.errorCode) {
    attributes["error.code"] = result.errorCode;
  }
  if (probeLocation) {
    attributes["probe.location"] = probeLocation;
  }
  return attributes;
}

/**
 * Register the observable gauges once at startup. The callbacks iterate the
 * live last-result map, so hot-reloaded probes appear and disappear without
 * re-registering anything. Low-cardinality discipline: labels carry only the
 * probe name, type, error code and location — never URLs, hosts or ids.
 */
export function MetricsInit(config: { PROBE_LOCATION: string }): void {
  probeLocation = config.PROBE_LOCATION;

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
        if (result.statusCode !== undefined) {
          observableResult.observe(result.statusCode, probeAttributes(result));
        }
      }
    },
    "HTTP response status code of the last probe run",
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
}
