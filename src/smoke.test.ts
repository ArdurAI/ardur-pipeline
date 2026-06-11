/**
 * Unit smoke tests for the orchestrator's OWN logic — cycle math, the artifact
 * store round-trip, and the conductor's control flow (idempotency, last-good-wins,
 * degraded classification) driven by FAKE runners.
 *
 * These deliberately do NOT spawn the real engines: true end-to-end coverage is
 * owned by `ardur-engine-e2e`. Here we only prove the glue behaves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cycleFor, cycleId, windowStart, nextRefreshAt } from './cycle.ts';
import { ArtifactStore, buildManifest, type CyclePublishSet } from './store.ts';
import { runCycle } from './orchestrate.ts';
import { createLogger, type Logger } from './log.ts';
import { loadConfig } from './config.ts';
import { SCHEMA_VERSION } from './contracts.ts';
import type {
  AggregationArtifact,
  RankingArtifact,
  Top10Artifact,
  ArticleArtifact,
  CycleMeta,
} from './contracts.ts';
import type { StageRunners } from './runners.ts';

const silent: Logger = createLogger({ format: 'json', write: () => {} });

function testConfig(store: string) {
  const config = loadConfig({ ARTIFACT_STORE: store, STAGE_RETRIES: '0', STAGE_BACKOFF_MS: '0' });
  return config;
}

// --- tiny artifact fixtures -------------------------------------------------

function envelope<T>(
  stage: AggregationArtifact['artifact'],
  cycle: CycleMeta,
  runId: string,
  data: T,
  warnings: string[] = [],
) {
  return {
    schemaVersion: SCHEMA_VERSION,
    artifact: stage,
    runId,
    upstreamRunId: null,
    generatedAt: cycle.windowStart,
    cycle,
    topics: [],
    warnings,
    data,
  };
}

function fakeRunners(
  cycle: CycleMeta,
  opts: { failAt?: string; degrade?: boolean } = {},
): StageRunners {
  const warn = (s: string) => (opts.degrade ? [`degraded:${s}`] : []);
  return {
    async aggregate() {
      if (opts.failAt === 'aggregate') throw new Error('boom-aggregate');
      return envelope(
        'aggregation',
        cycle,
        'agg-1',
        { itemsByTopic: {}, clustersByTopic: {}, coverageByTopic: {} },
        warn('agg'),
      ) as AggregationArtifact;
    },
    async rank() {
      if (opts.failAt === 'rank') throw new Error('boom-rank');
      return envelope('ranking', cycle, 'rank-1', {
        rankedByTopic: {},
        audit: [],
        weightProfile: 'balanced@v1',
      }) as RankingArtifact;
    },
    async selectTop10() {
      if (opts.failAt === 'top10') throw new Error('boom-top10');
      return envelope('top10', cycle, 'top10-1', {
        nextRefreshAt: nextRefreshAt(cycle),
        topicsCovered: ['ai'],
        top10ByTopic: {},
        global: [
          {
            rank: 1,
            clusterId: 'c1',
            topic: 'ai',
            topicLabel: 'AI',
            headline: 'H1',
            score: {
              interaction: 0,
              credibility: 0,
              recency: 0,
              diversity: 0,
              corroboration: 0,
              total: 1,
              weights: {},
            },
            sourceQuality: 'multi-source',
            confidence: 'high',
            references: [],
            delta: { previousRank: null, movement: 'new' },
            carriedOver: false,
          },
        ],
        stability: { carriedOver: 0, fresh: 1, churnRate: 1 },
      }) as Top10Artifact;
    },
    async synthesize() {
      if (opts.failAt === 'synthesize') throw new Error('boom-synth');
      return envelope('articles', cycle, 'art-1', {
        articles: [],
        copyrightPolicy: {
          originalTextOnly: true,
          maxQuoteWords: 25,
          reproduceArticleBody: false,
          requireAttribution: true,
          requireCanonicalLinks: true,
        },
      }) as ArticleArtifact;
    },
  };
}

// --- cycle math -------------------------------------------------------------

test('cycle math floors to 6h UTC boundaries', () => {
  const c = cycleFor(new Date('2026-06-11T07:43:12Z'));
  assert.equal(c.id, '2026-06-11T06:00:00.000Z');
  assert.equal(c.windowStart, '2026-06-11T06:00:00.000Z');
  assert.equal(c.windowEnd, '2026-06-11T12:00:00.000Z');
  assert.equal(nextRefreshAt(c), c.windowEnd);
});

test('all instants within a window share a cycle id (idempotency basis)', () => {
  const a = cycleId(windowStart(new Date('2026-06-11T06:00:00Z')));
  const b = cycleId(windowStart(new Date('2026-06-11T11:59:59Z')));
  assert.equal(a, b);
});

// --- store round-trip -------------------------------------------------------

test('store publish is atomic and round-trips via manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-store-'));
  const store = new ArtifactStore(root);
  const cycle = cycleFor(new Date('2026-06-11T06:00:00Z'));
  const runners = fakeRunners(cycle);
  const set: CyclePublishSet = {
    cycle,
    aggregation: await runners.aggregate(cycle),
    ranking: await runners.rank(await runners.aggregate(cycle)),
    top10: await runners.selectTop10(
      await runners.rank(await runners.aggregate(cycle)),
      null,
      await runners.aggregate(cycle),
    ),
    articles: await runners.synthesize(
      await runners.selectTop10(
        await runners.rank(await runners.aggregate(cycle)),
        null,
        await runners.aggregate(cycle),
      ),
      await runners.aggregate(cycle),
    ),
  };
  const manifest = buildManifest(set, 'published', cycle.windowStart, []);
  await store.publish(set, manifest);

  const read = await store.readManifest();
  assert.equal(read?.cycle.id, cycle.id);
  assert.equal(read?.runIds.top10, 'top10-1');
  const latest = JSON.parse(await readFile(join(root, 'latest', 'articles.json'), 'utf8'));
  assert.equal(latest.artifact, 'articles');
});

// --- conductor control flow -------------------------------------------------

test('happy path publishes and is then idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-orch-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T06:30:00Z');
  const cycle = cycleFor(now());

  const first = await runCycle({ config, logger: silent, now, runners: fakeRunners(cycle) });
  assert.equal(first.status, 'published');

  const second = await runCycle({ config, logger: silent, now, runners: fakeRunners(cycle) });
  assert.equal(second.status, 'skipped');
});

test('a failed stage publishes nothing (last-good-wins)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-fail-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T06:30:00Z');
  const cycle = cycleFor(now());

  const res = await runCycle({
    config,
    logger: silent,
    now,
    runners: fakeRunners(cycle, { failAt: 'rank' }),
  });
  assert.equal(res.status, 'failed');
  const store = new ArtifactStore(root);
  assert.equal(await store.readManifest(), null);
});

test('upstream warnings classify the cycle as degraded but still publish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-degraded-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T06:30:00Z');
  const cycle = cycleFor(now());

  const res = await runCycle({
    config,
    logger: silent,
    now,
    runners: fakeRunners(cycle, { degrade: true }),
  });
  assert.equal(res.status, 'degraded');
  assert.ok(res.warnings.some((w) => w.startsWith('degraded:')));
  const store = new ArtifactStore(root);
  assert.equal((await store.readManifest())?.status, 'degraded');
});
