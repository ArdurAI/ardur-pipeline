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
import {
  ArtifactStore,
  buildManifest,
  categorizeWarnings,
  publishedArticles,
  applyLowConfidenceHold,
  type CyclePublishSet,
} from './store.ts';
import { runCycle } from './orchestrate.ts';
import { createLogger, type Logger } from './log.ts';
import { loadConfig, aiEnv } from './config.ts';
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

// --- cycle.id canonical format (#13) ----------------------------------------

test('cycleId emits full ISO 8601 UTC with milliseconds (canonical wire format)', () => {
  // Pins the format contract: @ardurai/contracts CycleMeta.id example is
  // "2026-06-11T06:00:00.000Z". The orchestrator's cycle-consistency check
  // compares this string against the id stamped in every engine artifact, so
  // the format must be exact — NOT the truncated "2026-06-11T06:00Z" form.
  assert.equal(cycleId(new Date('2026-06-11T06:00:00.000Z')), '2026-06-11T06:00:00.000Z');
  assert.equal(cycleId(new Date('2026-06-11T12:00:00.000Z')), '2026-06-11T12:00:00.000Z');
  assert.equal(cycleId(new Date('2026-06-11T18:00:00.000Z')), '2026-06-11T18:00:00.000Z');
  assert.equal(cycleId(new Date('2026-06-11T00:00:00.000Z')), '2026-06-11T00:00:00.000Z');
});

// --- sentinel catch-up math (#12) -------------------------------------------

