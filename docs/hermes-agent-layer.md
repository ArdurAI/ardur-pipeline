# Hermes agent layer — feasibility & target architecture

**Status:** proposed (feasibility pass) · **Owner:** pipeline · **Date:** 2026-06-11

> How an autonomous **Hermes agent** layer takes over content curation + creation by
> orchestrating the four Ardur engines (`ardur-news-aggregator`, `ardur-ranking-engine`,
> `ardur-top10-engine`, `ardur-article-synthesizer`) and the `ardur-pipeline` orchestrator,
> once the engines and `ardur.ai` are fully built and operational.
>
> This is a **planning/feasibility document**. It does not change any engine. It references
> the contract direction in [`docs/integration-plan.md`](./integration-plan.md) and the runtime
> direction in [`docs/deploy-plan.md`](./deploy-plan.md); it does **not** redefine contracts —
> the parallel `@ardurai/contracts` redesign owns those. Agent-readiness changes that the
> engines need are filed as `status:ready` `agent-readiness` issues (linked at the end).

---

## 0. TL;DR

- **We do not need an "agent" to run the pipeline.** Today's `ardur-pipeline` conductor —
  a fixed `aggregate → rank → top10 → synthesize → publish` sequence with a schema gate,
  retries, last-good-wins, atomic publish, and cycle-id idempotency — is the *correct*
  architecture for the mechanical pipeline and should stay. An agent that free-roams over a
  deterministic 4-stage chain is pure overhead.
- **What an agent adds is judgment at specific gates**, not loop control: *which* topics
  deserve an original article this cycle, *whether we have already said everything worth
  saying* about a running story, and *whether a synthesized draft clears editorial QA*. These
  are exactly the decisions the deterministic ranking score and the current rules-based
  editorial gate approximate but cannot reason about.
- **The right shape is "agent-in-the-loop at judgment gates"**: the deterministic pipeline is
  the spine; the Hermes agent is invoked at the **curation gate** (post-top10), the
  **coverage-exhaustion gate**, and the **editorial-QA gate** (post-synthesize). Everything
  the agent produces stays `draft:true` behind the existing review gate — it never publishes
  directly. This matches CONTENT-009 and the `ardur.ai` ingest gate exactly.
- **The single biggest blocker is not the agent — it's that the engines are not yet cleanly
  tool-callable**: four different input conventions, non-deterministic ids/timestamps, raw
  stack-trace errors, no machine-readable tool schema, no `--describe`. These are filed as
  agent-readiness issues and are pure interface hardening (no behaviour change).
- **The second blocker is that the LLM path is not actually exercised** (everything runs the
  deterministic fallback today). Until real models are wired *and* there is an eval/QA harness,
  the agent's judgment cannot be trusted over the deterministic score, so autonomy must ramp
  behind metrics, not a flag flip.

---

## 1. Where we are today (two content systems, converging)

There are **two** content systems in the repo set right now. The architecture below unifies
them; naming this honestly is half the work.

### 1.1 System A — the in-repo "Hermes content engine" (`ardur.ai`)

Lives inside the website repo as `scripts/*.mjs` + `src/lib/aiProvider.mjs` + the
`content-engine/` workspace, scheduled by GitHub Actions.

- **News path:** `refresh-news.mjs → build-news-momentum-signals.mjs →
  build-news-topic-clusters.mjs → build-news-digests.mjs`, writing
  `src/data/newsDigestSnapshot.ts` (consumed at build by `index.astro`, `news/index.astro`,
  `news/signals/[id].astro`, `news-digests.json.ts`). NEWS-009 hard-asserts exactly 10 global
  ranked signals.
- **Article-intelligence path:** `refresh-article-intelligence.mjs` reads the Astro content
  collection + `articleMetrics.json`, writes `src/data/articleIntelligenceSnapshot.ts`.
- **Provider abstraction (`aiProvider.mjs`):** `generateSignalBrief()` supports
  `deterministic` (default), `ollama`, `openai`. With the default provider — and the CI sets
  `ARDUR_AI_PROVIDER` to `deterministic` unless an org var overrides — **every brief is the
  deterministic fallback; no LLM call is made.** Any provider error also falls back. A per-run
  AI budget (`ARDUR_AI_MAX_GENERATIONS`, default 20) forces deterministic after N generations.
