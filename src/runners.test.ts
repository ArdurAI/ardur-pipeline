/**
 * Integration tests for createCliRunners — spawn-based, no fake runners.
 *
 * Tests #24 (minimal env, bounded buffers) and #25 (named flags for top10 CLI).
 * Each test writes a tiny mock CLI into a temp dir and configures the runner to
 * use that dir as the engine. No real engine repos are required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliRunners } from './runners.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './log.ts';
import { cycleFor } from './cycle.ts';
import { SCHEMA_VERSION } from '@ardurai/contracts';
import type { RankingArtifact, AggregationArtifact } from '@ardurai/contracts';

const silent = createLogger({ format: 'json', write: () => {} });

// ---------------------------------------------------------------------------
// Minimal artifact fixtures
// ---------------------------------------------------------------------------

function minimalCycle() {
  return cycleFor(new Date('2026-06-11T06:00:00Z'));
}

function minimalRanking(): RankingArtifact {
  const cycle = minimalCycle();
  return {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'ranking',
    runId: 'rank-test',
    upstreamRunId: null,
    generatedAt: cycle.windowStart,
    cycle,
    topics: [],
    warnings: [],
    data: { rankedByTopic: {}, audit: [], weightProfile: 'balanced@v1' },
  } as unknown as RankingArtifact;
}

function minimalAggregation(): AggregationArtifact {
  const cycle = minimalCycle();
  return {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'aggregation',
    runId: 'agg-test',
    upstreamRunId: null,
    generatedAt: cycle.windowStart,
    cycle,
    topics: [],
    warnings: [],
    data: {
      itemsByTopic: {},
      clustersByTopic: {},
      coverageByTopic: {},
      documentsByTopic: {},
      factsByCluster: {},
    },
  } as unknown as AggregationArtifact;
}

// A mock CLI that outputs a minimal valid top10 artifact from --ranking flag input.
function mockTop10Cli(schemaVersion: string): string {
  return [
    "import { readFileSync } from 'node:fs';",
    "const argv = process.argv.slice(2);",
    // Fail loudly if the caller did NOT use named flags (old positional arg style)
    "if (!argv.includes('--ranking')) {",
    "  process.stderr.write('FAIL: expected --ranking named flag\\n');",
    "  process.exit(42);",
    "}",
    "const ri = argv.indexOf('--ranking');",
    "const rank = JSON.parse(readFileSync(argv[ri + 1], 'utf8'));",
    'const out = {',
    `  schemaVersion: '${schemaVersion}',`,
    "  artifact: 'top10', runId: 'mock-top10', upstreamRunId: null,",
    "  generatedAt: rank.generatedAt, cycle: rank.cycle,",
    "  topics: [], warnings: [],",
    "  data: { nextRefreshAt: rank.cycle.windowEnd, topicsCovered: [], top10ByTopic: {}, global: [], stability: { carriedOver: 0, fresh: 0, churnRate: 0 } }",
    '};',
    "process.stdout.write(JSON.stringify(out) + '\\n');",
  ].join('\n');
}

// A mock aggregation CLI that checks the env for a canary variable.
function mockAggEnvCli(canaryKey: string, schemaVersion: string): string {
  return [
    `if (process.env['${canaryKey}'] !== undefined) {`,
    `  process.stderr.write('FAIL: canary env var ${canaryKey} was forwarded\\n');`,
    "  process.exit(77);",
    "}",
    // also assert that the AI knob env was forwarded
    "if (!process.env['ARDUR_AI_PROVIDER']) {",
    "  process.stderr.write('FAIL: ARDUR_AI_PROVIDER not forwarded\\n');",
    "  process.exit(78);",
    "}",
    "const cycle = { id: '2026-06-11T06:00:00.000Z', windowStart: '2026-06-11T06:00:00.000Z', windowEnd: '2026-06-11T12:00:00.000Z' };",
    'const out = {',
    `  schemaVersion: '${schemaVersion}',`,
    "  artifact: 'aggregation', runId: 'env-ok', upstreamRunId: null,",
    "  generatedAt: cycle.windowStart, cycle,",
    "  topics: [], warnings: [],",
    "  data: { itemsByTopic: {}, clustersByTopic: {}, coverageByTopic: {}, documentsByTopic: {}, factsByCluster: {} }",
    '};',
    "process.stdout.write(JSON.stringify(out) + '\\n');",
  ].join('\n');
}

// ---------------------------------------------------------------------------
// #25 — selectTop10 uses named flags (--ranking / --aggregation)
// ---------------------------------------------------------------------------

test('selectTop10 runner passes named --ranking flag to top10 CLI', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'ardur-runner-top10-'));
  await mkdir(join(tmpDir, 'src'), { recursive: true });
  await writeFile(join(tmpDir, 'src', 'cli.ts'), mockTop10Cli(SCHEMA_VERSION));

  const cycle = minimalCycle();
  const config = loadConfig({
    ARTIFACT_STORE: tmpDir,
    ENGINE_TOP10: tmpDir,
    STAGE_RETRIES: '0',
    STAGE_BACKOFF_MS: '0',
    STAGE_TIMEOUT_TOP10_MS: '15000',
  });
  const runners = createCliRunners(config, cycle, silent);

  const top10 = await runners.selectTop10(minimalRanking(), null, minimalAggregation());
  assert.equal(top10.artifact, 'top10');
  assert.equal(top10.runId, 'mock-top10');
});

test('selectTop10 runner omits --previous flag when previous is null', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'ardur-runner-top10-noprev-'));
  await mkdir(join(tmpDir, 'src'), { recursive: true });
  // This CLI fails if --previous is present (should not be when previous=null)
  const cli = [
    "import { readFileSync } from 'node:fs';",
    "const argv = process.argv.slice(2);",
    "if (argv.includes('--previous')) {",
    "  process.stderr.write('FAIL: --previous should be absent when previous=null\\n');",
    "  process.exit(43);",
    "}",
    "const ri = argv.indexOf('--ranking');",
    "const rank = JSON.parse(readFileSync(argv[ri + 1], 'utf8'));",
    'const out = {',
    `  schemaVersion: '${SCHEMA_VERSION}',`,
    "  artifact: 'top10', runId: 'no-prev', upstreamRunId: null,",
    "  generatedAt: rank.generatedAt, cycle: rank.cycle,",
    "  topics: [], warnings: [],",
    "  data: { nextRefreshAt: rank.cycle.windowEnd, topicsCovered: [], top10ByTopic: {}, global: [], stability: { carriedOver: 0, fresh: 0, churnRate: 0 } }",
    '};',
    "process.stdout.write(JSON.stringify(out) + '\\n');",
  ].join('\n');
  await writeFile(join(tmpDir, 'src', 'cli.ts'), cli);

  const cycle = minimalCycle();
  const config = loadConfig({
    ARTIFACT_STORE: tmpDir,
    ENGINE_TOP10: tmpDir,
    STAGE_RETRIES: '0',
    STAGE_BACKOFF_MS: '0',
    STAGE_TIMEOUT_TOP10_MS: '15000',
  });
  const runners = createCliRunners(config, cycle, silent);

  const top10 = await runners.selectTop10(minimalRanking(), null, minimalAggregation());
  assert.equal(top10.runId, 'no-prev');
});

// ---------------------------------------------------------------------------
// #24 — subprocess does not inherit full process.env
// ---------------------------------------------------------------------------

test('engine subprocess does not receive parent process.env canary var', async () => {
  const CANARY = 'ARDUR_PIPE_TEST_CANARY_24';
  const tmpDir = await mkdtemp(join(tmpdir(), 'ardur-runner-env-'));
  await mkdir(join(tmpDir, 'src'), { recursive: true });
  await writeFile(join(tmpDir, 'src', 'cli.ts'), mockAggEnvCli(CANARY, SCHEMA_VERSION));

  const original = process.env[CANARY];
  process.env[CANARY] = 'should-not-be-forwarded';

  try {
    const cycle = minimalCycle();
    const config = loadConfig({
      ARTIFACT_STORE: tmpDir,
      ENGINE_AGGREGATOR: tmpDir,
      STAGE_RETRIES: '0',
      STAGE_BACKOFF_MS: '0',
      STAGE_TIMEOUT_AGGREGATE_MS: '15000',
    });
    const runners = createCliRunners(config, cycle, silent);

    // Should succeed — the canary is NOT forwarded to the child process.
    const agg = await runners.aggregate(cycle);
    assert.equal(agg.artifact, 'aggregation');
    assert.equal(agg.runId, 'env-ok');
  } finally {
    if (original === undefined) delete process.env[CANARY];
    else process.env[CANARY] = original;
  }
});

// ---------------------------------------------------------------------------
// #24 — bounded stdout buffer
// ---------------------------------------------------------------------------

test('engine subprocess that overflows stdout is killed with an error', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'ardur-runner-overflow-'));
  await mkdir(join(tmpDir, 'src'), { recursive: true });
  // CLI that writes ~200 MiB of data (well above the 128 MiB limit).
  const cli = [
    "// Write 200 MB of zeros to stdout to trigger the buffer limit.",
    "const chunk = Buffer.alloc(1024 * 1024, 'x'); // 1 MiB",
    "for (let i = 0; i < 200; i++) process.stdout.write(chunk);",
  ].join('\n');
  await writeFile(join(tmpDir, 'src', 'cli.ts'), cli);

  const cycle = minimalCycle();
  const config = loadConfig({
    ARTIFACT_STORE: tmpDir,
    ENGINE_AGGREGATOR: tmpDir,
    STAGE_RETRIES: '0',
    STAGE_BACKOFF_MS: '0',
    STAGE_TIMEOUT_AGGREGATE_MS: '30000',
  });
  const runners = createCliRunners(config, cycle, silent);

  await assert.rejects(
    () => runners.aggregate(cycle),
    (err: Error) => err.message.includes('exceeded'),
  );
});
