# pgqueue-control

**Mission control for Postgres-backed job queues and durable workflows.** Your queue lives in Postgres — but it's a black box. pgqueue-control gives you a live dashboard, queue depths, job timelines, workflow checkpoints, a dead-letter queue you can actually operate, and Prometheus metrics. No extra infrastructure: it reads the schema your queue already maintains.

Supports **[pg-boss](https://github.com/timgit/pg-boss)** (job queue) and **[Absurd](https://github.com/earendil-works/absurd)** (durable workflows) today. graphile-worker is on the roadmap — the adapter interface is ~80 lines, PRs welcome.

## Why

Postgres-backed queues are having a moment, especially for AI agent workloads: long-running tasks, retries against flaky LLM APIs, human-in-the-loop steps. They're simple and self-hostable. But once you're in production, the questions start:

- How deep is each queue *right now*? Is something backing up?
- Why did this job fail? What was the error on attempt 2 vs attempt 3?
- Which workflow steps already ran, and where exactly did the task stop?
- What's sitting in the dead-letter queue, and which original job did each entry come from?
- How do I alert when failures spike?

Today the answer is "open psql and write queries against internal tables." pgqueue-control is that, productized.

## Quick start

```bash
docker compose up --build
```

This boots Postgres, a demo producer that generates realistic traffic (successes, flaky retries, permanently failing jobs that land in a DLQ), and the API + dashboard on port 4400. The image is multi-stage: stage 1 compiles the Angular dashboard, stage 2 runs the API serving that build — nothing precompiled is committed to the repo.

Open **http://localhost:4400** — default credentials `admin` / `admin` — or hit the API:

```bash
curl -u admin:admin localhost:4400/api/queues
curl -u admin:admin "localhost:4400/api/jobs?queue=agent-tasks&state=failed"
curl localhost:4400/metrics
```

Point it at your own database instead:

```bash
DATABASE_URL=postgres://user:pass@host:5432/db npm run dev
```

## Dashboard

**Angular 20** (standalone components + signals), source in `dashboard/`. The production build is emitted to `public/` and served by the API process — one container, one port.

- Per-queue strips: state distribution bar, live counts, depth sparkline (pg-boss)
- Job table with filters: queue, state, **id prefix**, **date/time range** — plus pagination
- Job drawer: payload, error output, attempt history, DLQ trace with a link to the original job, one-click retry
- For Absurd tasks: **persisted checkpoints** (step name, status, cached result) — see exactly where a workflow stopped and what it will *not* re-execute on retry

Architecture: a signal-based store (`dashboard/src/app/core/dashboard-store.ts`) owns all state and the 4s polling loop; components (`queue-list`, `jobs-table`, `job-drawer`, `sparkline`) read signals and call store mutations. `ApiService` wraps `HttpClient` against the same API the CLI uses.

Development: `npm run dashboard:dev` starts `ng serve` on :4300 with a proxy to the API on :4400 (the proxy injects the default dev credentials). `npm run dashboard:build` regenerates `public/`.

## Configuration

Everything is environment variables (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — (required) | Postgres connection string |
| `QUEUE_BACKEND` | `pgboss` | `pgboss` \| `absurd` |
| `PORT` | `4400` | HTTP port |
| `PGBOSS_SCHEMA` | `pgboss` | Schema to read (pg-boss backend) |
| `ABSURD_SCHEMA` | `absurd` | Schema to read (Absurd backend) |
| `PANEL_USER` / `PANEL_PASSWORD` | `admin` / `admin` | Basic Auth for the panel and API |

Auth notes: credentials are checked with constant-time comparison; `/metrics` stays open so Prometheus can scrape without credentials. Basic Auth travels in cleartext — put this behind HTTPS if it leaves localhost.

## API

All endpoints (except `/metrics`) require Basic Auth.

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Liveness + active backend |
| GET | `/api/queues` | All queues with per-state job counts, DLQ detection, retry config |
| GET | `/api/queues/:name/stats?sinceMinutes=60` | Historical depth samples (pg-boss `queue_stats`; empty for Absurd, which keeps no history) |
| GET | `/api/jobs?queue=&state=&id=&from=&to=&limit=&offset=` | Paginated job listing with filters |
| GET | `/api/queues/:name/jobs/:id` | Full job detail: payload, error output, retry history, DLQ trace, checkpoints |
| POST | `/api/queues/:name/jobs/:id/retry` | Re-enqueue a `failed`/`cancelled` job (409 otherwise) |
| GET | `/metrics` | Prometheus: `pgqueue_jobs{backend,queue,state}` gauges |

Filter details:

- `state`: `created` · `retry` · `active` · `sleeping` · `completed` · `cancelled` · `failed`
- `id`: uuid **prefix** match (the dashboard shows truncated ids). Note: Absurd uses time-ordered UUIDv7, so tasks created close together share short prefixes — paste more of the id there.
- `from` / `to`: ISO datetimes bounding the job creation time. Invalid dates or `from > to` → 400.

Dead-lettered jobs expose `sourceQueue` and `sourceJobId`, so you can trace every DLQ entry back to the job that produced it.

## Backends

Everything above the adapter speaks a neutral `QueueAdapter` interface ([src/adapters/types.ts](src/adapters/types.ts)). Adding a backend = implementing 6 methods against its schema.

### pg-boss (`QUEUE_BACKEND=pgboss`)

Classic job queue: atomic jobs that run or fail whole. The adapter reads `pgboss.queue` / `pgboss.job` / `pgboss.queue_stats` directly (v10+ schema, verified against v12).

### Absurd (`QUEUE_BACKEND=absurd`)

[Absurd](https://github.com/earendil-works/absurd) is durable execution on plain Postgres — tasks are split into checkpointed steps; on retry, completed steps are not re-executed. The adapter maps its model onto the shared interface:

| Absurd | shown as |
|---|---|
| `pending`, never started | `created` |
| `pending`, ran before | `retry` |
| `running` | `active` |
| `sleeping` (suspended on a timer or `awaitEvent`) | `sleeping` |
| `completed` / `failed` / `cancelled` | same |

Schema notes learned by inspection (not assumption): each queue owns dynamic tables (`t_<queue>`, `r_<queue>`, `c_<queue>`); `attempts` increments at spawn, so a never-run task already has `attempts = 1`; retry goes through `absurd.retry_task()`, which only accepts `failed` tasks.

Setup: apply [scripts/absurd.sql](scripts/absurd.sql) to your database (or let the SDK's `createQueue()` do it), then `QUEUE_BACKEND=absurd npm run dev`.

## Design principles

**Respect the database.** The overview never aggregates the (potentially huge, partitioned) `job` table: pg-boss maintains live counters on its tiny `queue` table, and we read those. Job listings filter by queue name — the partition key — so Postgres prunes to a single partition. No long transactions, no locks on job rows, a dedicated 5-connection pool tagged `application_name=pgqueue-control` so you can spot us in `pg_stat_activity`.

**Read-only by default.** The only write is the explicit retry action, which mirrors each backend's own retry semantics.

**Verify against real schemas.** Both adapters were built against live databases populated by the backends' own SDKs — never against assumed table layouts. The smoke test keeps it that way.

## Alerting example

With the `/metrics` endpoint scraped by Prometheus:

```yaml
- alert: DeadLetterQueueGrowing
  expr: pgqueue_jobs{queue="agent-tasks-dlq", state="created"} > 10
  for: 5m
```

## Project layout

```
src/
  adapters/        QueueAdapter interface + pg-boss and Absurd implementations
  api/
    server.ts      bootstrap: config, adapter selection, router mounting
    routes/        one router per resource (health, queues, jobs, metrics)
    middleware/    basic auth, error handling
    metrics.ts     Prometheus registry
  helpers/         ServerConfig (env validation, fail-fast at startup)
dashboard/
  src/app/
    core/          models, ApiService, signal store + polling
    components/    queue-list, jobs-table, job-drawer, sparkline
public/            Angular production build (generated — gitignored; built by
                   `npm run dashboard:build` locally or inside the Docker image)
Dockerfile         multi-stage: dashboard build -> API runtime
demo/
  producer.ts          pg-boss traffic generator (workers, retries, DLQ)
  absurd-producer.ts   Absurd traffic generator (checkpoints, sleeps, events)
scripts/
  seed.ts          bulk pg-boss test data via direct SQL (thousands of jobs in seconds)
  absurd.sql       Absurd schema (from earendil-works/absurd)
  smoke.sh         end-to-end test: boots both backends, 44 checks
```

## Development

```bash
npm install
npm run typecheck
npm run dev            # start API + dashboard build (loads .env)
npm run dashboard:dev  # Angular dev server on :4300 (proxies API to :4400)
npm run dashboard:build # rebuild public/ from dashboard/
npm run demo           # pg-boss traffic generator
npx tsx --env-file=.env demo/absurd-producer.ts   # Absurd traffic generator
npx tsx --env-file=.env scripts/seed.ts           # bulk pg-boss seed data
bash scripts/smoke.sh  # end-to-end smoke test (both backends, needs seeded data)
```

## Roadmap

- [x] Web dashboard (queue overview, job drawer, DLQ with one-click retry)
- [x] Absurd adapter (durable workflows: checkpoints, sleeping tasks)
- [x] Basic Auth for the panel
- [x] Job filters: state, id prefix, date/time range
- [ ] graphile-worker adapter
- [ ] Bulk retry / cancel
- [ ] Users in the database (replace hardcoded Basic Auth)
- [ ] Configurable alert rules without Prometheus

MIT
