# Local quickstart: OpenObserve + pi-usage

This spins up a disposable OpenTelemetry backend on your machine and gives you a WakaTime-style dashboard — no Tempo, Prometheus or Grafana required.

[OpenObserve](https://github.com/openobserve/openobserve) is a single-binary, OTLP-native observability platform. It is only the **receiving end for this example**; pi-usage itself has no OpenObserve dependency and speaks plain OTLP.

> **This is a local throwaway setup.** It uses a weak default password and publishes port 5080. Do not reuse it anywhere reachable from a network you do not control.

## 1. Start the backend

```bash
cd packages/usage/examples/openobserve
docker compose up -d
```

First boot runs OpenObserve's database migration, which takes roughly 30 seconds. Check readiness:

```bash
curl -sf -o /dev/null -w '%{http_code}\n' http://localhost:5080/web/   # expect 200
```

Then open <http://localhost:5080> and log in with `root@example.com` / `PiUsage!7x` <!-- betterleaks:allow - disposable local example -->

## 2. Import the dashboard

**Dashboards → New Dashboard → Import** — upload [`dashboard.json`](dashboard.json). The panels query the traces stream directly, so the dashboard works before any data exists (it will just be empty until you send some).

## 3. Start pi with pi-usage pointed at it

From any working directory you want to measure:

```bash
cd /path/to/your/project
PI_USAGE_OTLP_TRACES_ENDPOINT="http://localhost:5080/api/default/v1/traces" \
PI_USAGE_OTLP_HEADERS="Authorization=Basic $(printf '%s:%s' root@example.com 'PiUsage!7x' | base64 -w0)" \ # betterleaks:allow
pi
```

That is the whole setup. pi-usage reads `PI_USAGE_*` variables by default and ignores the standard `OTEL_*` ones, so it will not pick up — or disturb — an OTLP endpoint that another tool in your shell already exports.

Inside pi, run `/pi-usage` at any time to confirm the endpoint, the queue and the sent count. It also shows the session's local totals — useful to cross-check against what arrives in OpenObserve.

## 4. Work, then look

Ask pi to read files, change something, finish the request. Segments are exported when the request settles. Then:

- **Dashboard**: open **Dashboards → Pi Usage — Coding Insights**. Set the time range to cover your session. Panels: total minutes, language donut, projects, daily file-vs-app.
- **Traces UI**: **Traces → default** — one trace per pi session; `pi.request` spans are user requests, `pi.segment` children are attribution segments, and **waits show up as gaps** in the waterfall.

A healthy trace:

- one trace per session (all requests share a trace id);
- `pi.segment` is parented to `pi.request`;
- dialog waits are empty stretches in the waterfall;
- file segments carry `coding.segment.kind=file`, `coding.language`, `coding.project`, and (by default) `coding.entity`.

## 5. Query it from outside

The dashboard is SQL over the traces stream; external programs (a README stats renderer, for example) use the same query via the HTTP API:

```bash
curl -sS -X POST "http://localhost:5080/api/default/_search?type=traces" \
  -u 'root@example.com:PiUsage!7x' -H 'Content-Type: application/json' \  # betterleaks:allow
  --data '{"query":{"sql":"SELECT coding_language, SUM(duration)/1000000.0/60.0 AS minutes FROM \"default\" WHERE coding_segment_kind = '\''file'\'' AND coding_language IS NOT NULL GROUP BY coding_language ORDER BY minutes DESC","start_time":'"$(( ($(date +%s) - 7*86400) * 1000000 ))"',"end_time":'"$(( $(date +%s) * 1000000 ))"'}}'
```

PI_USAGE_* cross-check: `/pi-usage` inside pi shows local session totals; the sum over a session window here should match it.

### Gotchas worth knowing

- **`duration` is stored in microseconds.** pi-usage sends OTLP nanoseconds; OpenObserve's OTLP ingest converts them to µs. Divide by `1e6` for seconds (the queries above do `/1000000.0`).
- **`_timestamp` and the search API take microseconds** (`start_time`/`end_time`), not milliseconds.
- **The spans arrive seconds after the request settles**, not continuously — segments are settled at turn/request boundaries by design.

## Why no pipeline / no PromQL

You might expect a "traces → metrics" pipeline step. It is deliberately absent:

- Scheduled pipelines in OpenObserve are stateless batch ETL: each run aggregates only its own lookback window, so a 1-minute pipeline emits at most one sparse sample per label combination per minute.
- The Metrics UI defaults to `rate(...[1m])` and instant queries — both need dense samples and come up empty on that sparse series (it looks like "no data" even when rows exist).
- A `period > frequency` overlap (re-aggregate a long window every minute, cumulative style) is rejected by the scheduler (`Invalid timerange. Skipping to next run`).

Querying the traces stream with SQL directly has none of these problems: zero ETL delay, no state, `SUM(duration)` is exactly the total effective seconds, and SQL is the most vendor-neutral query surface. If you want PromQL-native counters (`duration_sum`) for a Grafana/Prometheus stack instead, use the [Tempo example](../tempo.yaml) — the extension config is identical apart from the endpoint.

## Tear down

```bash
docker compose down          # keep the data volume
docker compose down -v       # remove data too
```

Data lives in a named volume, never in the repository working tree.
