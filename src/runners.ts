/**
 * Stage runners — the only place that knows how to invoke the four engines.
 *
 * Each engine is a separate repo with a JSON-in / JSON-out CLI. The orchestrator
 * spawns those CLIs as child processes and never imports engine internals, so an
 * engine can change its implementation freely as long as it honours the shared
 * `contracts.ts` wire format. This is the seam the spec calls the "engine handoff".
 *
 *   aggregator    : cli.ts                              -> AggregationArtifact (stdout)
 *   ranking       : cli.ts <aggregation.json>           -> RankingArtifact     (stdout)
 *   top10         : cli.ts <ranking.json> <prev> <agg>  -> Top10Artifact       (stdout)
 *   synthesizer   : cli.ts --top10 t --aggregation a    -> ArticleArtifact     (stdout)
 *
 * Engine logic lives in the engine repos. This file is wiring only — it writes
 * the upstream artifacts to a scratch dir, runs the next CLI, and parses stdout.
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { assertCompatibleArtifact } from '@ardurai/contracts';
import type {
  AggregationArtifact,
  RankingArtifact,
  Top10Artifact,
  ArticleArtifact,
  CycleMeta,
  PipelineStage,
} from '@ardurai/contracts';
import { aiEnv, type PipelineConfig } from './config.ts';
import type { Logger } from './log.ts';

/** Pluggable so the orchestrator can be unit-tested with fakes (no spawning). */
export interface StageRunners {
  aggregate(cycle: CycleMeta): Promise<AggregationArtifact>;
  rank(aggregation: AggregationArtifact): Promise<RankingArtifact>;
  selectTop10(
    ranking: RankingArtifact,
    previous: Top10Artifact | null,
    aggregation: AggregationArtifact,
  ): Promise<Top10Artifact>;
  synthesize(top10: Top10Artifact, aggregation: AggregationArtifact): Promise<ArticleArtifact>;
  /** Remove the per-cycle scratch dir. Call in a finally after all stages complete (#31). */
  cleanupScratch?(): Promise<void>;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
}

// Safe env keys passed through from the parent process (#24).
// process.execPath is an absolute path, so PATH is not needed.
// AI knobs and Ollama settings come from the `env` arg (aiEnv result).
const SAFE_PASSTHROUGH_KEYS = ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'USERPROFILE'] as const;

// Hard output limits to prevent OOM from a runaway engine (#24).
const MAX_STDOUT_BYTES = 128 * 1024 * 1024; // 128 MiB
const MAX_STDERR_BYTES = 1 * 1024 * 1024; // 1 MiB

/** Run an engine CLI in its own repo, capture stdout, enforce a timeout. */
function runEngineCli(
  cwd: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
  logger: Logger,
): Promise<SpawnResult> {
  const cli = join(cwd, 'src', 'cli.ts');
  const nodeArgs = ['--experimental-strip-types', cli, ...args];
  logger.debug('spawn engine', { cwd, args });

  // Build minimal env: only the declared safe passthrough keys + explicit AI knobs.
  // Never spread process.env — that would leak secrets, tokens, and host config.
  const safeEnv: Record<string, string> = {};
  for (const key of SAFE_PASSTHROUGH_KEYS) {
    const val = process.env[key];
    if (val !== undefined) safeEnv[key] = val;
  }

  return new Promise<SpawnResult>((resolve, reject) => {
    // detached: true — on timeout/overflow we kill the process GROUP so grandchildren
    // (model servers, fetchers spawned by the engine) are also reaped (#31).
    const child = spawn(process.execPath, nodeArgs, {
      cwd,
      env: { ...safeEnv, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let done = false;
    // StringDecoders handle multi-byte UTF-8 split across chunk boundaries (#28).
    const stdoutDec = new StringDecoder('utf8');
    const stderrDec = new StringDecoder('utf8');

    const fail = (reason: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Kill the process group to reap grandchildren (#31).
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already dead */
        }
      }
      reject(reason);
    };

    const timer = setTimeout(
      () => fail(new Error(`engine timed out after ${timeoutMs}ms: ${cwd} ${args.join(' ')}`)),
      timeoutMs,
    );

    child.stdout.on('data', (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail(new Error(`engine stdout exceeded ${MAX_STDOUT_BYTES} bytes: ${cwd}`));
        return;
      }
      stdout += stdoutDec.write(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderrBytes += d.length;
      if (stderrBytes <= MAX_STDERR_BYTES) stderr += stderrDec.write(d);
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Flush any trailing incomplete multi-byte character (#28).
      stdout += stdoutDec.end();
      stderr += stderrDec.end();
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        // Engines emit structured JSON errors to stdout. Include both stdout
        // and stderr in the rejection so CI logs show the actionable error
        // detail (ZodError issues, schema gate messages) — not just stderr.
        reject(
          new Error(
            `engine exited ${code}: ${cwd}\n` +
              `--- stdout (last 2000 chars) ---\n${stdout.slice(-2000)}\n` +
              `--- stderr (last 2000 chars) ---\n${stderr.slice(-2000)}`,
          ),
        );
      }
    });
  });
}

function parseArtifact<T>(label: string, raw: string, stage: PipelineStage): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`${label} produced invalid JSON: ${reason}`);
  }
  // Gate before stamp: throws SchemaVersionError on version or stage mismatch.
  const { envelope, warnings } = assertCompatibleArtifact(parsed, stage);
  if (warnings.length > 0) {
    (envelope.warnings as string[]).push(...warnings);
  }
  return envelope as unknown as T;
}

