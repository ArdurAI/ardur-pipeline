/**
 * Golden fixture tests — run the orchestrator end-to-end over pre-baked, deterministic
 * artifacts and assert the full output structure.
 *
 * These tests cover:
 *  - Full dry-run: all four stages run, archive is written correctly, no pointer flip.
 *  - Idempotent re-run: the second publish attempt is a no-op (status: 'skipped').
 *  - Manifest structure: health rollup, warning categories, summary, runIds.
 *  - run.json archive: includes rawWarnings for forensics.
 *  - metrics.ndjson grows by one line per distinct cycle.
 *
 * Fake runners return golden, pin-point artifacts so the assertions are stable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cycleFor, nextRefreshAt } from './cycle.ts';
import { ArtifactStore } from './store.ts';
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

function testConfig(storeRoot: string) {
  return loadConfig({ ARTIFACT_STORE: storeRoot, STAGE_RETRIES: '0', STAGE_BACKOFF_MS: '0' });
}

/** Pre-baked artifact set used across all golden assertions. */
function goldenRunners(cycle: CycleMeta, warnings: string[] = []): StageRunners {
  return {
    async aggregate() {
      return {
        schemaVersion: SCHEMA_VERSION,
        artifact: 'aggregation',
        runId: 'golden-agg-run',
        upstreamRunId: null,
        generatedAt: cycle.windowStart,
        cycle,
        topics: [{ id: 'ai', label: 'AI', description: 'Artificial intelligence' }],
        warnings,
        data: {
          itemsByTopic: {
            ai: [
              {
                id: 'item-1',
                topic: 'ai',
                topicLabel: 'AI',
                title: 'Golden Article One',
                source: 'TechNews',
                sourceDomain: 'technews.com',
                sourceUrl: 'https://technews.com',
                url: 'https://technews.com/golden-1',
                tier: 'technical-news',
                publishedAt: cycle.windowStart,
                summaryHint: 'A summary hint',
                interaction: {
                  feedRank: 0,
                  shares: null,
                  comments: null,
                  reactions: null,
                  crossSourceMentions: 2,
                  velocity: null,
                  capturedAt: cycle.windowStart,
                  provenance: 'rss-position',
                },
                clusterId: 'cluster-1',
                fingerprint: 'golden-fp-1',
              },
            ],
          },
          clustersByTopic: {
            ai: [
              {
                clusterId: 'cluster-1',
                topic: 'ai',
                topicLabel: 'AI',
                headline: 'Golden Article One',
                memberIds: ['item-1'],
                sourceCount: 1,
                distinctDomains: 1,
                tierHistogram: { 'technical-news': 1 },
                earliestPublishedAt: cycle.windowStart,
                latestPublishedAt: cycle.windowStart,
              },
            ],
          },
          coverageByTopic: {
            ai: {
              sourcesConfigured: 20,
              sourcesQueried: 20,
              sourcesResponded: 18,
              distinctDomains: 15,
              degraded: false,
            },
          },
        },
      } as AggregationArtifact;
    },

    async rank(aggregation) {
      return {
        schemaVersion: SCHEMA_VERSION,
        artifact: 'ranking',
        runId: 'golden-rank-run',
        upstreamRunId: aggregation.runId,
        generatedAt: cycle.windowStart,
        cycle,
        topics: aggregation.topics,
        warnings: [],
        data: {
          rankedByTopic: {
            ai: [
              {
                clusterId: 'cluster-1',
                topic: 'ai',
                topicLabel: 'AI',
                headline: 'Golden Article One',
                rank: 1,
                score: {
                  interaction: 0.8,
                  credibility: 0.9,
                  recency: 0.7,
                  diversity: 0.6,
                  corroboration: 0.85,
                  total: 0.81,
                  weights: {
                    interaction: 0.2,
                    credibility: 0.25,
                    recency: 0.2,
                    diversity: 0.15,
                    corroboration: 0.2,
                  },
                },
                sourceQuality: 'multi-source',
                confidence: 'high',
                verification: 'multi-source',
                sourceCount: 1,
                distinctDomains: 1,
                tierHistogram: { 'technical-news': 1 },
                memberIds: ['item-1'],
                earliestPublishedAt: cycle.windowStart,
                latestPublishedAt: cycle.windowStart,
                auditId: 'audit-1',
              },
            ],
          },
          audit: [
            {
              auditId: 'audit-1',
              clusterId: 'cluster-1',
              topic: 'ai',
              inputs: {
                interaction: 0.8,
                credibility: 0.9,
                recency: 0.7,
                diversity: 0.6,
                corroboration: 0.85,
              },
              weights: {
                interaction: 0.2,
                credibility: 0.25,
                recency: 0.2,
                diversity: 0.15,
                corroboration: 0.2,
              },
              computed: {
                interaction: 0.8,
                credibility: 0.9,
                recency: 0.7,
                diversity: 0.6,
                corroboration: 0.85,
                total: 0.81,
                weights: {},
              },
              rationale: 'Deterministic golden score',
              weightProfile: 'balanced@v1',
              rankedAt: cycle.windowStart,
            },
          ],
          weightProfile: 'balanced@v1',
        },
      } as RankingArtifact;
    },

    async selectTop10(ranking, _previous, _aggregation) {
      return {
        schemaVersion: SCHEMA_VERSION,
        artifact: 'top10',
        runId: 'golden-top10-run',
        upstreamRunId: ranking.runId,
        generatedAt: cycle.windowStart,
        cycle,
        topics: ranking.topics,
        warnings: [],
        data: {
          nextRefreshAt: nextRefreshAt(cycle),
          topicsCovered: ['ai'],
          top10ByTopic: {
            ai: [
              {
                rank: 1,
                clusterId: 'cluster-1',
                topic: 'ai',
                topicLabel: 'AI',
                headline: 'Golden Article One',
                score: {
                  interaction: 0.8,
                  credibility: 0.9,
                  recency: 0.7,
                  diversity: 0.6,
                  corroboration: 0.85,
                  total: 0.81,
                  weights: {},
                },
                sourceQuality: 'multi-source',
                confidence: 'high',
                references: [
                  {
                    source: 'TechNews',
                    sourceDomain: 'technews.com',
                    tier: 'technical-news',
                    url: 'https://technews.com/golden-1',
                    title: 'Golden Article One',
                    publishedAt: cycle.windowStart,
                  },
                ],
                delta: { previousRank: null, movement: 'new' },
                carriedOver: false,
              },
            ],
          },
          global: [
            {
              rank: 1,
              clusterId: 'cluster-1',
              topic: 'ai',
              topicLabel: 'AI',
              headline: 'Golden Article One',
              score: {
                interaction: 0.8,
                credibility: 0.9,
                recency: 0.7,
                diversity: 0.6,
                corroboration: 0.85,
                total: 0.81,
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
        },
      } as Top10Artifact;
    },

    async synthesize(top10, _aggregation) {
      return {
        schemaVersion: SCHEMA_VERSION,
        artifact: 'articles',
        runId: 'golden-art-run',
        upstreamRunId: top10.runId,
        generatedAt: cycle.windowStart,
        cycle,
        topics: top10.topics,
        warnings: [],
        data: {
          articles: [
            {
              id: 'article-golden-1',
              rank: 1,
              topic: 'ai',
              topicLabel: 'AI',
              headline: 'Golden Article One',
              dek: 'The golden standfirst.',
              body: [{ type: 'paragraph', text: 'Golden body paragraph.' }],
              keyPoints: ['Point one'],
              whyItMatters: 'It matters because gold.',
              readerAction: 'Read the original.',
              tags: ['ai', 'golden'],
              confidence: 'high',
              sourceQuality: 'multi-source',
              references: [
                {
                  source: 'TechNews',
                  sourceDomain: 'technews.com',
                  tier: 'technical-news',
                  url: 'https://technews.com/golden-1',
                  title: 'Golden Article One',
                  publishedAt: cycle.windowStart,
                },
              ],
              provenance: {
                clusterId: 'cluster-1',
                sourceCount: 1,
                distinctDomains: 1,
                upstreamRunId: 'golden-top10-run',
              },
              ai: {
                provider: 'deterministic',
                model: 'none',
                status: 'fallback',
                generatedAt: cycle.windowStart,
              },
              legalNote: 'Original text only.',
              wordCount: 5,
              readingTimeMinutes: 1,
              generatedAt: cycle.windowStart,
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
      } as ArticleArtifact;
    },
  };
}

// ---------------------------------------------------------------------------
// Golden fixture tests
// ---------------------------------------------------------------------------

test('dry-run: writes full archive with golden artifacts, no pointer flip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-golden-dry-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T06:30:00Z');
  const cycle = cycleFor(now());
  const cycleSlug = cycle.id.replace(/:/g, '-');

  const res = await runCycle({
    config,
    logger: silent,
    now,
    dryRun: true,
    runners: goldenRunners(cycle),
  });

  // Status semantics are the same as a real publish.
  assert.equal(res.status, 'published');
  assert.equal(res.dryRun, true);

  // All four stage files must be in the archive.
  for (const file of [
    'aggregation.json',
    'ranking.json',
    'top10.json',
    'articles.json',
    'run.json',
  ]) {
    assert.ok(existsSync(join(root, 'cycles', cycleSlug, file)), `archive/${file} missing`);
  }

  // Assert specific golden content in the archive.
  const top10Archive = JSON.parse(
    await readFile(join(root, 'cycles', cycleSlug, 'top10.json'), 'utf8'),
  ) as Top10Artifact;
  assert.equal(top10Archive.data.global[0]?.headline, 'Golden Article One');
  assert.equal(top10Archive.runId, 'golden-top10-run');

  const articlesArchive = JSON.parse(
    await readFile(join(root, 'cycles', cycleSlug, 'articles.json'), 'utf8'),
  ) as ArticleArtifact;
  assert.equal(articlesArchive.data.articles.length, 1);
  assert.equal(articlesArchive.data.articles[0]?.id, 'article-golden-1');

  // run.json carries rawWarnings.
  const runRec = JSON.parse(await readFile(join(root, 'cycles', cycleSlug, 'run.json'), 'utf8'));
  assert.ok(Array.isArray(runRec.rawWarnings));

  // Pointer files must NOT exist.
  assert.ok(!existsSync(join(root, 'manifest.json')), 'manifest.json must not exist after dry-run');
  assert.ok(!existsSync(join(root, 'latest')), 'latest/ must not exist after dry-run');
});

test('real publish produces correct manifest structure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-golden-pub-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T06:30:00Z');
  const cycle = cycleFor(now());

  await runCycle({ config, logger: silent, now, runners: goldenRunners(cycle) });

  const store = new ArtifactStore(root);
  const manifest = await store.readManifest();
  assert.ok(manifest, 'manifest.json must exist after publish');

  // Schema version.
  assert.equal(manifest.schemaVersion, SCHEMA_VERSION);

  // Cycle id correct.
  assert.equal(manifest.cycle.id, cycle.id);

  // RunIds match golden runner ids.
  assert.equal(manifest.runIds.aggregation, 'golden-agg-run');
  assert.equal(manifest.runIds.ranking, 'golden-rank-run');
  assert.equal(manifest.runIds.top10, 'golden-top10-run');
  assert.equal(manifest.runIds.articles, 'golden-art-run');

  // Summary.
  assert.deepEqual(manifest.summary.topicsCovered, ['ai']);
  assert.equal(manifest.summary.globalTop10[0]?.headline, 'Golden Article One');
  assert.equal(manifest.summary.articleCount, 1);

  // Health rollup.
  assert.equal(manifest.health.failedSources, 2); // 20 queried, 18 responded
  assert.equal(manifest.health.degradedTopics, 0);
  assert.equal(manifest.health.articlesDropped, 9); // expected 10, got 1
  assert.equal(manifest.health.usedFallback, false);

  // Warnings array is categorized (not raw strings).
  assert.ok(Array.isArray(manifest.warnings));
  if (manifest.warnings.length > 0) {
    assert.ok(typeof manifest.warnings[0]!.category === 'string');
  }

  // nextRefreshAt points to cycle end.
  assert.equal(manifest.nextRefreshAt, cycle.windowEnd);
});

test('idempotent re-run after real publish returns skipped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-golden-idem-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T06:30:00Z');
  const cycle = cycleFor(now());

  const first = await runCycle({ config, logger: silent, now, runners: goldenRunners(cycle) });
  assert.equal(first.status, 'published');

  const second = await runCycle({ config, logger: silent, now, runners: goldenRunners(cycle) });
  assert.equal(second.status, 'skipped');
  assert.equal(second.dryRun, undefined);
});

