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
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AggregationArtifact,
  RankingArtifact,
  Top10Artifact,
  ArticleArtifact,
  CycleMeta,
} from './contracts.ts';
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
}

interface SpawnResult {
  stdout: string;
  stderr: string;
}

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

  return new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`engine timed out after ${timeoutMs}ms: ${cwd} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`engine exited ${code}: ${cwd}\n${stderr.slice(-2000)}`));
      }
    });
  });
}

function parseArtifact<T>(label: string, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`${label} produced invalid JSON: ${reason}`);
  }
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
      return parseArtifact<AggregationArtifact>('aggregation', stdout);
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
      return parseArtifact<RankingArtifact>('ranking', stdout);
    },

    async selectTop10(ranking, previous, aggregation) {
      const rankingPath = await writeScratch('ranking.json', ranking);
      const prevPath = previous ? await writeScratch('previous-top10.json', previous) : '-';
      const aggPath = await writeScratch('aggregation.json', aggregation);
      const { stdout } = await runEngineCli(
        config.engines.top10,
        [rankingPath, prevPath, aggPath],
        env,
        config.stageTimeouts.top10,
        logger,
      );
      return parseArtifact<Top10Artifact>('top10', stdout);
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
      return parseArtifact<ArticleArtifact>('articles', stdout);
    },
  };
}
