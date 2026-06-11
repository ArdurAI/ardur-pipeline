/**
 * Unit tests for the tool registry.
 *
 * Engine tools (aggregate / rank / select_top10 / synthesize) require the real
 * engine repos to be checked out, so we only test the registry's descriptor
 * listing, availability checks, and error-envelope behaviour here. The
 * check_coverage tool is tested end-to-end with a real temp DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolRegistry } from './tool-registry.ts';
import { CoverageStore } from './coverage-store.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './log.ts';

const silent = createLogger({ format: 'json', write: () => {} });

// ---------------------------------------------------------------------------
// Descriptor listing
// ---------------------------------------------------------------------------

test('tool registry exposes exactly 5 tools in the correct order', () => {
  const config = loadConfig({});
  const registry = createToolRegistry(config, silent);
  const descriptors = registry.descriptors();

  assert.equal(descriptors.length, 5);
  assert.deepEqual(
    descriptors.map((d) => d.name),
    ['aggregate', 'rank', 'select_top10', 'synthesize', 'check_coverage'],
  );
});

test('every tool has a non-empty description and object inputSchema', () => {
  const config = loadConfig({});
  const registry = createToolRegistry(config, silent);

  for (const d of registry.descriptors()) {
    assert.ok(d.description.length > 0, `${d.name}: description is empty`);
    assert.equal(d.inputSchema.type, 'object', `${d.name}: inputSchema.type must be "object"`);
    assert.ok(d.sizeBudget > 0, `${d.name}: sizeBudget must be positive`);
  }
});

test('availability() resolves for each tool without throwing', async () => {
  const config = loadConfig({});
  const registry = createToolRegistry(config, silent);

  for (const d of registry.descriptors()) {
    const avail = await d.availability();
    assert.ok(
      typeof avail.available === 'boolean',
      `${d.name}: availability.available must be boolean`,
    );
  }
});

// ---------------------------------------------------------------------------
// Error envelopes
// ---------------------------------------------------------------------------

test('unknown tool name returns UNKNOWN_TOOL error', async () => {
  const registry = createToolRegistry(loadConfig({}), silent);
  const result = await registry.call('nonexistent_tool', {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'UNKNOWN_TOOL');
});

test('rank without aggregation returns MISSING_INPUT error', async () => {
  const registry = createToolRegistry(loadConfig({}), silent);
  const result = await registry.call('rank', {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'MISSING_INPUT');
});

test('select_top10 without ranking returns MISSING_INPUT error', async () => {
  const registry = createToolRegistry(loadConfig({}), silent);
  const result = await registry.call('select_top10', { aggregation: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'MISSING_INPUT');
});

test('synthesize without top10 returns MISSING_INPUT error', async () => {
  const registry = createToolRegistry(loadConfig({}), silent);
  const result = await registry.call('synthesize', { aggregation: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'MISSING_INPUT');
});

test('check_coverage without topic or fingerprint returns MISSING_INPUT error', async () => {
  const registry = createToolRegistry(loadConfig({}), silent);
  const result = await registry.call('check_coverage', {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'MISSING_INPUT');
});

// ---------------------------------------------------------------------------
// check_coverage with a real temp DB
// ---------------------------------------------------------------------------

test('check_coverage returns covered=true for a recorded fingerprint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ardur-reg-cov-'));
  const dbPath = join(dir, 'coverage.db');

  // Pre-populate the DB
  const store = new CoverageStore(dbPath);
  store.record(
    {
      fingerprint: 'reg-fp-1',
      clusterId: 'c1',
      topic: 'ai',
      cycleId: 'cycle-1',
      publishedAt: '2026-06-11T07:00:00Z',
    },
    'now',
  );
  store.close();

  const config = loadConfig({ HERMES_COVERAGE_DB: dbPath });
  const registry = createToolRegistry(config, silent);
  const result = await registry.call('check_coverage', { fingerprint: 'reg-fp-1' });

  assert.equal(result.ok, true);
  if (result.ok) {
    const data = result.data as { covered: boolean };
    assert.equal(data.covered, true);
  }
});

test('check_coverage returns COVERAGE_DISABLED when coverageDbPath is empty', async () => {
  const config = loadConfig({ HERMES_COVERAGE_DB: '' });
  // Override the default so it's actually empty
  const patchedConfig = { ...config, hermes: { ...config.hermes, coverageDbPath: '' } };
  const registry = createToolRegistry(patchedConfig, silent);
  const result = await registry.call('check_coverage', { topic: 'ai' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'COVERAGE_DISABLED');
});
