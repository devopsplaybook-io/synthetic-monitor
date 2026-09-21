import { ProbeResult, ResolvedProbeConfig } from "./ProbeTypes";
import { initialDelayMs, Scheduler } from "./Scheduler";

function probe(
  name: string,
  intervalSeconds: number,
  overrides: Partial<ResolvedProbeConfig> = {},
): ResolvedProbeConfig {
  return {
    name,
    type: "http",
    target: `http://localhost/${name}`,
    intervalSeconds,
    timeoutSeconds: 5,
    method: "GET",
    headers: {},
    ...overrides,
  };
}

function result(probeName: string): ProbeResult {
  return {
    probeName,
    probeType: "http",
    success: true,
    durationMs: 10,
    time: Date.now(),
  };
}

const sleep = (ms: number) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

describe("initialDelayMs", () => {
  it("stays within [0, intervalMs)", () => {
    for (let i = 0; i < 200; i++) {
      const delay = initialDelayMs(10000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(10000);
    }
  });

  it("uses the injected random source", () => {
    expect(initialDelayMs(1000, () => 0.5)).toBe(500);
  });
});

describe("Scheduler", () => {
  it("executes probes on their own per-probe interval", async () => {
    const executions: string[] = [];
    const scheduler = new Scheduler({
      maxConcurrency: 5,
      execute: async (p) => {
        executions.push(p.name);
        return result(p.name);
      },
      onResult: () => {},
      log: () => {},
    });
    scheduler.start([probe("a", 0.05), probe("b", 0.1)]);

    await sleep(120);
    expect(executions).toContain("a");
    expect(executions).toContain("b");

    const countA = executions.filter((name) => name === "a").length;
    await sleep(120);
    expect(
      executions.filter((name) => name === "a").length,
    ).toBeGreaterThan(countA);
    await scheduler.stop();
  });

  it("calls onResult for each completed run", async () => {
    const results: string[] = [];
    const scheduler = new Scheduler({
      maxConcurrency: 5,
      execute: async (p) => result(p.name),
      onResult: (r) => results.push(r.probeName),
      log: () => {},
    });
    scheduler.start([probe("a", 0.05)]);
    await sleep(120);
    await scheduler.stop();
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((name) => name === "a")).toBe(true);
  });

  it("enforces the concurrency cap", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const scheduler = new Scheduler({
      maxConcurrency: 2,
      execute: async (p) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(50);
        concurrent--;
        return result(p.name);
      },
      onResult: () => {},
      log: () => {},
    });
    const manyProbes = Array.from({ length: 4 }, (_v, i) =>
      probe(`p${i}`, 0.2),
    );
    scheduler.start(manyProbes);
    await sleep(600);
    await scheduler.stop();
    expect(maxConcurrent).toBe(2);
  }, 10000);

  it("hot reload: removed probes stop running, changed probes are rescheduled", async () => {
    const executions: string[] = [];
    const scheduler = new Scheduler({
      maxConcurrency: 5,
      execute: async (p) => {
        executions.push(p.name);
        return result(p.name);
      },
      onResult: () => {},
      log: () => {},
    });
    scheduler.start([probe("keep", 0.05), probe("drop", 0.05)]);
    await sleep(120);
    expect(executions).toContain("drop");

    const dropCountBefore = executions.filter((name) => name === "drop").length;
    scheduler.updateProbes([probe("keep", 0.05), probe("new", 0.05)]);
    await sleep(250);
    await scheduler.stop();

    expect(executions.filter((name) => name === "new").length).toBeGreaterThanOrEqual(1);
    expect(executions.filter((name) => name === "drop").length).toBe(
      dropCountBefore,
    );
  });

  it("stop() clears timers so no further executions happen", async () => {
    const executions: string[] = [];
    const scheduler = new Scheduler({
      maxConcurrency: 5,
      execute: async (p) => {
        executions.push(p.name);
        return result(p.name);
      },
      onResult: () => {},
      log: () => {},
    });
    scheduler.start([probe("a", 0.05)]);
    await sleep(120);
    await scheduler.stop();
    const count = executions.length;
    await sleep(250);
    expect(executions.length).toBe(count);
  });
});
