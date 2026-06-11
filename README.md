# ardur-pipeline

**The end-to-end orchestrator for the Ardur AI content pipeline.** Every 6 hours it
runs the four engines in order — **aggregate → rank → top-10 → synthesize** — and
publishes the artifacts [`ardur.ai`](https://github.com/ArdurAI/ardur.ai) consumes.

> Schema: **`ardur-content-pipeline/v1`** · Node ≥ 22 · TypeScript · MIT
>
> This repo is the **conductor and runtime host**. The actual content logic lives in
> the four engine repos; this repo spawns their CLIs, threads one cycle through them,
> and owns scheduling, idempotency, last-good-wins, observability, and the site handoff.
> It references the engines' canonical [`contracts.ts`](./src/contracts.ts) (vendored
> byte-identical) and never forks engine logic.

## What it does

```mermaid
flowchart LR
  subgraph pipe["ardur-pipeline (6h conductor)"]
    SCH[cron 0 */6 * * *] --> ORCH[runCycle]
    ORCH --> STORE[(artifact store)]
  end
  ORCH -->|spawn CLI| A[ardur-news-aggregator] --> R[ardur-ranking-engine] --> T[ardur-top10-engine] --> S[ardur-article-synthesizer]
  S --> ORCH
  STORE -->|manifest.json + latest/| SITE[(ardur.ai · in-app read)]
```

- **6-hour cycle**, UTC-aligned (`floor(now, 6h)` → 00:00 / 06:00 / 12:00 / 18:00).
- **Idempotent** per cycle id — a delayed, retried, or backfilled trigger is the same cycle.
- **Last-good-wins** — a failed cycle publishes nothing; the previous cycle keeps serving.
- **Deterministic / budget=0 by default** — the whole chain runs with no API key and no
  network model call, and still produces a complete, publishable cycle.
- **Observable** — structured per-stage logs, a `RunResult` summary, artifact upload, and
  a webhook alert on `failed` / `degraded`.

## Quickstart

```bash
# from a workspace with the four engines checked out as siblings:
#   ardur-pipeline/  ardur-news-aggregator/  ardur-ranking-engine/
#   ardur-top10-engine/  ardur-article-synthesizer/
cd ardur-pipeline
npm install
cp .env.example .env            # defaults are safe: deterministic, budget=0

# run the current cycle (logs -> stderr, RunResult JSON -> stdout)
npm run cycle

# backfill a specific window
node --experimental-strip-types src/cli.ts --at 2026-06-11T06:00:00Z

# the published store lands in ./.artifacts (manifest.json + latest/ + cycles/)
```

Exit code: `0` for `published | degraded | skipped`, `1` for `failed`.

## Deploy

**GitHub Actions scheduled workflow** is the recommended runtime
([`.github/workflows/cycle.yml`](./.github/workflows/cycle.yml)): free, native artifacts,
secrets, `workflow_dispatch` backfill, and one place for everything. The job checks out
the four engines as siblings, runs one cycle, and on success pushes the artifact store to
a dedicated **`published`** branch the site reads. Self-hosted cron and serverless are
documented alternatives. See [`docs/spec.md` §3](./docs/spec.md#3-runtime--deploy).

## Data handoff to ardur.ai

The site reads **`manifest.json`** (the last-good pointer) then **`latest/articles.json`**:

```
<store>/manifest.json          # cycle id, status, runIds, nextRefreshAt, top-10 summary
<store>/latest/                # aggregation|ranking|top10|articles .json (atomic set)
<store>/cycles/<cycleId>/      # immutable archive (audit + rollback)
```

`latest/` is swapped atomically (temp + rename) so a reader never sees a half-written set.
Full contract + schema: [`docs/spec.md` §4](./docs/spec.md#4-data-handoff-contract-to-ardurai).

## The four engines

| # | Repo | Produces |
|---|------|----------|
| 1 | [`ardur-news-aggregator`](https://github.com/ArdurAI/ardur-news-aggregator) | `AggregationArtifact` |
| 2 | [`ardur-ranking-engine`](https://github.com/ArdurAI/ardur-ranking-engine) | `RankingArtifact` |
| 3 | [`ardur-top10-engine`](https://github.com/ArdurAI/ardur-top10-engine) | `Top10Artifact` |
| 4 | [`ardur-article-synthesizer`](https://github.com/ArdurAI/ardur-article-synthesizer) | `ArticleArtifact` |

`ardur-top10-engine` also ships an in-process `runCycle` for library embedding; this repo
is the out-of-process conductor that spawns all four CLIs and owns the deploy + handoff.

## Layout

```
src/
  cli.ts          entrypoint — run one cycle (what the scheduler invokes)
  orchestrate.ts  the conductor: idempotency, retries, last-good-wins, alerting
  runners.ts      CLI-backed StageRunners — the only place that spawns engines
  store.ts        artifact store + the manifest handoff contract
  cycle.ts        6-hour UTC cycle math
  config.ts       env -> typed config (safe defaults; budget=0)
  retry.ts        bounded retry + backoff
  log.ts          structured logging
  alert.ts        webhook alerting
  contracts.ts    VENDORED shared wire contract (do not edit here)
  smoke.test.ts   unit tests for the orchestrator's own glue (not engine E2E)
docs/spec.md      full design spec with diagrams
.github/workflows/cycle.yml   the 6-hour scheduled cycle
```

## Scope boundary

- **In:** scheduling, orchestration, idempotency, retries, observability, the artifact
  store, and the handoff to the site.
- **Out:** engine logic (lives in the engine repos) and cross-engine end-to-end tests
  (owned by `ardur-engine-e2e`).

## License

[MIT](./LICENSE) © ArdurAI
