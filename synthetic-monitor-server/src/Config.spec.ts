import { Config } from "./Config";

const missingConfigFile = "/nonexistent/config.json";

describe("Config", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    delete process.env.PROBE_CONFIG_FILE;
    delete process.env.PROBE_LOCATION;
    delete process.env.PROBE_MAX_CONCURRENCY;
    delete process.env.PROBE_LOG_SUCCESS;
    delete process.env.SELF_PROBE_ENABLED;
    delete process.env.NOTIFICATION_CONSECUTIVE_FAILURES;
    delete process.env.NOTIFICATION_REPEAT_AFTER_HOURS;
    delete process.env.NOTIFICATION_DIGEST_SCHEDULE;
    delete process.env.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER;
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("exposes the service identity and defaults", async () => {
    const config = new Config(missingConfigFile);
    await config.reload();
    expect(config.SERVICE_ID).toBe("synthetic-monitor");
    expect(config.PROBE_CONFIG_FILE).toBe("probes.yaml");
    expect(config.PROBE_LOCATION).toBe("");
    expect(config.PROBE_MAX_CONCURRENCY).toBe(5);
    expect(config.PROBE_LOG_SUCCESS).toBe(true);
    expect(config.SELF_PROBE_ENABLED).toBe(true);
    expect(config.NOTIFICATION_CONSECUTIVE_FAILURES).toBe(3);
    expect(config.NOTIFICATION_REPEAT_AFTER_HOURS).toBe(4);
    expect(config.NOTIFICATION_DIGEST_SCHEDULE).toBe("");
    expect(config.VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("gives environment variables precedence over defaults", async () => {
    process.env.PROBE_MAX_CONCURRENCY = "12";
    process.env.PROBE_LOG_SUCCESS = "false";
    process.env.SELF_PROBE_ENABLED = "false";
    process.env.PROBE_LOCATION = "home-cluster";
    process.env.NOTIFICATION_CONSECUTIVE_FAILURES = "5";

    const config = new Config(missingConfigFile);
    await config.reload();
    expect(config.PROBE_MAX_CONCURRENCY).toBe(12);
    expect(config.PROBE_LOG_SUCCESS).toBe(false);
    expect(config.SELF_PROBE_ENABLED).toBe(false);
    expect(config.PROBE_LOCATION).toBe("home-cluster");
    expect(config.NOTIFICATION_CONSECUTIVE_FAILURES).toBe(5);
  });

  it("reads values from the config file when the env var is unset", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-"));
    const configFile = path.join(dir, "config.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({ PROBE_MAX_CONCURRENCY: 7, PROBE_LOCATION: "edge" }),
    );
    try {
      const config = new Config(configFile);
      await config.reload();
      expect(config.PROBE_MAX_CONCURRENCY).toBe(7);
      expect(config.PROBE_LOCATION).toBe("edge");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("masks sensitive values in the reload log", async () => {
    process.env.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER = "secret-token";
    const config = new Config(missingConfigFile);
    const messages: string[] = [];
    await config.reload((message) => messages.push(message));

    const sensitiveLine = messages.find((message) =>
      message.includes("OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER"),
    );
    expect(sensitiveLine).toBeDefined();
    expect(sensitiveLine).not.toContain("secret-token");
    expect(sensitiveLine).toContain("********************");
  });
});
