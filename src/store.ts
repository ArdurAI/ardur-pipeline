/**
 * Artifact store + the data-handoff contract to ardur.ai.
 *
 * Layout under `ARTIFACT_STORE`:
 *
 *   manifest.json                <- last-good pointer (THE thing the site reads first)
 *   latest/                      <- the currently-served cycle (atomic pointer flip)
 *     aggregation.json
 *     ranking.json
 *     top10.json
 *     articles.json              <- published articles only (held articles excluded)
 *   cycles/<cycleId>/            <- immutable per-cycle archive (audit + rollback)
 *     aggregation.json ranking.json top10.json articles.json run.json metrics.json
 *     articles.json includes ALL articles (held + published) for editorial audit.
 *   metrics.ndjson               <- append-only per-cycle metrics stream
 *
 * Publish is **all-or-nothing**: the immutable archive is written first, then
 * `latest/` and `manifest.json` are swapped in via temp-file + rename. A reader
 * that loads `manifest.json` is guaranteed a complete, internally-consistent set
 * — there is no window where `latest/` is half-written. If a cycle fails, the
 * pointer is never flipped and the previous cycle keeps serving (last-good-wins).
 *
 * HOLD semantics: articles with `editorialStatus: 'held'` are written to the
 * immutable archive (for editorial review) but are filtered out of `latest/`.
 * `manifest.health.heldArticles` counts them; `manifest.summary.articleCount`
 * reflects only the published slice.
 *
 * When `dryRun` is set, the archive is still written (for inspection) but the
 * `latest/` swap and `manifest.json` flip are skipped.
 */

import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '@ardurai/contracts';
import type {
  AggregationArtifact,
  RankingArtifact,
  Top10Artifact,
  ArticleArtifact,
  CycleMeta,
} from '@ardurai/contracts';

export type PublishStatus = 'published' | 'degraded';

/** The full set of artifacts produced by one successful cycle. */
export interface CyclePublishSet {
  cycle: CycleMeta;
  aggregation: AggregationArtifact;
  ranking: RankingArtifact;
  top10: Top10Artifact;
  articles: ArticleArtifact;
}

// ---------------------------------------------------------------------------
// Warning categorization (#2)
// ---------------------------------------------------------------------------

export interface WarningCategory {
  category: string;
  count: number;
  /** First up to 3 verbatim warnings in this category (rest in the archive). */
  sample: string[];
}

export interface HealthRollup {
  /** Sources queried but not responded across all topics. */
  failedSources: number;
  /** Topics whose coverage was marked degraded by the aggregator. */
  degradedTopics: number;
  /** Expected 10 articles; 10 - total articles produced (dropped by synthesizer). */
  articlesDropped: number;
  /** Articles held for editorial review (editorialStatus: 'held'). Not in latest/. */
  heldArticles: number;
  /** True if any engine fell back to a deterministic / zero-cost path. */
  usedFallback: boolean;
}

const WARNING_PATTERNS: Array<{ category: string; patterns: string[] }> = [
  { category: 'blocked-fetch', patterns: ['blocked', 'ssrf', 'forbidden'] },
  { category: 'http-error', patterns: ['http error', 'status', 'fetch failed', 'network'] },
  { category: 'diversity-floor', patterns: ['diversity', 'coverage', 'floor'] },
  { category: 'copyright-gate', patterns: ['copyright', 'paywalled', 'gated'] },
  { category: 'ai-fallback', patterns: ['fallback', 'budget', 'max_generations', 'deterministic'] },
  { category: 'editorial-hold', patterns: ['held', 'hold', 'fact corroboration'] },
  { category: 'cycle-mismatch', patterns: ['cycle mismatch'] },
];
const SAMPLE_CAP = 3;

function matchWarningCategory(warning: string): string {
  const lower = warning.toLowerCase();
  for (const { category, patterns } of WARNING_PATTERNS) {
    if (patterns.some((p) => lower.includes(p))) return category;
  }
  return 'other';
}

