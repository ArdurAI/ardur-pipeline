/**
 * 6-hour cycle math, UTC-aligned. The cycle is the unit of idempotency for the
 * whole pipeline: any trigger — scheduled, drifted, retried, or backfilled —
 * resolves to the same `CycleMeta` for a given instant, so re-running is safe.
 *
 * Window boundaries are `floor(now, 6h)` in UTC: 00:00, 06:00, 12:00, 18:00.
 * This mirrors `ardur-top10-engine`'s `cycle.ts`; it is intentionally tiny and
 * dependency-free so the orchestrator can derive cycles without importing an
 * engine. The canonical interval lives in the shared contract.
 */

import { CYCLE_INTERVAL_MS, type CycleMeta } from './contracts.ts';

/** Floor an instant to the start of its 6-hour UTC window. */
export function windowStart(now: Date): Date {
  const ms = Math.floor(now.getTime() / CYCLE_INTERVAL_MS) * CYCLE_INTERVAL_MS;
  return new Date(ms);
}

/**
 * Stable cycle id — the canonical form the four engines emit:
 * `windowStart.toISOString()`, e.g. "2026-06-11T06:00:00.000Z". Matching it
 * exactly keeps the orchestrator's idempotency key aligned with the cycle id
 * each engine stamps into its artifact (no spurious drift warnings).
 */
export function cycleId(start: Date): string {
  return start.toISOString();
}

/** Resolve the full `CycleMeta` for an instant. */
export function cycleFor(now: Date): CycleMeta {
  const start = windowStart(now);
  const end = new Date(start.getTime() + CYCLE_INTERVAL_MS);
  return {
    id: cycleId(start),
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
  };
}

/** ISO timestamp of the next refresh: this cycle's window end. */
export function nextRefreshAt(cycle: CycleMeta): string {
  return cycle.windowEnd;
}