test('dry-run then real run: real run publishes correctly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-golden-dry-then-real-'));
  const config = testConfig(root);
  const now = () => new Date('2026-06-11T06:30:00Z');
  const cycle = cycleFor(now());

  // Dry-run does not prevent the real publish.
  const dry = await runCycle({
    config,
    logger: silent,
    now,
    dryRun: true,
    runners: goldenRunners(cycle),
  });
  assert.equal(dry.status, 'published');
  assert.equal(dry.dryRun, true);

  const real = await runCycle({ config, logger: silent, now, runners: goldenRunners(cycle) });
  assert.equal(real.status, 'published');
  assert.equal(real.dryRun, undefined);

  // Now it's idempotent.
  const replay = await runCycle({ config, logger: silent, now, runners: goldenRunners(cycle) });
  assert.equal(replay.status, 'skipped');
});

test('metrics.ndjson accumulates one line per non-duplicate cycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ardur-golden-ndjson-'));
  const config = testConfig(root);

  // Two distinct cycles.
  const now1 = () => new Date('2026-06-11T06:30:00Z');
  const now2 = () => new Date('2026-06-11T12:30:00Z');
  const c1 = cycleFor(now1());
  const c2 = cycleFor(now2());

  await runCycle({ config, logger: silent, now: now1, runners: goldenRunners(c1) });
  await runCycle({ config, logger: silent, now: now2, runners: goldenRunners(c2) });

  const ndjsonPath = join(root, 'metrics.ndjson');
  const lines = (await readFile(ndjsonPath, 'utf8')).trim().split('\n');
  assert.ok(lines.length >= 2, 'at least 2 metrics lines for 2 cycles');

  const ids = lines.map((l) => (JSON.parse(l) as { cycleId: string }).cycleId);
  assert.ok(ids.includes(c1.id));
  assert.ok(ids.includes(c2.id));
});
