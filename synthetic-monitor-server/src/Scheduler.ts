import { PromisePool } from "./utils-std-ts/PromisePool";
import { ProbeResult, ResolvedProbeConfig } from "./ProbeTypes";

/**
 * Uniform random initial delay in [0, intervalMs) so probes started together
 * do not all fire on the same tick (staggered first run); the subsequent
 * ticks stay on the fixed per-probe interval.
 */
export function initialDelayMs(
  intervalMs: number,
  random = Math.random,
): number {
  return Math.floor(random() * intervalMs);
}

export interface SchedulerOptions {
  /** Maximum number of probes executed concurrently. */
  maxConcurrency: number;
  /** Runs one probe; injectable for tests. */
  execute: (probe: ResolvedProbeConfig) => Promise<ProbeResult>;
  /** Called for every completed probe run. */
  onResult: (result: ProbeResult) => void;
  log: (message: string) => void;
}

interface ProbeSchedule {
  probe: ResolvedProbeConfig;
  initialTimer: NodeJS.Timeout;
  intervalTimer: NodeJS.Timeout;
}

export class Scheduler {
  private schedules = new Map<string, ProbeSchedule>();
  private pool: PromisePool;
  private inFlight = 0;

  constructor(private readonly options: SchedulerOptions) {
    this.pool = new PromisePool(options.maxConcurrency);
  }

  public start(probes: ResolvedProbeConfig[]): void {
    for (const probe of probes) {
      this.scheduleProbe(probe);
    }
    this.options.log(`Scheduler started with ${probes.length} probe(s)`);
  }

  /**
   * Replace the scheduled probes (hot reload): timers of removed probes are
   * cleared and new or changed probes get a fresh staggered schedule.
   */
  public updateProbes(probes: ResolvedProbeConfig[]): void {
    const nextNames = new Set(probes.map((probe) => probe.name));
    for (const [name, schedule] of this.schedules) {
      if (!nextNames.has(name)) {
        clearTimeout(schedule.initialTimer);
        clearInterval(schedule.intervalTimer);
        this.schedules.delete(name);
      }
    }
    for (const probe of probes) {
      const existing = this.schedules.get(probe.name);
      if (existing && JSON.stringify(existing.probe) === JSON.stringify(probe)) {
        continue;
      }
      if (existing) {
        clearTimeout(existing.initialTimer);
        clearInterval(existing.intervalTimer);
      }
      this.scheduleProbe(probe);
    }
    this.options.log(`Scheduler now runs ${this.schedules.size} probe(s)`);
  }

  /**
   * Stop all timers and wait (bounded) for the in-flight probe executions.
   */
  public async stop(boundedWaitMs = 10000): Promise<void> {
    for (const schedule of this.schedules.values()) {
      clearTimeout(schedule.initialTimer);
      clearInterval(schedule.intervalTimer);
    }
    this.schedules.clear();
    const deadline = Date.now() + boundedWaitMs;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
    }
  }

  private scheduleProbe(probe: ResolvedProbeConfig): void {
    const intervalMs = probe.intervalSeconds * 1000;
    const run = () => {
      this.pool
        .add(async () => {
          // Count only executions that actually started, so stop() waits for
          // running probes instead of the whole pending queue.
          this.inFlight++;
          try {
            return await this.options.execute(probe);
          } finally {
            this.inFlight--;
          }
        })
        .then((result) => {
          if (result) {
            this.options.onResult(result);
          }
        })
        .catch((err) => {
          this.options.log(
            `Probe ${probe.name} execution failed: ${err instanceof Error ? err.message : err}`,
          );
        });
    };
    const initialTimer = setTimeout(run, initialDelayMs(intervalMs));
    const intervalTimer = setInterval(run, intervalMs);
    this.schedules.set(probe.name, { probe, initialTimer, intervalTimer });
  }
}
