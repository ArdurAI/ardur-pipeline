/**
 * CLI entrypoint — run one 6-hour cycle.
 *
 * Usage:
 *   node --experimental-strip-types src/cli.ts            # run the current cycle
 *   node --experimental-strip-types src/cli.ts --at 2026-06-11T06:00:00Z   # backfill
 *
 * Reads config from the environment (see .env.example). Emits structured logs to
 * stderr and a final JSON `RunResult` to stdout. Exit code:
 *   0  published | degraded | skipped   (cycle is live; the site has fresh data)
 *   1  failed                           (nothing published; last-good stays live)
 *
 * This is what the scheduled GitHub Actions workflow invokes every 6 hours.
 */

import { loadConfig } from './config.ts';
import { createLogger } from './log.ts';
import { runCycle } from './orchestrate.ts';

function parseAt(argv: string[]): Date | undefined {
  const i = argv.indexOf('--at');
  if (i === -1) return undefined;
  const raw = argv[i + 1];
  if (!raw) throw new Error('--at requires an ISO 8601 timestamp');
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) throw new Error(`invalid --at timestamp: ${raw}`);
  return at;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ format: config.observability.logFormat });
  const at = parseAt(process.argv.slice(2));

  const result = await runCycle({
    config,
    logger,
    now: at ? () => at : undefined,
  });

  // Final machine-readable summary on stdout (logs went to stderr).
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.status === 'failed' ? 1 : 0;
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