export function categorizeWarnings(warnings: string[]): WarningCategory[] {
  const map = new Map<string, { count: number; sample: string[] }>();
  for (const w of warnings) {
    const cat = matchWarningCategory(w);
    const entry = map.get(cat) ?? { count: 0, sample: [] };
    entry.count++;
    if (entry.sample.length < SAMPLE_CAP) entry.sample.push(w);
    map.set(cat, entry);
  }
  return Array.from(map.entries()).map(([category, { count, sample }]) => ({
    category,
    count,
    sample,
  }));
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * `manifest.json` — the stable, versioned handoff the site consumes. ardur.ai
 * reads this to know which cycle is live, when it expires, and the run ids to
 * trace. Additive-only: new optional fields never break an older consumer.
 */
export interface PublishManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  cycle: CycleMeta;
  status: PublishStatus;
  publishedAt: string; // ISO 8601 UTC
  nextRefreshAt: string; // cycle.windowEnd
  /** Run ids per stage, for end-to-end tracing across the four engines. */
  runIds: {
    aggregation: string;
    ranking: string;
    top10: string;
    articles: string;
  };
  /** Relative paths (from the store root) the site can fetch directly. */
  artifacts: {
    aggregation: string;
    ranking: string;
    top10: string;
    articles: string;
  };
  /**
   * Warnings compacted by category for the manifest consumer.
   * Full raw list lives in `cycles/<id>/run.json`.
   */
  warnings: WarningCategory[];
  /** One-glance health badge for the site. */
  health: HealthRollup;
  /** Topic + headline summary so the site can render without parsing payloads. */
  summary: {
    topicsCovered: string[];
    globalTop10: { rank: number; topic: string; headline: string }[];
    /** Count of articles in latest/articles.json (published only, held excluded). */
    articleCount: number;
  };
}

/** Full archive record stored in `cycles/<id>/run.json` (superset of manifest). */
interface RunArchive extends PublishManifest {
  rawWarnings: string[];
}

const STAGE_FILES = {
  aggregation: 'aggregation.json',
  ranking: 'ranking.json',
  top10: 'top10.json',
  articles: 'articles.json',
} as const;

export interface PublishOptions {
  /** Write the archive but skip `latest/` + `manifest.json` pointer flip. */
  dryRun?: boolean;
  /** Full raw warning list for the immutable archive (manifest gets a summary). */
  rawWarnings?: string[];
}

/** Return a copy of the ArticleArtifact with only explicitly-published articles (allowlist). */
function publishedArticles(artifact: ArticleArtifact): ArticleArtifact {
  // Allowlist: only 'published' status (or absent status for backward-compat with pre-Rev3
  // artifacts) reaches readers. Any explicit non-'published' value ('held', 'draft', etc.)
  // is excluded. A blacklist (!== 'held') would silently pass through unknown future statuses.
  const live = artifact.data.articles.filter(
    (a) => a.editorialStatus === 'published' || a.editorialStatus == null,
  );
  if (live.length === artifact.data.articles.length) return artifact;
  return { ...artifact, data: { ...artifact.data, articles: live } };
}

