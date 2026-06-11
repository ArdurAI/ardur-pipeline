# Ardur content pipeline — integration plan

**Status:** proposed · **Owner:** pipeline · **Date:** 2026-06-11

This plan addresses the two cross-repo weaknesses the 2026-06 QA review surfaced:

1. **schemaVersion contract gate** — version drift between repos currently fails
   *silent* (silent NaN, re-stamped/mislabelled output) instead of failing *loud*.
2. **Engine packaging** — how `ardur.ai` and `ardur-pipeline` should consume the
   engines and the shared contract, replacing today's byte-identical `contracts.ts`
   copies.

It is a planning document. No engine behaviour changes here; execution is tracked
by the coordinated `status:ready` issues listed in [§4](#4-coordinated-issues).

---

## 0. Current state (as built)

| Fact | Evidence |
| --- | --- |
| `SCHEMA_VERSION = 'ardur-content-pipeline/v1'` and `ArtifactEnvelope.schemaVersion` already exists | `contracts.ts` (all repos) |
| `contracts.ts` is vendored **byte-identical** across 5 repos (4 engines + pipeline) and is **already drifting** | `ardur-news-aggregator/src/contracts.ts` has `claims?: string[]`; the other four do **not** |
| Engines read upstream input as `JSON.parse(raw) as XArtifact` with **no version/structural check** | `ardur-ranking-engine/src/cli.ts:13`, `ardur-top10-engine/src/cli.ts:19`, `ardur-article-synthesizer/src/cli.ts:50` |
| Every engine **re-stamps** output with its *own local* `SCHEMA_VERSION` | `ardur-ranking-engine/src/index.ts:354`, `ardur-top10-engine/src/select.ts`, `ardur-article-synthesizer/src/synthesize.ts:291` |
| Orchestrator `parseArtifact()` checks JSON syntax only; soft-warns on cycle-id drift, never on version | `ardur-pipeline/src/runners.ts:91`, `orchestrate.ts:131` |
| Engines run as **sibling-dir CLIs** (`node --experimental-strip-types src/cli.ts`), resolved via `ENGINES_DIR`; **not** npm deps | `ardur-pipeline/src/runners.ts:56`, `config.ts:64` |
| `ardur.ai` consumes **no** pipeline artifact yet (100% fallback), no `@ardurai/*` dep, but already uses Zod for content collections | `ardur.ai/src/content.config.ts:14`; `package.json` |
| Real npm scope is **`@ardurai`** (e.g. `@ardurai/news-aggregator`), not `@ardur` | each `package.json` `name` |
| Spec already anticipates a contracts package (`@ardurai/pipeline-contracts`) | `ardur-pipeline/docs/spec.md:279` |

Two distinct failure modes follow from this:

- **Re-stamp / mislabel** — a downstream engine reads an artifact of an unknown
  version, processes it as v1, and stamps its output v1. A genuinely incompatible
  upstream artifact is laundered into a v1-looking output. (top10 #8.)
- **Silent NaN** — an out-of-contract enum value (e.g. a new `SourceTier`) flows
  through and yields a `NaN` score with no warning. (ranking #7.)

The version gate below kills the first class outright and is the first line of
defence for the second; the deeper data-shape guards the hardening sessions are
adding (NaN tier, copyright/render gates) handle the rest.

---

## 1. schemaVersion contract gate

### 1.1 Design principles

- **Gate at every read boundary, before the `as` cast.** The producer may keep
  stamping its own `SCHEMA_VERSION` — re-stamping is *correct* once the input has
  passed the gate (post-gate, versions are equal by construction). The bug is
  re-stamping *without* gating, not the re-stamp itself. So the fix is **"gate
  before stamp,"** not "propagate the upstream string."
- **Two evolution axes.** Keep `schemaVersion` as the *compatibility key* (the
  major line, hard-fail on mismatch) and add a separate monotonic
  `contractRevision` integer for *additive* changes (a new optional field such as
  `claims[]`). Additive change → bump revision, not the major line; the gate stays
  green. Breaking change → bump `v1` → `v2`, the gate fails loud everywhere until
  every consumer upgrades.
- **Two tiers of validation, both shipped from the shared contract:**
  - **Tier 1 (mandatory, zero-dependency):** version + stage + envelope-shape
    assertion. Hand-written, no runtime deps, trivially adoptable by every engine.
  - **Tier 2 (recommended, opt-in):** full structural Zod schemas exported for
    consumers that want shape/enum validation at the boundary. `ardur.ai` already
    uses Zod and is the natural first Tier-2 adopter at ingestion; engines may
    adopt incrementally to retire ad-hoc guards (e.g. ranking #7's NaN tier).

### 1.2 Contract change (additions to the canonical `contracts.ts`)

```ts
// --- versioning ---
export const SCHEMA_VERSION = 'ardur-content-pipeline/v1' as const; // unchanged on the wire
export const CONTRACT_REVISION = 2 as const; // monotonic; rev 2 == claims[] ratified

// optional, additive envelope field — does NOT bump the major line
export interface ArtifactEnvelope<TData> {
  schemaVersion: typeof SCHEMA_VERSION;
  contractRevision?: number; // producer's CONTRACT_REVISION; absent == rev 1
  // ...existing fields unchanged...
}

// --- the gate ---
export class SchemaVersionError extends Error {
  constructor(readonly detail: { expected: string; received: unknown; stage: string }) {
    super(
      `schemaVersion mismatch for ${detail.stage}: expected "${detail.expected}", ` +
      `received ${JSON.stringify(detail.received)}`,
    );
    this.name = 'SchemaVersionError';
  }
}

export interface ArtifactCheck<TStage extends PipelineStage> {
  envelope: ArtifactEnvelope<unknown>;
  warnings: string[]; // additive skew etc. — non-fatal
}

/**
 * Tier 1 gate. Run on every inbound artifact BEFORE casting to a stage type.
 * Throws SchemaVersionError on incompatible major drift or wrong upstream stage.
 * Returns the typed envelope plus non-fatal warnings (additive-revision skew).
 */
export function assertCompatibleArtifact<TStage extends PipelineStage>(
  raw: unknown,
  expectedStage: TStage,
): ArtifactCheck<TStage> {
  if (typeof raw !== 'object' || raw === null) {
    throw new SchemaVersionError({ expected: SCHEMA_VERSION, received: raw, stage: expectedStage });
  }
  const env = raw as Partial<ArtifactEnvelope<unknown>>;
  if (env.schemaVersion !== SCHEMA_VERSION) {
    throw new SchemaVersionError({ expected: SCHEMA_VERSION, received: env.schemaVersion, stage: expectedStage });
  }
  if (env.artifact !== expectedStage) {
    throw new SchemaVersionError({ expected: `artifact=${expectedStage}`, received: env.artifact, stage: expectedStage });
  }
  if (typeof env.data !== 'object' || env.data === null) {
    throw new SchemaVersionError({ expected: 'non-empty data', received: env.data, stage: expectedStage });
  }
  const warnings: string[] = [];
  const rev = typeof env.contractRevision === 'number' ? env.contractRevision : 1;
  if (rev > CONTRACT_REVISION) {
    warnings.push(
      `upstream contractRevision ${rev} > local ${CONTRACT_REVISION}; ` +
      `additive fields may be ignored (forward-compatible)`,
    );
  }
  return { envelope: env as ArtifactEnvelope<unknown>, warnings };
}
```

Tier 2 (separate export, depends on `zod`):

```ts
import { z } from 'zod';
export const AggregationArtifactSchema = z.object({ /* full envelope + data */ });
export const RankingArtifactSchema = z.object({ /* ... */ });
export const Top10ArtifactSchema = z.object({ /* ... */ });
export const ArticleArtifactSchema = z.object({ /* ... */ });
// exported from "@ardurai/contracts/zod" so Tier-1-only consumers pull no zod dep.
```

### 1.3 Compatibility rule

| Condition | Outcome |
| --- | --- |
| `input.schemaVersion !== SCHEMA_VERSION` (major line differs) | **throw** `SchemaVersionError` → process exits non-zero |
| `input.artifact !== expectedStage` (wrong upstream wired in) | **throw** `SchemaVersionError` |
| `input.contractRevision > local CONTRACT_REVISION` | **warn**, proceed (additive forward-compat) |
| `input.contractRevision <= local` | proceed silently |

### 1.4 Per-engine adoption steps

Ordering matters: the **version gate runs first**, then the existing local
data-shape guards (NaN tier, copyright, render). The version gate covers the
*cross-repo version* axis; local guards cover the *intra-contract data* axis.

**ardur-news-aggregator (stage 1, no upstream input):**
1. Adopt `@ardurai/contracts` (§2); delete vendored `contracts.ts`.
2. Stamp `contractRevision: CONTRACT_REVISION` on output; ratify `claims[]` as the
   rev-2 additive field (reconciles aggregator #6 / synthesizer #6).
3. No input gate needed (it is the source stage).

**ardur-ranking-engine (reads aggregation):**
1. Adopt `@ardurai/contracts`; delete vendored copy.
2. In `cli.ts:readInput()`, replace `JSON.parse(raw) as AggregationArtifact` with
   `const { envelope, warnings } = assertCompatibleArtifact(JSON.parse(raw), 'aggregation');`
   then cast `envelope as AggregationArtifact`; surface `warnings`.
3. Implements the gate requested in **ranking #8** using the shared helper; keep
   the NaN-tier guard from **ranking #7** running *after* the version gate.
4. Add a unit test: input with `schemaVersion: 'ardur-content-pipeline/v2'` → non-zero exit.

**ardur-top10-engine (reads ranking, optionally previous-top10 + aggregation):**
1. Adopt `@ardurai/contracts`; delete vendored copy.
2. Gate `ranking` (and `previous`→`top10`, `aggregation`→`aggregation`) in
   `cli.ts:readJson` call sites before casting.
3. Implements **top10 #8** (the "output mislabelled v1" bug) via the shared helper.
4. Unit test for v2 input → non-zero exit.

**ardur-article-synthesizer (reads top10 + aggregation):**
1. Adopt `@ardurai/contracts`; delete vendored copy.
2. Gate both inputs in `cli.ts:50–64` before casting; keep the existing
   copyright/render/provenance gates (the model fail-loud pattern) running after.
3. Stamp `contractRevision`; ratify `claims[]` (synthesizer #6).
4. Unit test for v2 input → non-zero exit.

**ardur-pipeline (orchestrator, defence in depth):**
1. Adopt `@ardurai/contracts`; delete vendored copy; source the manifest's
   `SCHEMA_VERSION`/`CONTRACT_REVISION` from the package (`store.ts:180`).
2. In `parseArtifact()` (`runners.ts:91`), call `assertCompatibleArtifact` per
   stage and fold returned `warnings` into the existing manifest warning channel
   (alongside the cycle-id drift warning at `orchestrate.ts:131`).
3. The orchestrator gate is belt-and-suspenders: even if an engine skips its own
   gate, drift fails the cycle and the last-good cycle stays live.

### 1.5 Reconciliation with the in-flight hardening guards

The hardening sessions are adding local fail-loud guards **now**, in the vendored
copies, before `@ardurai/contracts` ships. To make the later package swap a
drop-in rather than a rewrite:

- Write those local guards to the **same signature** this plan defines
  (`assertCompatibleArtifact(raw, stage)` + `SchemaVersionError`). Land them as a
  local helper in each repo first; when the package ships, the change is an import
  swap (`./schema-guard` → `@ardurai/contracts`) and a delete, not a redesign.
- Keep data-shape guards (NaN tier, copyright, render) **separate** from the
  version gate so they survive the package migration untouched as Tier-2-adjacent
  checks.

---

## 2. Engine packaging

### 2.1 The two consumption needs are different

1. **The shared contract** (types + validators) is needed by all 5 repos **and**
   `ardur.ai`. This is the painful byte-identical copy and the source of the
   `claims[]` drift.
2. **Engine executables** are needed only by `ardur-pipeline`, which **spawns them
   as subprocess CLIs** — it imports no engine *code*, only the contract.
   `ardur.ai` needs only the engines' **output JSON** (`manifest.json`,
   `latest/*.json`), never engine code.

So "package the engines" is the wrong frame. Package the **contract**; leave the
engines as runnable checkouts.

### 2.2 Option comparison

| Option | What it solves | Cost / risk | Verdict |
| --- | --- | --- | --- |
| **(a) npm packages per engine under `@ardurai`** | Lets consumers `import` engine logic | Overkill — orchestrator spawns CLIs, never imports them; `ardur.ai` needs only output JSON. Adds publish ceremony for code nobody imports. | ✗ Reject for engines |
| **(b) git dependencies (pinned SHA/tag)** | Pin engine *versions* without a registry | Works for pinning, but engines are run as sibling-dir CLIs, so a pinned `ENGINES_DIR` checkout / submodule already does this. Git deps for the *contract* lose semver + clean release. | ✗ Reject as the contract mechanism; pinning handled by pipeline #1 |
| **(c) single `@ardurai/contracts` package, source of truth** | Eliminates the vendored copies and the entire drift class (`claims[]` could not have diverged) | One small package to publish; consumers add one dep | ✓ **Recommended** |

### 2.3 Recommendation

- **Ship `@ardurai/contracts` as the single source of truth (option c).** Tiny:
  type-only core + the Tier-1 zero-dep gate, with Tier-2 Zod schemas under a
  `@ardurai/contracts/zod` subpath so Tier-1-only consumers pull no `zod`. Its
  **major version is locked to the `/vN` major line** (package `1.x` ↔
  `schemaVersion v1`); additive changes are MINOR + `CONTRACT_REVISION++`.
  (Supersedes the tentative `@ardurai/pipeline-contracts` name in `spec.md:279` —
  shorter, scope-clear.)
- **Do not package the engines as libraries.** Keep them as sibling checkouts run
  by the orchestrator; handle version pinning via the existing pipeline #1 ("pin
  engine versions in the cycle workflow") with a tag/SHA-pinned `ENGINES_DIR`.
- **`ardur.ai`** depends on `@ardurai/contracts` for ingestion types + Tier-2 Zod,
  and consumes artifacts as **published JSON** (the pipeline's `manifest.json` /
  `latest/*.json`), not by importing engine code.

### 2.4 Registry choice

Recommend **public npm under `@ardurai`**. The repos are already public, the
contract is harmless types + validators, and a public package gives `ardur.ai`'s
static build and the pipeline CI a **zero-auth install** (no token plumbing in CI).
**GitHub Packages** (the token already carries `write:packages`) is the fallback if
the org later wants the contract kept org-internal — at the cost of auth on every
install.

### 2.5 Migration steps

1. **Create `ardur-contracts` repo** under `ArdurAI`. Move the canonical
   `contracts.ts` (currently `ardur-pipeline/src/contracts.ts`) into it; add the
   Tier-1 gate + `SchemaVersionError` + `CONTRACT_REVISION`; add Tier-2 Zod under a
   subpath export. Publish **`@ardurai/contracts@1.0.0`**.
2. **Per repo (5 engines+pipeline, then ardur.ai):** `npm i @ardurai/contracts@^1`;
   replace `./contracts` imports with `@ardurai/contracts`; **delete the vendored
   `contracts.ts`**; add a CI guard that fails if a local `contracts.ts` reappears.
3. **Interim before publish:** use `npm` workspaces or `file:` links so adoption
   can start before the first registry publish; flip to `@ardurai/contracts@^1`
   once published.
4. **ardur-pipeline:** source manifest `SCHEMA_VERSION`/`CONTRACT_REVISION` from the
   package; add the `parseArtifact()` gate (§1.4).
5. **ardur.ai:** add the dep; gate pipeline artifacts at ingestion with Tier-2 Zod
   (lands under INTEG-001 / #81).

### 2.6 Versioning & release

- **Semver, major-locked to the schema line.** `@ardurai/contracts` MAJOR === the
  `/vN` in `SCHEMA_VERSION`. Breaking change → MAJOR bump → `SCHEMA_VERSION` →
  `v2` → the runtime gate fails loud on any not-yet-upgraded consumer. Additive
  field → MINOR bump + `CONTRACT_REVISION++` (e.g. `claims[]` → `1.1.0`, rev 2).
  Doc/no-shape changes → PATCH.
- **Release:** tag `vX.Y.Z` on `ardur-contracts` → CI publishes. Consumers pin
  `^1`; Renovate/Dependabot raises upgrade PRs. The runtime schemaVersion gate is
  the backstop if a registry mismatch ever slips past CI.
- **Two reinforcing layers:** npm semver catches drift at *install/build*; the
  schemaVersion gate catches it at *runtime*. Both point at the same major line.

---

## 3. Sequencing

1. **Now (hardening sessions):** land local gates in each engine written to the
   `assertCompatibleArtifact` signature (§1.5). Closes ranking #8, top10 #8, and
   the synthesizer gate gap immediately, in the vendored copies.
2. **Next:** create + publish `@ardurai/contracts@1.0.0` (the Tier-1 gate + Zod).
3. **Then:** per-repo adoption — swap imports, delete vendored copies, add CI
   guard. Orchestrator gate + manifest sourcing.
4. **Then:** `ardur.ai` ingestion gate (INTEG-001 / #81) consuming published JSON.
5. **Ongoing:** `claims[]` ratified as rev 2; future breaking changes go through
   the MAJOR-bump / `v2` path.

---

## 4. Coordinated issues

Tracked under the pipeline rollout tracker; each is filed `status:ready`.

- **ardur-pipeline** — rollout tracker (this plan); create `@ardurai/contracts`
  package; orchestrator `parseArtifact()` gate.
- **ardur-news-aggregator** — adopt package; emit `contractRevision`; ratify
  `claims[]` (rev 2). (with #6)
- **ardur-ranking-engine** — adopt package; shared input gate (implements #8;
  keep #7 NaN guard after).
- **ardur-top10-engine** — adopt package; shared input gate (implements #8).
- **ardur-article-synthesizer** — adopt package; gate top10+aggregation inputs;
  ratify `claims[]` (with #6).
- **ardur.ai** — gate pipeline artifacts at ingestion with Tier-2 Zod (under
  INTEG-001 / #81).
