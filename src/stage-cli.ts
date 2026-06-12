/**
 * Stage-by-stage pipeline CLI — run individual deterministic stages or the full
 * prepare chain with ZERO tokens.
 *
 * AI is isolated to the `synthesize` command only. Every other command runs the
 * deterministic engines and writes artifacts to a work dir.
 *
 * Commands:
 *   aggregate                  run the aggregator (no AI)
 *   rank                       rank clusters from aggregation.json (no AI)
 *   top10                      select top-10 from ranking.json + aggregation.json (no AI)
 *   prepare                    aggregate → rank → top10 in one shot (no AI, no tokens)
 *   synthesize                 write articles from top10.json + aggregation.json (AI step only)
 *
 * Options:
 *   --work-dir <path>          read/write stage artifacts here (default: .artifacts/prepared)
 *   --at <ISO>                 cycle-window anchor; defaults to now
 *
 * Logs → stderr  |  final summary JSON → stdout
 * Exit: 0 = ok, 1 = error
 *
 * Typical usage:
 *   npm run prepare                            # zero tokens → .artifacts/prepared/
 *   npm run synthesize                         # AI step only, reads prepared/ artifacts
 *   npm run prepare && npm run synthesize      # full cycle, staged
 *   npm run cycle:no-ai                        # prepare + held-only synthesis (no tokens)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { createLogger } from './log.ts';
import { createCliRunners } from './runners.ts';
import { cycleFor } from './cycle.ts';
import type { AggregationArtifact, RankingArtifact, Top10Artifact } from '@ardurai/contracts';

const WORK_DIR_DEFAULT = '.artifacts/prepared';

function parseAt(argv: string[]): Date {
  const i = argv.indexOf('--at');
  if (i === -1) return new Date();
  const raw = argv[i + 1];
  if (!raw) throw new Error('--at requires an ISO 8601 timestamp');
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) throw new Error(`invalid --at: ${raw}`);
  return at;
}

function parseWorkDir(argv: string[]): string {
  const i = argv.indexOf('--work-dir');
  const raw = i >= 0 ? argv[i + 1] : undefined;
  return resolve(raw ?? WORK_DIR_DEFAULT);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ format: config.observability.logFormat });
  const argv = process.argv.slice(2);
  const command = argv[0];
  const workDir = parseWorkDir(argv);
  const at = parseAt(argv);
  const cycle = cycleFor(at);
  const runners = createCliRunners(config, cycle, logger);

  const write = async (name: string, data: unknown): Promise<void> => {
    await mkdir(workDir, { recursive: true });
    const path = join(workDir, `${name}.json`);
    await writeFile(path, JSON.stringify(data, null, 2));
    logger.info(`[stage] wrote ${name}`, { path, cycleId: cycle.id });
  };

  const read = async <T>(name: string): Promise<T> => {
    const path = join(workDir, `${name}.json`);
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  };

  const t0 = performance.now();

  switch (command) {
    case 'aggregate': {
      logger.info('[stage] aggregate start', { cycleId: cycle.id, workDir });
      const agg = await runners.aggregate(cycle);
      await write('aggregation', agg);
      const clusterCount = Object.values(agg.data.clustersByTopic).flat().length;
      const factCount = Object.values(agg.data.factsByCluster ?? {}).flat().length;
      logger.info('[stage] aggregate done', {
        clusterCount,
        factCount,
        ms: Math.round(performance.now() - t0),
      });
      process.stdout.write(
        JSON.stringify({
          stage: 'aggregate',
          cycleId: cycle.id,
          clusterCount,
          factCount,
          workDir,
        }) + '\n',
      );
      break;
    }

    case 'rank': {
      logger.info('[stage] rank start', { cycleId: cycle.id, workDir });
      const agg = await read<AggregationArtifact>('aggregation');
      const ranking = await runners.rank(agg);
      await write('ranking', ranking);
      logger.info('[stage] rank done', { ms: Math.round(performance.now() - t0) });
      process.stdout.write(JSON.stringify({ stage: 'rank', cycleId: cycle.id, workDir }) + '\n');
      break;
    }

    case 'top10': {
      logger.info('[stage] top10 start', { cycleId: cycle.id, workDir });
      const agg = await read<AggregationArtifact>('aggregation');
      const ranking = await read<RankingArtifact>('ranking');
      const top10 = await runners.selectTop10(ranking, null, agg);
      await write('top10', top10);
      const entries = top10.data.global;
      logger.info('[stage] top10 done', {
        entries: entries.length,
        topics: top10.data.topicsCovered.length,
        ms: Math.round(performance.now() - t0),
      });
      process.stdout.write(
        JSON.stringify({ stage: 'top10', cycleId: cycle.id, entries: entries.length, workDir }) +
          '\n',
      );
      break;
    }

    case 'prepare': {
      // aggregate → rank → top10: ZERO tokens, fully deterministic
      logger.info('[stage] prepare start (aggregate → rank → top10)', {
        cycleId: cycle.id,
        workDir,
      });

      const agg = await runners.aggregate(cycle);
      await write('aggregation', agg);
      logger.info('[stage] aggregate done', {
        clusterCount: Object.values(agg.data.clustersByTopic).flat().length,
      });

      const ranking = await runners.rank(agg);
      await write('ranking', ranking);
      logger.info('[stage] rank done');

      const top10 = await runners.selectTop10(ranking, null, agg);
      await write('top10', top10);
      const entries = top10.data.global;
      logger.info('[stage] top10 done', { entries: entries.length });

      const clusterCount = Object.values(agg.data.clustersByTopic).flat().length;
      const factCount = Object.values(agg.data.factsByCluster ?? {}).flat().length;
      const ms = Math.round(performance.now() - t0);
      logger.info('[stage] prepare done', {
        cycleId: cycle.id,
        clusterCount,
        factCount,
        top10: entries.length,
        workDir,
        ms,
      });
      process.stdout.write(
        JSON.stringify({
          stage: 'prepare',
          cycleId: cycle.id,
          clusterCount,
          factCount,
          top10: entries.length,
          workDir,
          ms,
        }) + '\n',
      );
      break;
    }

    case 'synthesize': {
      // AI step only — reads top10 + aggregation from workDir
      logger.info('[stage] synthesize start (AI step)', { cycleId: cycle.id, workDir });
      const agg = await read<AggregationArtifact>('aggregation');
      const top10 = await read<Top10Artifact>('top10');
      const articles = await runners.synthesize(top10, agg);
      await write('articles', articles);
      const published = articles.data.articles.filter(
        (a) => !('editorialStatus' in a) || a.editorialStatus !== 'held',
      ).length;
      const held = articles.data.articles.filter(
        (a) => 'editorialStatus' in a && a.editorialStatus === 'held',
      ).length;
      const ms = Math.round(performance.now() - t0);
      logger.info('[stage] synthesize done', { published, held, ms });
      process.stdout.write(
        JSON.stringify({ stage: 'synthesize', cycleId: cycle.id, published, held, workDir, ms }) +
          '\n',
      );
      break;
    }

    default:
      process.stderr.write(
        [
          'Usage: stage-cli <command> [options]',
          '',
          'Commands (AI = 0 tokens unless noted):',
          '  aggregate             run aggregator engine',
          '  rank                  rank clusters from aggregation.json',
          '  top10                 select top-10 from ranking + aggregation',
          '  prepare               aggregate → rank → top10 in one shot (zero tokens)',
          '  synthesize            write articles from prepared artifacts  ← AI step',
          '',
          'Options:',
          '  --work-dir <path>     artifact work directory (default: .artifacts/prepared)',
          '  --at <ISO>            cycle-window anchor (default: now)',
          '',
        ].join('\n'),
      );
      process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
