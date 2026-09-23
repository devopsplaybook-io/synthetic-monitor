import { ProbeResult, ResolvedProbeConfig } from "./ProbeTypes";

export interface AlertConfig {
  NOTIFICATION_CONSECUTIVE_FAILURES: number;
  NOTIFICATION_REPEAT_AFTER_HOURS: number;
  PROBE_LOCATION?: string;
}

/** Structural subset of the shared NotificationsClient used by this service. */
export interface NotificationSender {
  isEnabled(): boolean;
  error(title: string, body?: string, source?: string): Promise<unknown>;
  info(title: string, body?: string, source?: string): Promise<unknown>;
}

interface ProbeAlertState {
  consecutiveFailures: number;
  alerting: boolean;
  alertSince?: number;
  lastNotificationAt?: number;
  lastErrorDetail?: string;
  lastSuccessTime?: number;
  lastFailureTime?: number;
}

const NOTIFICATION_SOURCE = "synthetic-monitor";

/**
 * Consecutive-failure alert state machine per probe:
 * - an `error` notification after N consecutive failures (flap suppression:
 *   fewer than N failures followed by a recovery stay silent),
 * - an `info` notification on recovery,
 * - repeat notifications while a probe keeps failing are suppressed for
 *   `NOTIFICATION_REPEAT_AFTER_HOURS` hours,
 * - everything is a no-op while the notifications integration is disabled
 *   (`NOTIFICATIONS_API` unset).
 */
export class AlertService {
  private states = new Map<string, ProbeAlertState>();
  private readonly failureThreshold: number;
  private readonly repeatWindowMs: number;
  private readonly location: string;

  constructor(
    config: AlertConfig,
    private readonly sender: NotificationSender,
    private readonly now: () => number = Date.now,
  ) {
    this.failureThreshold = Math.max(1, config.NOTIFICATION_CONSECUTIVE_FAILURES);
    this.repeatWindowMs = Math.max(0, config.NOTIFICATION_REPEAT_AFTER_HOURS) * 3600 * 1000;
    this.location = config.PROBE_LOCATION ?? "";
  }

  public async onResult(
    result: ProbeResult,
    probe?: ResolvedProbeConfig,
  ): Promise<void> {
    const state = this.states.get(result.probeName) ?? {
      consecutiveFailures: 0,
      alerting: false,
    };
    const failureThreshold = probe?.failureThreshold ?? this.failureThreshold;

    if (!result.success) {
      state.consecutiveFailures++;
      state.lastFailureTime = result.time;
      state.lastErrorDetail = result.errorDetail ?? result.errorCode;

      if (!state.alerting && state.consecutiveFailures >= failureThreshold) {
        state.alerting = true;
        state.alertSince = result.time;
        state.lastNotificationAt = this.now();
        await this.sendError(result.probeName, state, result, false, probe);
      } else if (
        state.alerting &&
        this.repeatWindowMs > 0 &&
        state.lastNotificationAt !== undefined &&
        this.now() - state.lastNotificationAt >= this.repeatWindowMs
      ) {
        state.lastNotificationAt = this.now();
        await this.sendError(result.probeName, state, result, true, probe);
      }
    } else {
      const wasAlerting = state.alerting;
      state.consecutiveFailures = 0;
      state.alerting = false;
      state.lastSuccessTime = result.time;
      if (wasAlerting) {
        await this.sendRecovery(result.probeName, state);
      }
    }

    this.states.set(result.probeName, state);
  }

  /**
   * Markdown digest of the current state of every known probe (for the
   * optional periodic digest notification).
   */
  public buildDigestBody(): string {
    const lines: string[] = ["## Synthetic monitoring digest", ""];
    lines.push("| Probe | State | Consecutive failures | Last error | Last success |", "| --- | --- | --- | --- | --- |");
    for (const [name, state] of this.states) {
      const stateText = state.alerting ? "failing" : "up";
      const lastError = state.lastErrorDetail ?? "-";
      const lastSuccess = state.lastSuccessTime
        ? new Date(state.lastSuccessTime).toISOString()
        : "-";
      lines.push(`| ${name} | ${stateText} | ${state.consecutiveFailures} | ${lastError.replace(/\|/g, "\\|")} | ${lastSuccess} |`);
    }
    lines.push("");
    return lines.join("\n");
  }

  public async sendDigest(): Promise<void> {
    if (!this.sender.isEnabled()) {
      return;
    }
    await this.sender.info(
      "Synthetic monitoring digest",
      this.buildDigestBody(),
      NOTIFICATION_SOURCE,
    );
  }

  private async sendError(
    probeName: string,
    state: ProbeAlertState,
    result: ProbeResult,
    isRepeat: boolean,
    probe?: ResolvedProbeConfig,
  ): Promise<void> {
    if (!this.sender.isEnabled()) {
      return;
    }
    const title = isRepeat
      ? `Probe ${probeName} is still failing`
      : `Probe ${probeName} is failing`;
    const location = probe ? this.location : "";
    const body = [
      `Probe \`${probeName}\` (type: ${result.probeType}) failed ${state.consecutiveFailures} consecutive time(s).`,
      probe
        ? `Target: \`${probe.target}\`${location ? ` (location: ${location})` : ""}`
        : "",
      `Error: ${result.errorCode ?? "unknown"}${result.errorDetail ? ` — ${result.errorDetail}` : ""}`,
      state.alertSince
        ? `Alerting since: ${new Date(state.alertSince).toISOString()}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    await this.sender.error(title, body, NOTIFICATION_SOURCE);
  }

  private async sendRecovery(
    probeName: string,
    state: ProbeAlertState,
  ): Promise<void> {
    if (!this.sender.isEnabled()) {
      return;
    }
    const downtimeMinutes =
      state.alertSince !== undefined
        ? Math.round((this.now() - state.alertSince) / 60000)
        : undefined;
    const body = [
      `Probe \`${probeName}\` is reporting success again.`,
      downtimeMinutes !== undefined
        ? `It was failing for about ${downtimeMinutes} minute(s).`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    await this.sender.info(
      `Probe ${probeName} recovered`,
      body,
      NOTIFICATION_SOURCE,
    );
  }
}
