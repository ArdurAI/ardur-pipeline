/**
 * Unit tests for the SQLite + FTS5 coverage store.
 * Requires --experimental-sqlite (Node 22.5+) — already in the test script.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoverageStore, openCoverageStore } from './coverage-store.ts';

async function tempDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ardur-cov-'));
  return join(dir, 'coverage.db');
}

// ---------------------------------------------------------------------------
// Fingerprint lookup (stage 1)
// ---------------------------------------------------------------------------

test('record and check by exact fingerprint', async () => {
  const store = new CoverageStore(await tempDb());

  store.record(
    {
      fingerprint: 'fp-1',
      clusterId: 'cluster-1',
      topic: 'ai',
      cycleId: '2026-06-11T06:00:00.000Z',
      publishedAt: '2026-06-11T07:00:00.000Z',
      articleSlug: 'ai-article-1',
      angle: 'GPT-4 update',
    },
    '2026-06-11T07:00:00.000Z',
  );

  const result = store.check({ fingerprint: 'fp-1' });
  assert.equal(result.covered, true);
  assert.equal(result.hitCount, 1);
  assert.equal(result.hits[0]?.matchType, 'fingerprint');
  assert.equal(result.hits[0]?.topic, 'ai');

  store.close();
});

test('unknown fingerprint → not covered', async () => {
  const store = new CoverageStore(await tempDb());
  const result = store.check({ fingerprint: 'nonexistent' });
  assert.equal(result.covered, false);
  assert.equal(result.hitCount, 0);
  store.close();
});

// ---------------------------------------------------------------------------
// FTS5 topic search (stage 2)
// ---------------------------------------------------------------------------

test('FTS5 topic search finds a recorded entry', async () => {
  const store = new CoverageStore(await tempDb());

  store.record(
    {
      fingerprint: 'fp-sec',
      clusterId: 'cluster-sec',
      topic: 'security',
      cycleId: '2026-06-11T06:00:00.000Z',
      publishedAt: '2026-06-11T07:00:00.000Z',
      articleSlug: 'log4j-patch',
      angle: 'Log4j patch released',
    },
    '2026-06-11T07:00:00.000Z',
  );

  const result = store.check({ topic: 'security' });
  assert.equal(result.covered, true);
  assert.ok(result.hits.some((h) => h.matchType === 'fts'));

  store.close();
});

test('FTS5 search on unknown topic → not covered', async () => {
  const store = new CoverageStore(await tempDb());
  const result = store.check({ topic: 'quantumcomputingz' });
  assert.equal(result.covered, false);
  store.close();
});

test('fingerprint match takes priority; FTS stage 2 is skipped when stage 1 hits', async () => {
  const store = new CoverageStore(await tempDb());

  store.record(
    {
      fingerprint: 'fp-ai',
      clusterId: 'c1',
      topic: 'ai',
      cycleId: '2026-06-11T06:00:00.000Z',
      publishedAt: '2026-06-11T07:00:00.000Z',
    },
    'now',
  );

  const result = store.check({ fingerprint: 'fp-ai', topic: 'ai' });
  // All hits should be fingerprint-match type (stage 1 found something)
  assert.ok(result.hits.every((h) => h.matchType === 'fingerprint'));

  store.close();
});

// ---------------------------------------------------------------------------
// Exhaustion threshold
// ---------------------------------------------------------------------------

test('topic is not exhausted with fewer than 3 distinct cycles', async () => {
  const store = new CoverageStore(await tempDb());

  store.record(
    {
      fingerprint: 'a',
      clusterId: 'c1',
      topic: 'devops',
      cycleId: 'cycle-1',
      publishedAt: '2026-01-01T00:00:00Z',
    },
    'now',
  );
  store.record(
    {
      fingerprint: 'b',
      clusterId: 'c2',
      topic: 'devops',
      cycleId: 'cycle-2',
      publishedAt: '2026-01-01T06:00:00Z',
    },
    'now',
  );

  assert.equal(store.check({ topic: 'devops' }).exhausted, false);
  store.close();
});

test('topic is exhausted at 3 distinct cycles', async () => {
  const store = new CoverageStore(await tempDb());

  store.record(
    {
      fingerprint: 'a',
      clusterId: 'c1',
      topic: 'devops',
      cycleId: 'cycle-1',
      publishedAt: '2026-01-01T00:00:00Z',
    },
    'now',
  );
  store.record(
    {
      fingerprint: 'b',
      clusterId: 'c2',
      topic: 'devops',
      cycleId: 'cycle-2',
      publishedAt: '2026-01-01T06:00:00Z',
    },
    'now',
  );
  store.record(
    {
      fingerprint: 'c',
      clusterId: 'c3',
      topic: 'devops',
      cycleId: 'cycle-3',
      publishedAt: '2026-01-01T12:00:00Z',
    },
    'now',
  );

  assert.equal(store.check({ topic: 'devops' }).exhausted, true);
  store.close();
});

// ---------------------------------------------------------------------------
// State_meta cursors
// ---------------------------------------------------------------------------

test('getCursor returns null for absent key', async () => {
  const store = new CoverageStore(await tempDb());
  assert.equal(store.getCursor('last-cycle'), null);
  store.close();
});

test('setCursor and getCursor round-trip', async () => {
  const store = new CoverageStore(await tempDb());
  store.setCursor('last-cycle', '2026-06-11T06:00:00.000Z', '2026-06-11T07:00:00.000Z');
  assert.equal(store.getCursor('last-cycle'), '2026-06-11T06:00:00.000Z');

  // Upsert replaces the value
  store.setCursor('last-cycle', '2026-06-11T12:00:00.000Z', '2026-06-11T13:00:00.000Z');
  assert.equal(store.getCursor('last-cycle'), '2026-06-11T12:00:00.000Z');

  store.close();
});

// ---------------------------------------------------------------------------
// Idempotency (UNIQUE fingerprint+cycle_id)
// ---------------------------------------------------------------------------

test('recording the same fingerprint+cycleId twice is a no-op', async () => {
  const store = new CoverageStore(await tempDb());

  const rec = {
    fingerprint: 'dup-fp',
    clusterId: 'c1',
    topic: 'ml',
    cycleId: 'cycle-1',
    publishedAt: '2026-06-11T00:00:00Z',
  };
  store.record(rec, 'now');
  store.record(rec, 'now'); // duplicate — INSERT OR IGNORE

  const result = store.check({ fingerprint: 'dup-fp' });
  assert.equal(result.hitCount, 1);

  store.close();
});

// ---------------------------------------------------------------------------
// openCoverageStore factory
// ---------------------------------------------------------------------------

test('openCoverageStore creates a store at <artifactStore>/coverage.db', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ardur-cov-open-'));
  const store = openCoverageStore(dir);

  // Verify it works by recording + checking
  store.record(
    {
      fingerprint: 'factory-fp',
      clusterId: 'c1',
      topic: 'test',
      cycleId: 'c1',
      publishedAt: '2026-01-01T00:00:00Z',
    },
    'now',
  );
  assert.equal(store.check({ fingerprint: 'factory-fp' }).covered, true);

  store.close();
});
