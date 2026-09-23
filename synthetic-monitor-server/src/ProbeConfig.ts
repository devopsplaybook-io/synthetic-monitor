import { readFile } from "node:fs";
import { parse } from "yaml";
import {
  ProbeConfigEntry,
  ProbeType,
  ResolvedProbeConfig,
} from "./ProbeTypes";

const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_TIMEOUT_SECONDS = 5;
const PROBE_TYPES: ProbeType[] = ["http", "tcp", "dns", "tls"];
const HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

/**
 * Replace every `${ENV_VAR}` occurrence in the value with the content of the
 * environment variable. An unset variable rejects the whole configuration so
 * a broken Secret deployment is loudly reported instead of probing with a
 * half-interpolated target.
 */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    const resolved = process.env[name];
    if (resolved === undefined) {
      throw new Error(`Unresolved environment variable in probe config: ${name}`);
    }
    return resolved;
  });
}

function interpolateDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return interpolateEnv(value);
  }
  if (Array.isArray(value)) {
    return value.map(interpolateDeep);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = interpolateDeep(entry);
    }
    return result;
  }
  return value;
}

function validateHttpTarget(target: string, probeName: string): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`Probe ${probeName}: target is not a valid URL: ${target}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Probe ${probeName}: http probe target must use http or https, got ${url.protocol}`,
    );
  }
}

