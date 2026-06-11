/**
 * The conductor — drive one full 6-hour cycle end to end:
 *
 *   aggregate -> rank -> selectTop10 -> synthesize -> publish
 *
 * Design properties (see docs/spec.md for the reasoning):
 *
 *  - **Idempotent per `cycle.id`** — the cycle is `floor(now, 6h)` UTC, so a
 *    drifted / retried / backfilled trigger resolves to the same cycle. The
 *    store's `loadPublished` guard makes a re-fire a cheap no-op.
 *  - **Last-good-wins** — if any stage throws (after its retries), nothing is
 *    published and the previous cycle stays live. Publishing is all-or-nothing.
 *  - **Bounded retries** — each engine stage is wrapped in `withRetry`; a
 *    transient failure does not sink the cycle, an exhausted one does.
 *  - **Observable** — structured logs per stage with durations; a roll-up
 *    `RunResult`; a webhook alert on `failed`/`degraded`; per-cycle metrics.
 *  - **Dry-run** — when `dryRun` is set, all four stages run and the immutable
 *    archive is written, but `latest/` and `manifest.json` are NOT flipped. The
 *    result carries `dryRun: true`. Safe for verification and E2E harnesses.
 *
 * This orchestrator is the OUT-OF-PROCESS deployment conductor: it spawns the
 * four engine CLIs (see runners.ts). `ardur-top10-engine` ships an in-process
 * `runCycle` for library embedding; this repo is the runtime host that owns the
 * schedule, the artifact store, and the handoff to ardur.ai.
 */

import type { CycleMeta } from '@ardurai/contracts';
import type { PipelineConfig } from './config.ts';
import type { Logger } from './log.ts';
import type { CoverageStore } from './coverage-store.ts';
import { cycleFor, nextRefreshAt } from './cycle.ts';
import { withRetry } from './retry.ts';
import { createCliRunners, type StageRunners } from './runners.ts';
import { ArtifactStore, buildManifest, type CyclePublishSet, type PublishStatus } from './store.ts';
import { sendAlert } from './alert.ts';
import { buildCycleMetrics, emitMetrics } from './metrics.ts';
import type { AggregationArtifact, Top10Artifact, ArticleArtifact } from '@ardurai/contracts';

export type CycleStatus = 'published' | 'degraded' | 'failed' | 'skipped';

export interface StageTiming {
  stage: string;
  ms: number;
}

export interface RunResult {
  cycle: CycleMeta;
  status: CycleStatus;
  warnings: string[];
  nextRefreshAt: string;
  timings: StageTiming[];
  /** True when the cycle ran with dryRun: latest/ and manifest.json were not written. */
  dryRun?: boolean;
  /** Articles held by the editorial gate (editorialStatus: 'held') — not in latest/. */
  heldCount?: number;
}

