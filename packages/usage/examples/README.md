# pi-usage backend examples

These are **examples, not requirements** — pi-usage speaks plain OTLP/HTTP and works with any OpenTelemetry-compatible trace backend. This directory just happens to document the reference setup the dashboards and queries below assume: Tempo storing traces, its metrics-generator deriving Prometheus metrics, Grafana querying both.

## Pieces

- [`tempo.yaml`](tempo.yaml) — single-binary Tempo with the OTLP receiver and, crucially, the metrics-generator spanmetrics processor configured with the `coding.*` dimensions. Point the `remote_write` URL at your Prometheus.
- [`dashboard.json`](dashboard.json) — importable Grafana dashboard (total time, languages donut, projects, daily bars). Set your Prometheus datasource uid after import.

## The queries that matter

Tempo spanmetrics emits `traces_spanmetrics_latency_sum` (seconds) and `traces_spanmetrics_calls_total`; the OTel Collector spanmetrics connector emits `duration_sum`/`calls_total` instead — same queries either way, different names.

```promql
# total effective work, hours
sum(increase(traces_spanmetrics_latency_sum{service_name="pi-usage", coding_segment_kind=~".+"}[$__range])) / 3600

# languages (what WakaTime's pie chart shows)
sum by (coding_language) (increase(traces_spanmetrics_latency_sum{service_name="pi-usage", coding_segment_kind="file"}[$__range])) / 3600

# projects
sum by (coding_project) (increase(traces_spanmetrics_latency_sum{service_name="pi-usage", coding_segment_kind=~".+"}[$__range])) / 3600

# "editors & agents" — one series per OTLP-speaking agent
sum by (service_name) (increase(traces_spanmetrics_latency_sum{coding_segment_kind=~".+"}[$__range])) / 3600
```

`coding_segment_kind=~".+"` filters out `pi.request` parent spans so time is never double-counted; request spans exist only to give each trace its waterfall structure.

## Trace drill-down

Open the Tempo datasource and search `{ resource.service.name = "pi-usage" }`. One trace = one pi session; `pi.request` spans are user requests; `pi.segment` children are attribution segments and **waits show up as gaps**. To find every segment that touched a file:

```traceql
{ span.coding.entity = "src/main.py" }
```

## Grafana Cloud note

This works on Grafana Cloud Traces too, but with friction: the metrics-generator is off by default, span metrics for `INTERNAL` span kinds and custom dimensions both require a Grafana Support request, and the free tier keeps only 14 days. Self-hosted Tempo has none of that.

## GitHub README stats

To reproduce the WakaTime-style "Coding Insights" block in a profile README, run the language/project queries above from a scheduled GitHub Actions workflow against your (reachable, authenticated) Prometheus, render the ASCII bars, and commit between `<!--START_SECTION-->` markers. Neovim/editor time can still be merged in from the WakaTime API if you keep its classic editor plugins.
