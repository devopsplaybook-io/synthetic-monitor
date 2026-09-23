import { AlertService, NotificationSender } from "./AlertService";
import { ProbeResult, ResolvedProbeConfig } from "./ProbeTypes";

function probeConfig(
  overrides: Partial<ResolvedProbeConfig> = {},
): ResolvedProbeConfig {
  return {
    name: "web",
    type: "http",
    target: "https://example.com/health",
    intervalSeconds: 600,
    timeoutSeconds: 5,
    method: "GET",
    headers: {},
    ...overrides,
  };
}

interface SentNotification {
  severity: "error" | "info";
  title: string;
  body: string;
}

function fakeSender(enabled = true): {
  sender: NotificationSender;
  sent: SentNotification[];
} {
  const sent: SentNotification[] = [];
  const sender: NotificationSender = {
    isEnabled: () => enabled,
    error: async (title: string, body?: string) => {
      sent.push({ severity: "error", title, body: body ?? "" });
      return null;
    },
    info: async (title: string, body?: string) => {
      sent.push({ severity: "info", title, body: body ?? "" });
      return null;
    },
  };
  return { sender, sent };
}

function failingResult(probeName = "web", time = Date.now()): ProbeResult {
  return {
    probeName,
    probeType: "http",
    success: false,
    durationMs: 100,
    errorCode: "connect_refused",
    errorDetail: "connect ECONNREFUSED",
    time,
  };
}

function successResult(probeName = "web", time = Date.now()): ProbeResult {
  return {
    probeName,
    probeType: "http",
    success: true,
    durationMs: 20,
    statusCode: 200,
    time,
  };
}

const alertConfig = {
  NOTIFICATION_CONSECUTIVE_FAILURES: 3,
  NOTIFICATION_REPEAT_AFTER_HOURS: 4,
};

describe("AlertService", () => {
  it("sends an error notification only after the failure threshold", async () => {
    const { sender, sent } = fakeSender();
    const alertService = new AlertService(alertConfig, sender);

    await alertService.onResult(failingResult());
    await alertService.onResult(failingResult());
    expect(sent).toHaveLength(0);

    await alertService.onResult(failingResult());
    expect(sent).toHaveLength(1);
    expect(sent[0].severity).toBe("error");
    expect(sent[0].title).toBe("Probe web is failing");
    expect(sent[0].body).toMatch(/3 consecutive time\(s\)/);
    expect(sent[0].body).toMatch(/connect_refused/);
  });

  it("sends an info notification on recovery after an alert", async () => {
    const { sender, sent } = fakeSender();
    const alertService = new AlertService(alertConfig, sender);

    for (let i = 0; i < 3; i++) {
      await alertService.onResult(failingResult());
    }
    await alertService.onResult(successResult());
    expect(sent).toHaveLength(2);
    expect(sent[1].severity).toBe("info");
    expect(sent[1].title).toBe("Probe web recovered");
  });

  it("stays silent on flap: fewer than threshold failures then recovery", async () => {
    const { sender, sent } = fakeSender();
    const alertService = new AlertService(alertConfig, sender);

    await alertService.onResult(failingResult());
    await alertService.onResult(failingResult());
    await alertService.onResult(successResult());
    await alertService.onResult(failingResult());
    await alertService.onResult(failingResult());
    expect(sent).toHaveLength(0);
  });

  it("re-notifies only after the repeat window has elapsed", async () => {
    let nowMs = 1_000_000;
    const { sender, sent } = fakeSender();
    const alertService = new AlertService(alertConfig, sender, () => nowMs);

    for (let i = 0; i < 3; i++) {
      await alertService.onResult(failingResult());
    }
    expect(sent).toHaveLength(1);

    // Still within the 4h repeat window.
    nowMs += 3 * 3600 * 1000;
    for (let i = 0; i < 5; i++) {
      await alertService.onResult(failingResult());
    }
    expect(sent).toHaveLength(1);

    // After 4 hours a repeat notification is sent.
    nowMs += 1.5 * 3600 * 1000;
    await alertService.onResult(failingResult());
    expect(sent).toHaveLength(2);
    expect(sent[1].title).toBe("Probe web is still failing");
  });

  it("is a no-op when the notifications integration is disabled", async () => {
    const { sender, sent } = fakeSender(false);
    const alertService = new AlertService(alertConfig, sender);

    for (let i = 0; i < 5; i++) {
      await alertService.onResult(failingResult());
    }
    await alertService.onResult(successResult());
    await alertService.sendDigest();
    expect(sent).toHaveLength(0);
  });

  it("uses the per-probe failure threshold when the probe defines one", async () => {
    const { sender, sent } = fakeSender();
    const alertService = new AlertService(alertConfig, sender);
    const probe = probeConfig({ failureThreshold: 1 });

    await alertService.onResult(failingResult("external"), probe);
    expect(sent).toHaveLength(1);
    expect(sent[0].severity).toBe("error");
    expect(sent[0].body).toMatch(/1 consecutive time\(s\)/);

    // A probe without an override keeps the global threshold.
    const { sender: sender2, sent: sent2 } = fakeSender();
    const alertService2 = new AlertService(alertConfig, sender2);
    await alertService2.onResult(failingResult("internal"), probeConfig());
    expect(sent2).toHaveLength(0);
  });

  it("includes type, target and location in the failure body", async () => {
    const { sender, sent } = fakeSender();
    const alertService = new AlertService(
      { ...alertConfig, PROBE_LOCATION: "home" },
      sender,
    );

    for (let i = 0; i < 3; i++) {
      await alertService.onResult(
        failingResult("web"),
        probeConfig({ failureThreshold: 3 }),
      );
    }

    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("https://example.com/health");
    expect(sent[0].body).toContain("location: home");
  });

  it("tracks probes independently", async () => {
    const { sender, sent } = fakeSender();
    const alertService = new AlertService(alertConfig, sender);

    await alertService.onResult(failingResult("a"));
    await alertService.onResult(failingResult("b"));
    await alertService.onResult(failingResult("a"));
    await alertService.onResult(failingResult("b"));
    await alertService.onResult(failingResult("a"));
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe("Probe a is failing");
  });

  it("builds a Markdown digest of the current states", async () => {
    const { sender, sent } = fakeSender();
    const alertService = new AlertService(alertConfig, sender);

    for (let i = 0; i < 3; i++) {
      await alertService.onResult(failingResult("web"));
    }
    await alertService.onResult(successResult("db"));

    await alertService.sendDigest();
    expect(sent).toHaveLength(2);
    expect(sent[1].severity).toBe("info");
    expect(sent[1].title).toBe("Synthetic monitoring digest");
    expect(sent[1].body).toContain("| web | failing | 3 |");
    expect(sent[1].body).toContain("| db | up | 0 |");
  });
});