test('windowStart floors every instant in a 6h window to the same boundary', () => {
  // The sentinel computes floor(now, 6h) in bash to find the "expected" cycle
  // id, then compares it against the live manifest. This test verifies the JS
  // equivalent: any instant inside a window resolves to the window start.
  const boundaries = [
    '2026-06-11T00:00:00.000Z',
    '2026-06-11T06:00:00.000Z',
    '2026-06-11T12:00:00.000Z',
    '2026-06-11T18:00:00.000Z',
  ];
  for (const boundary of boundaries) {
    const start = new Date(boundary);
    // One second before the NEXT window must still resolve to this boundary.
    const oneBeforeNext = new Date(start.getTime() + 6 * 60 * 60 * 1000 - 1000);
    assert.equal(
      cycleId(windowStart(oneBeforeNext)),
      boundary,
      `instant ${oneBeforeNext.toISOString()} should floor to ${boundary}`,
    );
    // The boundary itself resolves to itself.
    assert.equal(cycleId(windowStart(start)), boundary);
  }
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
  assert.equal(manifest.health.heldArticles, 0); // no held articles in fake fixture
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

  // Simulates parseArtifact gating a v2-schemaVersion payload from the aggregation engine.
  const badRunners: StageRunners = {
    async aggregate() {
      const payload = {
        schemaVersion: 'ardur-content-pipeline/v2',
        artifact: 'aggregation',
        data: {},
      };
      assertCompatibleArtifact(payload, 'aggregation');
      return payload as unknown as AggregationArtifact;
    },
    async rank() {
      throw new Error('unreachable');
    },
    async selectTop10() {
      throw new Error('unreachable');
    },
    async synthesize() {
      throw new Error('unreachable');
    },
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

  // Simulates a mis-wired engine that outputs 'ranking' where 'aggregation' is expected.
  const miswiredRunners: StageRunners = {
    async aggregate() {
      const payload = { schemaVersion: SCHEMA_VERSION, artifact: 'ranking', data: {} };
      assertCompatibleArtifact(payload, 'aggregation');
      return payload as unknown as AggregationArtifact;
    },
    async rank() {
      throw new Error('unreachable');
    },
    async selectTop10() {
      throw new Error('unreachable');
    },
    async synthesize() {
      throw new Error('unreachable');
    },
  };

  const res = await runCycle({ config, logger: silent, now, runners: miswiredRunners });
  assert.equal(res.status, 'failed');
  const store = new ArtifactStore(root);
  assert.equal(await store.readManifest(), null, 'no publish on stage mismatch');
});

// --- HOLD path (#15) --------------------------------------------------------

test('held articles are excluded from latest/ but included in cycle archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-hold-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T06:30:00Z');
  const cycle = cycleFor(now());

  // Runner that synthesizes one published + one held article.
  const holdRunners: StageRunners = {
    ...fakeRunners(cycle),
    async synthesize(top10) {
      return envelope('articles' as AggregationArtifact['artifact'], cycle, 'art-hold', {
        articles: [
          {
            id: 'art-pub-1',
            rank: 1,
            topic: 'ai',
            topicLabel: 'AI',
            headline: 'Published AI Article',
            dek: 'A published piece.',
            body: [],
            keyPoints: [],
            whyItMatters: '',
            readerAction: '',
            tags: [],
            confidence: 'high',
            sourceQuality: 'multi-source',
            references: [],
            provenance: {
              clusterId: 'c1',
              sourceCount: 1,
              distinctDomains: 1,
              upstreamRunId: top10.runId,
            },
            ai: {
              provider: 'deterministic',
              model: 'none',
              status: 'fallback',
              generatedAt: cycle.windowStart,
            },
            legalNote: '',
            wordCount: 10,
            readingTimeMinutes: 1,
            generatedAt: cycle.windowStart,
            editorialStatus: 'published',
          },
          {
            id: 'art-held-1',
            rank: 2,
            topic: 'security',
            topicLabel: 'Security',
            headline: 'Held Security Article',
            dek: 'Insufficient corroboration.',
            body: [],
            keyPoints: [],
            whyItMatters: '',
            readerAction: '',
            tags: [],
            confidence: 'low',
            sourceQuality: 'single source',
            references: [],
            provenance: {
              clusterId: 'c2',
              sourceCount: 1,
              distinctDomains: 1,
              upstreamRunId: top10.runId,
            },
            ai: {
              provider: 'deterministic',
              model: 'none',
              status: 'fallback',
              generatedAt: cycle.windowStart,
            },
            legalNote: '',
            wordCount: 5,
            readingTimeMinutes: 1,
            generatedAt: cycle.windowStart,
            editorialStatus: 'held',
          },
        ],
        copyrightPolicy: {
          originalTextOnly: true,
          maxQuoteWords: 25,
          reproduceArticleBody: false,
          requireAttribution: true,
          requireCanonicalLinks: true,
        },
      }) as unknown as ArticleArtifact;
    },
  };

  const res = await runCycle({ config, logger: silent, now, runners: holdRunners });

  // Cycle degrades because of the hold warning.
  assert.equal(res.status, 'degraded');
  assert.equal(res.heldCount, 1);
  assert.ok(res.warnings.some((w) => w.includes('held')));

  // Archive has both articles.
  const cycleSlug = cycle.id.replace(/:/g, '-');
  const archived = JSON.parse(
    await readFile(join(root, 'cycles', cycleSlug, 'articles.json'), 'utf8'),
  ) as ArticleArtifact;
  assert.equal(archived.data.articles.length, 2);

  // latest/ strips the held article.
  const live = JSON.parse(
    await readFile(join(root, 'latest', 'articles.json'), 'utf8'),
  ) as ArticleArtifact;
  assert.equal(live.data.articles.length, 1);
  assert.equal(live.data.articles[0]!.id, 'art-pub-1');

  // Manifest health reflects the split.
  const store = new ArtifactStore(root);
  const manifest = await store.readManifest();
  assert.ok(manifest);
  assert.equal(manifest.health.heldArticles, 1);
  assert.equal(manifest.summary.articleCount, 1);
});

// --- #20 allowlist gate -------------------------------------------------------

test('#20: allowlist — article with unknown status does not reach latest/', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-allowlist-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T06:30:00Z');
  const cycle = cycleFor(now());

  // Runner that returns an article with an unrecognised status ('draft').
  // The blacklist (!== 'held') would have let it through; the allowlist must not.
  const draftRunners: StageRunners = {
    ...fakeRunners(cycle),
    async synthesize(top10) {
      return envelope('articles' as AggregationArtifact['artifact'], cycle, 'art-draft', {
        articles: [
          {
            id: 'art-draft-1',
            rank: 1,
            topic: 'ai',
            topicLabel: 'AI',
            headline: 'Draft Article',
            dek: '',
            body: [],
            keyPoints: [],
            whyItMatters: '',
            readerAction: '',
            tags: [],
            confidence: 'high',
            sourceQuality: 'multi-source',
            references: [],
            provenance: {
              clusterId: 'c1',
              sourceCount: 1,
              distinctDomains: 1,
              upstreamRunId: top10.runId,
            },
            ai: {
              provider: 'deterministic',
              model: 'none',
              status: 'fallback',
              generatedAt: cycle.windowStart,
            },
            legalNote: '',
            wordCount: 10,
            readingTimeMinutes: 1,
            generatedAt: cycle.windowStart,
            editorialStatus: 'draft', // not 'published' and not 'held'
          },
        ],
        copyrightPolicy: {
          originalTextOnly: true,
          maxQuoteWords: 25,
          reproduceArticleBody: false,
          requireAttribution: true,
          requireCanonicalLinks: true,
        },
      }) as unknown as ArticleArtifact;
    },
  };

  await runCycle({ config, logger: silent, now, runners: draftRunners });

  const live = JSON.parse(
    await readFile(join(root, 'latest', 'articles.json'), 'utf8'),
  ) as ArticleArtifact;
  assert.equal(live.data.articles.length, 0, 'draft article must not reach latest/');
});

