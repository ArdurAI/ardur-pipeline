/**
 * Per-cycle metrics — written to the artifact store after every run.
 *
 * Output:
 *   cycles/<id>/metrics.json  — the structured record for this cycle
 *   metrics.ndjson            — append-only stream for dashboards / SLO tracking
 *   METRICS_WEBHOOK_URL       — optional POST (same plumbing as alert.ts)
 *
 * SLO checks are derived booleans so a dashboard can gate on them directly without
 * re-implementing the thresholds (spec §6: full cycle ≤ 25 min, freshness ≤ cycle+25m).
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CycleMetrics {
  cycleId: string;
  /** CycleStatus: 'published' | 'degraded' | 'failed' | 'skipped' */
  status: string;
  startedAt: string; // ISO 8601 UTC
  /** Wall-clock duration per stage (ms), keyed by stage name. */
  stageMs: Record<string, number>;
  warningCount: number;
  articleCount: number;
  topicsCovered: string[];
  /** Sum of stage durations (ms). */
  fullCycleMs: number;
  slo: {
    /** fullCycleMs <= 25 min — the spec §6 p95 budget. */
    withinBudget: boolean;
    /** True when the cycle was published or degraded (site gets fresh content). */
    artifactFresh: boolean;
  };
}

const SLO_FULL_CYCLE_MS = 25 * 60 * 1000;

export function buildCycleMetrics(
  status: string,
  cycleId: string,
  startedAt: string,
  timings: Array<{ stage: string; ms: number }>,
  warningCount: number,
  articleCount: number,
  topicsCovered: string[],
): CycleMetrics {
  const stageMs: Record<string, number> = {};
  let fullCycleMs = 0;
  for (const t of timings) {
    stageMs[t.stage] = t.ms;
    fullCycleMs += t.ms;
  }
  return {
    cycleId,
    status,
    startedAt,
    stageMs,
    warningCount,
    articleCount,
    topicsCovered,
    fullCycleMs,
    slo: {
      withinBudget: fullCycleMs <= SLO_FULL_CYCLE_MS,
      artifactFresh: status === 'published' || status === 'degraded',
    },
  };
}

export interface MetricsEmitOptions {
  storeRoot: string;
  cycleId: string;
  webhookUrl?: string | null;
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void };
}

export async function emitMetrics(metrics: CycleMetrics, opts: MetricsEmitOptions): Promise<void> {
  const { storeRoot, cycleId, logger } = opts;
  const cycleDir = join(storeRoot, 'cycles', cycleId.replace(/:/g, '-'));

  try {
    await mkdir(storeRoot, { recursive: true });
    await mkdir(cycleDir, { recursive: true });
    await writeFile(join(cycleDir, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
    await appendFile(join(storeRoot, 'metrics.ndjson'), JSON.stringify(metrics) + '\n');
  } catch (e) {
    logger?.warn('metrics write failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  if (!opts.webhookUrl) return;
  try {
    const res = await fetch(opts.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(metrics),
    });
    if (!res.ok) logger?.warn('metrics webhook non-2xx', { status: res.status });
  } catch (e) {
    logger?.warn('metrics webhook failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