export interface RunCycleDeps {
  config: PipelineConfig;
  logger: Logger;
  /** Injectable for tests; defaults to CLI-backed runners over the real engines. */
  runners?: StageRunners;
  /** Injectable for tests; defaults to a filesystem store at config.artifactStore. */
  store?: ArtifactStore;
  /** Injectable clock so cycles are reproducible. Default `new Date()`. */
  now?: () => Date;
  /**
   * When true, run all four stages and write the immutable archive under
   * `cycles/<id>/` but skip the `latest/` + `manifest.json` pointer flip.
   * The returned RunResult has `dryRun: true`.
   */
  dryRun?: boolean;
  /**
   * Coverage store for Hermes dark-launch gates. Optional — omit to skip gates.
   * When provided, each gate logs what an agent WOULD do without acting on it.
   * The deterministic conductor path is unchanged regardless.
   */
  coverageStore?: CoverageStore;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Hermes dark-launch gates
//
// Each gate logs what an autonomous agent WOULD do at this decision point.
// The verdict is tagged `hermesGate: true` for easy grep/filter. The
// deterministic path continues unchanged — these are observations, not actions.
// ---------------------------------------------------------------------------

function darkLaunchCurationGate(
  aggregation: AggregationArtifact,
  coverage: CoverageStore | undefined,
  log: Logger,
): void {
  if (!coverage) return;

  const topicsWithCoverage: { topic: string; hitCount: number }[] = [];
  for (const topic of Object.keys(aggregation.data.clustersByTopic)) {
    const result = coverage.check({ topic });
    if (result.covered) {
      topicsWithCoverage.push({ topic, hitCount: result.hitCount });
    }
  }

  log.info('hermes:curation-gate [dark-launch]', {
    hermesGate: true,
    gate: 'curation',
    verdict: {
      topicsChecked: Object.keys(aggregation.data.clustersByTopic).length,
      topicsWithPriorCoverage: topicsWithCoverage.length,
      topicsWithCoverage,
      // Threshold: skip topics seen ≥2 times unless cluster diversity is high
      wouldSkipCount: topicsWithCoverage.filter((t) => t.hitCount >= 2).length,
    },
    deterministic: 'pass',
  });
}

function darkLaunchExhaustionGate(
  top10: Top10Artifact,
  coverage: CoverageStore | undefined,
  log: Logger,
): void {
  if (!coverage) return;

  const exhaustedTopics: string[] = [];
  for (const topic of top10.data.topicsCovered) {
    const result = coverage.check({ topic });
    if (result.exhausted) exhaustedTopics.push(topic);
  }

  log.info('hermes:coverage-exhaustion-gate [dark-launch]', {
    hermesGate: true,
    gate: 'coverage-exhaustion',
    verdict: {
      topicsChecked: top10.data.topicsCovered.length,
      exhaustedTopics,
      wouldFlagCount: exhaustedTopics.length,
    },
    deterministic: 'pass',
  });
}

function darkLaunchEditorialGate(articles: ArticleArtifact, log: Logger): void {
  const wouldHold: { id: string; reasons: string[] }[] = [];

  for (const article of articles.data.articles) {
    if (article.editorialStatus === 'held') continue; // already held by deterministic gate

    const reasons: string[] = [];
    if (article.ai?.provider === 'deterministic' && article.ai?.status === 'fallback') {
      reasons.push('deterministic-fallback');
    }
    if (article.confidence === 'low') reasons.push('low-confidence');
    if (article.references.length === 0) reasons.push('no-references');
    if (article.wordCount !== undefined && article.wordCount < 100) reasons.push('too-short');

    if (reasons.length > 0) wouldHold.push({ id: article.id, reasons });
  }

  const deterministic = {
    heldByProvGate: articles.data.articles.filter((a) => a.editorialStatus === 'held').length,
    publishedCount:
      articles.data.articles.length -
      articles.data.articles.filter((a) => a.editorialStatus === 'held').length,
  };

  log.info('hermes:editorial-qa-gate [dark-launch]', {
    hermesGate: true,
    gate: 'editorial-qa',
    verdict: {
      articlesChecked: articles.data.articles.length,
      wouldHoldCount: wouldHold.length,
      wouldHold,
      wouldPublishCount: deterministic.publishedCount - wouldHold.length,
    },
    deterministic,
  });
}

/** Run one full cycle. Never throws for an expected pipeline failure. */
export async function runCycle(deps: RunCycleDeps): Promise<RunResult> {
  const { config } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const startedAt = now.toISOString();
  const cycle = cycleFor(now);
  const next = nextRefreshAt(cycle);
  const log = deps.logger.child({ cycleId: cycle.id });
  const store = deps.store ?? new ArtifactStore(config.artifactStore);
  const runners = deps.runners ?? createCliRunners(config, cycle, log);
  const warnings: string[] = [];
  const timings: StageTiming[] = [];
  let articleCount = 0;
  let heldCount = 0;
  let topicsCovered: string[] = [];

  log.info('cycle start', { windowStart: cycle.windowStart, windowEnd: cycle.windowEnd });

  // Emit metrics at every exit point, best-effort.
  const finalize = async (result: RunResult): Promise<RunResult> => {
    const withHeld = heldCount > 0 ? { ...result, heldCount } : result;
    const metrics = buildCycleMetrics(
      withHeld.status,
      cycle.id,
      startedAt,
      withHeld.timings,
      withHeld.warnings.length,
      articleCount,
      topicsCovered,
    );
    await emitMetrics(metrics, {
      storeRoot: store.root,
      cycleId: cycle.id,
      webhookUrl: config.observability.metricsWebhookUrl,
      logger: log,
    });
    return deps.dryRun ? { ...withHeld, dryRun: true } : withHeld;
  };

  // Timing helper — wraps a stage with retry + duration logging.
  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    const result = await withRetry(fn, {
      attempts: config.retry.attempts,
      backoffMs: config.retry.backoffMs,
      label: name,
      logger: log,
    });
    const ms = Math.round(performance.now() - started);
    timings.push({ stage: name, ms });
    log.info('stage ok', { stage: name, ms });
    return result;
  };

  // --- Idempotency: short-circuit a cycle that is already published. ----------
  try {
    const existing = await store.loadPublished(cycle);
    if (existing) {
      log.info('idempotent skip: cycle already published');
      return finalize({ cycle, status: 'skipped', warnings, nextRefreshAt: next, timings });
    }
  } catch (e) {
    warnings.push(`loadPublished failed (continuing): ${errMessage(e)}`);
  }