function validateHostPortTarget(target: string, probeName: string): void {
  const lastColon = target.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === target.length - 1) {
    throw new Error(
      `Probe ${probeName}: target must be formatted as host:port, got ${target}`,
    );
  }
  const port = Number(target.slice(lastColon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Probe ${probeName}: target port must be an integer between 1 and 65535, got ${target}`,
    );
  }
}

function validateProbeEntry(entry: ProbeConfigEntry): ResolvedProbeConfig {
  if (!entry || typeof entry !== "object") {
    throw new Error("Probe list contains an entry that is not an object");
  }
  const name = entry.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("Every probe requires a non-empty name");
  }
  if (!PROBE_TYPES.includes(entry.type)) {
    throw new Error(
      `Probe ${name}: type must be one of ${PROBE_TYPES.join(", ")}, got ${entry.type}`,
    );
  }
  if (typeof entry.target !== "string" || entry.target.trim() === "") {
    throw new Error(`Probe ${name}: a non-empty target is required`);
  }
  if (
    entry.intervalSeconds !== undefined &&
    (typeof entry.intervalSeconds !== "number" || entry.intervalSeconds <= 0)
  ) {
    throw new Error(`Probe ${name}: intervalSeconds must be a positive number`);
  }
  if (
    entry.timeoutSeconds !== undefined &&
    (typeof entry.timeoutSeconds !== "number" || entry.timeoutSeconds <= 0)
  ) {
    throw new Error(`Probe ${name}: timeoutSeconds must be a positive number`);
  }
  if (
    entry.failureThreshold !== undefined &&
    (!Number.isInteger(entry.failureThreshold) || entry.failureThreshold < 1)
  ) {
    throw new Error(
      `Probe ${name}: failureThreshold must be a positive integer`,
    );
  }

  const intervalSeconds = entry.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const timeoutSeconds = entry.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (timeoutSeconds >= intervalSeconds) {
    throw new Error(
      `Probe ${name}: timeoutSeconds (${timeoutSeconds}) must be lower than intervalSeconds (${intervalSeconds})`,
    );
  }

  if (entry.type === "http") {
    validateHttpTarget(entry.target, name);
  } else if (entry.type === "tcp" || entry.type === "tls") {
    validateHostPortTarget(entry.target, name);
  }

  let method = "GET";
  if (entry.method !== undefined) {
    if (
      typeof entry.method !== "string" ||
      !HTTP_METHODS.includes(entry.method.toUpperCase())
    ) {
      throw new Error(
        `Probe ${name}: method must be one of ${HTTP_METHODS.join(", ")}, got ${entry.method}`,
      );
    }
    method = entry.method.toUpperCase();
  }

  if (
    entry.headers !== undefined &&
    (typeof entry.headers !== "object" ||
      entry.headers === null ||
      Array.isArray(entry.headers) ||
      Object.values(entry.headers).some((v) => typeof v !== "string"))
  ) {
    throw new Error(`Probe ${name}: headers must be a map of string values`);
  }

  if (entry.body !== undefined && typeof entry.body !== "string") {
    throw new Error(`Probe ${name}: body must be a string`);
  }
  if (
    entry.body !== undefined &&
    ["GET", "HEAD"].includes(method)
  ) {
    throw new Error(
      `Probe ${name}: body is only supported for methods with a request body`,
    );
  }

  let expect;
  if (entry.expect !== undefined) {
    if (typeof entry.expect !== "object" || entry.expect === null) {
      throw new Error(`Probe ${name}: expect must be a map`);
    }
    const expectValue = entry.expect;
    if (
      expectValue.statusCode !== undefined &&
      (!Number.isInteger(expectValue.statusCode) || expectValue.statusCode < 0)
    ) {
      throw new Error(`Probe ${name}: expect.statusCode must be an integer`);
    }
    if (
      expectValue.bodyContains !== undefined &&
      typeof expectValue.bodyContains !== "string"
    ) {
      throw new Error(`Probe ${name}: expect.bodyContains must be a string`);
    }
    if (
      expectValue.maxDurationMs !== undefined &&
      (typeof expectValue.maxDurationMs !== "number" ||
        expectValue.maxDurationMs <= 0)
    ) {
      throw new Error(
        `Probe ${name}: expect.maxDurationMs must be a positive number`,
      );
    }
    if (entry.type !== "http" && (expectValue.statusCode !== undefined || expectValue.bodyContains !== undefined)) {
      throw new Error(
        `Probe ${name}: expect.statusCode and expect.bodyContains are only supported for http probes`,
      );
    }
    expect = expectValue;
  }

  return {
    name,
    type: entry.type,
    target: entry.target,
    intervalSeconds,
    timeoutSeconds,
    ...(entry.failureThreshold !== undefined
      ? { failureThreshold: entry.failureThreshold }
      : {}),
    method,
    headers: entry.headers ?? {},
    ...(entry.body !== undefined ? { body: entry.body } : {}),
    ...(expect !== undefined ? { expect } : {}),
  };
}

function validateProbeList(raw: unknown): ResolvedProbeConfig[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Probe config must be a YAML object with a probes list");
  }
  const probes = (raw as { probes: unknown }).probes;
  if (!Array.isArray(probes)) {
    throw new Error("Probe config must contain a probes list");
  }
  const seenNames = new Set<string>();
  return probes.map((entry: ProbeConfigEntry) => {
    const resolved = validateProbeEntry(entry);
    if (seenNames.has(resolved.name)) {
      throw new Error(`Duplicate probe name: ${resolved.name}`);
    }
    seenNames.add(resolved.name);
    return resolved;
  });
}

/**
 * Loads and hot-reloads the probes.yaml probe configuration.
 *
 * The first successful load populates the probe list; a failing load throws
 * (the caller decides to fail fast at startup). Subsequent reloads triggered
 * by the ConfigMap kubelet sync keep the last known good configuration when
 * the new content fails to parse or validate.
 */
export class ProbeConfig {
  private probes: ResolvedProbeConfig[] = [];

  constructor(private readonly filePath: string) {}

  public getProbes(): ResolvedProbeConfig[] {
    return this.probes;
  }

  public async load(): Promise<void> {
    const content = await new Promise<string>((resolve, reject) => {
      readFile(this.filePath, "utf8", (err, data) =>
        err ? reject(err) : resolve(data),
      );
    });
    const raw = interpolateDeep(parse(content));
    this.probes = validateProbeList(raw);
  }

  /**
   * Reload the configuration file, keeping the current probes when the new
   * content is invalid. Returns true when the configuration changed to a new
   * valid version.
   */
  public reloadKeepingLastKnownGood(log: (message: string) => void): Promise<boolean> {
    return this.load().then(
      () => true,
      (err) => {
        log(
          `Ignoring invalid probe configuration from ${this.filePath}, keeping last known good config (${this.probes.length} probes): ${err instanceof Error ? err.message : err}`,
        );
        return false;
      },
    );
  }
}

/**
 * Prepend the built-in deadman self-probe when enabled and a metrics endpoint
 * is configured. The self-probe checks the otel-light origin so a broken
 * ingestion pipeline shows up in the probe metrics themselves.
 */
export function withSelfProbe(
  config: { SELF_PROBE_ENABLED: boolean; OPENTELEMETRY_COLLECTOR_HTTP_METRICS: string },
  probes: ResolvedProbeConfig[],
): ResolvedProbeConfig[] {
  if (!config.SELF_PROBE_ENABLED || !config.OPENTELEMETRY_COLLECTOR_HTTP_METRICS) {
    return probes;
  }
  let origin: string;
  try {
    origin = new URL(config.OPENTELEMETRY_COLLECTOR_HTTP_METRICS).origin;
  } catch {
    return probes;
  }
  if (probes.some((probe) => probe.name === "otel-light-self")) {
    return probes;
  }
  return [
    {
      name: "otel-light-self",
      type: "http",
      target: `${origin}/`,
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      method: "GET",
      headers: {},
      expect: { statusCode: 200 },
    },
    ...probes,
  ];
}
