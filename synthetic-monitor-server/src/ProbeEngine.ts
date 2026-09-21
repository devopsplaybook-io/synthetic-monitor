import * as dns from "node:dns";
import * as net from "node:net";
import * as tls from "node:tls";
import {
  ProbeErrorCode,
  ProbeResult,
  ResolvedProbeConfig,
} from "./ProbeTypes";

export interface HttpEngineDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface TcpEngineDeps {
  createSocket: () => net.Socket;
}

export interface DnsEngineDeps {
  resolve: (hostname: string, timeoutMs: number) => Promise<string[]>;
}

export interface TlsEngineDeps {
  connect: (options: tls.ConnectionOptions) => tls.TLSSocket;
}

function classifyLookupCode(code: string): ProbeErrorCode {
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_FAIL") {
    return "dns_error";
  }
  if (code === "ECONNREFUSED") {
    return "connect_refused";
  }
  return "unknown";
}

function isTlsCode(code: string): boolean {
  return (
    code.startsWith("CERT_") ||
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL") ||
    code === "EPROTO"
  );
}

function classifyFetchError(err: unknown): {
  errorCode: ProbeErrorCode;
  errorDetail: string;
} {
  const detail = err instanceof Error ? err.message : String(err);
  // Node's fetch (undici) reports network failures as a TypeError whose
  // actual cause carries the errno code; also check err.code directly.
  const causeCode =
    (err as { cause?: { code?: string } })?.cause?.code ??
    (err as { code?: string })?.code ??
    "";
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return { errorCode: "timeout", errorDetail: detail };
  }
  if (causeCode) {
    if (isTlsCode(causeCode)) {
      return { errorCode: "tls_error", errorDetail: `${causeCode}: ${detail}` };
    }
    return { errorCode: classifyLookupCode(causeCode), errorDetail: `${causeCode}: ${detail}` };
  }
  return { errorCode: "unknown", errorDetail: detail };
}

function classifySocketError(err: unknown): {
  errorCode: ProbeErrorCode;
  errorDetail: string;
} {
  const detail = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code ?? "";
  if (code) {
    return { errorCode: classifyLookupCode(code), errorDetail: `${code}: ${detail}` };
  }
  return { errorCode: "unknown", errorDetail: detail };
}

const realHttpDeps: HttpEngineDeps = { fetch: globalThis.fetch };

