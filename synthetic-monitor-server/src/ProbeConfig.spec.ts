import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProbeConfig, withSelfProbe } from "./ProbeConfig";
import { ResolvedProbeConfig } from "./ProbeTypes";

const VALID_YAML = `
probes:
  - name: web
    type: http
    target: http://localhost:8080/
    expect:
      statusCode: 200
  - name: db
    type: tcp
    target: localhost:5432
    intervalSeconds: 60
    timeoutSeconds: 10
`;

function writeConfigFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-config-"));
  const filePath = path.join(dir, "probes.yaml");
  fs.writeFileSync(filePath, content);
  return filePath;
}

function cleanup(filePath: string): void {
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
}

describe("ProbeConfig", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("applies defaults for interval and timeout", async () => {
    const filePath = writeConfigFile(VALID_YAML);
    try {
      const probeConfig = new ProbeConfig(filePath);
      await probeConfig.load();
      const probes = probeConfig.getProbes();
      expect(probes).toHaveLength(2);
      expect(probes[0]).toMatchObject({
        name: "web",
        type: "http",
        intervalSeconds: 30,
        timeoutSeconds: 5,
        method: "GET",
        headers: {},
      });
      expect(probes[1]).toMatchObject({
        name: "db",
        intervalSeconds: 60,
        timeoutSeconds: 10,
      });
    } finally {
      cleanup(filePath);
    }
  });

  it("interpolates ${ENV} variables in targets and headers", async () => {
    process.env.TEST_PROBE_SECRET = "s3cr3t";
    const filePath = writeConfigFile(`
probes:
  - name: auth
    type: http
    target: http://${"localhost"}:8080/
    headers:
      Authorization: "Bearer \${TEST_PROBE_SECRET}"
`);
    try {
      const probeConfig = new ProbeConfig(filePath);
      await probeConfig.load();
      expect(probeConfig.getProbes()[0].headers.Authorization).toBe(
        "Bearer s3cr3t",
      );
    } finally {
      cleanup(filePath);
      delete process.env.TEST_PROBE_SECRET;
    }
  });

  it("rejects a configuration with an unresolved environment variable", async () => {
    delete process.env.TEST_PROBE_MISSING_SECRET;
    const filePath = writeConfigFile(`
probes:
  - name: auth
    type: http
    target: http://localhost:8080/
    headers:
      Authorization: "Bearer \${TEST_PROBE_MISSING_SECRET}"
`);
    try {
      const probeConfig = new ProbeConfig(filePath);
      await expect(probeConfig.load()).rejects.toThrow(
        /Unresolved environment variable.*TEST_PROBE_MISSING_SECRET/,
      );
    } finally {
      cleanup(filePath);
    }
  });

  it("keeps last known good config when a reload parses invalid YAML", async () => {
    const filePath = writeConfigFile(VALID_YAML);
    try {
      const probeConfig = new ProbeConfig(filePath);
      await probeConfig.load();
      expect(probeConfig.getProbes()).toHaveLength(2);

      fs.writeFileSync(filePath, "probes: [ { name: broken, ");
      const messages: string[] = [];
      const changed = await probeConfig.reloadKeepingLastKnownGood((m) =>
        messages.push(m),
      );

      expect(changed).toBe(false);
      expect(probeConfig.getProbes()).toHaveLength(2);
      expect(messages[0]).toMatch(/keeping last known good config/);
    } finally {
      cleanup(filePath);
    }
  });

  it("keeps last known good config when a reload fails validation", async () => {
    const filePath = writeConfigFile(VALID_YAML);
    try {
      const probeConfig = new ProbeConfig(filePath);
      await probeConfig.load();

      fs.writeFileSync(
        filePath,
        `
probes:
  - name: web
    type: http
    target: http://localhost:8080/
    timeoutSeconds: 60
    intervalSeconds: 30
`,
      );
      const changed = await probeConfig.reloadKeepingLastKnownGood(() => {});

      expect(changed).toBe(false);
      expect(probeConfig.getProbes()[0].timeoutSeconds).toBe(5);
    } finally {
      cleanup(filePath);
    }
  });

  it.each([
    [
      "duplicate names",
      `
probes:
  - name: same
    type: http
    target: http://a/
  - name: same
    type: tcp
    target: b:1
`,
      /Duplicate probe name: same/,
    ],
    [
      "missing type",
      `
probes:
  - name: no-type
    target: http://a/
`,
      /type must be one of/,
    ],
    [
      "missing target",
      `
probes:
  - name: no-target
    type: http
`,
      /non-empty target is required/,
    ],
    [
      "timeout greater than interval",
      `
probes:
  - name: slow
    type: http
    target: http://a/
    intervalSeconds: 5
    timeoutSeconds: 10
`,
      /must be lower than intervalSeconds/,
    ],
    [
      "invalid http URL",
      `
probes:
  - name: bad-url
    type: http
    target: not a url
`,
      /not a valid URL/,
    ],
    [
      "invalid host:port",
      `
probes:
  - name: bad-port
    type: tcp
    target: localhost:notaport
`,
      /port must be an integer/,
    ],
    [
      "unsupported probe type",
      `
probes:
  - name: icmp
    type: icmp
    target: localhost
`,
      /type must be one of/,
    ],
    [
      "expect.statusCode on a tcp probe",
      `
probes:
  - name: tcp-expect
    type: tcp
    target: localhost:5432
    expect:
      statusCode: 200
`,
      /only supported for http probes/,
    ],
    [
      "body on a GET probe",
      `
probes:
  - name: get-body
    type: http
    target: http://a/
    body: hello
`,
      /body is only supported/,
    ],
  ])("rejects invalid config: %s", async (_label, yaml, expectedError) => {
    const filePath = writeConfigFile(yaml);
    try {
      const probeConfig = new ProbeConfig(filePath);
      await expect(probeConfig.load()).rejects.toThrow(expectedError);
    } finally {
      cleanup(filePath);
    }
  });

  it("allows body on a POST probe", async () => {
    const filePath = writeConfigFile(`
probes:
  - name: post-api
    type: http
    target: http://a/refresh
    method: POST
    body: '{"force": true}'
`);
    try {
      const probeConfig = new ProbeConfig(filePath);
      await probeConfig.load();
      expect(probeConfig.getProbes()[0].body).toBe('{"force": true}');
    } finally {
      cleanup(filePath);
    }
  });
});

