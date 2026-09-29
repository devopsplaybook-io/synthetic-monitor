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

/**
 * Gauge labels are a fixed set per probe: an attribute that varies with the
 * value (`error.code` on failures only) would make the OTel SDK re-export the
 * previous value under a new card as a frozen series, contradicting the live
 * one. Failure reasons are not reported as gauge attributes.
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
 * Register the observable gauges once at startup. The gauge callbacks iterate
 * the live last-result map, so hot-reloaded probes appear and disappear
 * without re-registering anything. Labels carry only the probe name, type and
 * location — never URLs, hosts or ids.
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
}