- **The editorial gate (the most mature asset in the whole estate).** Three layers:
  1. *Snapshot filter* — `refresh-article-intelligence.mjs` drops `draft:true` /
     `editorialStatus:'idea'`.
  2. *Article validator* — `scripts/validate-articles.mjs`: required frontmatter, enum gates
     (`audience`/`confidence`/`editorialStatus`), **source-trail strength gate** (high/medium
     confidence and `ready`/`published` require ≥1 strong source: primary/code/paper/dataset/
     benchmark), **publication-state gate**, **provenance gate** (`generatedBy {agent, model,
     runId, generatedAt}` on draft/review), body-safety (no raw HTML/MDX/`javascript:`),
     credential-leak scan, canonical-URL equality. Each failure `exit(1)`.
  3. *Ingest gate* — `scripts/content-engine-artifacts.mjs#validateManifest`: **Hermes
     artifacts may not publish directly** (`editorialStatus:'published'` rejected) and must
     keep `draft:true` until human review (CONTENT-009).
- **CONTENT-006…011** delivered: the artifact ABI (`rendered.md` / `manifest.json` /
  `sources.json` / `run-report.json`, `schemaVersion: ardur-content-engine/v1`), website
  ingestion (`content:ingest`), daily planner + scoring (`content-engine-planner.mjs`,
  `ardur-content-plan/v1`), the draft-only review gate, and run-report integrity with secret
  redaction.
- **Schedule:** `.github/workflows/hourly-intelligence.yml` runs `refresh:intelligence` hourly,
  builds, and opens/updates a PR on `automation/hourly-intelligence-refresh` — **never
  auto-merges.** The article-*creation* CLIs (`content:plan` / `content:ingest` /
  `content:crosspost`) exist but **are not wired to any schedule**.

### 1.2 System B — the out-of-process pipeline (`ardur-pipeline` + 4 engines)

The newer, cleaner production spine.

- **`ardur-pipeline`** spawns each engine CLI as a child process in strict order
  (`src/orchestrate.ts#runCycle`, `src/runners.ts#createCliRunners`), passing upstream
  artifacts as scratch-file args and parsing each engine's **stdout** JSON. It imports *no*
  engine code — only `@ardurai/contracts`.
- **Schema gate between every stage** — `parseArtifact()` calls
  `assertCompatibleArtifact(raw, stage)` before casting ("gate before stamp").
- **Resilience** — per-stage bounded retry + backoff, spawn timeouts (SIGKILL), and
  **last-good-wins**: any stage failure after retries publishes nothing, returns `failed`, and
  leaves the previous cycle live. Publish is all-or-nothing via atomic temp-dir/temp-file
  `rename`.
- **Idempotency** — the unit is `cycleId = floor(now, 6h) UTC`; a re-fire of the same cycle is
  a `skipped` no-op. Cross-cycle continuity flows through `loadPreviousTop10()` →
  `Top10Entry.delta` / `carriedOver` / `StabilityReport` (the seed of "have we covered this").
- **Schedule & handoff** — `.github/workflows/cycle.yml` cron `0 */6 * * *`; the final artifacts
  (`manifest.json` + `latest/` + immutable `cycles/<id>/`) are pushed to a `published` orphan
  branch that `ardur.ai` consumes at build by raw HTTPS fetch.
- **Contract** — `@ardurai/contracts` v1.x ↔ wire `ardur-content-pipeline/v1`, two-axis
  versioning (`schemaVersion` hard-fail major key + `contractRevision` additive counter),
  Tier-1 zero-dep gate (mandatory) + Tier-2 Zod (`@ardurai/contracts/zod`, opt-in — `ardur.ai`
  is the first ingestion adopter). **Engines must stay CLIs, not libraries** (integration-plan
  §2.3); only the contract is packaged.

### 1.3 The convergence that this doc assumes

System B (the 6-hour pipeline → `published` branch) is the **production content spine going
forward**. System A's news/article *generation* scripts are superseded by it; what survives
from System A and becomes load-bearing is its **editorial brain**: the `validate-articles`
gate, the ingest review gate, the `generatedBy` provenance contract, and the
source-trail/copyright discipline. The Hermes agent layer sits **on top of System B** and
**reuses System A's editorial gate** as the non-bypassable QA boundary on the creation path.

