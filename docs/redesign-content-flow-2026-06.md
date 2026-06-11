# Redesign: Fact-Grounded, AI-Primary, Visually-Rich Content Flow

**Status:** Design — approved for implementation (issues filed `status:ready`)
**Date:** 2026-06-11
**Owner:** Content pipeline (4 engines + contracts + ardur.ai render)
**Schema impact:** `ardur-content-pipeline/v1` unchanged; `CONTRACT_REVISION` 2 → 3 (purely additive)

---

## 0. TL;DR

Today the pipeline produces **headline paraphrase**, not journalism. The synthesizer never
sees an article body — it receives `title + summaryHint (≤250 chars of RSS metadata) + source
links`, and (in CI) runs the **deterministic** path by default, which templates flat prose out of
those titles. The provenance "gate" only checks that claim tokens overlap with **source titles**,
so it cannot catch a hallucinated fact and cannot ground a real one.

This redesign rebuilds the spine **collect → read → extract → synthesize → render** so Ardur
publishes substantive, fact-grounded, AI-written, visually-rich articles:

1. **SOURCING** — uncapped per-topic ingestion across the 155-feed catalog **plus** per-topic
   search discovery; an owned ETL that fetches, extracts, dedups, normalizes, and **stores**.
2. **READ & EXTRACT** — fetch full article text where ToS/robots allow (paywalled → snippet +
   flagged), and extract **structured facts/claims, each tagged with per-source provenance**.
   This *replaces* the title+hint input to the synthesizer. **No assumptions** — nothing is
   asserted that is not grounded in an extracted source fact.
3. **SYNTHESIZE** — **AI-primary** (Ollama primary, keys from env/secret store, optional API).
   The LLM writes every article from the extracted facts, full-length, GenZ-but-professional.
   Deterministic becomes a **last-resort that HOLDS** the piece rather than publishing flat text.
   A **claim-level provenance gate** requires every factual statement to trace to ≥1 (prefer ≥2
   corroborating) source facts.
4. **RENDER** — extend the in-app `ArticleBlock[]` contract with **chart** (from the real
   extracted numbers), **image**, **embed**, and **gif/animation** blocks (openly-licensed or
   generated media only), plus the Astro components to render them.
5. **COPYRIGHT** — safe by **original expression + short quotes (<25 words) + attribution +
   canonical links**, *not* by refusing to read. Bodies are stored privately for extraction and
   never emitted on the wire.
6. **HERMES-READY** — every engine exposes a typed, documented tool interface and the pipeline
   emits a stable artifact, so a Hermes agent can orchestrate the engines later.

The keystone is **`@ardurai/contracts` rev 3** (owned here): `ExtractedFact`, `FactProvenance`,
`SourceDocument`, the richer visual `ArticleBlock` union, and an uncapped source set — all
additive, gate-safe, and referenced by the parallel Hermes workstream.

---

## 1. Current state (grounded in code, 2026-06-11)

| Stage | Repo | What actually happens today | The flaw |
|---|---|---|---|
| Collect | `ardur-news-aggregator` | RSS/Atom over a **155-feed catalog** (143 active) + **per-topic Google News RSS** discovery. `diversityFloor: 20` is a **lower** bound, not a cap. Output = `AggregatedItem` carrying `summaryHint` (≤250 chars, feed `<description>`) and `claims?: string[]` (≤5 keyword strings). | **No bodies fetched.** Stateless — nothing stored. `claims[]` are keywords, not facts. |
| Rank | `ardur-ranking-engine` | 4 signals (corroboration, technical significance, source tier, engagement) over cluster metadata. | Corroboration is domain-count, not **fact-level** agreement. |
| Top-10 | `ardur-top10-engine` | Selects 10, attaches `references: SourceRef[]` **capped at 5**. | Caps the very source breadth we want; passes no facts. |
| Synthesize | `ardur-article-synthesizer` | Input = `headline + references[] (metadata) ` — `references.slice(0,10)`, **never bodies**. LLM path exists (Ollama/OpenAI) but **defaults to `deterministic`**; provenance gate matches claim tokens vs `source.title+domain` (weak). Emits `paragraph`/`heading` blocks only. | **Paraphrases headlines.** Deterministic *publishes* flat templated text. Gate can't ground or refute a fact. No visual blocks. |
| Render | `ardur.ai` | Articles render as **Markdown content collections** (`getCollection('articles')` → `<Content />`), not `ArticleBlock[]`. No chart/image/embed lib. News-panel hover is **stubbed**. | The structured render contract is unused; rich media impossible. |
| Orchestrate | `ardur-pipeline` | Spawns 4 engine CLIs as subprocesses (JSON in/out), GitHub Actions cron `0 */6 * * *`, publishes `manifest.json` + `latest/*.json`. Gate via `assertCompatibleArtifact`. | Strong spine; no fact/ETL stage, no tool-manifest for Hermes. |

