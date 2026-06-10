# Observability pack

Out-of-the-box monitoring for any open-rgs game server: a Prometheus
scrape config, an alert rule group, and a Grafana dashboard built
against the standard `rgs_*` series (see `packages/core/src/metrics-rgs.ts`
for the authoritative list, and the "Instance identity & metrics
scraping" section of `specs/07-deployment.md` for the contract).

## Scraping /admin/metrics

The metrics endpoint sits behind the admin bearer token
(`OPEN_RGS_ADMIN_TOKEN`). Minimum viable job:

```yaml
scrape_configs:
  - job_name: rgs
    metrics_path: /admin/metrics
    authorization:
      type: Bearer
      credentials: <admin-token>
    static_configs:
      - targets: ["rgs-1.internal:8080"]
```

Metrics are pod-local. Scrape **every** instance and aggregate in
queries - never scrape through a load balancer.

`prometheus-scrape.example.yml` has the full version: the static job
above plus a `kubernetes_sd_configs` pod-discovery job that follows
the HPA, filters on the `app: rgs-<game-id>` pod label, and normalizes
the job label to `rgs`.

## Kubernetes: make instance ids match pod names

The server self-generates an `rgs-<8 hex>` instance id unless told
otherwise. In K8s, pass the pod name via the downward API so
`rgs_build_info{instance_id}`, `/healthz`, logs, and `kubectl` all
agree:

```yaml
env:
  - name: OPEN_RGS_INSTANCE_ID
    valueFrom: { fieldRef: { fieldPath: metadata.name } }
```

Add that to the container in `deploy/k8s/deployment.yml`.

## Dashboard

Import `grafana-dashboard.json` (Dashboards -> New -> Import). Grafana
prompts for a Prometheus datasource on import (`${DS_PROMETHEUS}`
input). The `job` variable defaults to `rgs`; switch it if you named
your scrape job differently.

Panels: instance table (from `rgs_build_info`), spin rate per
instance, platform RPC p50/p95/p99, instance births & deaths,
sessions/WS, platform SLA (connected / flaps / errors), GGR per
currency, live RTP vs declared, stakes/wins flow.

## Alerts

Load `alerts.yml` via `rule_files` in your `prometheus.yml`:

```yaml
rule_files:
  - alerts.yml
```

What fires and why:

| Alert | Severity | Meaning |
|---|---|---|
| `RgsPlatformDisconnected` | critical | a wallet link is down |
| `RgsWalletSilent` | critical | connected but no successful RPC in 30s |
| `RgsPlatformFlapping` | warning | connection bouncing |
| `RgsRtpDrift` | warning | 6h live RTP off the declared line (noisy by nature - read the comment in the file) |
| `RgsNegativeGgrHour` | info | house paid out more than it took in this hour; expected occasionally |
| `RgsInstanceChurn` | warning | instance count moving fast - crash loops or eager autoscaling |
| `RgsErrorBudget` | warning | >5% of platform RPCs failing |

Thresholds are defaults for a moderately busy fleet - tune them to
your volume before wiring a pager.
