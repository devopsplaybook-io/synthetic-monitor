export type ProbeType = "http" | "tcp" | "dns" | "tls";

/**
 * Failure taxonomy reported as the `error.code` metric attribute and in log
 * records. Values outside this list collapse to `unknown`.
 */
export type ProbeErrorCode =
  | "dns_error"
  | "connect_refused"
  | "network_unreachable"
  | "connection_reset"
  | "tls_error"
  | "timeout"
  | "status_mismatch"
  | "body_mismatch"
  | "unknown";

export interface ProbeExpectations {
  /** HTTP only: expected response status code. */
  statusCode?: number;
  /** HTTP only: substring that must appear in the response body. */
  bodyContains?: string;
  /** Maximum allowed round-trip duration in milliseconds (all probe types). */
  maxDurationMs?: number;
}

export interface ProbeConfigEntry {
  name: string;
  type: ProbeType;
  target: string;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  /** HTTP only. Defaults to GET. */
  method?: string;
  /** HTTP only. Header values support ${ENV} interpolation. */
  headers?: Record<string, string>;
  /** HTTP only. Body supports ${ENV} interpolation. */
  body?: string;
  expect?: ProbeExpectations;
}

export interface ResolvedProbeConfig {
  name: string;
  type: ProbeType;
  target: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  method: string;
  headers: Record<string, string>;
  body?: string;
  expect?: ProbeExpectations;
}

export interface ProbeResult {
  probeName: string;
  probeType: ProbeType;
  success: boolean;
  /** Round-trip duration in milliseconds. */
  durationMs: number;
  /** HTTP response status code, only when a response was received. */
  statusCode?: number;
  errorCode?: ProbeErrorCode;
  /** Free-form detail (underlying error message), never used as a label. */
  errorDetail?: string;
  /** TLS probes only: remaining validity of the peer certificate in days. */
  certRemainingDays?: number;
  /** Epoch milliseconds at which the probe completed. */
  time: number;
}
