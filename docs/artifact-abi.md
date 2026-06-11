# Ardur Pipeline — Artifact ABI

This document describes the **stable handoff contract** between the four Ardur
content-pipeline engines and the ardur.ai site. An external orchestrator (Hermes
agent, MCP shim, or any tool) can consume a full cycle using only the information
here — no engine source code required.

Schema version: `ardur-content-pipeline/v1`  
Contract revision: **3** (Rev 3 adds fact/provenance layer, visual ArticleBlock union,
`editorialStatus`, uncapped references, `gateStatus`.)

---

## 1. Artifact store layout

```
<ARTIFACT_STORE>/
  manifest.json               ← last-good pointer; read this first
  latest/
    aggregation.json          ← AggregationArtifact
    ranking.json              ← RankingArtifact
    top10.json                ← Top10Artifact
    articles.json             ← ArticleArtifact (published articles only)
  cycles/<cycleId>/           ← immutable archive (held articles included)
    aggregation.json  ranking.json  top10.json  articles.json
    run.json                  ← manifest + rawWarnings
    metrics.json              ← CycleMetrics
  metrics.ndjson              ← append-only line-delimited CycleMetrics stream
```

`latest/articles.json` contains **only articles with `editorialStatus !== 'held'`**.
The immutable archive under `cycles/<id>/articles.json` includes ALL articles
(held + published) for editorial review.

---

## 2. Envelope shape (all artifacts)

Every artifact is an `ArtifactEnvelope<TData>`:

```jsonc
{
  "schemaVersion": "ardur-content-pipeline/v1",   // hard-fail if mismatch
  "contractRevision": 3,                           // warn (forward-compat) if > local
  "artifact": "<stage>",                           // "aggregation" | "ranking" | "top10" | "articles"
  "runId": "<uuid>",                               // unique per stage execution
  "upstreamRunId": "<uuid> | null",                // producing stage's runId
  "generatedAt": "<ISO-8601-UTC>",
  "cycle": {
    "id": "<ISO-8601-UTC windowStart>",
    "windowStart": "<ISO-8601-UTC>",
    "windowEnd": "<ISO-8601-UTC>"                  // windowStart + 6 h
  },
  "topics": [{ "id": "...", "label": "...", "description": "..." }],
  "provider": { "provider": "ollama|openai|deterministic", "model": "...", "status": "generated|fallback" },
  "warnings": ["..."],                             // non-fatal issues
  "data": { /* stage-specific payload */ }
}
```

**Gate rule:** always call `assertCompatibleArtifact(raw, expectedStage)` from
`@ardurai/contracts` before casting to a stage type. It throws `SchemaVersionError`
on `schemaVersion` or `artifact` mismatch and emits non-fatal warnings on
forward-revision skew.

---

## 3. Stage-by-stage reference

### Stage 1 — Aggregation

CLI: `node --experimental-strip-types src/cli.ts`  
Input: _(none)_  
Output: `ArtifactEnvelope<AggregationData>` on stdout

Key payload fields (`data`):
- `itemsByTopic: Record<topic, AggregatedItem[]>` — ≥20–30 items per topic
- `clustersByTopic: Record<topic, Cluster[]>` — title-similarity clusters
- `coverageByTopic: Record<topic, SourceCoverage>` — source diversity stats
- `documentsByTopic?: Record<topic, SourceDocument[]>` _(Rev 3)_ — fetched doc metadata (bodies are private, never on the wire)
- `factsByCluster?: Record<clusterId, ExtractedFact[]>` _(Rev 3)_ — AI-extracted facts with per-source provenance

### Stage 2 — Ranking

CLI: `node --experimental-strip-types src/cli.ts <aggregation.json>`  
Input: `aggregation.json` (path to `AggregationArtifact`)  
Output: `ArtifactEnvelope<RankingData>` on stdout

