import { SpanStatusCode } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { Span } from "@opentelemetry/sdk-trace-base";
import { OTelLogger, OTelTracer } from "./OTelContext";
import { runProbe } from "./ProbeEngine";
import { ProbeResult, ResolvedProbeConfig } from "./ProbeTypes";

export interface ProbeRunnerOptions {
  /** Emit INFO log records for successful runs (failures are always logged). */
  logSuccess: boolean;
  /** Value of the `probe.location` attribute; omitted when empty. */
  location: string;
}

function applyResultToSpan(
  span: Span,
  result: ProbeResult,
  location: string,
): void {
  span.setAttribute("probe.name", result.probeName);
  span.setAttribute("probe.type", result.probeType);
  if (location) {
    span.setAttribute("probe.location", location);
  }
  span.setAttribute("duration_ms", result.durationMs);
  if (result.statusCode !== undefined) {
    span.setAttribute("http.response.status_code", result.statusCode);
  }
  if (!result.success) {
    span.setAttribute("error.code", result.errorCode ?? "unknown");
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: result.errorDetail ?? result.errorCode ?? "probe failed",
    });
  }
}

/**
 * Log record for one probe result. The message text is stable per outcome
 * (the duration varies per run and would fragment otel-light's "top error
 * messages"); everything variable goes into attributes, and `trace.id`/
 * `span.id` are the keys otel-light extracts into its log rows.
 */
function emitProbeResultLog(
  result: ProbeResult,
  span: Span,
  options: ProbeRunnerOptions,
): void {
  if (result.success && !options.logSuccess) {
    return;
  }
  const statusText =
    result.statusCode !== undefined ? ` (status ${result.statusCode})` : "";
  const message = result.success
    ? `Probe ${result.probeName} [${result.probeType}] succeeded${statusText}`
    : `Probe ${result.probeName} [${result.probeType}] failed: error.code=${result.errorCode ?? "unknown"}`;
  const body = `[probe-result] ${message}`;
  const severityNumber = result.success
    ? SeverityNumber.INFO
    : SeverityNumber.ERROR;
  const severityText = result.success ? "info" : "error";
  console.log(`[${severityText}] ${body}`);

  const logger = OTelLogger().getLogger();
  if (!logger) {
    return;
  }
  const attributes: Record<string, string | number> = {
    "log.type": "probe-result",
    "probe.name": result.probeName,
    "probe.type": result.probeType,
    duration_ms: result.durationMs,
  };
  if (options.location) {
    attributes["probe.location"] = options.location;
  }
  if (result.statusCode !== undefined) {
    attributes.status_code = result.statusCode;
  }
  if (!result.success) {
    attributes["error.code"] = result.errorCode ?? "unknown";
    if (result.errorDetail) {
      attributes["error.detail"] = result.errorDetail;
    }
  }
  const spanContext = span.spanContext();
  attributes["trace.id"] = spanContext.traceId;
  attributes["span.id"] = spanContext.spanId;

  logger.emit({ severityNumber, severityText, body, attributes });
}

/**
 * Run one probe inside a `probe.<name>` span: the span carries the outcome
 * (ERROR status + code on failure) and the result log record is emitted while
 * the span is open so it can be correlated with the trace.
 */
export async function runProbeWithSpan(
  probe: ResolvedProbeConfig,
  options: ProbeRunnerOptions,
): Promise<ProbeResult> {
  const span = OTelTracer().startSpan(`probe.${probe.name}`);
  try {
    const result = await runProbe(probe);
    applyResultToSpan(span, result, options.location);
    emitProbeResultLog(result, span, options);
    return result;
  } finally {
    span.end();
  }
}
