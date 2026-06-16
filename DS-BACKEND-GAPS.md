# Design-System Backend Gaps

Fields and data that the design-system homepage components need but the pipeline does not yet emit.
Each gap lists: which component needs it, what the engine currently provides, and the cheapest
deterministic path to close it.

---

## GAP-1 — Story-specific `summary` field

| | |
|---|---|
| **Components** | `SignalRadar`, `SignalGraph`, `SignalTicker`, `RankRow` |
| **What they need** | A concise (≤ 20 word) story-specific summary per signal |
| **What the engine emits** | Nothing. The only text field is `headline`. The legacy `signal-map-data.js` used a hard-coded template: `"From [Source] — here's what actually changed and why it matters for [topic]."` — identical across every story. |
| **Adapter workaround** | `scripts/ds-adapter.ts` generates summaries deterministically from `headline` + unique reference titles + `factsByCluster` entities. Covers 5 story archetypes (release note, podcast, quote, rich headline, multi-ref). 0 AI tokens. |
| **Permanent fix** | Add a `synthesizer` stage that runs after ranking and writes a `summary` field onto each `Top10Signal`. The synthesizer already exists (`src/runners.ts`) but only produces article bodies. Cheapest path: extract the 1-sentence lede from the synthesizer's article draft and backfill it onto the signal. No Ollama required — the deterministic extraction path in the adapter already does this. |

---

## GAP-2 — Stable signal `id` / canonical URL

| | |
|---|---|
| **Components** | `SignalRadar`, `SignalGraph`, `SignalTicker`, `RankRow` (all need `href` and optionally `id`) |
| **What they need** | `href="/news/{id}"` pointing to an ardur.ai article page; a stable `id` that survives across cycles |
| **What the engine emits** | `clusterId` (e.g. `"cluster-ai-9"`) — stable within a cycle but reset on re-aggregation. The `references[].url` points to the original external source. |
| **Adapter workaround** | Uses `references[0].url` (first unique external ref) as the href. The `id` is cycle-scoped: `"s1"…"s10"`. |
| **Permanent fix** | Add a `signalId` field to `Top10Signal` that is a stable hash of the cluster's canonical URL or headline (SHA-1 first 8 chars). Wire it to the ardur.ai `/news/[id]` route. This also unblocks the `onSelect` handlers in all DS components. |

---

## GAP-3 — Radar topic → angle mapping

| | |
|---|---|
| **Components** | `SignalRadar` |
| **What they need** | The `topic` string is used internally by the component to assign a clockface angle (sector) to each blip. The component auto-distributes topics it sees, so ordering is non-deterministic across renders. |
| **What the engine emits** | `topic` slug (ai, kubernetes, models, platform, security) and `topicLabel`. No ordering hint. |
| **Adapter workaround** | None needed — the `SignalRadar` component handles placement. |
| **Permanent fix (optional)** | Emit a `topicOrder: string[]` field in `top10.json` or publish a separate `topics-config.json`. This would let the radar lock each topic to a fixed sector and prevent layout jitter as new topics appear. |

---

## GAP-4 — Signal graph edge weights

| | |
|---|---|
| **Components** | `SignalGraph` |
| **What they need** | Optionally explicit `links: [{a, b, relation, weight}]` for the force-directed graph. The component infers edges from shared `topic` values but only creates hub-to-node edges, not cross-signal edges. |
| **What the engine emits** | `ranking.json` has `factsByCluster` (per-cluster entity extraction). The legacy `signal-map-data.js` was produced by a graph-engine stage (ENGINE-008) that computed `same_project`, `similar_to`, `follows_up`, and `competes_with` links with weights. |
| **Adapter workaround** | `SignalGraph` accepts `signals: SignalNode[]` and generates hub edges from shared topics automatically — no explicit links required. |
| **Permanent fix** | Re-enable the ENGINE-008 co-mention graph pass. Its output shape (`links: [{a, b, relation, weight}]`) can be published as `graph.json` alongside `top10.json`. The `SignalGraph` component would need a `links?` prop added to accept explicit edges (currently only signals are accepted). |

---

## GAP-5 — Rank delta for global list

| | |
|---|---|
| **Components** | `RankRow` (delta indicator — visual +/- movement badge) |
| **What they need** | Movement relative to previous cycle for the same story |
| **What the engine emits** | `delta.movement` + `delta.previousRank` are present on the **per-topic** rankings but almost always `"new"` on the **global** cross-topic list (the global list resets each cycle; only 1 of 10 signals had a non-null `previousRank` in the current cycle). |
| **Adapter workaround** | `delta` is computed from the engine field; most show `"NEW"` which is correct. |
| **Permanent fix** | The store/cycle pipeline needs to carry over a global rank index from the previous cycle (similar to how per-topic rank-carry works) and use it to compute `delta` on the global list. |

---

## GAP-6 — RepoCard project data

| | |
|---|---|
| **Components** | `RepoCard` |
| **What they need** | `{name, description, topics, language, languageColor, stars, license, href}` per project |
| **What the engine emits** | Nothing — the pipeline has no concept of "Ardur projects". |
| **Adapter workaround** | `ds-home.json` includes a `repos` array with one hand-curated entry (`ardur-pipeline`). |
| **Permanent fix** | Add a `projects.json` artifact to the pipeline (or a separate GitHub-API fetch stage) that pulls live star counts, language, and description from GitHub. Could be a lightweight separate job that runs daily rather than per-cycle. |

---

## GAP-7 — Confidence band on `SignalTicker` score meter

| | |
|---|---|
| **Components** | `SignalTicker` |
| **What they need** | `score` (0–1) to drive the visual score meter. Optionally a `confidence` band ("High" / "Medium" / "Low") for the HUD label. |
| **What the engine emits** | `score.total` (0–1) ✓ and `confidence` (lowercase "high" / "medium") ✓ |
| **Gap** | None — both are present after the adapter normalises confidence to title-case. Noted here for completeness. |

---

## Summary table

| Gap | Component(s) | Severity | Fix location |
|-----|-------------|----------|--------------|
| GAP-1 `summary` | All | **Critical** (blank if missing) | Synthesizer → write `summary` onto `Top10Signal` |
| GAP-2 stable `id` / href | All | **High** (links dead) | Store: add `signalId` hash + wire ardur.ai route |
| GAP-3 topic angle | SignalRadar | Low (component auto-handles) | Optional: add `topicOrder` config |
| GAP-4 graph edges | SignalGraph | Medium (inferred edges only) | Re-enable ENGINE-008 + add `links?` to `SignalGraph` |
| GAP-5 global delta | RankRow | Low (most are "NEW") | Store: carry global rank index across cycles |
| GAP-6 repo data | RepoCard | High (static fallback only) | New: GitHub API fetch job → `projects.json` |
| GAP-7 score/confidence | SignalTicker | None (present after normalise) | — |
