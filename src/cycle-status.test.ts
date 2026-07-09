import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCycleStatusReport,
  buildSanitizedProviderStatus,
  postKanbanStatus,
} from './cycle-status.ts';

test('sanitized provider status never exposes proxy keys', () => {
  const status = buildSanitizedProviderStatus({
    ARDUR_AI_PROVIDER: 'hermes',
    ARDUR_AI_MAX_GENERATIONS: '7',
    GATEWAY_PROXY_URL: 'https://proxy.example/v1',
    GATEWAY_PROXY_KEY: 'super-secret',
  });
  assert.equal(status.ai_provider, 'hermes');
  assert.equal(status.ai_max_generations, 7);
  assert.equal(status.hermes_proxy_configured, true);
  assert.equal(JSON.stringify(status).includes('super-secret'), false);
});

test('validation failure classifies mixed-cycle hard-fail', () => {
  const report = buildCycleStatusReport({
    cycleId: '2026-06-11T06:00:00.000Z',
    status: 'failed',
    warnings: [
      'top10 cycle mismatch: expected 2026-06-11T06:00:00.000Z, got 2099-01-01T00:00:00.000Z',
      'validation failure: mixed-cycle artifacts blocked before publish',
    ],
    env: { ARDUR_AI_PROVIDER: 'hermes' },
    now: new Date('2026-06-11T07:00:00Z'),
  });
  assert.equal(report.failureClass, 'validation');
  assert.equal(report.lastGoodPreserved, true);
  assert.equal(report.provider.ai_provider, 'hermes');
});

test('published status is none failure class', () => {
  const report = buildCycleStatusReport({
    status: 'published',
    warnings: [],
    articleCount: 3,
    topicsCovered: ['ai'],
  });
  assert.equal(report.failureClass, 'none');
  assert.equal(report.lastGoodPreserved, false);
  assert.equal(report.articleCount, 3);
});

test('kanban post skips when token/url missing', async () => {
  const report = buildCycleStatusReport({ status: 'failed', warnings: ['stage failed: boom'] });
  const result = await postKanbanStatus({ report, token: null, issueUrl: null });
  assert.equal(result, 'skipped');
});

test('kanban post succeeds with mocked fetch', async () => {
  const report = buildCycleStatusReport({
    status: 'degraded',
    cycleId: 'c1',
    warnings: ['degraded:agg'],
  });
  const result = await postKanbanStatus({
    report,
    token: 't',
    issueUrl: 'https://github.com/ArdurAI/ardur.ai/issues/216',
    fetchImpl: async () => new Response('{}', { status: 201 }) as Response,
  });
  assert.equal(result, 'ok');
});