test('#20: low-confidence enforcement — conductor holds low-confidence articles the synthesizer passed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-lowconf-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T06:30:00Z');
  const cycle = cycleFor(now());

  // Runner returns two articles: one high-confidence published, one low-confidence published.
  // The synthesizer marks both as 'published'; the conductor must hold the low-confidence one.
  const lowConfRunners: StageRunners = {
    ...fakeRunners(cycle),
    async synthesize(top10) {
      return envelope('articles' as AggregationArtifact['artifact'], cycle, 'art-lc', {
        articles: [
          {
            id: 'art-hi-1',
            rank: 1,
            topic: 'ai',
            topicLabel: 'AI',
            headline: 'High-Confidence Article',
            dek: '',
            body: [],
            keyPoints: [],
            whyItMatters: '',
            readerAction: '',
            tags: [],
            confidence: 'high',
            sourceQuality: 'multi-source',
            references: [],
            provenance: {
              clusterId: 'c1',
              sourceCount: 2,
              distinctDomains: 2,
              upstreamRunId: top10.runId,
            },
            ai: {
              provider: 'deterministic',
              model: 'none',
              status: 'fallback',
              generatedAt: cycle.windowStart,
            },
            legalNote: '',
            wordCount: 100,
            readingTimeMinutes: 1,
            generatedAt: cycle.windowStart,
            editorialStatus: 'published', // synthesizer says published
          },
          {
            id: 'art-lo-1',
            rank: 2,
            topic: 'security',
            topicLabel: 'Security',
            headline: 'Low-Confidence Article',
            dek: '',
            body: [],
            keyPoints: [],
            whyItMatters: '',
            readerAction: '',
            tags: [],
            confidence: 'low', // low confidence
            sourceQuality: 'single source',
            references: [],
            provenance: {
              clusterId: 'c2',
              sourceCount: 1,
              distinctDomains: 1,
              upstreamRunId: top10.runId,
            },
            ai: {
              provider: 'deterministic',
              model: 'none',
              status: 'fallback',
              generatedAt: cycle.windowStart,
            },
            legalNote: '',
            wordCount: 10,
            readingTimeMinutes: 1,
            generatedAt: cycle.windowStart,
            editorialStatus: 'published', // synthesizer says published, but conductor must override
          },
        ],
        copyrightPolicy: {
          originalTextOnly: true,
          maxQuoteWords: 25,
          reproduceArticleBody: false,
          requireAttribution: true,
          requireCanonicalLinks: true,
        },
      }) as unknown as ArticleArtifact;
    },
  };

  const res = await runCycle({ config, logger: silent, now, runners: lowConfRunners });

  // Cycle must be degraded because the conductor held the low-confidence article.
  assert.equal(res.status, 'degraded');
  assert.equal(res.heldCount, 1);
  assert.ok(res.warnings.some((w) => w.includes('held')));

  // Archive has both articles (for editorial audit), the low-conf one now marked 'held'.
  const cycleSlug = cycle.id.replace(/:/g, '-');
  const archived = JSON.parse(
    await readFile(join(root, 'cycles', cycleSlug, 'articles.json'), 'utf8'),
  ) as ArticleArtifact;
  assert.equal(archived.data.articles.length, 2);
  const archivedLowConf = archived.data.articles.find((a) => a.id === 'art-lo-1');
  assert.ok(archivedLowConf, 'low-conf article must be in archive');
  assert.equal(archivedLowConf.editorialStatus, 'held', 'conductor must have set it to held');

  // latest/ must contain only the high-confidence article.
  const live = JSON.parse(
    await readFile(join(root, 'latest', 'articles.json'), 'utf8'),
  ) as ArticleArtifact;
  assert.equal(live.data.articles.length, 1);
  assert.equal(live.data.articles[0]!.id, 'art-hi-1');
});

