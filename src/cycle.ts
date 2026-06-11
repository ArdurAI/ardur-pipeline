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

import { CYCLE_INTERVAL_MS, type CycleMeta } from '@ardurai/contracts';

/** Floor an instant to the start of its 6-hour UTC window. */
export function windowStart(now: Date): Date {
  const ms = Math.floor(now.getTime() / CYCLE_INTERVAL_MS) * CYCLE_INTERVAL_MS;
  return new Date(ms);
}

/**
 * Stable cycle id in the canonical wire format defined by `@ardurai/contracts`
 * (`CycleMeta.id` comment: "2026-06-11T06:00:00.000Z"). Full ISO 8601 UTC with
 * milliseconds — NOT the truncated minute-precision form (`slice(0,16)+'Z'`).
 *
 * Canonical format rationale: the full form preserves sub-minute precision for
 * future sub-6h windows, is unambiguously parseable, and is what the contracts
 * package documentation specifies as the example. Engines must emit this format
 * so the orchestrator's cycle-consistency check (orchestrate.ts) never fires
 * spurious `cycle-mismatch` warnings.
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
