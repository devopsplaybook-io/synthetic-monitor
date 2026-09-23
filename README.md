# synthetic-monitor

Headless synthetic monitoring prober for the devopsplaybook.io ecosystem: it periodically probes configured endpoints (is the application up and running?) and emits the results as OpenTelemetry metrics and logs to [otel-light](https://github.com/devopsplaybook-io/otel-light), which visualizes the signals. No UI of its own, no database — every probe is fully configured via a YAML file mounted from a Kubernetes ConfigMap.

Sibling of [cloudcost](https://github.com/devopsplaybook-io/cloudcost): headless Node.js 22 + TypeScript 7 service, OTel emission via `@devopsplaybook.io/otel-utils`, notifications via `@devopsplaybook.io/common-utils`.

## How it works

1. On startup the service loads `probes.yaml` (path: `PROBE_CONFIG_FILE`), interpolates `${ENV_VAR}` placeholders from the environment and validates the full schema. A broken config at startup exits the process loudly; on hot reload the last known good configuration is kept and the error is logged.
2. Each probe runs on its own interval with a randomized first run (staggered, no synchronized bursts) and is executed through a concurrency-limited pool (`PROBE_MAX_CONCURRENCY`).
3. Every result updates in-memory state that observable gauges read at each OTel collection cycle, produces one OTel trace span (`probe.<name>`, ERROR status on failure) and one correlated log record, and drives the alerting state machine.
4. A built-in self-probe (`otel-light-self`) checks the otel-light origin when `SELF_PROBE_ENABLED` and a metrics endpoint is configured — a deadman check for the ingestion pipeline itself.

## Probe types

| Type | Target format | What it measures |
| --- | --- | --- |
| `http` | `http(s)://host:port/path` | Round-trip of the request (method, headers, body, response read), status and body assertions |
| `tcp` | `host:port` | TCP connect (the reachability proxy; ICMP is deliberately not implemented in v1 — raw sockets need privileges) |
| `dns` | `hostname` | A/AAAA resolution time (`resolve4`, fallback `resolve6`) |
| `tls` | `host:port` | TLS handshake plus remaining validity of the peer certificate |

## probes.yaml schema

```yaml
probes:
  - name: otel-light-home        # required, unique across probes
    type: http                   # required: http | tcp | dns | tls
    target: http://localhost:8080/   # required (format depends on type)
    intervalSeconds: 30          # optional, default 30; must be > timeoutSeconds
    timeoutSeconds: 5            # optional, default 5
    method: GET                  # http only, optional, default GET
    headers:                     # http only, optional; values support ${ENV}
      Authorization: "Bearer ${PROBE_API_SECRET_TOKEN}"
    body: '{"force": true}'      # http only, optional, not allowed on GET/HEAD; supports ${ENV}
    expect:                      # optional assertions
      statusCode: 200            # http only
      bodyContains: "ok"         # http only
      maxDurationMs: 2000        # all types; failure code is timeout when exceeded
```

Validation rules: unique probe names, required `name`/`type`/`target`, per-type target format, `timeoutSeconds < intervalSeconds`, `statusCode`/`bodyContains` only on `http` probes, known HTTP methods, `body` only on methods with a request body.

At most the first 64 KB of a response body are read (`bodyContains` is searched in that window only), and the read stops as soon as the expected text is found — a large body can neither exhaust the container nor delay the result.

`${ENV_VAR}` interpolation runs before validation and applies to every string value. An unresolved variable rejects the configuration (last known good config kept on reload) so a broken Secret deployment is loudly reported. Secrets must never be written into the ConfigMap.

### Hot reload

The service watches the probe file (`fs.watchFile`). Kubelet propagates ConfigMap updates to the mounted directory within about a minute, so probe changes need no pod restart. Invalid YAML or schema violations keep the previous configuration and log the error. The ConfigMap is mounted as a **directory** — `subPath` mounts do not receive kubelet updates.

## Emitted OpenTelemetry signals

Metrics, traces and logs describe the same probe results. Labels and attributes are low-cardinality by design — never full URLs, hostnames or ids.

### Metrics

Observable gauges, registered once at startup; callbacks read the last-result state, so hot reloads add/remove series without re-registration. A gauge's label set is fixed per probe (`probe.name`, `probe.type`, `probe.location`) and never varies with the value: an attribute carried only on failures (like `error.code`) makes the OTel SDK re-export the previous value under a second series, leaving a frozen data point that contradicts the live one.

| Metric | Labels | Meaning |
| --- | --- | --- |
| `probe.success` | `probe.name`, `probe.type`, `probe.location` (when set) | 1 if the last run succeeded, 0 otherwise |
| `probe.duration` | same | Last round-trip duration in seconds |
| `probe.http.status_code` | same | Last HTTP response status code; **`0` means no response was received** (http probes only) |
| `probe.dns.lookup_time` | same | Last DNS resolution time in seconds (`dns` probes) |
| `probe.tls.cert_remaining_days` | same | Days remaining before the certificate expires (`tls` probes) |
| `probe.last_result_age_seconds` | same | Seconds since the last completed run of the probe (heartbeat) |

The `status_code` sentinel matters: not observing the metric while an endpoint is unreachable would keep displaying the last known status (a flat `200`) during an outage.

Failure reasons live on the counter, not on the gauges:

| Metric | Labels | Meaning |
| --- | --- | --- |
| `synthetic-monitor.probe.runs.total` | `probe.name`, `probe.type`, `probe.location`, `result` (`success`/`failure`), `error.code` (failures) | Cumulative number of probe runs by outcome (`StandardMeter.createCounter` prefixes counter names with the service id) |

Counters are cumulative per series: after a recovery the `result=failure` series stays visible at its last total — their documented semantics, unaffected for `increase()`/`rate()` queries. The heartbeat (`probe.last_result_age_seconds`) grows while no new result arrives, so a silently stopped probe (stuck scheduler, hung run holding a pool slot) is directly alertable (e.g. `probe.last_result_age_seconds > 3 × <probe interval>`) — a `probe.success == 1` deadman check would stay green on frozen state.

### Traces

One span per probe run, named `probe.<name>` (`otel-utils` sanitizes it to `probe_<name>`) with the outcome as attributes: `probe.name`, `probe.type`, `probe.location`, `duration_ms`, `http.response.status_code` (when a response was received) and `error.code` on failures. A failing probe sets the span status to **ERROR** (message: the error detail), so failures are visible in otel-light's error/trace views.

### Logs

One log record per probe run — INFO on success, ERROR on failure — emitted inside the probe span, so `trace.id`/`span.id` link it to the trace (otel-light extracts them into its log rows). Structured attributes: `log.type=probe-result`, `probe.name`, `probe.type`, `probe.location`, `duration_ms`, `status_code` (when available), `error.code` and `error.detail` on failures. The message text is stable per outcome (`Probe <name> [<type>] succeeded` / `Probe <name> [<type>] failed: error.code=<code>`) — the variable duration would otherwise fragment otel-light's "top error messages" view. `PROBE_LOG_SUCCESS=false` turns off the success records (failure records are always emitted).

Failure taxonomy reported as `error.code` (metric counter, span attribute, log attribute):

| Code | Meaning |
| --- | --- |
| `dns_error` | Name resolution failed (ENOTFOUND, EAI_AGAIN, SERVFAIL, ...) |
| `connect_refused` | TCP connection refused |
| `network_unreachable` | No route to the address (ENETUNREACH, EHOSTUNREACH) |
| `connection_reset` | Connection reset by the peer (ECONNRESET) |
| `tls_error` | TLS/certificate handshake failure |
| `timeout` | Probe timeout exceeded (also used when `expect.maxDurationMs` is breached) |
| `status_mismatch` | HTTP status differs from `expect.statusCode` |
| `body_mismatch` | Response body does not contain `expect.bodyContains` |
| `unknown` | Anything else |

For fetch failures the error detail carries the undici cause fields (`ECONNREFUSED connect 10.43.0.5:443: fetch failed`, and the same for socket errors), which separates "the service has no endpoints" from "the pod refuses the port".

## Configuration

Priority: environment variables > `config.json` > defaults (ConfigBase conventions; `config.json` is hot-reloadable).

| Field | Default | Description |
| --- | --- | --- |
| `PROBE_CONFIG_FILE` | `probes.yaml` | Path to the probe configuration |
| `PROBE_LOCATION` | `""` | Value of the `probe.location` attribute (multi-perspective checks; omitted when empty) |
| `PROBE_MAX_CONCURRENCY` | `5` | Maximum probes executed concurrently |
| `PROBE_LOG_SUCCESS` | `true` | Emit an INFO log record for successful runs (failures are always logged) |
| `SELF_PROBE_ENABLED` | `true` | Built-in `otel-light-self` deadman probe |
| `NOTIFICATION_CONSECUTIVE_FAILURES` | `3` | Failures before an `error` notification is sent |
| `NOTIFICATION_REPEAT_AFTER_HOURS` | `4` | Repeat-suppression window while a probe keeps failing |
| `NOTIFICATION_DIGEST_SCHEDULE` | `""` | Optional node-cron expression (UTC) for a periodic Markdown digest |
| `NOTIFICATIONS_API` / `NOTIFICATIONS_TOKEN` | `""` | Notifications integration; alerts are **silent** when unset |
| `OPENTELEMETRY_COLLECTOR_HTTP_METRICS` / `_LOGS` / `_TRACES` | `""` | otel-light OTLP HTTP endpoints |
| `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER` | `""` | Bearer token for otel-light ingestion |
| `OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS` | `60` | Metrics export interval |
| `OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS` | `60` | Logs export interval |

### Alerting

Per-probe state machine: an `error` notification after `NOTIFICATION_CONSECUTIVE_FAILURES` consecutive failures, an `info` notification on recovery, flap suppression (fewer than N failures followed by a recovery stays silent) and a repeat-suppression window while the probe keeps failing. With `NOTIFICATION_DIGEST_SCHEDULE` set (validated cron, evaluated in UTC), a periodic Markdown digest summarizes the state of every probe. All of it is fail-safe: when `NOTIFICATIONS_API`/`NOTIFICATIONS_TOKEN` are unset nothing is sent.

## Self-monitoring

The service exports its own traces/logs/metrics with `service.name=synthetic-monitor`. Exporter errors are logged and never crash the process. On `SIGTERM`/`SIGINT` the schedulers stop, in-flight probes are awaited (bounded) and the OpenTelemetry exporters are flushed (`forceFlush()`/`shutdown()`; feature-detected — full flush requires `@devopsplaybook.io/otel-utils` ≥ 1.3.0).

## Running locally

```bash
cd synthetic-monitor-server
npm ci
cp probes.example.yaml probes.yaml
# point at a local otel-light (e.g. its docker-compose) and clear notifications:
OPENTELEMETRY_COLLECTOR_HTTP_METRICS=http://localhost:8080/v1/metrics \
OPENTELEMETRY_COLLECTOR_HTTP_LOGS=http://localhost:8080/v1/logs \
OPENTELEMETRY_COLLECTOR_HTTP_TRACES=http://localhost:8080/v1/traces \
npm run dev
```

## Build, lint, test

```bash
cd synthetic-monitor-server
npm run build   # tsc + spec type-check
npm run lint    # oxlint
npm test        # jest with v8 coverage
```

## Docker

```bash
docker build -t synthetic-monitor .
docker run --rm -e OPENTELEMETRY_COLLECTOR_HTTP_METRICS=http://host:8080/v1/metrics \
  -v $(pwd)/probes.yaml:/etc/synthetic-monitor/probes.yaml:ro \
  -e PROBE_CONFIG_FILE=/etc/synthetic-monitor/probes.yaml \
  synthetic-monitor
```

## Kubernetes

The production deployment is managed by GitOps, not from this repository: [`DidierHoarau/didier-home`](https://github.com/DidierHoarau/didier-home), `clusters/prod-home-apps/otel/otel-light/base/deployment-synthetic-monitor.yaml` — namespace `otel-light`, image `devopsplaybookio/synthetic-monitor:beta`, `probes.yaml` from a ConfigMap mounted as a directory and secrets via `envFrom` (`didiercloud-otel-common-local`, `didiercloud-notifications-common`). Change the deployment there; the legacy manifests previously shipped in `docs/deployments/kubernetes/synthetic-monitor/` (own namespace, `secretKeyRef`, hard-coded replicas) were removed so applying them cannot create a second, competing deployment.

- Probe changes are ConfigMap edits: the kubelet syncs the mounted directory within ~1 minute and the service hot-reloads (no restart needed).
- A restart (`kubectl -n otel-light rollout restart deployment/synthetic-monitor`) is only needed to pick up a new image.

### Security notes (SSRF trade-off)

The service is intentionally allowed to reach internal endpoints — that is its purpose — which makes it an SSRF-prone component by design. Mitigations: probe targets come exclusively from the operator-controlled ConfigMap (not from any request input), secrets are injected from a Secret at load time and never logged, and the emitted labels are low-cardinality (no URLs). It exposes no network listener (no ingress surface). If your cluster uses default-deny NetworkPolicies, allow egress to DNS, otel-light and the intended probe targets, one instance per location/cluster (`PROBE_LOCATION` distinguishes perspectives).

## CI

- **PR Check** (`.github/workflows/pr-check.yml`): version check, build, lint, tests, Docker build pushing `beta-pr-<N>`/`beta`.
- **Main Build** (`.github/workflows/main-build.yml`): promotes the validated image to `<version>`/`<major>`/`<minor>`/`latest` on merge.

Requires the repository Actions secrets `DOCKER_HUB_USERNAME` and `DOCKER_HUB_ACCESS_TOKEN` (plus optional `QUALITY_DASHBOARD_URL`/`QUALITY_DASHBOARD_TOKEN`).