// --- #29 articleCount matches the allowlist, not totalArticles-held -----------

test('#29: articleCount equals publishedArticles() allowlist count (not total-held)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-ac-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T06:30:00Z');
  const cycle = cycleFor(now());

  // Three articles: 1 published, 1 held, 1 draft.
  // total - held = 2, but allowlist count = 1 (only 'published' passes).
  const mixedRunners: StageRunners = {
    ...fakeRunners(cycle),
    async synthesize(top10) {
      return envelope('articles' as AggregationArtifact['artifact'], cycle, 'art-29', {
        articles: [
          {
            id: 'art-pub',
            rank: 1,
            topic: 'ai',
            topicLabel: 'AI',
            headline: 'H1',
            dek: '',
            body: [],
            keyPoints: [],
            whyItMatters: '',
            readerAction: '',
            tags: [],
            confidence: 'high',
            sourceQuality: 'multi-source',
            references: [],
            provenance: {
              clusterId: 'c1',
              sourceCount: 1,
              distinctDomains: 1,
              upstreamRunId: top10.runId,
            },
            ai: {
              provider: 'deterministic',
              model: 'none',
              status: 'fallback',
              generatedAt: cycle.windowStart,
            },
            legalNote: '',
            wordCount: 100,
            readingTimeMinutes: 1,
            generatedAt: cycle.windowStart,
            editorialStatus: 'published',
          },
          {
            id: 'art-held',
            rank: 2,
            topic: 'security',
            topicLabel: 'Security',
            headline: 'H2',
            dek: '',
            body: [],
            keyPoints: [],
            whyItMatters: '',
            readerAction: '',
            tags: [],
            confidence: 'high',
            sourceQuality: 'multi-source',
            references: [],
            provenance: {
              clusterId: 'c2',
              sourceCount: 1,
              distinctDomains: 1,
              upstreamRunId: top10.runId,
            },
            ai: {
              provider: 'deterministic',
              model: 'none',
              status: 'fallback',
              generatedAt: cycle.windowStart,
            },
            legalNote: '',
            wordCount: 100,
            readingTimeMinutes: 1,
            generatedAt: cycle.windowStart,
            editorialStatus: 'held',
          },
          {
            id: 'art-draft',
            rank: 3,
            topic: 'cloud',
            topicLabel: 'Cloud',
            headline: 'H3',
            dek: '',
            body: [],
            keyPoints: [],
            whyItMatters: '',
            readerAction: '',
            tags: [],
            confidence: 'high',
            sourceQuality: 'multi-source',
            references: [],
            provenance: {
              clusterId: 'c3',
              sourceCount: 1,
              distinctDomains: 1,
              upstreamRunId: top10.runId,
            },
            ai: {
              provider: 'deterministic',
              model: 'none',
              status: 'fallback',
              generatedAt: cycle.windowStart,
            },
            legalNote: '',
            wordCount: 100,
            readingTimeMinutes: 1,
            generatedAt: cycle.windowStart,
            editorialStatus: 'draft',
          },
        ],
        copyrightPolicy: {
          originalTextOnly: true,
          maxQuoteWords: 25,
          reproduceArticleBody: false,
          requireAttribution: true,
          requireCanonicalLinks: true,
        },
      }) as unknown as ArticleArtifact;
    },
  };

  await runCycle({ config, logger: silent, now, runners: mixedRunners });

  const store = new ArtifactStore(root);
  const manifest = await store.readManifest();
  assert.ok(manifest);

  // latest/articles.json must have only the 'published' article.
  const live = JSON.parse(
    await readFile(join(root, 'latest', 'articles.json'), 'utf8'),
  ) as ArticleArtifact;
  assert.equal(live.data.articles.length, 1);

  // manifest.summary.articleCount must equal the allowlist count, not total-held.
  assert.equal(
    manifest.summary.articleCount,
    live.data.articles.length,
    'articleCount must equal the count in latest/articles.json',
  );

  // health.heldArticles must still count only explicitly-held articles.
  assert.equal(manifest.health.heldArticles, 1);
});

// --- #33 manifest.artifacts.articles points at latest/ (held-filtered) -------