Key payload fields (`data`):
- `rankedByTopic: Record<topic, RankedCluster[]>` — scored, sorted clusters
  - `RankedCluster.score: ScoreBreakdown` (interaction, credibility, corroboration, `technicalSignificance?`, recency×, diversity×)
  - `RankedCluster.references?: SourceRef[]` _(Rev 3)_ — uncapped copyright-safe refs (Option 2: ranking attaches them so top10 doesn't need to reload the full aggregation)
  - `RankedCluster.sourceDocIds?: string[]` _(Rev 3)_ — `SourceDocument.id` values
  - `RankedCluster.gateStatus?: 'auto' | 'flagged' | 'hold'` _(Rev 3)_ — editorial pre-classification
- `audit: AuditEntry[]` — fully reproducible per-cluster score records
- `weightProfile: string` — named, versioned weight profile

### Stage 3 — Top-10

CLI: `node --experimental-strip-types src/cli.ts <ranking.json> <previous-top10.json|--> <aggregation.json>`  
Input: ranking artifact + optional previous Top-10 + aggregation artifact  
Output: `ArtifactEnvelope<Top10Data>` on stdout

Key payload fields (`data`):
- `global: Top10Entry[]` — the cross-topic Top-10
- `top10ByTopic: Record<topic, Top10Entry[]>` — per-topic Top-10
- `topicsCovered: string[]`
- `nextRefreshAt: string` — windowEnd (6 h)
- `stability: StabilityReport` — churn vs previous cycle
- `Top10Entry.references: SourceRef[]` — **full uncapped set** (display cap is a renderer concern)
- `Top10Entry.sourceDocIds?: string[]` _(Rev 3)_

### Stage 4 — Synthesizer

CLI: `node --experimental-strip-types src/cli.ts --top10 <top10.json> --aggregation <aggregation.json>`  
Input: top10 + aggregation artifacts  
Output: `ArtifactEnvelope<ArticleData>` on stdout

Key payload fields (`data`):
- `articles: SynthesizedArticle[]` — one article per Top-10 entry (may be fewer if synthesis fails)
- `copyrightPolicy: CopyrightPolicy` — original-text-only, 25-word quote cap, no article bodies

`SynthesizedArticle` key fields:
- `body: ArticleBlock[]` — paragraph/heading/list/quote/callout/chart/image/gif/embed
- `editorialStatus?: 'published' | 'held' | 'draft'` _(Rev 3)_ — **'held' articles must NOT be published to readers**
- `facts?: ExtractedFact[]` _(Rev 3)_ — facts used to write this article
- `claims?: ClaimProvenance[]` _(Rev 3)_ — per-sentence claim→fact mapping

---

## 4. manifest.json structure

`manifest.json` is the **stable site-facing pointer**. ardur.ai reads this to know
which cycle is live without parsing the full payloads.

```jsonc
{
  "schemaVersion": "ardur-content-pipeline/v1",
  "cycle": { "id": "...", "windowStart": "...", "windowEnd": "..." },
  "status": "published | degraded",
  "publishedAt": "<ISO-8601-UTC>",
  "nextRefreshAt": "<ISO-8601-UTC>",
  "runIds": { "aggregation": "...", "ranking": "...", "top10": "...", "articles": "..." },
  "artifacts": {
    "aggregation": "cycles/<id>/aggregation.json",
    "ranking":     "cycles/<id>/ranking.json",
    "top10":       "cycles/<id>/top10.json",
    "articles":    "cycles/<id>/articles.json"
  },
  "warnings": [{ "category": "...", "count": 0, "sample": ["..."] }],
  "health": {
    "failedSources": 0,
    "degradedTopics": 0,
    "articlesDropped": 0,
    "heldArticles": 0,       // Rev 3: articles held for editorial review
    "usedFallback": false
  },
  "summary": {
    "topicsCovered": ["ai", "security", "..."],
    "globalTop10": [{ "rank": 1, "topic": "...", "headline": "..." }],
    "articleCount": 10       // published articles only (held excluded)
  }
}
```

`status: 'degraded'` means the cycle published but with upstream warnings (source
diversity fell below floor, AI fallback triggered, articles held, etc.).

---

## 5. Editorial HOLD semantics

A `SynthesizedArticle` with `editorialStatus: 'held'` represents a piece where the
provenance gate determined that factual claims could not be adequately corroborated.

**Rules:**
- Held articles are written to `cycles/<id>/articles.json` (audit trail).
- Held articles are **excluded** from `latest/articles.json` (site-facing pointer).
- `manifest.health.heldArticles` counts them; `manifest.summary.articleCount` excludes them.
- Held articles generate a pipeline warning → cycle classifies as `degraded`.
- A Hermes agent inspecting held articles can trigger re-synthesis after additional
  fact-extraction passes or manual editorial override.

---

## 6. Calling the pipeline as an external orchestrator

The `assertCompatibleArtifact` gate from `@ardurai/contracts` is the only shared
dependency you need. Call it on each engine's stdout before passing the artifact to
the next stage.

```typescript
import { assertCompatibleArtifact } from '@ardurai/contracts';

// 1. Run aggregator, capture stdout.
const { envelope: agg } = assertCompatibleArtifact(JSON.parse(aggStdout), 'aggregation');

// 2. Write agg to a temp file, run ranking with it as the first positional arg.
const { envelope: rank } = assertCompatibleArtifact(JSON.parse(rankStdout), 'ranking');

// 3. Write rank + prev-top10 (or '-' for none) + agg, run top10.
const { envelope: top10 } = assertCompatibleArtifact(JSON.parse(top10Stdout), 'top10');

// 4. Write top10 + agg, run synthesizer.
const { envelope: articles } = assertCompatibleArtifact(JSON.parse(synthStdout), 'articles');

// 5. Filter held articles before publishing.
const publishable = articles.data.articles.filter(a => a.editorialStatus !== 'held');
```

Engines are **stateless and idempotent per `cycle.id`**: calling the same engine
twice with the same inputs and the same `cycle.id` in the envelope produces
identical output. The orchestrator may safely retry failed stages.

---

## 7. Tool manifests

Machine-readable tool manifests live next to this document:

| File | Engine |
|------|--------|
| `tool-manifests/aggregator.json` | ardur-news-aggregator |
| `tool-manifests/ranking.json`    | ardur-ranking-engine |
| `tool-manifests/top10.json`      | ardur-top10-engine |
| `tool-manifests/synthesizer.json`| ardur-article-synthesizer |

Each manifest includes the CLI invocation spec, required env vars, input/output
artifact stage names, and an abbreviated JSON Schema for the output envelope.
Load them with `loadToolManifest(docsDir, engineName)` from `src/tool-manifest.ts`.