```
            ┌───────────────────────────── Hermes agent layer (NEW) ─────────────────────────────┐
            │  judgment only, at gates — never owns the mechanical sequence                       │
            │   • curation gate      • coverage-exhaustion gate     • editorial-QA gate           │
            └───────▲───────────────────────▲───────────────────────────▲───────────────────────┘
                    │ tools (typed)          │ coverage memory           │ editorial gate (reused)
   ┌────────────────┴────────────────────────┴───────────────────────────┴─────────────────┐
   │  ardur-pipeline conductor (deterministic spine — KEEP)                                  │
   │   aggregate ─→ rank ─→ top10 ─→ synthesize ─→ publish (atomic, last-good-wins)          │
   └───────▲────────────▲──────────▲──────────────▲────────────────────────────▲────────────┘
       news-aggregator  ranking   top10        synthesizer                 published branch
        (live fetch)    (pure)    (pure)     (LLM-capable)                → ardur.ai @ build
```

---

## 2. Target architecture — the Hermes agent layer

Five concerns, each grounded in a battle-tested pattern from the `hermes-agent` reference
(Nous Research) and the existing Ardur code.

### 2.1 Engines as typed tools (the tool layer)

`ardur-pipeline/src/runners.ts` already **is** a tool adapter in everything but name: it
spawns `node --experimental-strip-types <engineDir>/src/cli.ts`, passes scratch-file args,
captures stdout, and gates with `assertCompatibleArtifact`. Promote it to a first-class
**tool registry** where each engine is one tool with:

- a **declared JSON-Schema input/output** derived from `@ardurai/contracts` (do not hand-author
  — see the `--describe` ask in §4 so the schema is the engine's own truth);
- a **structured error envelope** (`{ error: { code, message, stage, detail } }`) instead of a
  raw stack trace, so a failed tool call is machine-distinguishable from a degraded one;
- an **availability probe** (`check_fn`, TTL-cached) — "is this engine checked out at
  `ENGINES_DIR` and on a compatible contract revision?" — so an unavailable engine drops from
  the tool list instead of erroring mid-loop;
- a **result-size budget** — engine artifacts are large; cap what re-enters the agent context
  (pass a handle/summary, not the full `AggregationArtifact`).

Expose the registry **two ways** (hermes-agent runs both; we likely need both eventually):

1. **Internal registry** for the in-process conductor/agent — fastest path, what `runners.ts`
   becomes.
2. **MCP server** (FastMCP-style, docstring/type-driven schema) living in `ardur-pipeline`,
   exposing `aggregate` / `rank` / `select_top10` / `synthesize` / `check_coverage` as MCP
   tools, so *other* agents (Claude Code, a future web backend, an ops console) can drive the
   pipeline without re-implementing the spawn/gate logic.

> **Tooling note:** the reference's `hermes-agent` declares tools as hand-written JSON-Schema
> dicts; `kimi-cli` declares them as pydantic models per tool (typed, auto-serialised to both
> registry and MCP). For us the schema should come from `@ardurai/contracts` via `--describe`,
> which is strictly better than either — the wire contract is already the source of truth.

### 2.2 The agent runtime — judgment at gates, not loop ownership

A single bounded tool-calling loop (hermes-agent pattern A1: perceive→decide→act→observe,
"no tool calls = done") with **dual budget gates** (A2: an iteration cap *and* a token budget,
with a one-turn grace call so a budget-exhausted run still emits a final report) and an
**inactivity watchdog** (A3: reap on *no activity*, not wall-clock — engine CLIs legitimately
run minutes; aggregate's timeout is already 600s, synth 900s).

But the loop does **not** replace `runCycle`'s fixed sequence. It is invoked at three gates:

| Gate | When | The judgment | Falls back to (today) |
|---|---|---|---|
| **Curation** | after `top10`, before `synthesize` | Of the Top-10 per topic, which stories merit an *original article* this cycle? Which are already covered / not worth a new piece? | synthesize all Top-10 (deterministic) |
| **Coverage-exhaustion** | inside curation, per running story | Have we already said everything worth saying about this ongoing story, or is there a genuinely new angle? | `StabilityReport` + `carriedOver` heuristic |
| **Editorial-QA** | after `synthesize`, before publish-candidate | Does this draft clear quality + originality + source-trail + copyright, beyond what the rules-based gate checks? | `validate-articles.mjs` rules gate |

Each gate is a *typed decision*: the agent returns a structured verdict
(`{ select: topicId[], skip: [{topicId, reason}], angles: {...} }`), the conductor acts on it,
and if the agent is unavailable or over budget the conductor uses the deterministic fallback in
the right column. **This is what makes the design safe to ship incrementally** — every gate has
a working non-agent default, so the agent can be dark-launched (logged, not acted on) before it
holds the wheel.

### 2.3 Coverage memory (the "have we exhausted coverage?" substrate)

Back it with **SQLite + FTS5** (hermes-agent pattern M1) — a single file, no service:

- a `coverage` table keyed by **content fingerprint** (the contract already carries
  `AggregatedItem.fingerprint` = normalized title + canonical URL, and `clusterId`), with
  `topic`, `cycle_id`, `published_at`, `article_slug`, `angle`, and an FTS5 index;
- `state_meta` key/value cursors (`last_cycle_at`, per-source high-water marks) — the same
  escape hatch hermes-agent uses for `last_auto_prune`;
- exposed to the agent as a `check_coverage(topic | fingerprint)` **tool** the curation prompt
  is told to call *before* selecting a story (pattern M2: proactive recall-as-tool).

Honest caveat (from the reference review): **FTS keyword match ≠ semantic dedup.** "Already
covered" for news needs similarity, not string overlap. Use a **two-stage** check: cheap FTS5
prefilter → embedding-similarity (or a cheap-model) confirm. The pipeline's existing
`StabilityReport`/`delta`/`carriedOver` signals are the deterministic seed; coverage memory is
the durable, cross-cycle, queryable upgrade.

> This store is **cross-cycle state the pipeline does not currently keep** — today the only
> memory is `loadPreviousTop10()` (one cycle back). Coverage memory is the single new piece of
> durable state the agent layer introduces. It belongs next to the artifact store (and, like
> it, can be persisted on the `published`/a sibling branch or a small KV in prod).

### 2.4 Provider abstraction & model-per-task

Adopt the reference's `resolve_runtime_provider()` shape (P1): provider selection returns a
neutral runtime descriptor (`provider`, `api_key`, `base_url`, `api_mode`) the agent consumes,
so each gate can pin a **different/cheaper model** — curation judgment on a cheap model, the
editorial-QA verdict on a strong one — without touching orchestration. Reuse the deterministic
fallback that **already exists** in both `ardur.ai/src/lib/aiProvider.mjs` and
`ardur-article-synthesizer` (`ARDUR_AI_PROVIDER=deterministic` / `ARDUR_AI_ENABLED=0`). Add the
reference's explicit **fallback chain** (P2: primary → fallback list → formatted hard-fail) so
a provider outage degrades the cycle to deterministic output (clearly labelled
`provider: deterministic, status: fallback`) rather than dropping it.

### 2.5 Autonomy guardrails (non-negotiable, mostly already present)

| Guardrail | Pattern | How it maps to Ardur |
|---|---|---|
| Non-interactive defaults to **deny** | hermes G1 (`cron_mode`) | The 6h cron runs unattended; the publish/approve step defaults to deny unless an explicit known-safe allowlist is opted in. Mirrors the current "open a PR, never auto-merge". |
| **Hardline floor** below any auto-approve | hermes G2 | Never publish directly (CONTENT-009 already enforces `draft:true`), never force-push the `published` branch, never delete the artifact store / `cycles/` archive. Un-bypassable regardless of autonomy level. |
| Toolset gating, default-off costly tools | hermes G3 | The agent gets exactly the 4 engine tools + `check_coverage`; no messaging/scheduling tools; costly model paths off unless configured (the "surprise \$4.63 run" lesson). |
| **Assembled-prompt injection scan** | hermes G4 | News is untrusted input that flows into a creation prompt — a textbook injection vector. Scan the *fully assembled* prompt (fetched content included) before the auto-approving creation step. Complements the existing `source-safety.mjs` SSRF allow-list and the body-safety gate. |
| Per-run cleanup + atomic writes | hermes G5 | A 6h loop spawning subprocess CLIs *will* leak fds without `finally`-teardown; all state writes stay atomic (the artifact store already is). |
| At-most-once scheduling | hermes S2 (pre-advance + stale fast-forward) | Pipeline already has cycle-id idempotency + GitHub Actions `concurrency` (no two cycles at once); keep that, don't reinvent. |

The editorial gate (`validate-articles` + ingest review gate + source-trail/copyright/
ungrounded-claim gates) is a **hard boundary the agent cannot pass** — fail-closed, exactly as
the synthesizer's copyright/render gates already drop-and-warn. The agent can *propose*; the
gate disposes.

### 2.6 Publishing ready artifacts the website consumes

No change to the consumer contract. The agent's output still flows:

- **News/digests:** through the existing pipeline → `manifest.json` + `latest/` on the
  `published` branch → `ardur.ai` build. The agent only changes *which* topics get synthesized
  and the editorial verdict; the artifact shape and transport are unchanged
  (`@ardurai/contracts` v1).
- **Articles:** synthesized draft → `ArticleArtifact` → ingest as `draft:true` Astro article
  under `src/content/articles/YYYY/MM/<slug>.md` with `generatedBy` provenance → `validate:
  articles` gate → human review (the existing `automation/*` PR flow) → publish. The agent
  **never** sets `editorialStatus:'published'`.

---

## 3. Gaps between today and the target

| # | Gap | Today | Needed | Risk if skipped |
|---|---|---|---|---|
| G1 | **Engines aren't uniformly tool-callable** | 4 different input conventions (aggregator: none; ranking: stdin\|file; top10: positional files; synthesizer: named flags) | One uniform CLI convention (`--in`/`--out`/`--provider`, JSON in/out) | Every tool needs a bespoke adapter; brittle |
| G2 | **No machine-readable tool schema** | schemas live only in `@ardurai/contracts` types | `--describe` emitting each engine's input/output JSON-Schema + version | Hand-authored tool schemas drift from the contract |
| G3 | **Non-deterministic ids/timestamps** | aggregator: `randomUUID` + wall clock + live net; ranking: wall-clock `generatedAt`; synthesizer: wall-clock article `id`/`runId`/`generatedAt` even on the no-LLM path | `--now` + `--run-id` flags (libs already accept `now`) | No idempotent re-runs, no cache keys, e2e flakiness |
| G4 | **Errors aren't structured** | only ranking has a clean one-liner; others emit raw stack traces | JSON error envelope + documented exit codes | Agent can't distinguish "failed" from "degraded" |
| G5 | **`contractRevision` stamped inconsistently** | aggregator + synthesizer stamp `2`; ranking + top10 omit | Stamp consistently in all four | Forward-compat skew warnings; mislabeled producers |
| G6 | **Hidden env-driven network mode** | synthesizer silently flips to OpenAI/Ollama if a key is in env unless `ARDUR_AI_ENABLED=0` | Require explicit `--provider`; never implicit | An agent run silently incurs paid-API cost / non-determinism |
| G7 | **No coverage memory** | only `loadPreviousTop10()` (one cycle back) | SQLite+FTS5 coverage store + `check_coverage` tool | No real "already covered / exhausted" judgment |
| G8 | **LLM path unexercised; no eval harness** | 100% deterministic fallback everywhere | Real providers wired + an eval/QA harness scoring agent verdicts vs. baseline | Agent judgment is unmeasured → can't be trusted over the deterministic score |
| G9 | **`orchestrate.ts` in top10 has no CLI; aggregator has no offline/fixture mode** | library entrypoints / live-only | A fixture/offline mode for deterministic agent + e2e testing | Can't test the agent loop hermetically |
| G10 | **cycle-id precision mismatch** | pipeline emits ms ISO ids; top10 emits minute-precision | Align cycle-id formatting | Soft cycle-consistency warnings, e2e workarounds |
| G11 | **Two content systems** | `ardur.ai` in-repo scripts + the pipeline both produce content | Decide convergence: pipeline = spine, in-repo editorial gate = reused QA | Duplicated, drifting logic |

G1–G6, G9, G10 are **pure interface hardening — no behaviour change** — and are filed as
agent-readiness issues (§6). G7 is new infra (pipeline-side). G8 and G11 are programme-level
decisions, not engine changes.

---

## 4. The one architectural ask of the engines: `--describe` + uniform CLI

Everything in §3's G1–G6 collapses into a single, cheap, behaviour-preserving convention every
engine adopts:

```
node --experimental-strip-types src/cli.ts --describe
  → { name, stage, contract: { schemaVersion, contractRevision },
      input: <JSON-Schema>, output: <JSON-Schema>, flags: [...] }

node --experimental-strip-types src/cli.ts --in <file|-> --out <file|-> \
     --provider deterministic --now <iso> --run-id <id> [--json-errors]
  → artifact JSON on stdout (or --out); logs on stderr;
    on failure: { error: { code, message, stage, detail } } + non-zero exit
```

This makes each engine a **self-describing, deterministic, uniformly-invoked typed tool**. The
tool layer (§2.1) and MCP server self-register from `--describe`; the agent gets idempotent
re-runs from `--now`/`--run-id`; failures become machine-distinguishable. It is the highest-
leverage agent-readiness change and is **fully feasible now** — the engine library functions
(`runXxx(opts)`) already accept `now`; only the CLI surface is missing.

> **Coordinate with the `@ardurai/contracts` redesign:** `--describe` should emit the schema
> *from the contract package* (ideally a `describeStage(stage)` helper the contract exports),
> not a hand-maintained copy. This is a request to the contract direction
> ([`integration-plan.md`](./integration-plan.md)), not a redefinition of it — the doc here
> assumes the two-axis (`schemaVersion` + `contractRevision`), CLIs-not-libraries, Tier-1/Tier-2
> model stands.

---

## 5. Phased path (engines+site operational → agent takes over)

Each phase is independently shippable and leaves a working system.

- **Phase 0 — Operational spine (≈now).** Engines + `ardur-pipeline` run the deterministic 6h
  cycle, publishing to the `published` branch; `ardur.ai` consumes it at build. No agent.
  *Exit:* a green cycle end-to-end in CI with the contract gate enforced.

- **Phase 1 — Agent-ready engines (interface hardening, no behaviour change).** Land G1–G6,
  G9, G10: uniform `--in/--out/--provider`, `--now/--run-id`, `--describe`, JSON errors,
  consistent `contractRevision`, fixture mode, cycle-id alignment. Coordinate `--describe`
  schema source with the contracts redesign. *Exit:* every engine self-describes and runs
  byte-deterministically given `--now/--run-id`; e2e passes hermetically.

- **Phase 2 — Tool layer + MCP + coverage memory (still deterministic conductor).** Promote
  `runners.ts` to a tool registry; stand up the `ardur-pipeline` MCP server; build the
  SQLite+FTS5 coverage store + `check_coverage`. The conductor now calls tools through the
  registry and consults coverage memory for dedup, but the *sequence is still fixed*. **Dark-
  launch the agent**: it observes each gate and logs the verdict it *would* have made; nothing
  acts on it. *Exit:* agent verdicts logged for ≥N cycles; coverage dedup measurably reduces
  duplicate stories vs. the `StabilityReport` baseline.

- **Phase 3 — Agent at the judgment gates (behind deny-default, draft-only).** Wire real
  providers + an eval harness (G8). Insert the agent at the curation, coverage-exhaustion, and
  editorial-QA gates. Output stays `draft:true` behind the existing review gate; the
  `automation/*` PR flow + human review is unchanged. Guardrails G1–G5 (§2.5) fully on. *Exit:*
  agent-curated cycles match-or-beat the deterministic baseline on the eval harness; no
  editorial-gate regressions; reviewers approve at the historical rate.

- **Phase 4 — Progressive autonomy.** Only after Phase 3 metrics hold: expand the auto-approve
  allowlist for known-safe publishes within the hardline floor; give the agent more *creation*
  latitude (article angle, series planning, cross-posting via `content:crosspost`); enable
  model-per-task routing. The hardline floor (G2) and the editorial gate never move. *Exit:* a
  defined, reversible autonomy ladder with a kill-switch back to Phase 2's deterministic
  conductor.

---

## 6. Honest feasibility — now vs. later

**Feasible now (low risk, parts already exist):**
- Wrapping engines as typed tools — `runners.ts` is 80% of it.
- `--describe` + uniform CLI + `--now/--run-id` — library functions already accept `now`.
- Coverage memory (SQLite+FTS5) and an MCP server — standard, no new external services.
- Reusing the editorial gate as the QA boundary — it is the most mature asset in the estate.
- A deterministic conductor that consults coverage memory for dedup — no LLM required.

**Feasible only later (needs real models + measurement):**
- Genuine curation *judgment* that beats the deterministic ranking score. Until the LLM path is
  wired and there is an eval harness, an agent here is unmeasured and likely *worse* than the
  score it replaces.
- "Have we exhausted coverage?" reasoning beyond similarity dedup.
- Any **auto-publish** autonomy — gated behind Phase 3 metrics and the human-review track
  record; the safe default (PR + human review) should persist well into Phase 4.

**The blunt version:** the engines and pipeline being "fully built and operational" is
necessary but **not sufficient** for the agent to add value. The agent earns its place only
once (a) the engines are cleanly tool-callable (Phase 1), (b) real models are in the loop with
an eval harness (Phase 3 prerequisite), and (c) coverage memory exists (Phase 2). Before that,
the deterministic pipeline *is* the correct answer and an agent is overhead we should not ship.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| **Prompt injection** from untrusted news into the creation prompt | Assembled-prompt injection scan (G4 pattern) + existing `source-safety` SSRF allow-list + body-safety gate; provenance on every draft |
| **Cost runaway** on an unattended loop | Dual budgets (iteration + token) with grace call; default-off costly model paths; deterministic fallback; per-tool result-size budget |
| **Hallucination / fabrication** | Existing hard gates — source-trail (≥1 strong source), copyright (<25-word quotes), ungrounded-claim drop — are fail-closed and un-bypassable by the agent |
| **Non-determinism / lost idempotency** | `--now`/`--run-id` (G3); cycle-id as the idempotency key; at-most-once scheduling already in place |
| **Agent judgment worse than the score** | Dark-launch (Phase 2) + eval harness (Phase 3) gate before the agent holds the wheel; every gate has a deterministic fallback |
| **Semantic dedup is hard** | Two-stage coverage check (FTS prefilter → embedding/cheap-model confirm); deterministic `StabilityReport` as the floor |
| **Contract drift** | Reference `@ardurai/contracts` as the single source; `--describe` emits the contract's own schema; do not fork |
| **Two-system duplication erodes** | Explicit convergence (§1.3): pipeline = spine, in-repo editorial gate = reused QA; retire System A's *generation* scripts, keep its *gate* |
| **Over-automation erodes quality** | Keep PR + human review through Phase 3; reversible autonomy ladder with a kill-switch to the deterministic conductor |

---

## 8. References

- [`docs/integration-plan.md`](./integration-plan.md) — `@ardurai/contracts` direction
  (two-axis versioning, Tier-1/Tier-2, CLIs-not-libraries). **Authoritative for contracts; this
  doc references, does not redefine.**
- [`docs/deploy-plan.md`](./deploy-plan.md) — runtime/transport (GitHub Actions → `published`
  branch → Cloudflare Pages).
- [`docs/spec.md`](./spec.md) — pipeline orchestrator spec.
- `ardur.ai`: `scripts/validate-articles.mjs`, `scripts/content-engine-artifacts.mjs`,
  `src/lib/aiProvider.mjs`, `.github/workflows/hourly-intelligence.yml`, `PROJECT.md` (Epic 2,
  CONTENT-006…011).
- Pattern source: `hermes-agent` reference (bounded loop + budgets + cron at-most-once +
  SQLite/FTS5 state + provider fallback + autonomy guardrails); `kimi-cli` (typed pydantic
  tools); `codex` (typed function-tool errors).

---

## 9. Agent-readiness issues filed

Filed as `status:ready` + `agent-readiness` on each repo (see the session report for live
links):

- **ardur-news-aggregator** — uniform CLI + `--in/--out`; `--now/--run-id` (kill `randomUUID`/
  wall-clock on the default path); offline/fixture mode; `--describe`; JSON errors;
  `contractRevision` stamp.
- **ardur-ranking-engine** — `--now` flag (deterministic `generatedAt`); `--describe`; JSON
  error envelope; stamp `contractRevision`.
- **ardur-top10-engine** — `--in/--out` + stdin support; collapse positional-arg/`-` ergonomics;
  `--describe`; `contractRevision` stamp; give `orchestrate.ts` a CLI or drop the script target;
  align cycle-id precision.
- **ardur-article-synthesizer** — `--now/--run-id` (deterministic ids/timestamps on the no-LLM
  path); require explicit `--provider` (no implicit env network mode); `--describe`; JSON
  errors.
- **ardur-pipeline** — promote `runners.ts` to a tool registry; add the MCP server; add the
  SQLite+FTS5 coverage store + `check_coverage`; dark-launch agent verdict logging at the gates.