test('#33: manifest.artifacts.articles points at latest/articles.json, not the held-inclusive archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-art33-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T06:30:00Z');
  const cycle = cycleFor(now());

  await runCycle({ config, logger: silent, now, runners: fakeRunners(cycle) });

  const store = new ArtifactStore(root);
  const manifest = await store.readManifest();
  assert.ok(manifest);
  assert.equal(
    manifest.artifacts.articles,
    'latest/articles.json',
    'artifacts.articles must be the held-filtered live path (#33)',
  );
});

// --- #27 latest/ is continuously accessible across re-publish ----------------

test('#27: re-publish via atomic rename — latest/ is accessible before and after the swap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-swap27-'));
  const config = testConfig(root);
  const now1 = () => new Date('2026-06-11T06:30:00Z');
  const cycle1 = cycleFor(now1());
  const now2 = () => new Date('2026-06-11T13:00:00Z');
  const cycle2 = cycleFor(now2());

  // First publish.
  await runCycle({ config, logger: silent, now: now1, runners: fakeRunners(cycle1) });
  assert.ok(
    existsSync(join(root, 'latest', 'articles.json')),
    'latest/ must exist after first publish',
  );

  // Second publish into a different cycle.
  await runCycle({ config, logger: silent, now: now2, runners: fakeRunners(cycle2) });
  assert.ok(
    existsSync(join(root, 'latest', 'articles.json')),
    'latest/ must exist after second publish',
  );

  // Both cycle archives must coexist.
  assert.ok(
    existsSync(join(root, 'cycles', cycle1.id.replace(/:/g, '-'), 'articles.json')),
    'cycle1 archive exists',
  );
  assert.ok(
    existsSync(join(root, 'cycles', cycle2.id.replace(/:/g, '-'), 'articles.json')),
    'cycle2 archive exists',
  );
});

// --- publishedArticles / applyLowConfidenceHold exports (#42 dead-code fix) --

test('publishedArticles allowlist: only published and null-status pass, draft and held blocked', () => {
  const cycle = cycleFor(new Date('2026-06-11T06:00:00Z'));
  const base = {
    rank: 1,
    topic: 'ai',
    topicLabel: 'AI',
    headline: 'H',
    dek: '',
    body: [],
    keyPoints: [],
    whyItMatters: '',
    readerAction: '',
    tags: [],
    confidence: 'high' as const,
    sourceQuality: 'multi-source' as const,
    references: [],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'r' },
    ai: {
      provider: 'det',
      model: 'none',
      status: 'fallback' as const,
      generatedAt: cycle.windowStart,
    },
    legalNote: '',
    wordCount: 100,
    readingTimeMinutes: 1,
    generatedAt: cycle.windowStart,
  };
  const art = {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'articles' as const,
    stage: 'articles' as const,
    runId: 'r',
    upstreamRunId: null,
    generatedAt: cycle.windowStart,
    cycle,
    topics: [],
    warnings: [],
    data: {
      articles: [
        { ...base, id: 'pub', editorialStatus: 'published' as const },
        { ...base, id: 'held', editorialStatus: 'held' as const },
        { ...base, id: 'draft', editorialStatus: 'draft' as const },
        { ...base, id: 'none' },
      ],
      copyrightPolicy: {
        originalTextOnly: true,
        maxQuoteWords: 25,
        reproduceArticleBody: false,
        requireAttribution: true,
        requireCanonicalLinks: true,
      },
    },
  } as unknown as ArticleArtifact;
  const live = publishedArticles(art);
  assert.deepEqual(
    live.data.articles.map((a) => a.id),
    ['pub', 'none'],
  );
});