export async function probeHttp(
  probe: ResolvedProbeConfig,
  deps: HttpEngineDeps = realHttpDeps,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeoutMs = probe.timeoutSeconds * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await deps.fetch(probe.target, {
      method: probe.method,
      headers: probe.headers,
      ...(probe.body !== undefined ? { body: probe.body } : {}),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const durationMs = Date.now() - started;

    if (
      probe.expect?.statusCode !== undefined &&
      response.status !== probe.expect.statusCode
    ) {
      return {
        probeName: probe.name,
        probeType: probe.type,
        success: false,
        durationMs,
        statusCode: response.status,
        errorCode: "status_mismatch",
        errorDetail: `Expected status ${probe.expect.statusCode}, got ${response.status}`,
        time: Date.now(),
      };
    }
    if (
      probe.expect?.bodyContains !== undefined &&
      !bodyText.includes(probe.expect.bodyContains)
    ) {
      return {
        probeName: probe.name,
        probeType: probe.type,
        success: false,
        durationMs,
        statusCode: response.status,
        errorCode: "body_mismatch",
        errorDetail: `Response body does not contain ${JSON.stringify(probe.expect.bodyContains)}`,
        time: Date.now(),
      };
    }
    if (
      probe.expect?.maxDurationMs !== undefined &&
      durationMs > probe.expect.maxDurationMs
    ) {
      return {
        probeName: probe.name,
        probeType: probe.type,
        success: false,
        durationMs,
        statusCode: response.status,
        errorCode: "timeout",
        errorDetail: `Probe took ${durationMs}ms, maxDurationMs is ${probe.expect.maxDurationMs}`,
        time: Date.now(),
      };
    }
    return {
      probeName: probe.name,
      probeType: probe.type,
      success: true,
      durationMs,
      statusCode: response.status,
      time: Date.now(),
    };
  } catch (err) {
    const classified = classifyFetchError(err);
    return {
      probeName: probe.name,
      probeType: probe.type,
      success: false,
      durationMs: Date.now() - started,
      ...classified,
      time: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

const realTcpDeps: TcpEngineDeps = { createSocket: () => new net.Socket() };

export async function probeTcp(
  probe: ResolvedProbeConfig,
  deps: TcpEngineDeps = realTcpDeps,
): Promise<ProbeResult> {
  const lastColon = probe.target.lastIndexOf(":");
  const host = probe.target.slice(0, lastColon);
  const port = Number(probe.target.slice(lastColon + 1));
  return new Promise<ProbeResult>((resolve) => {
    const started = Date.now();
    const socket = deps.createSocket();
    let settled = false;
    const finish = (
      success: boolean,
      classified?: { errorCode: ProbeErrorCode; errorDetail: string },
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve({
        probeName: probe.name,
        probeType: probe.type,
        success,
        durationMs: Date.now() - started,
        ...classified,
        time: Date.now(),
      });
    };
    socket.setTimeout(probe.timeoutSeconds * 1000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () =>
      finish(false, { errorCode: "timeout", errorDetail: "Connect timeout" }),
    );
    socket.once("error", (err) => finish(false, classifySocketError(err)));
    socket.connect(port, host);
  });
}

const realDnsDeps: DnsEngineDeps = {
  resolve: async (hostname, timeoutMs) => {
    const resolver = new dns.promises.Resolver({
      timeout: timeoutMs,
      tries: 2,
    });
    try {
      return await resolver.resolve4(hostname);
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "";
      if (code === "ENODATA" || code === "EAI_NODATA") {
        return await resolver.resolve6(hostname);
      }
      throw err;
    }
  },
};

export async function probeDns(
  probe: ResolvedProbeConfig,
  deps: DnsEngineDeps = realDnsDeps,
): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const addresses = await deps.resolve(
      probe.target,
      probe.timeoutSeconds * 1000,
    );
    const durationMs = Date.now() - started;
    if (addresses.length === 0) {
      return {
        probeName: probe.name,
        probeType: probe.type,
        success: false,
        durationMs,
        errorCode: "dns_error",
        errorDetail: "The name resolved to no address",
        time: Date.now(),
      };
    }
    if (
      probe.expect?.maxDurationMs !== undefined &&
      durationMs > probe.expect.maxDurationMs
    ) {
      return {
        probeName: probe.name,
        probeType: probe.type,
        success: false,
        durationMs,
        errorCode: "timeout",
        errorDetail: `Probe took ${durationMs}ms, maxDurationMs is ${probe.expect.maxDurationMs}`,
        time: Date.now(),
      };
    }
    return {
      probeName: probe.name,
      probeType: probe.type,
      success: true,
      durationMs,
      time: Date.now(),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code ?? "";
    const errorCode: ProbeErrorCode =
      code === "ETIMEDOUT" ? "timeout" : "dns_error";
    return {
      probeName: probe.name,
      probeType: probe.type,
      success: false,
      durationMs: Date.now() - started,
      errorCode,
      errorDetail: code ? `${code}: ${detail}` : detail,
      time: Date.now(),
    };
  }
}

const realTlsDeps: TlsEngineDeps = { connect: (options) => tls.connect(options) };

export async function probeTls(
  probe: ResolvedProbeConfig,
  deps: TlsEngineDeps = realTlsDeps,
): Promise<ProbeResult> {
  const lastColon = probe.target.lastIndexOf(":");
  const host = probe.target.slice(0, lastColon);
  const port = Number(probe.target.slice(lastColon + 1));
  return new Promise<ProbeResult>((resolve) => {
    const started = Date.now();
    let settled = false;
    let socket: tls.TLSSocket;
    const finish = (
      success: boolean,
      extra?: {
        errorCode?: ProbeErrorCode;
        errorDetail?: string;
        certRemainingDays?: number;
      },
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({
        probeName: probe.name,
        probeType: probe.type,
        success,
        durationMs: Date.now() - started,
        ...extra,
        time: Date.now(),
      });
    };
    const timer = setTimeout(() => {
      finish(false, { errorCode: "timeout", errorDetail: "Handshake timeout" });
    }, probe.timeoutSeconds * 1000);
    socket = deps.connect({ host, port, rejectUnauthorized: true });
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const validTo = new Date(cert.valid_to).getTime();
      const certRemainingDays = Math.floor((validTo - Date.now()) / 86400000);
      finish(true, { certRemainingDays });
    });
    socket.once("error", (err) => {
      const classified = classifySocketError(err);
      const code = (err as { code?: string })?.code ?? "";
      finish(false, {
        errorCode: isTlsCode(code) ? "tls_error" : classified.errorCode,
        errorDetail: classified.errorDetail,
      });
    });
  });
}

export function runProbe(probe: ResolvedProbeConfig): Promise<ProbeResult> {
  switch (probe.type) {
    case "http":
      return probeHttp(probe);
    case "tcp":
      return probeTcp(probe);
    case "dns":
      return probeDns(probe);
    case "tls":
      return probeTls(probe);
  }
}