  // --- Previous board for deltas (non-fatal if it fails). ---------------------
  let previous: Awaited<ReturnType<StageRunners['selectTop10']>> | null = null;
  try {
    previous = await store.loadPreviousTop10(cycle);
  } catch (e) {
    warnings.push(`loadPreviousTop10 failed (continuing without deltas): ${errMessage(e)}`);
  }

  // --- Drive the stages. Any throw (post-retry) => failed, publish nothing. ---
  let set: CyclePublishSet;
  try {
    const aggregation = await stage('aggregate', () => runners.aggregate(cycle));
    darkLaunchCurationGate(aggregation, deps.coverageStore, log);

    const ranking = await stage('rank', () => runners.rank(aggregation));
    const top10 = await stage('top10', () => runners.selectTop10(ranking, previous, aggregation));
    darkLaunchExhaustionGate(top10, deps.coverageStore, log);

    const articles = await stage('synthesize', () => runners.synthesize(top10, aggregation));
    darkLaunchEditorialGate(articles, log);

    // Honor HOLD: held articles are archived but must not reach readers.
    const heldArticles = articles.data.articles.filter((a) => a.editorialStatus === 'held');
    if (heldArticles.length > 0) {
      heldCount = heldArticles.length;
      log.warn('articles held for editorial review', {
        heldCount,
        held: heldArticles.map((a) => ({ id: a.id, topic: a.topic, headline: a.headline })),
      });
      // Push into the artifact's own warnings so it flows into upstreamWarnings → degraded status.
      articles.warnings.push(
        `${heldCount} article(s) held: insufficient fact corroboration — not published to latest/`,
      );
    }

    set = { cycle, aggregation, ranking, top10, articles };
    articleCount = articles.data.articles.length - heldArticles.length;
    topicsCovered = top10.data.topicsCovered;
  } catch (e) {
    warnings.push(`stage failed: ${errMessage(e)}`);
    log.error('cycle failed before publish', { warnings });
    await sendAlert(
      config.observability.alertWebhookUrl,
      { cycle, status: 'failed', warnings },
      log,
    );
    return finalize({ cycle, status: 'failed', warnings, nextRefreshAt: next, timings });
  }

  // Soft cycle-consistency checks — flag drift without failing the cycle.
  for (const [name, art] of [
    ['aggregation', set.aggregation],
    ['ranking', set.ranking],
    ['top10', set.top10],
    ['articles', set.articles],
  ] as const) {
    if (art.cycle.id !== cycle.id) {
      warnings.push(`${name} cycle mismatch: expected ${cycle.id}, got ${art.cycle.id}`);
    }
  }

  // Upstream non-fatal warnings classify the published cycle as degraded.
  const upstreamWarnings = [
    ...set.aggregation.warnings,
    ...set.ranking.warnings,
    ...set.top10.warnings,
    ...set.articles.warnings,
  ];
  const status: PublishStatus = upstreamWarnings.length > 0 ? 'degraded' : 'published';
  const publishedAt = now.toISOString();
  const allWarnings = [...warnings, ...upstreamWarnings];
  const manifest = buildManifest(set, status, publishedAt, allWarnings);

  // --- Publish all-or-nothing. ------------------------------------------------
  try {
    await stage('publish', () =>
      store.publish(set, manifest, { dryRun: deps.dryRun, rawWarnings: allWarnings }),
    );
  } catch (e) {
    allWarnings.push(`publish failed: ${errMessage(e)}`);
    log.error('cycle failed at publish (previous cycle stays live)', { warnings: allWarnings });
    await sendAlert(
      config.observability.alertWebhookUrl,
      { cycle, status: 'failed', warnings: allWarnings },
      log,
    );
    return finalize({
      cycle,
      status: 'failed',
      warnings: allWarnings,
      nextRefreshAt: next,
      timings,
    });
  }

  // After a real (non-dry) publish, record coverage for future gate queries.
  if (!deps.dryRun && deps.coverageStore) {
    const nowStr = now.toISOString();
    for (const entry of set.top10.data.global) {
      deps.coverageStore.record(
        {
          fingerprint: entry.clusterId,
          clusterId: entry.clusterId,
          topic: entry.topic,
          cycleId: cycle.id,
          publishedAt: nowStr,
          angle: entry.headline,
        },
        nowStr,
      );
    }
    deps.coverageStore.setCursor('last-cycle-id', cycle.id, nowStr);
    deps.coverageStore.setCursor('last-cycle-status', status, nowStr);
  }

  log.info('cycle published', {
    status,
    dryRun: deps.dryRun ?? false,
    nextRefreshAt: next,
    warnings: allWarnings.length,
  });
  if (status === 'degraded') {
    await sendAlert(
      config.observability.alertWebhookUrl,
      { cycle, status: 'degraded', warnings: allWarnings },
      log,
    );
  }
  return finalize({ cycle, status, warnings: allWarnings, nextRefreshAt: next, timings });
}