test('applyLowConfidenceHold forces low-confidence published → held', () => {
  const cycle = cycleFor(new Date('2026-06-11T06:00:00Z'));
  const base = {
    rank: 1,
    topic: 'ai',
    topicLabel: 'AI',
    headline: 'H',
    dek: '',
    body: [],
    keyPoints: [],
    whyItMatters: '',
    readerAction: '',
    tags: [],
    sourceQuality: 'multi-source' as const,
    references: [],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'r' },
    ai: {
      provider: 'det',
      model: 'none',
      status: 'fallback' as const,
      generatedAt: cycle.windowStart,
    },
    legalNote: '',
    wordCount: 100,
    readingTimeMinutes: 1,
    generatedAt: cycle.windowStart,
  };
  const art = {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'articles' as const,
    stage: 'articles' as const,
    runId: 'r',
    upstreamRunId: null,
    generatedAt: cycle.windowStart,
    cycle,
    topics: [],
    warnings: [],
    data: {
      articles: [
        { ...base, id: 'hi', confidence: 'high' as const, editorialStatus: 'published' as const },
        { ...base, id: 'lo', confidence: 'low' as const, editorialStatus: 'published' as const },
        {
          ...base,
          id: 'lo-already-held',
          confidence: 'low' as const,
          editorialStatus: 'held' as const,
        },
      ],
      copyrightPolicy: {
        originalTextOnly: true,
        maxQuoteWords: 25,
        reproduceArticleBody: false,
        requireAttribution: true,
        requireCanonicalLinks: true,
      },
    },
  } as unknown as ArticleArtifact;
  const result = applyLowConfidenceHold(art);
  const statuses = Object.fromEntries(result.data.articles.map((a) => [a.id, a.editorialStatus]));
  assert.equal(statuses['hi'], 'published');
  assert.equal(statuses['lo'], 'held');
  assert.equal(statuses['lo-already-held'], 'held');
});

// --- #45 mixed-cycle hard-fail before last-good publish -----------------------

test('#45: mixed-cycle artifacts hard-fail and preserve previous last-good', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-mix45-'));
  const config = testConfig(root);
  const now1 = () => new Date('2026-06-11T06:30:00Z');
  const cycle1 = cycleFor(now1());

  // Establish a good last-good first.
  const good = await runCycle({
    config,
    logger: silent,
    now: now1,
    runners: fakeRunners(cycle1),
  });
  assert.equal(good.status, 'published');
  const store = new ArtifactStore(root);
  const goodManifest = await store.readManifest();
  assert.ok(goodManifest);
  assert.equal(goodManifest.cycle.id, cycle1.id);

  // Next 6h window so we are not short-circuited by same-cycle idempotent skip.
  const now2 = () => new Date('2026-06-11T12:30:00Z');
  const cycle2 = cycleFor(now2());
  const wrongCycle: CycleMeta = {
    ...cycle2,
    id: '2099-01-01T00:00:00.000Z',
    windowStart: '2099-01-01T00:00:00.000Z',
    windowEnd: '2099-01-01T06:00:00.000Z',
  };
  const mixedRunners = fakeRunners(cycle2);
  const originalTop10 = mixedRunners.selectTop10;
  mixedRunners.selectTop10 = async (ranking, previous, aggregation) => {
    const top10 = await originalTop10(ranking, previous, aggregation);
    return { ...top10, cycle: wrongCycle };
  };

  const bad = await runCycle({
    config,
    logger: silent,
    now: now2,
    runners: mixedRunners,
  });
  assert.equal(bad.status, 'failed');
  assert.ok(bad.warnings.some((w) => /cycle mismatch/i.test(w)));
  assert.ok(bad.warnings.some((w) => /validation failure/i.test(w)));

  const liveManifest = await store.readManifest();
  assert.ok(liveManifest);
  assert.equal(liveManifest.cycle.id, cycle1.id, 'previous last-good must remain live');
  assert.equal(liveManifest.status, 'published');
});

test('aiEnv forwards Hermes proxy allowlist only', () => {
  const config = loadConfig({
    ARTIFACT_STORE: '/tmp/unused',
    ARDUR_AI_PROVIDER: 'hermes',
    ARDUR_AI_MAX_GENERATIONS: '3',
  });
  const prev = { ...process.env };
  try {
    process.env['GATEWAY_PROXY_URL'] = 'https://proxy.example/v1';
    process.env['GATEWAY_PROXY_KEY'] = 'secret-key';
    process.env['HERMES_PROXY_URL'] = 'https://hermes.example/v1';
    process.env['RANDOM_SECRET'] = 'should-not-forward';
    process.env['HERMES_AVAILABLE'] = '1';
    process.env['CI'] = 'false';
    const env = aiEnv(config);
    assert.equal(env.ARDUR_AI_PROVIDER, 'hermes');
    assert.equal(env.GATEWAY_PROXY_URL, 'https://proxy.example/v1');
    assert.equal(env.GATEWAY_PROXY_KEY, 'secret-key');
    assert.equal(env.HERMES_PROXY_URL, 'https://hermes.example/v1');
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'RANDOM_SECRET'), false);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
  }
});