/**
 * Build the real CLI-backed runners. Upstream artifacts are written to a
 * per-cycle scratch dir so each engine reads them as file args.
 */
export function createCliRunners(
  config: PipelineConfig,
  cycle: CycleMeta,
  logger: Logger,
): StageRunners {
  const scratch = join(config.artifactStore, '.scratch', cycle.id.replace(/:/g, '-'));
  const env = aiEnv(config);

  const writeScratch = async (name: string, value: unknown): Promise<string> => {
    await mkdir(scratch, { recursive: true });
    const path = join(scratch, name);
    await writeFile(path, JSON.stringify(value));
    return path;
  };

  return {
    async aggregate() {
      const { stdout } = await runEngineCli(
        config.engines.aggregator,
        [],
        env,
        config.stageTimeouts.aggregate,
        logger,
      );
      return parseArtifact<AggregationArtifact>('aggregation', stdout, 'aggregation');
    },

    async rank(aggregation) {
      const aggPath = await writeScratch('aggregation.json', aggregation);
      const { stdout } = await runEngineCli(
        config.engines.ranking,
        [aggPath],
        env,
        config.stageTimeouts.rank,
        logger,
      );
      return parseArtifact<RankingArtifact>('ranking', stdout, 'ranking');
    },

    async selectTop10(ranking, previous, aggregation) {
      const rankingPath = await writeScratch('ranking.json', ranking);
      const aggPath = await writeScratch('aggregation.json', aggregation);
      // Use named flags as declared by the top10 CLI (#25: legacy positional args were silently
      // ignored by the named-flag parser, so previous/aggregation were never loaded).
      const top10Args: string[] = ['--ranking', rankingPath];
      if (previous) {
        const prevPath = await writeScratch('previous-top10.json', previous);
        top10Args.push('--previous', prevPath);
      }
      top10Args.push('--aggregation', aggPath);
      const { stdout } = await runEngineCli(
        config.engines.top10,
        top10Args,
        env,
        config.stageTimeouts.top10,
        logger,
      );
      return parseArtifact<Top10Artifact>('top10', stdout, 'top10');
    },

    async synthesize(top10, aggregation) {
      const top10Path = await writeScratch('top10.json', top10);
      const aggPath = await writeScratch('aggregation.json', aggregation);
      const { stdout } = await runEngineCli(
        config.engines.synthesizer,
        ['--top10', top10Path, '--aggregation', aggPath],
        env,
        config.stageTimeouts.synthesize,
        logger,
      );
      return parseArtifact<ArticleArtifact>('articles', stdout, 'articles');
    },

    async cleanupScratch() {
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