**The single highest-leverage fix:** put **extracted facts with provenance** in front of the
synthesizer and make the LLM the primary writer. Everything else composes around that.

---

## 2. Target architecture

```
                         ┌─────────────────────── ETL store (owned, persistent) ───────────────────────┐
                         │  raw_html · extracted_body (PRIVATE) · normalized_doc · facts · dedup index   │
                         └──────────────────────────────────────────────────────────────────────────────┘
                                          ▲ store/read            ▲ store/read
  discovery                 read+extract  │      fact extraction  │
  ┌───────────────┐  uncapped ┌──────────┴──────┐  ┌─────────────┴────────┐
  │ 155-feed cat. │──────────▶│  full-text fetch │─▶│ ExtractedFact[]      │
  │ + per-topic   │  cluster  │  (robots/ToS;    │  │  + FactProvenance    │──┐
  │   search      │           │  paywall→snippet)│  │  + SourceDocument[]  │  │
  └───────────────┘           └──────────────────┘  └──────────────────────┘  │
        ardur-news-aggregator (now an ETL)                                     │ AggregationArtifact (rev 3)
                                                                               ▼
                                              ┌───────────────────────────────────────┐
                                              │ ardur-ranking-engine                   │
                                              │  + fact-level corroboration signal     │
                                              └───────────────────┬───────────────────┘
                                                                  ▼ RankingArtifact
                                              ┌───────────────────────────────────────┐
                                              │ ardur-top10-engine                     │
                                              │  uncapped source set + facts passthrough│
                                              └───────────────────┬───────────────────┘
                                                                  ▼ Top10Artifact (+ facts)
                                              ┌───────────────────────────────────────┐
                                              │ ardur-article-synthesizer (AI-PRIMARY) │
                                              │  writes FROM facts · claim provenance  │
                                              │  gate · chart/image/embed/gif blocks   │
                                              │  deterministic = HOLD (never flat-pub) │
                                              └───────────────────┬───────────────────┘
                                                                  ▼ ArticleArtifact (rich blocks)
                                              ┌───────────────────────────────────────┐
                                              │ ardur.ai render: block components,     │
                                              │  charts from real numbers, hover summary│
                                              └───────────────────────────────────────┘
```

