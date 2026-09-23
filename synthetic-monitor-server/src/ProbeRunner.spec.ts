import { SpanStatusCode } from "@opentelemetry/api";
import * as http from "node:http";
import * as net from "node:net";
import { AddressInfo } from "node:net";
import { OTelSetLogger, OTelSetTracer } from "./OTelContext";
import { runProbeWithSpan } from "./ProbeRunner";
import { ResolvedProbeConfig } from "./ProbeTypes";

interface EmittedRecord {
  severityNumber: number;
  severityText: string;
  body: string;
  attributes: Record<string, unknown>;
}

const TRACE_ID = "6ab32bd09b8760a4512912f9069e7998";
const SPAN_ID = "a1b2c3d4e5f60718";

class FakeSpan {
  public attributes: Record<string, unknown> = {};
  public status?: { code: number; message?: string };
  public ended = false;

  public setAttribute(key: string, value: unknown): void {
    this.attributes[key] = value;
  }

  public setStatus(status: { code: number; message?: string }): void {
    this.status = status;
  }

  public spanContext() {
    return { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 };
  }

  public end(): void {
    this.ended = true;
  }
}

function setup(): {
  span: FakeSpan;
  startSpan: jest.Mock;
  records: EmittedRecord[];
} {
  const span = new FakeSpan();
  const startSpan = jest.fn(() => span);
  OTelSetTracer({ startSpan } as never);
  const records: EmittedRecord[] = [];
  OTelSetLogger({
    getLogger: () => ({
      emit: (record: EmittedRecord) => records.push(record),
    }),
  } as never);
  return { span, startSpan, records };
}

function httpProbe(target: string, overrides: Partial<ResolvedProbeConfig> = {}): ResolvedProbeConfig {
  return {
    name: "web",
    type: "http",
    target,
    intervalSeconds: 30,
    timeoutSeconds: 5,
    method: "GET",
    headers: {},
    ...overrides,
  };
}

async function startHttpServer(
  status: number,
  body: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Port that was just bound and released: connecting to it is refused. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("runProbeWithSpan", () => {
  let consoleLog: jest.SpyInstance;
  let cleanups: Array<() => Promise<void>>;

  beforeEach(() => {
    consoleLog = jest.spyOn(console, "log").mockImplementation(() => {});
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
    consoleLog.mockRestore();
  });

  it("reports a successful probe on the span and emits a correlated INFO log", async () => {
    const { span, startSpan, records } = setup();
    const server = await startHttpServer(200, "hello");
    cleanups.push(server.close);

    const result = await runProbeWithSpan(httpProbe(server.url), {
      logSuccess: true,
      location: "home",
    });

    expect(result.success).toBe(true);
    expect(startSpan).toHaveBeenCalledWith("probe.web");
    expect(span.attributes).toMatchObject({
      "probe.name": "web",
      "probe.type": "http",
      "probe.location": "home",
      "http.response.status_code": 200,
    });
    expect(span.attributes.duration_ms).toBeGreaterThanOrEqual(0);
    expect(span.status).toBeUndefined();
    expect(span.ended).toBe(true);

    expect(records).toHaveLength(1);
    expect(records[0].severityText).toBe("info");
    expect(records[0].attributes).toMatchObject({
      "trace.id": TRACE_ID,
      "span.id": SPAN_ID,
      "log.type": "probe-result",
      "probe.name": "web",
      "probe.type": "http",
      "probe.location": "home",
      status_code: 200,
    });
    // The per-run duration lives in the attributes only: variable text in the
    // message fragments otel-light's "top messages" view.
    expect(records[0].body).toBe(
      "[probe-result] Probe web [http] succeeded (status 200)",
    );
  });

  it("sets ERROR status and an error attribute when the probe fails", async () => {
    const { span, records } = setup();
    const port = await closedPort();

    const result = await runProbeWithSpan(
      httpProbe(`http://127.0.0.1:${port}/`),
      { logSuccess: true, location: "home" },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("connect_refused");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toContain("ECONNREFUSED");
    expect(span.attributes["error.code"]).toBe("connect_refused");
    expect(span.attributes["http.response.status_code"]).toBeUndefined();
    expect(span.ended).toBe(true);

    expect(records).toHaveLength(1);
    expect(records[0].severityText).toBe("error");
    expect(records[0].body).toBe(
      "[probe-result] Probe web [http] failed: error.code=connect_refused",
    );
    expect(records[0].attributes["error.code"]).toBe("connect_refused");
    expect(records[0].attributes["error.detail"]).toContain("ECONNREFUSED");
    expect(records[0].attributes["trace.id"]).toBe(TRACE_ID);
  });

  it("records the response status code on a failing span", async () => {
    const { span } = setup();
    const server = await startHttpServer(500, "boom");
    cleanups.push(server.close);

    const result = await runProbeWithSpan(
      httpProbe(server.url, { expect: { statusCode: 200 } }),
      { logSuccess: true, location: "home" },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("status_mismatch");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["http.response.status_code"]).toBe(500);
    expect(span.attributes["error.code"]).toBe("status_mismatch");
  });

  it("suppresses success logs when logSuccess is false, never failure logs", async () => {
    const server = await startHttpServer(200, "hello");
    cleanups.push(server.close);
    const port = await closedPort();

    const success = setup();
    await runProbeWithSpan(httpProbe(server.url), {
      logSuccess: false,
      location: "home",
    });
    expect(success.records).toHaveLength(0);

    const failure = setup();
    await runProbeWithSpan(httpProbe(`http://127.0.0.1:${port}/`), {
      logSuccess: false,
      location: "home",
    });
    expect(failure.records).toHaveLength(1);
    expect(failure.records[0].severityText).toBe("error");
  });
});