describe("withSelfProbe", () => {
  const existingProbe: ResolvedProbeConfig = {
    name: "web",
    type: "http",
    target: "http://elsewhere/",
    intervalSeconds: 30,
    timeoutSeconds: 5,
    method: "GET",
    headers: {},
  };

  it("prepends a self-probe against the otel-light origin when enabled", () => {
    const probes = withSelfProbe(
      {
        SELF_PROBE_ENABLED: true,
        OPENTELEMETRY_COLLECTOR_HTTP_METRICS: "http://otel-light:8080/v1/metrics",
      },
      [existingProbe],
    );
    expect(probes).toHaveLength(2);
    expect(probes[0]).toMatchObject({
      name: "otel-light-self",
      type: "http",
      target: "http://otel-light:8080/",
      expect: { statusCode: 200 },
    });
  });

  it("does nothing when disabled or no metrics endpoint is set", () => {
    expect(
      withSelfProbe(
        { SELF_PROBE_ENABLED: false, OPENTELEMETRY_COLLECTOR_HTTP_METRICS: "http://otel-light:8080/v1/metrics" },
        [existingProbe],
      ),
    ).toHaveLength(1);
    expect(
      withSelfProbe({ SELF_PROBE_ENABLED: true, OPENTELEMETRY_COLLECTOR_HTTP_METRICS: "" }, [
        existingProbe,
      ]),
    ).toHaveLength(1);
  });

  it("does not duplicate an existing user-defined self probe", () => {
    const probes = withSelfProbe(
      {
        SELF_PROBE_ENABLED: true,
        OPENTELEMETRY_COLLECTOR_HTTP_METRICS: "http://otel-light:8080/v1/metrics",
      },
      [{ ...existingProbe, name: "otel-light-self" }],
    );
    expect(probes).toHaveLength(1);
    expect(probes[0].target).toBe("http://elsewhere/");
  });
});
