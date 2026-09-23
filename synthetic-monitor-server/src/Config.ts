import { ConfigBase } from "@devopsplaybook.io/common-utils";
import { readFileSync } from "node:fs";
import path from "path";

export class Config extends ConfigBase {
  public PROBE_CONFIG_FILE = "probes.yaml";
  public PROBE_LOCATION = "";
  public PROBE_MAX_CONCURRENCY = 5;
  public PROBE_LOG_SUCCESS = true;
  public SELF_PROBE_ENABLED = true;
  public NOTIFICATION_CONSECUTIVE_FAILURES = 3;
  public NOTIFICATION_REPEAT_AFTER_HOURS = 4;
  public NOTIFICATION_DIGEST_SCHEDULE = "";
  public NOTIFICATIONS_API = "";
  public NOTIFICATIONS_TOKEN = "";

  constructor(configFile?: string) {
    super("synthetic-monitor", configFile);
    // ConfigBase resolves the version relative to its own compiled location
    // inside node_modules, which never finds the application package.json:
    // read it relative to this compiled file instead (dist/../package.json).
    try {
      const pkg = JSON.parse(
        readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
      );
      if (pkg && pkg.version) {
        this.VERSION = pkg.version;
      }
    } catch {
      // keep the ConfigBase default
    }
    this.addConfigField({ field: "PROBE_CONFIG_FILE" });
    this.addConfigField({ field: "PROBE_LOCATION" });
    this.addConfigField({ field: "PROBE_MAX_CONCURRENCY" });
    this.addConfigField({ field: "PROBE_LOG_SUCCESS" });
    this.addConfigField({ field: "SELF_PROBE_ENABLED" });
    this.addConfigField({ field: "NOTIFICATION_CONSECUTIVE_FAILURES" });
    this.addConfigField({ field: "NOTIFICATION_REPEAT_AFTER_HOURS" });
    this.addConfigField({ field: "NOTIFICATION_DIGEST_SCHEDULE" });
    this.addConfigField({ field: "NOTIFICATIONS_API" });
    this.addConfigField({ field: "NOTIFICATIONS_TOKEN", sensitive: true });
  }
}
