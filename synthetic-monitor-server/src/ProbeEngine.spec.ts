import * as net from "node:net";
import { probeDns, probeHttp, probeTcp, probeTls } from "./ProbeEngine";
import { ResolvedProbeConfig } from "./ProbeTypes";

function httpProbe(overrides: Partial<ResolvedProbeConfig> = {}): ResolvedProbeConfig {
  return {
    name: "web",
    type: "http",
    target: "http://localhost:8080/",
    intervalSeconds: 30,
    timeoutSeconds: 5,
    method: "GET",
    headers: {},
    ...overrides,
  };
}

function fakeResponse(
  status: number,
  body: string,
): Response {
  return {
    status,
    text: async () => body,
  } as unknown as Response;
}

describe("probeHttp", () => {
  it("reports success with status code and duration", async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeResponse(200, "all good"));
    const result = await probeHttp(httpProbe(), { fetch: fetchMock });
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.errorCode).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("sends configured method, headers and body", async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeResponse(200, ""));
    await probeHttp(
      httpProbe({
        method: "POST",
        headers: { Authorization: "Bearer x" },
        body: '{"a":1}',
      }),
      { fetch: fetchMock },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer x" },
        body: '{"a":1}',
      }),
    );
  });

  it("reports status_mismatch when the status does not match", async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeResponse(500, "oops"));
    const result = await probeHttp(
      httpProbe({ expect: { statusCode: 200 } }),
      { fetch: fetchMock },
    );
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("status_mismatch");
    expect(result.statusCode).toBe(500);
  });

  it("reports body_mismatch when the body does not contain the expected text", async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeResponse(200, "nothing here"));
    const result = await probeHttp(
      httpProbe({ expect: { bodyContains: "OK" } }),
      { fetch: fetchMock },
    );
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("body_mismatch");
    expect(result.statusCode).toBe(200);
  });

  it("reports timeout when maxDurationMs is exceeded", async () => {
    const fetchMock = jest.fn().mockImplementation(async () => {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 80));
      return fakeResponse(200, "");
    });
    const result = await probeHttp(
      httpProbe({ expect: { maxDurationMs: 10 } }),
      { fetch: fetchMock },
    );
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("timeout");
    expect(result.durationMs).toBeGreaterThanOrEqual(10);
  });

  it("reports timeout when the request is aborted", async () => {
    const fetchMock = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const abortError = new Error("The operation was aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        }),
    );
    const result = await probeHttp(httpProbe({ timeoutSeconds: 0.05 }), {
      fetch: fetchMock,
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("timeout");
  });

  it.each([
    ["ENOTFOUND", "dns_error"],
    ["EAI_AGAIN", "dns_error"],
    ["ECONNREFUSED", "connect_refused"],
    ["CERT_HAS_EXPIRED", "tls_error"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_error"],
    ["ECONNRESET", "unknown"],
  ])("classifies cause code %s as %s", async (code, expected) => {
    const fetchError = new Error("fetch failed");
    (fetchError as unknown as { cause: unknown }).cause = { code };
    const fetchMock = jest.fn().mockRejectedValue(fetchError);
    const result = await probeHttp(httpProbe(), { fetch: fetchMock });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(expected);
    expect(result.statusCode).toBeUndefined();
  });
});

describe("probeTcp", () => {
  function tcpProbe(overrides: Partial<ResolvedProbeConfig> = {}): ResolvedProbeConfig {
    return {
      name: "db",
      type: "tcp",
      target: "127.0.0.1:1",
      intervalSeconds: 30,
      timeoutSeconds: 5,
      method: "GET",
      headers: {},
      ...overrides,
    };
  }

  it("succeeds against a listening port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address() as net.AddressInfo;
    const result = await probeTcp(tcpProbe({ target: `127.0.0.1:${address.port}` }));
    expect(result.success).toBe(true);
    expect(result.errorCode).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it("reports connect_refused against a closed port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    const result = await probeTcp(tcpProbe({ target: `127.0.0.1:${port}` }));
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("connect_refused");
  });

  it("reports timeout when the socket is idle for too long", async () => {
    const { EventEmitter } = await import("node:events");
    const fakeSocket = new EventEmitter() as unknown as net.Socket;
    (fakeSocket as unknown as { setTimeout: unknown }).setTimeout = () => fakeSocket;
    (fakeSocket as unknown as { destroy: unknown }).destroy = () => {};
    (fakeSocket as unknown as { connect: unknown }).connect = () => {};
    const pending = probeTcp(tcpProbe({ timeoutSeconds: 0.05 }), {
      createSocket: () => fakeSocket,
    });
    // The engine arms socket.setTimeout(timeoutMs); with the fake socket the
    // engine timeout is exercised by emitting the timeout event.
    fakeSocket.emit("timeout");
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("timeout");
  });

  it("classifies socket errors", async () => {
    const { EventEmitter } = await import("node:events");
    const fakeSocket = new EventEmitter() as unknown as net.Socket;
    (fakeSocket as unknown as { setTimeout: unknown }).setTimeout = () => fakeSocket;
    (fakeSocket as unknown as { destroy: unknown }).destroy = () => {};
    (fakeSocket as unknown as { connect: unknown }).connect = () => {};
    const pending = probeTcp(tcpProbe(), { createSocket: () => fakeSocket });
    fakeSocket.emit(
      "error",
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("connect_refused");
  });
});

describe("probeDns", () => {
  it("succeeds when the name resolves", async () => {
    const result = await probeDns(
      { name: "dns", type: "dns", target: "example.com", intervalSeconds: 30, timeoutSeconds: 5, method: "GET", headers: {} },
      { resolve: async () => ["93.184.216.34"] },
    );
    expect(result.success).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it("reports dns_error on resolution failure", async () => {
    const result = await probeDns(
      { name: "dns", type: "dns", target: "missing.example", intervalSeconds: 30, timeoutSeconds: 5, method: "GET", headers: {} },
      {
        resolve: async () => {
          const err = new Error("queryA ENOTFOUND missing.example");
          (err as unknown as { code: string }).code = "ENOTFOUND";
          throw err;
        },
      },
    );
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("dns_error");
  });

  it("reports timeout when the resolver times out", async () => {
    const result = await probeDns(
      { name: "dns", type: "dns", target: "slow.example", intervalSeconds: 30, timeoutSeconds: 5, method: "GET", headers: {} },
      {
        resolve: async () => {
          const err = new Error("resolution timed out");
          (err as unknown as { code: string }).code = "ETIMEDOUT";
          throw err;
        },
      },
    );
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("timeout");
  });
});

describe("probeTls", () => {
  it("reports success with the certificate remaining days", async () => {
    const { EventEmitter } = await import("node:events");
    const fakeSocket = new EventEmitter() as unknown as net.Socket;
    (fakeSocket as unknown as { destroy: unknown }).destroy = () => {};
    (fakeSocket as unknown as { getPeerCertificate: unknown }).getPeerCertificate =
      () => ({ valid_to: new Date(Date.now() + 30 * 86400000) });
    const pending = probeTls(
      { name: "tls", type: "tls", target: "example.com:443", intervalSeconds: 30, timeoutSeconds: 5, method: "GET", headers: {} },
      { connect: () => fakeSocket as never },
    );
    fakeSocket.emit("secureConnect");
    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.certRemainingDays).toBe(30);
  });

  it("reports tls_error on certificate errors", async () => {
    const { EventEmitter } = await import("node:events");
    const fakeSocket = new EventEmitter() as unknown as net.Socket;
    (fakeSocket as unknown as { destroy: unknown }).destroy = () => {};
    const pending = probeTls(
      { name: "tls", type: "tls", target: "example.com:443", intervalSeconds: 30, timeoutSeconds: 5, method: "GET", headers: {} },
      { connect: () => fakeSocket as never },
    );
    fakeSocket.emit(
      "error",
      Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
    );
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("tls_error");
  });

  it("reports timeout when the handshake does not complete", async () => {
    const { EventEmitter } = await import("node:events");
    const fakeSocket = new EventEmitter() as unknown as net.Socket;
    (fakeSocket as unknown as { destroy: unknown }).destroy = () => {};
    jest.useFakeTimers();
    try {
      const pending = probeTls(
        { name: "tls", type: "tls", target: "example.com:443", intervalSeconds: 30, timeoutSeconds: 5, method: "GET", headers: {} },
        { connect: () => fakeSocket as never },
      );
      jest.advanceTimersByTime(6000);
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("timeout");
    } finally {
      jest.useRealTimers();
    }
  });
});
