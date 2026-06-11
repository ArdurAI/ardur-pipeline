/**
 * Bounded retry with exponential backoff. Used to wrap each engine stage so a
 * transient failure (a flaky source fetch, a model timeout) does not kill the
 * whole cycle. Retries are *capped* and *logged*; a stage that exhausts its
 * attempts throws, and the orchestrator turns that into last-good-wins.
 */

import type { Logger } from './log.ts';

export interface RetryOptions {
  attempts: number; // additional tries after the first (0 => no retry)
  backoffMs: number; // base delay; attempt n waits backoffMs * 2^(n-1)
  label: string;
  logger: Logger;
  /** Injectable sleep so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const maxTries = Math.max(1, options.attempts + 1);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxTries) break;
      const delay = options.backoffMs * 2 ** (attempt - 1);
      options.logger.warn('stage attempt failed; retrying', {
        stage: options.label,
        attempt,
        maxTries,
        delayMs: delay,
        error: message(error),
      });
      await sleep(delay);
    }
  }

  throw new Error(`${options.label} failed after ${maxTries} attempt(s): ${message(lastError)}`);
}
