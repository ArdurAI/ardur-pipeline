/**
 * Unit smoke tests for the orchestrator's OWN logic — cycle math, the artifact
 * store round-trip, and the conductor's control flow (idempotency, last-good-wins,
 * degraded classification, dry-run, metrics) driven by FAKE runners.
 *
 * These deliberately do NOT spawn the real engines: true end-to-end coverage is
 * owned by `ardur-engine-e2e`. Here we only prove the glue behaves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cycleFor, cycleId, windowStart, nextRefreshAt } from './cycle.ts';
import { ArtifactStore, buildManifest, categorizeWarnings, type CyclePublishSet } from './store.ts';
import { runCycle } from './orchestrate.ts';
import { createLogger, type Logger } from './log.ts';
import { loadConfig } from './config.ts';
import { SCHEMA_VERSION, SchemaVersionError, assertCompatibleArtifact } from '@ardurai/contracts';
import type {
  AggregationArtifact,
  RankingArtifact,
  Top10Artifact,
  ArticleArtifact,
  CycleMeta,
} from '@ardurai/contracts';
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

// --- warning categorization -------------------------------------------------

test('categorizeWarnings groups by pattern and caps samples', () => {
  const warnings = [
    'blocked: example.com SSRF',
    'blocked: internal.net',
    'diversity floor missed for topic ai',
    'unknown issue',
  ];
  const cats = categorizeWarnings(warnings);
  const blocked = cats.find((c) => c.category === 'blocked-fetch');
  assert.ok(blocked, 'blocked-fetch category present');
  assert.equal(blocked.count, 2);
  assert.equal(blocked.sample.length, 2);
  const diversity = cats.find((c) => c.category === 'diversity-floor');
  assert.ok(diversity);
  assert.equal(diversity.count, 1);
});

// --- manifest health rollup -------------------------------------------------

test('buildManifest computes health rollup', async () => {
  const cycle = cycleFor(new Date('2026-06-11T06:00:00Z'));
  const runners = fakeRunners(cycle);
  const agg = await runners.aggregate(cycle);
  const rank = await runners.rank(agg);
  const top10 = await runners.selectTop10(rank, null, agg);
  const articles = await runners.synthesize(top10, agg);
  const set: CyclePublishSet = { cycle, aggregation: agg, ranking: rank, top10, articles };
  const manifest = buildManifest(set, 'published', cycle.windowStart, []);
  assert.equal(manifest.health.articlesDropped, 10); // 0 articles produced, expected 10
  assert.equal(manifest.health.usedFallback, false);
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

// --- dry-run (#4) -----------------------------------------------------------

test('dry-run writes archive but leaves manifest.json and latest/ untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-dry-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T12:30:00Z');
  const cycle = cycleFor(now());

  const res = await runCycle({
    config,
    logger: silent,
    now,
    dryRun: true,
    runners: fakeRunners(cycle),
  });

  assert.equal(res.status, 'published');
  assert.equal(res.dryRun, true);

  // Archive must exist.
  const cycleSlug = cycle.id.replace(/:/g, '-');
  assert.ok(existsSync(join(root, 'cycles', cycleSlug, 'top10.json')));
  assert.ok(existsSync(join(root, 'cycles', cycleSlug, 'run.json')));

  // Pointer files must NOT exist.
  assert.ok(
    !existsSync(join(root, 'manifest.json')),
    'manifest.json must not be written on dry-run',
  );
  assert.ok(!existsSync(join(root, 'latest')), 'latest/ must not be written on dry-run');
});

test('dry-run does not mark the cycle as published, so a subsequent real run succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-dry2-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T12:30:00Z');
  const cycle = cycleFor(now());

  await runCycle({ config, logger: silent, now, dryRun: true, runners: fakeRunners(cycle) });

  // Real run should still publish (dry-run didn't flip the pointer).
  const real = await runCycle({ config, logger: silent, now, runners: fakeRunners(cycle) });
  assert.equal(real.status, 'published');
  assert.equal(real.dryRun, undefined);
  assert.ok(existsSync(join(root, 'manifest.json')));
});

// --- metrics (#3) -----------------------------------------------------------

test('a published cycle emits metrics.json and appends to metrics.ndjson', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-metrics-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T18:30:00Z');
  const cycle = cycleFor(now());

  await runCycle({ config, logger: silent, now, runners: fakeRunners(cycle) });

  const cycleSlug = cycle.id.replace(/:/g, '-');
  const metricsPath = join(root, 'cycles', cycleSlug, 'metrics.json');
  assert.ok(existsSync(metricsPath), 'metrics.json written');
  const m = JSON.parse(await readFile(metricsPath, 'utf8'));
  assert.equal(m.cycleId, cycle.id);
  assert.equal(m.status, 'published');
  assert.ok(typeof m.fullCycleMs === 'number');
  assert.ok(typeof m.slo.withinBudget === 'boolean');
  assert.ok(m.slo.artifactFresh === true);

  const ndjsonPath = join(root, 'metrics.ndjson');
  assert.ok(existsSync(ndjsonPath), 'metrics.ndjson written');
  const lines = (await readFile(ndjsonPath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]!);
  assert.equal(line.cycleId, cycle.id);
});

test('failed cycle also emits metrics (partial)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-metrics-fail-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T18:30:00Z');
  const cycle = cycleFor(now());

  await runCycle({
    config,
    logger: silent,
    now,
    runners: fakeRunners(cycle, { failAt: 'aggregate' }),
  });

  const cycleSlug = cycle.id.replace(/:/g, '-');
  const metricsPath = join(root, 'cycles', cycleSlug, 'metrics.json');
  assert.ok(existsSync(metricsPath));
  const m = JSON.parse(await readFile(metricsPath, 'utf8'));
  assert.equal(m.status, 'failed');
  assert.equal(m.slo.artifactFresh, false);
});

// --- assertCompatibleArtifact gate (#8) ------------------------------------

test('assertCompatibleArtifact throws SchemaVersionError on wrong schemaVersion', () => {
  const bad = {
    schemaVersion: 'ardur-content-pipeline/v2',
    artifact: 'aggregation',
    data: {},
    warnings: [],
  };
  assert.throws(
    () => assertCompatibleArtifact(bad, 'aggregation'),
    (e) => e instanceof SchemaVersionError && e.detail.stage === 'aggregation',
  );
});

test('assertCompatibleArtifact throws SchemaVersionError on wrong artifact stage', () => {
  const bad = {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'ranking',
    data: {},
    warnings: [],
  };
  assert.throws(
    () => assertCompatibleArtifact(bad, 'aggregation'),
    (e) => e instanceof SchemaVersionError && e.detail.stage === 'aggregation',
  );
});

test('schema version mismatch in a runner fails the cycle with no publish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-gate-schema-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T06:30:00Z');
  const cycle = cycleFor(now());

  // Simulates parseArtifact gating a v2-schemaVersion payload from the aggregation engine.
  const badRunners: StageRunners = {
    async aggregate() {
      const payload = { schemaVersion: 'ardur-content-pipeline/v2', artifact: 'aggregation', data: {} };
      assertCompatibleArtifact(payload, 'aggregation');
      return payload as unknown as AggregationArtifact;
    },
    async rank() { throw new Error('unreachable'); },
    async selectTop10() { throw new Error('unreachable'); },
    async synthesize() { throw new Error('unreachable'); },
  };

  const res = await runCycle({ config, logger: silent, now, runners: badRunners });
  assert.equal(res.status, 'failed');
  assert.ok(res.warnings.some((w) => w.includes('v2')));
  const store = new ArtifactStore(root);
  assert.equal(await store.readManifest(), null, 'no publish on gate failure');
});

test('wrong artifact stage in a runner fails the cycle with no publish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-gate-stage-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T06:30:00Z');
  const cycle = cycleFor(now());

  // Simulates a mis-wired engine that outputs 'ranking' where 'aggregation' is expected.
  const miswiredRunners: StageRunners = {
    async aggregate() {
      const payload = { schemaVersion: SCHEMA_VERSION, artifact: 'ranking', data: {} };
      assertCompatibleArtifact(payload, 'aggregation');
      return payload as unknown as AggregationArtifact;
    },
    async rank() { throw new Error('unreachable'); },
    async selectTop10() { throw new Error('unreachable'); },
    async synthesize() { throw new Error('unreachable'); },
  };

  const res = await runCycle({ config, logger: silent, now, runners: miswiredRunners });
  assert.equal(res.status, 'failed');
  const store = new ArtifactStore(root);
  assert.equal(await store.readManifest(), null, 'no publish on stage mismatch');
});