**Design invariants (owner's hard rules, encoded):**
- **No assumptions.** A factual sentence ships only if it traces to ≥1 `ExtractedFact`. Prefer ≥2
  corroborating sources; single-source facts are publishable but flagged `confidence: low`.
- **Read, don't reproduce.** Bodies are fetched and stored **privately** for extraction; the wire
  artifact carries facts (original expression), short quotes (<25 words), and canonical links only.
- **AI-primary, fail to HOLD.** The LLM writes. If it can't be grounded, the piece is **held**
  (`editorialStatus: held`), not published as flat deterministic text.

---

## 3. SOURCING — uncapped ingestion + owned ETL

### 3.1 Remove the ceilings (they're downstream, not in the aggregator)
The aggregator already has **no upper cap** — `diversityFloor` is a floor. The effective ceiling
lives downstream:
- `Top10Entry.references` **capped at 5** (`select.ts`).
- Synthesizer `references.slice(0, 10)` (`provider.ts`).

**Action:** the cap becomes a **render/display** concern, never a data concern. Top-10 and the
synthesizer carry the **full** source set; ardur.ai decides how many chips to show. Practical
limits only: fetch budget, de-dup, paywall/ToS.

### 3.2 Discovery beyond the catalog
Per topic, ingest **all** clustered coverage from the 155-feed catalog **plus** search discovery:
- Keep the existing per-topic **Google News RSS** query.
- Add a pluggable `SearchProvider` interface (Google News today; Bing News / Brave / DuckDuckGo
  News as drop-in providers behind the same interface and the existing SSRF allowlist).
- Newly-discovered domains are tier-classified via the existing `news-source-policy.md` rules; an
  unknown domain defaults to `tier: news`, `credibilityHint: 0.6`, and is logged for catalog review.

### 3.3 The ETL (owned — worthwhile, spec'd)
The aggregator graduates from a stateless RSS reader to a small **ETL with a persistent store**.
This is worth building: full-text extraction, dedup across cycles, change-detection, and a fact
store are all stateful and reused by ranking + synthesis.

**Stages (all SSRF-guarded via existing `source-safety.ts` allowlist + bounded reads):**
1. **Discover** — catalog feeds + search providers → candidate URLs per topic.
2. **Fetch** — `GET` the article. Respect `robots.txt` (cache per-host, honor `Crawl-delay`),
   `User-Agent: ArdurContentBot (+https://ardur.ai/bot)`, per-host concurrency + politeness delay,
   bounded body read, redirect policy `error`, timeout. Conditional `If-None-Match`/`If-Modified-Since`
   against the store to skip unchanged pages.
3. **Classify access** — `allowed` | `paywalled` | `robots-disallowed` | `tos-restricted`.
   Paywall heuristics (meta `isAccessibleForFree=false`, known paywall selectors, truncated body).
4. **Extract** — main-content extraction (Readability/`@mozilla/readability` or `trafilatura`-class
   in a worker) → `{ body, lang, wordCount, contentHash }`. `paywalled`/`disallowed` → snippet-only.
5. **Normalize** — strip boilerplate, canonicalize URL (no PII/fragment), UTC dates.
6. **Dedup** — existing title+url fingerprint **plus** `contentHash` (catches syndication/repost).
7. **Store** — persist `SourceDocument` (+ private `body`) keyed by `contentHash`/`id`.

**Store choice (pragmatic, CI-friendly):** start with a content-addressed JSON/NDJSON store on the
published-artifacts branch sibling (`etl-store/`), keyed by `sourceDocId`, with a per-topic dedup
index. Bodies live **only** in this store, **gitignored from any public mirror**, never on the wire.
SQLite is the upgrade path when the store outgrows flat files; the `EtlStore` interface is defined
so the backend can swap without touching callers.

```ts
interface EtlStore {
  getByContentHash(hash: string): Promise<SourceDocument | null>;
  getBody(sourceDocId: string): Promise<string | null>;   // PRIVATE; never serialized to wire
  put(doc: SourceDocument, body: string | null): Promise<void>;
  hasFresh(url: string, etag?: string, lastModified?: string): Promise<boolean>;
}
```

---

## 4. READ & EXTRACT — facts with provenance

This stage **replaces `title + summaryHint`** as the synthesizer's input.

### 4.1 Fact extraction (AI-primary, deterministic floor)
For each cluster, run an extraction pass over the stored bodies:
- **Primary:** Ollama (env-configured model) with a strict JSON schema, prompted to emit **atomic,
  original-expression** statements — each tagged to the `sourceDocId` it came from, with an optional
  `quote` (<25 words verbatim) and structured `quantity` for any number.
- **Floor:** when the LLM is unavailable, a deterministic extractor still produces structured facts
  from sentence-level patterns (numbers/units/dates/named entities) so ranking never starves — but
  **synthesis** treats a fact-poor cluster as a HOLD, never as license to invent.

**Hard rules baked into the extractor:**
- Every `ExtractedFact` carries ≥1 `FactProvenance{ sourceDocId, url, quote? }`.
- `corroboration` = count of **distinct source domains** asserting the fact (fuzzy-matched).
- Numbers populate `quantity{ metric, value, unit, asOf }` so the synthesizer can build charts from
  **real** figures (no invented data points).
- No fact without provenance is ever emitted. The store keeps the body for audit; the wire keeps the
  fact + short quote + link.

### 4.2 What flows on the wire
`AggregationData` gains (additive) `documentsByTopic: SourceDocument[]` and
`factsByCluster: Record<clusterId, ExtractedFact[]>`. Bodies are **not** included.

---

## 5. SYNTHESIZE — AI-primary, claim-provenance gated, visually rich

### 5.1 Input change
`GenerateRequest` replaces `headline + references` with **`facts: ExtractedFact[]`** (plus references
for attribution and the cluster headline as a hint). The prompt instructs the model to write the
article **only from the facts**, citing fact IDs inline so the gate can map sentences → facts.

### 5.2 AI-primary
- **Primary provider: Ollama** (`ARDUR_AI_PROVIDER=ollama`), endpoint + model + key read from
  env/secret store (`OLLAMA_HOST`, `OLLAMA_API_KEY`, `OLLAMA_MODEL`) — **never hardcoded**.
- Optional hosted API (`openai`) behind the same `AiProvider` interface, key from env.
- Full-length article, **GenZ-but-professional** voice (`ardur-voice/genz-professional/v1`,
  already specced) — keep the voice lint + banned lexicon.

### 5.3 Deterministic = HOLD, not flat-publish
The deterministic path **no longer publishes**. When the LLM is unavailable or every grounding
attempt fails, the article is emitted with `editorialStatus: 'held'` and a reason; the pipeline
**does not** publish held pieces to readers (they surface in the editorial queue / `draft`). This
kills the "flat headline paraphrase shipped to prod" failure mode.

### 5.4 Claim-level provenance gate (the core correctness gate)
Replace the title-token heuristic with a **fact-grounded** gate:
1. Split the article into claim-bearing sentences (skip explicitly editorial/transition lines).
2. For each factual sentence, require a mapping to ≥1 `ExtractedFact` (by inline fact-ID citation,
   reinforced by entity/number/semantic overlap as a backstop against bad citations).
3. **Publish** only if every factual sentence is grounded. **Prefer ≥2 corroborating** sources —
   sentences grounded in a single-source fact are allowed but tagged `confidence: low` and rendered
   with a "single-source" marker.
4. Ungrounded sentence ⇒ one bounded re-ask ("ground or drop this sentence"); still ungrounded ⇒
   **HOLD** the article (never silently degrade to flat text).

Copyright gate (25-word quote cap, 8-gram verbatim screen, canonical-link + attribution
requirement, credential screen) stays and runs **after** the provenance gate.

### 5.5 Visual blocks from real data
The synthesizer emits the new `ArticleBlock` variants:
- **`chart`** — built **only** from `ExtractedFact.quantity` values; every datapoint carries
  `factIds` and a source attribution footer. No invented numbers.
- **`image`** / **`gif`** — only `origin: 'generated'` or `origin: 'openly-licensed'` (license
  required), with `MediaProvenance`. (Generated media is produced by an image/gif step; openly-licensed
  pulls from CC0/CC-BY catalogs.)
- **`embed`** — allowlisted providers only.

---

## 6. CONTRACTS — rev 3 (owned here; additive, gate-safe)

`SCHEMA_VERSION` stays `ardur-content-pipeline/v1`. Bump `CONTRACT_REVISION` 2 → 3. All additions are
**optional fields / new union members**; rev-2 consumers ignore them, and the `assertCompatibleArtifact`
gate is unaffected. **Renderer rule:** unknown `ArticleBlock.type` ⇒ skip (or render a link-out
fallback), never throw.

```ts
// ── Rev 3: read/extract layer ───────────────────────────────────────────────
export type ExtractionStatus = 'full' | 'snippet' | 'failed';
export type AccessPolicy = 'allowed' | 'paywalled' | 'robots-disallowed' | 'tos-restricted';

/** Metadata for a fetched source article. The BODY is never serialized here —
 *  it lives only in the private ETL store for extraction + audit. */
export interface SourceDocument {
  id: string;                 // stable id (hash of canonical url)
  url: string;                // canonical, no PII/fragment
  source: string;
  sourceDomain: string;
  tier: SourceTier;
  title: string;
  publishedAt: string;
  fetchedAt: string;
  extraction: ExtractionStatus;
  accessPolicy: AccessPolicy;
  wordCount: number | null;
  lang: string | null;
  contentHash: string;        // dedup / change-detection
}

export interface FactProvenance {
  sourceDocId: string;        // → SourceDocument.id
  sourceDomain: string;
  url: string;                // canonical link for attribution
  quote?: string;             // optional verbatim support, < 25 words
}

/** An atomic, original-expression fact extracted from one or more bodies. */
export interface ExtractedFact {
  id: string;
  topic: string;
  clusterId: string;
  statement: string;          // original expression, not a copied sentence
  quantity?: {                // present when the fact is quantitative → charts
    metric: string;
    value: number;
    unit?: string;
    asOf?: string;            // ISO date the figure refers to
  };
  entities: string[];
  provenance: FactProvenance[];   // length >= 1, ALWAYS
  corroboration: number;          // distinct source domains, >= 1
  confidence: Confidence;
  extractedBy: ProviderMeta;
}

// AggregationData gains (additive):
//   documentsByTopic?: Record<string, SourceDocument[]>;
//   factsByCluster?:  Record<string, ExtractedFact[]>;

// ── Rev 3: visual render blocks ──────────────────────────────────────────────
export interface MediaProvenance {
  origin: 'generated' | 'openly-licensed';
  license?: string;           // required when openly-licensed (e.g. "CC0", "CC-BY-4.0")
  creator?: string;
  sourceUrl?: string;
}

/** Existing 5 text types, unchanged. */
export interface TextBlock {
  type: 'paragraph' | 'heading' | 'list' | 'quote' | 'callout';
  text?: string;
  items?: string[];
  attribution?: { source: string; url: string };
}
export interface ChartBlock {
  type: 'chart';
  chartType: 'bar' | 'line' | 'area' | 'scatter' | 'pie';
  title: string;
  series: Array<{ label: string; value: number; unit?: string }>;  // from ExtractedFact.quantity ONLY
  factIds: string[];          // → ExtractedFact.id (every datapoint traces back)
  caption?: string;
  attribution: { sources: { source: string; url: string }[] };
}
export interface ImageBlock { type: 'image'; src: string; alt: string; caption?: string; media: MediaProvenance; }
export interface GifBlock   { type: 'gif';   src: string; alt: string; poster?: string; media: MediaProvenance; }
export interface EmbedBlock { type: 'embed'; provider: string; url: string; title?: string; }

/** Additive union — text variant preserved for backward compat. */
export type ArticleBlock = TextBlock | ChartBlock | ImageBlock | GifBlock | EmbedBlock;

// ── Rev 3: uncapped source set ───────────────────────────────────────────────
// Top10Entry.references: cap is REMOVED (display cap moves to the renderer).
// Top10Entry gains (additive): sourceDocIds?: string[]   // full uncapped provenance set
// SynthesizedArticle gains (additive):
//   editorialStatus?: 'published' | 'held' | 'draft';
//   facts?: ExtractedFact[];   // the grounding set used (for the source-trail UI)
```

Zod mirrors (`@ardurai/contracts/zod`) get the same additions with `.passthrough()` retained for
forward-compat. README versioning table updated; rev-3 note added.

---

## 7. RENDER — ardur.ai components (site-side issues)

The site currently renders Markdown. To render `ArticleBlock[]` (and reap the rich blocks):
- **Block renderer**: `src/components/ArticleBlocks/` with one component per type —
  `TextBlock.astro`, `ChartBlock.astro`, `ImageBlock.astro`, `GifBlock.astro`, `EmbedBlock.astro`,
  and an `ArticleBlocks.astro` dispatcher (`switch(block.type)` with an unknown-type skip fallback).
- **Charts within budget**: render charts as **server-built inline SVG** (no client charting lib) to
  respect the 200 KiB-gz JS / 16 KiB-gz CSS budgets — datapoints come straight from `ChartBlock.series`.
  A tiny progressive-enhancement script (Intersection-Observer reveal) only if it fits the 8 KiB-gz
  entry budget.
- **Images/gifs**: Astro image pipeline (lazy, format negotiation); gifs as looping `<video>` where
  possible; every asset shows its `MediaProvenance` (license/creator). Per-block media weight budget.
- **Embeds**: sandboxed `<iframe>` from an allowlist only.
- **Source trail**: render the full uncapped source set + per-fact provenance (links + short quotes),
  with a "single-source" marker on `confidence: low` claims.
- **News-panel hover → interactive scrolling summary**: replace the stubbed/truncated/duplicated
  hover with a real scrolling reveal (`max-height` + `overflow-y:auto`, fade affordance, smooth
  auto-scroll on hover), touch + screen-reader parity, `prefers-reduced-motion` respected, within the
  news-interaction latency budget (160 ms desktop / 220 ms mobile).

These extend `docs/content-engine-contract.md` on ardur.ai (the manifest/rendered ABI) to carry
`blocks: ArticleBlock[]` alongside the existing markdown body during migration.

---

## 8. COPYRIGHT posture

Safe **because** we read, not by refusing to:
- Bodies fetched only where robots/ToS allow; **stored privately**, never emitted on the wire, never
  in any public mirror of the store.
- Wire carries **original-expression facts** + **short quotes (<25 words)** with attribution +
  **canonical links**. Existing 8-gram verbatim screen and 25-word quote cap stay, now also applied to
  `FactProvenance.quote`.
- Paywalled / `robots-disallowed` ⇒ **snippet-only + flagged**; never extracted in full.
- Generated/licensed media only; license recorded in `MediaProvenance`.

---

## 9. HERMES-READY

- **Typed tool-manifest per engine** (`tool-manifest.json`): `{ name, description, inputSchema,
  outputSchema, cli }` where the schemas reference `@ardurai/contracts` (generated from the Zod
  schemas). Each engine already is a pure JSON-in/JSON-out CLI — the manifest makes that
  machine-discoverable.
- **Stable emitted artifact**: `ardur-pipeline` already publishes `manifest.json` + `latest/*.json`
  under a versioned schema; rev-3 additions are additive so the artifact stays stable. Document the
  artifact ABI as the Hermes hand-off contract.
- **Orchestration parity**: a Hermes agent can call the same CLIs (or an MCP shim wrapping them) in the
  same order with the same gate. No engine holds session state; all are idempotent per `cycle.id`.

---

## 10. Rollout (filed as `status:ready` issues)

Order respects dependencies: **contracts rev 3 first**, then ETL/extraction, then synthesis, then
render; ranking/top-10/pipeline/Hermes wire through.

| # | Repo | Issue | Depends on |
|---|---|---|---|
| C1 | ardur-contracts | Rev 3 additive schema: `ExtractedFact`, `FactProvenance`, `SourceDocument`, visual `ArticleBlock` union, `MediaProvenance`, uncapped source set; bump `CONTRACT_REVISION`→3; Zod mirrors | — |
| A1 | ardur-news-aggregator | Remove downstream source ceilings; uncapped per-topic ingestion (budget/dedup only) | C1 |
| A2 | ardur-news-aggregator | Per-topic search discovery beyond catalog (`SearchProvider` interface) | C1 |
| A3 | ardur-news-aggregator | ETL: full-text fetch + extraction (robots/ToS; paywall→snippet+flag), normalize, persistent store | C1, A1 |
| A4 | ardur-news-aggregator | Fact extraction (AI-primary) → emit `ExtractedFact[]` + `SourceDocument[]` with per-source provenance | C1, A3 |
| A5 | ardur-news-aggregator | ETL copyright guard: store bodies privately; emit facts + <25-word quotes + canonical links only | C1, A3 |
| R1 | ardur-ranking-engine | Fact-level corroboration signal; pass facts through | C1, A4 |
| T1 | ardur-top10-engine | Uncapped source set + facts passthrough; remove `references` cap | C1, A4 |
| S1 | ardur-article-synthesizer | Consume `ExtractedFact[]` as primary input (replace title+hint) | C1, A4 |
| S2 | ardur-article-synthesizer | AI-primary (Ollama primary, env keys); deterministic → last-resort **HOLD** | C1, S1 |
| S3 | ardur-article-synthesizer | Claim-level provenance gate vs facts (≥1, prefer ≥2); fail-closed/HOLD | C1, S1 |
| S4 | ardur-article-synthesizer | Emit visual blocks: chart from real numbers, image/embed/gif + media provenance | C1, S1 |
| P1 | ardur-pipeline | Wire ETL/fact-extraction + AI-primary stages; honor `held` status (don't publish flat) | A4, S2 |
| P2 | ardur-pipeline | Hermes-ready: per-engine typed `tool-manifest.json` + documented stable artifact ABI | C1 |
| W1 | ardur.ai | Render new `ArticleBlock` variants (Chart/Image/Gif/Embed Astro components) within perf budgets | C1, S4 |
| W2 | ardur.ai | News-panel hover → interactive scrolling summary | — |
| W3 | ardur.ai | Adopt rev-3 contract at ingestion gate (Zod); render facts/provenance + uncapped source trail | C1, S1 |

**Acceptance for the whole redesign:** a cycle produces ≥1 article where (a) every factual sentence
maps to an `ExtractedFact` with provenance, (b) at least one `chart` block is built from real
extracted numbers, (c) the LLM wrote it (provider≠deterministic, status≠fallback), and (d) a
fact-starved topic is **held**, not published flat.