export class ArtifactStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private manifestPath(): string {
    return join(this.root, 'manifest.json');
  }

  cycleDir(cycle: CycleMeta): string {
    return join(this.root, 'cycles', cycle.id.replace(/:/g, '-'));
  }

  /** Read the current manifest, or null if nothing has been published yet. */
  async readManifest(): Promise<PublishManifest | null> {
    const path = this.manifestPath();
    if (!existsSync(path)) return null;
    return JSON.parse(await readFile(path, 'utf8')) as PublishManifest;
  }

  /**
   * Idempotency guard: if THIS cycle is already the live manifest, return its
   * Top-10 so a re-fire short-circuits. Returns null otherwise.
   */
  async loadPublished(cycle: CycleMeta): Promise<Top10Artifact | null> {
    const manifest = await this.readManifest();
    if (!manifest || manifest.cycle.id !== cycle.id) return null;
    return this.readCycleArtifact<Top10Artifact>(cycle, 'top10');
  }

  /** Load the previous cycle's Top-10 (whatever is currently live) for deltas. */
  async loadPreviousTop10(cycle: CycleMeta): Promise<Top10Artifact | null> {
    const manifest = await this.readManifest();
    if (!manifest || manifest.cycle.id === cycle.id) return null;
    return this.readCycleArtifact<Top10Artifact>(manifest.cycle, 'top10');
  }

  private async readCycleArtifact<T>(
    cycle: CycleMeta,
    stage: keyof typeof STAGE_FILES,
  ): Promise<T | null> {
    const path = join(this.cycleDir(cycle), STAGE_FILES[stage]);
    if (!existsSync(path)) return null;
    return JSON.parse(await readFile(path, 'utf8')) as T;
  }

  /**
   * Publish one cycle, all-or-nothing.
   *  1. write the immutable archive under cycles/<id>/ (full artifact, held included)
   *  2. stage latest/ with held articles filtered out
   *  3. atomically rename both into place (pointer flip) — skipped on dryRun
   */
  async publish(
    set: CyclePublishSet,
    manifest: PublishManifest,
    opts?: PublishOptions,
  ): Promise<void> {
    const dir = this.cycleDir(set.cycle);
    await mkdir(dir, { recursive: true });
    const rawWarnings = opts?.rawWarnings ?? [];
    const runRecord: RunArchive = { ...manifest, rawWarnings };

    // Archive always stores the FULL artifact (held articles included for audit).
    await Promise.all([
      writeFile(join(dir, STAGE_FILES.aggregation), pretty(set.aggregation)),
      writeFile(join(dir, STAGE_FILES.ranking), pretty(set.ranking)),
      writeFile(join(dir, STAGE_FILES.top10), pretty(set.top10)),
      writeFile(join(dir, STAGE_FILES.articles), pretty(set.articles)),
      writeFile(join(dir, 'run.json'), pretty(runRecord)),
    ]);

    if (opts?.dryRun) return;

    // Build a held-filtered view of articles for the live pointer.
    const liveArticles = publishedArticles(set.articles);

    // Stage latest/ explicitly (cannot cp cycle dir — articles differ).
    const latest = join(this.root, 'latest');
    const latestTmp = join(this.root, `.latest.tmp-${set.cycle.id.replace(/:/g, '-')}`);
    await rm(latestTmp, { recursive: true, force: true });
    await mkdir(latestTmp, { recursive: true });
    await Promise.all([
      writeFile(join(latestTmp, STAGE_FILES.aggregation), pretty(set.aggregation)),
      writeFile(join(latestTmp, STAGE_FILES.ranking), pretty(set.ranking)),
      writeFile(join(latestTmp, STAGE_FILES.top10), pretty(set.top10)),
      writeFile(join(latestTmp, STAGE_FILES.articles), pretty(liveArticles)),
    ]);
    await rm(latest, { recursive: true, force: true });
    await rename(latestTmp, latest);

    // Flip the manifest pointer last, via temp-file + rename.
    const manifestTmp = this.manifestPath() + '.tmp';
    await writeFile(manifestTmp, pretty(manifest));
    await rename(manifestTmp, this.manifestPath());
  }
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/** Build the manifest from a publish set + run outcome. */
export function buildManifest(
  set: CyclePublishSet,
  status: PublishStatus,
  publishedAt: string,
  warnings: string[],
): PublishManifest {
  const cycleSlug = set.cycle.id.replace(/:/g, '-');

  // Health rollup derived from actual artifact data.
  const coverages = Object.values(set.aggregation.data.coverageByTopic);
  const failedSources = coverages.reduce(
    (sum, c) => sum + Math.max(0, c.sourcesQueried - c.sourcesResponded),
    0,
  );
  const degradedTopics = coverages.filter((c) => c.degraded).length;
  const totalArticles = set.articles.data.articles.length;
  const heldArticles = set.articles.data.articles.filter(
    (a) => a.editorialStatus === 'held',
  ).length;
  const publishedCount = totalArticles - heldArticles;
  const articlesDropped = Math.max(0, 10 - totalArticles);
  const usedFallback = warnings.some(
    (w) => w.toLowerCase().includes('fallback') || w.toLowerCase().includes('deterministic'),
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    cycle: set.cycle,
    status,
    publishedAt,
    nextRefreshAt: set.top10.data.nextRefreshAt,
    runIds: {
      aggregation: set.aggregation.runId,
      ranking: set.ranking.runId,
      top10: set.top10.runId,
      articles: set.articles.runId,
    },
    artifacts: {
      aggregation: `cycles/${cycleSlug}/${STAGE_FILES.aggregation}`,
      ranking: `cycles/${cycleSlug}/${STAGE_FILES.ranking}`,
      top10: `cycles/${cycleSlug}/${STAGE_FILES.top10}`,
      articles: `cycles/${cycleSlug}/${STAGE_FILES.articles}`,
    },
    warnings: categorizeWarnings(warnings),
    health: { failedSources, degradedTopics, articlesDropped, heldArticles, usedFallback },
    summary: {
      topicsCovered: set.top10.data.topicsCovered,
      globalTop10: set.top10.data.global.map((e) => ({
        rank: e.rank,
        topic: e.topic,
        headline: e.headline,
      })),
      articleCount: publishedCount,
    },
  };
}
