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
 *     articles.json
 *   cycles/<cycleId>/            <- immutable per-cycle archive (audit + rollback)
 *     aggregation.json ranking.json top10.json articles.json run.json
 *
 * Publish is **all-or-nothing**: the immutable archive is written first, then
 * `latest/` and `manifest.json` are swapped in via temp-file + rename. A reader
 * that loads `manifest.json` is guaranteed a complete, internally-consistent set
 * — there is no window where `latest/` is half-written. If a cycle fails, the
 * pointer is never flipped and the previous cycle keeps serving (last-good-wins).
 */

import { mkdir, readFile, writeFile, rename, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION } from './contracts.ts';
import type {
  AggregationArtifact,
  RankingArtifact,
  Top10Artifact,
  ArticleArtifact,
  CycleMeta,
} from './contracts.ts';

export type PublishStatus = 'published' | 'degraded';

/** The full set of artifacts produced by one successful cycle. */
export interface CyclePublishSet {
  cycle: CycleMeta;
  aggregation: AggregationArtifact;
  ranking: RankingArtifact;
  top10: Top10Artifact;
  articles: ArticleArtifact;
}

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
  /** Non-fatal degradations rolled up from every stage. */
  warnings: string[];
  /** Topic + headline summary so the site can render without parsing payloads. */
  summary: {
    topicsCovered: string[];
    globalTop10: { rank: number; topic: string; headline: string }[];
    articleCount: number;
  };
}

const STAGE_FILES = {
  aggregation: 'aggregation.json',
  ranking: 'ranking.json',
  top10: 'top10.json',
  articles: 'articles.json',
} as const;

export class ArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private manifestPath(): string {
    return join(this.root, 'manifest.json');
  }

  private cycleDir(cycle: CycleMeta): string {
    // ':' is filesystem-hostile on some platforms; encode it for the dir name.
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
   *  1. write the immutable archive under cycles/<id>/
   *  2. stage latest/ + manifest into temp dirs/files
   *  3. atomically rename them into place (pointer flip)
   */
  async publish(set: CyclePublishSet, manifest: PublishManifest): Promise<void> {
    const dir = this.cycleDir(set.cycle);
    await mkdir(dir, { recursive: true });
    await Promise.all([
      writeFile(join(dir, STAGE_FILES.aggregation), pretty(set.aggregation)),
      writeFile(join(dir, STAGE_FILES.ranking), pretty(set.ranking)),
      writeFile(join(dir, STAGE_FILES.top10), pretty(set.top10)),
      writeFile(join(dir, STAGE_FILES.articles), pretty(set.articles)),
      writeFile(join(dir, 'run.json'), pretty(manifest)),
    ]);

    // Stage latest/ in a temp dir, then swap atomically.
    const latest = join(this.root, 'latest');
    const latestTmp = join(this.root, `.latest.tmp-${set.cycle.id.replace(/:/g, '-')}`);
    await rm(latestTmp, { recursive: true, force: true });
    await cp(dir, latestTmp, { recursive: true });
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
      aggregation: `cycles/${set.cycle.id.replace(/:/g, '-')}/${STAGE_FILES.aggregation}`,
      ranking: `cycles/${set.cycle.id.replace(/:/g, '-')}/${STAGE_FILES.ranking}`,
      top10: `cycles/${set.cycle.id.replace(/:/g, '-')}/${STAGE_FILES.top10}`,
      articles: `cycles/${set.cycle.id.replace(/:/g, '-')}/${STAGE_FILES.articles}`,
    },
    warnings,
    summary: {
      topicsCovered: set.top10.data.topicsCovered,
      globalTop10: set.top10.data.global.map((e) => ({
        rank: e.rank,
        topic: e.topic,
        headline: e.headline,
      })),
      articleCount: set.articles.data.articles.length,
    },
  };
}
