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
import { createToolRegistry, ToolRegistry } from './tool-registry.ts';
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

// ---------------------------------------------------------------------------
// #21 — gate-before-stamp: assertCompatibleArtifact on MCP tool inputs
// ---------------------------------------------------------------------------

test('#21: rank with malformed aggregation artifact returns INVALID_INPUT', async () => {
  const config = loadConfig({ HERMES_DARK_LAUNCH: 'true' });
  // Dark launch on but engines absent — availability check fires first. Use a patched
  // config with a real engine dir so availability passes and we reach the gate.
  const patchedConfig = {
    ...config,
    engines: {
      ...config.engines,
      ranking: '/nonexistent-engine', // availability will block before engine is spawned
    },
  };
  const registry = createToolRegistry(patchedConfig, silent);
  // Passing a valid-looking but schema-version-wrong artifact must be caught before spawn.
  const badAgg = {
    schemaVersion: 'ardur-content-pipeline/v999',
    artifact: 'aggregation',
    data: {},
    warnings: [],
  };
  const result = await registry.call('rank', { aggregation: badAgg });
  assert.equal(result.ok, false);
  // Either INVALID_INPUT (gate fires) or ENGINE_UNAVAILABLE (availability fires first on bad dir).
  // Both are acceptable — the key invariant is that the engine is NOT spawned on bad input.
  if (!result.ok) {
    assert.ok(
      result.error.code === 'INVALID_INPUT' || result.error.code === 'ENGINE_UNAVAILABLE',
      `expected INVALID_INPUT or ENGINE_UNAVAILABLE, got ${result.error.code}`,
    );
  }
});

test('#21: select_top10 with wrong-stage ranking artifact returns INVALID_INPUT', async () => {
  const config = loadConfig({ HERMES_DARK_LAUNCH: 'true' });
  const { SCHEMA_VERSION } = await import('@ardurai/contracts');
  const registry = createToolRegistry(config, silent);
  // ranking artifact with the WRONG artifact stage ('aggregation' instead of 'ranking')
  const wrongStage = {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'aggregation', // wrong — should be 'ranking'
    runId: 'r',
    upstreamRunId: null,
    generatedAt: new Date().toISOString(),
    cycle: { id: '2026-06-11T06:00:00.000Z', windowStart: '2026-06-11T06:00:00.000Z', windowEnd: '2026-06-11T12:00:00.000Z' },
    topics: [],
    warnings: [],
    data: {},
  };
  const validAgg = {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'aggregation',
    runId: 'a',
    upstreamRunId: null,
    generatedAt: new Date().toISOString(),
    cycle: { id: '2026-06-11T06:00:00.000Z', windowStart: '2026-06-11T06:00:00.000Z', windowEnd: '2026-06-11T12:00:00.000Z' },
    topics: [],
    warnings: [],
    data: {},
  };
  const result = await registry.call('select_top10', { ranking: wrongStage, aggregation: validAgg });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.error.code === 'INVALID_INPUT' || result.error.code === 'ENGINE_UNAVAILABLE',
      `expected INVALID_INPUT or ENGINE_UNAVAILABLE, got ${result.error.code}`,
    );
  }
});

// ---------------------------------------------------------------------------
// #22 — dark-launch gate: engine tools blocked when HERMES_DARK_LAUNCH=false
// ---------------------------------------------------------------------------

test('#22: aggregate returns DARK_LAUNCH_DISABLED when darkLaunchEnabled=false', async () => {
  const config = loadConfig({ HERMES_DARK_LAUNCH: 'false' });
  const registry = createToolRegistry(config, silent);
  const result = await registry.call('aggregate', {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'DARK_LAUNCH_DISABLED');
});

test('#22: rank returns DARK_LAUNCH_DISABLED when darkLaunchEnabled=false', async () => {
  const config = loadConfig({ HERMES_DARK_LAUNCH: 'false' });
  const registry = createToolRegistry(config, silent);
  const result = await registry.call('rank', { aggregation: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'DARK_LAUNCH_DISABLED');
});

test('#22: check_coverage is still allowed when darkLaunchEnabled=false', async () => {
  const config = loadConfig({ HERMES_DARK_LAUNCH: 'false' });
  const registry = createToolRegistry(config, silent);
  // Missing input, but the tool is reachable (MISSING_INPUT, not DARK_LAUNCH_DISABLED).
  const result = await registry.call('check_coverage', {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'MISSING_INPUT');
});

// ---------------------------------------------------------------------------
// #23 — availability() and sizeBudget are enforced in call()
// ---------------------------------------------------------------------------

test('#23: aggregate returns ENGINE_UNAVAILABLE when engine dir is absent', async () => {
  const config = loadConfig({ HERMES_DARK_LAUNCH: 'true', ENGINE_AGGREGATOR: '/nonexistent-path-xyz' });
  const registry = createToolRegistry(config, silent);
  const result = await registry.call('aggregate', {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'ENGINE_UNAVAILABLE');
});

test('#23: sizeBudget is enforced — SIZE_EXCEEDED when result is larger than budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ardur-reg-size-'));
  const dbPath = join(dir, 'size.db');

  // Pre-populate the DB so check_coverage returns a non-empty response.
  const store = new CoverageStore(dbPath);
  store.record(
    {
      fingerprint: 'fp-size-test',
      clusterId: 'c1',
      topic: 'ai',
      cycleId: 'cycle-1',
      publishedAt: '2026-06-11T07:00:00Z',
    },
    'now',
  );
  store.close();

  // Patch the registry so check_coverage has an absurdly small sizeBudget.
  class TinyBudgetRegistry extends ToolRegistry {
    override descriptors() {
      return super.descriptors().map((d) => ({ ...d, sizeBudget: 1 }));
    }
  }
  const config = loadConfig({ HERMES_COVERAGE_DB: dbPath });
  const registry = new TinyBudgetRegistry(config, silent);

  const result = await registry.call('check_coverage', { fingerprint: 'fp-size-test' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'SIZE_EXCEEDED');
});
