import { NotificationsClient } from "@devopsplaybook.io/common-utils";
import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import "dotenv/config";
import { watchFile } from "node:fs";
import * as cron from "node-cron";
import { AlertService } from "./AlertService";
import { Config } from "./Config";
import { MetricsInit, pruneProbeResults, recordProbeResult } from "./Metrics";
import {
  OTelLogger,
  OTelMeter,
  OTelSetMeter,
  OTelSetTracer,
  OTelTracer,
} from "./OTelContext";
import { ProbeConfig, withSelfProbe } from "./ProbeConfig";
import { ProbeRunnerOptions, runProbeWithSpan } from "./ProbeRunner";
import { ProbeResult, ResolvedProbeConfig } from "./ProbeTypes";
import { Scheduler } from "./Scheduler";

const logger = OTelLogger().createModuleLogger("app");

async function shutdownOtel(): Promise<void> {
  // otel-utils 1.3.0+ exposes forceFlush/shutdown; feature-detect so this also
  // runs against 1.2.x where the final flush relies on the export intervals.
  const otelClients = [OTelMeter(), OTelLogger(), OTelTracer()].filter(
    Boolean,
  ) as Array<{
    forceFlush?: () => Promise<void>;
    shutdown?: () => Promise<void>;
  }>;
  for (const client of otelClients) {
    try {
      if (typeof client.forceFlush === "function") {
        await client.forceFlush();
      }
      if (typeof client.shutdown === "function") {
        await client.shutdown();
      }
    } catch (err) {
      logger.error(
        "Error while flushing OpenTelemetry exporters on shutdown",
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }
}

logger.info("====== Starting Synthetic Monitor ======");

Promise.resolve()
  .then(async () => {
    const config = new Config();
    await config.reload((message) => logger.info(message));
    watchFile(config.CONFIG_FILE, () => {
      logger.info(`Config updated: ${config.CONFIG_FILE}`);
      config.reload((message) => logger.info(message));
    });

    OTelSetTracer(new StandardTracer(config));
    OTelSetMeter(new StandardMeter(config));
    OTelLogger().initOTel(config);

    const probeConfig = new ProbeConfig(config.PROBE_CONFIG_FILE);
    await probeConfig.load();
    const probes = withSelfProbe(config, probeConfig.getProbes());
    logger.info(
      `Loaded ${probes.length} probe(s) from ${config.PROBE_CONFIG_FILE}: ${probes.map((probe) => probe.name).join(", ")}`,
    );

    MetricsInit(config);

    const notificationClient = new NotificationsClient({
      apiEndpoint: config.NOTIFICATIONS_API,
      apiToken: config.NOTIFICATIONS_TOKEN,
      logger: OTelLogger().createModuleLogger("notifications"),
    });
    const alertService = new AlertService(config, notificationClient);

    const handleResult = (result: ProbeResult, probe: ResolvedProbeConfig): void => {
      recordProbeResult(result);
      alertService
        .onResult(result, probe)
        .catch((err) =>
          logger.error(
            "Unexpected error while evaluating alert state",
            err instanceof Error ? err : new Error(String(err)),
          ),
        );
    };

    const probeRunnerOptions: ProbeRunnerOptions = {
      logSuccess: config.PROBE_LOG_SUCCESS,
      location: config.PROBE_LOCATION,
    };
    const scheduler = new Scheduler({
      maxConcurrency: config.PROBE_MAX_CONCURRENCY,
      execute: (probe) => runProbeWithSpan(probe, probeRunnerOptions),
      onResult: handleResult,
      log: (message) => logger.info(message),
    });

    scheduler.start(probes);

    let reloading = false;
    watchFile(config.PROBE_CONFIG_FILE, { interval: 5000 }, () => {
      if (reloading) {
        return;
      }
      reloading = true;
      probeConfig
        .reloadKeepingLastKnownGood((message) => logger.info(message))
        .then((changed) => {
          if (changed) {
            const nextProbes = withSelfProbe(config, probeConfig.getProbes());
            scheduler.updateProbes(nextProbes);
            pruneProbeResults(
              new Set(nextProbes.map((probe) => probe.name)),
            );
            logger.info(
              `Probe configuration reloaded: ${nextProbes.length} probe(s) now scheduled`,
            );
          }
        })
        .finally(() => {
          reloading = false;
        });
    });

    if (config.NOTIFICATION_DIGEST_SCHEDULE) {
      if (cron.validate(config.NOTIFICATION_DIGEST_SCHEDULE)) {
        const digestTask = cron.schedule(
          config.NOTIFICATION_DIGEST_SCHEDULE,
          async () => {
            logger.info("Cron triggered: sending synthetic monitoring digest");
            try {
              await alertService.sendDigest();
            } catch (err) {
              logger.error(
                "Unexpected error while sending the digest notification",
                err instanceof Error ? err : new Error(String(err)),
              );
            }
          },
          { timezone: "UTC" },
        );
        digestTask.start();
        logger.info(
          `Digest notification scheduled with cron: ${config.NOTIFICATION_DIGEST_SCHEDULE} (UTC)`,
        );
      } else {
        logger.error(
          `Invalid NOTIFICATION_DIGEST_SCHEDULE cron expression: ${config.NOTIFICATION_DIGEST_SCHEDULE}, digest disabled`,
        );
      }
    }

    let shuttingDown = false;
    const gracefulShutdown = (signal: string) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      logger.info(`Received ${signal}, shutting down gracefully`);
      scheduler
        .stop()
        .then(shutdownOtel)
        .then(() => {
          logger.info("Shutdown complete");
          process.exit(0);
        })
        .catch((err) => {
          logger.error(
            "Unexpected error during shutdown",
            err instanceof Error ? err : new Error(String(err)),
          );
          process.exit(1);
        });
    };
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  })
  .catch((err) => {
    logger.error(
      "Fatal error during startup",
      err instanceof Error ? err : new Error(String(err)),
    );
    process.exit(1);
  });
