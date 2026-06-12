/**
 * Hermes entry point — the single callable a hermes-agent uses to drive the
 * deterministic pipeline and emit a news-engine-handoff artifact ready for
 * ardur.ai to consume via ARDUR_NEWS_ENGINE_ARTIFACT.
 *
 * STUB: runs prepare (+ optionally synthesize) via the existing runner
 * infrastructure. Autonomous agent gate logic (curation, coverage checks,
 * budget decisions) is not yet implemented — those will be added when the
 * Hermes agent layer is built out (see docs/hermes.md).
 *
 * Usage:
 *   node --experimental-strip-types scripts/hermes-run.ts [options]
 *   npm run hermes
 *   npm run hermes -- --prepare-only
 *
 * Options:
 *   --prepare-only            skip synthesis; handoff has top-10 but no articles
 *   --out <path>              write handoff JSON here (default: .artifacts/hermes-handoff.json)
 *   --work-dir <path>         stage artifact scratch dir (default: .artifacts/prepared)
 *   --at <ISO>                cycle-window anchor (default: now)
 *
 * Stdout: the absolute path of the written handoff file (set this as ARDUR_NEWS_ENGINE_ARTIFACT)
 * Stderr: structured logs
 * Exit:   0 = success, 1 = error
 *
 * -----------------------------------------------------------------------
 * How Hermes drives the engines (design contract, implemented incrementally)
 * -----------------------------------------------------------------------
 *
 * The pipeline has two segments with very different cost profiles:
 *
 *   [DETERMINISTIC — ZERO tokens]       [AI — tokens here only]
 *   aggregate → rank → top10    ───────→    synthesize
 *        │                                      │
 *        └──── handoff.top10                    └──── handoff.articles
 *
 * hermes-agent's role is to be the gate between segments:
 *
 *   Step 1: hermes-agent calls `npm run hermes -- --prepare-only`
 *           → receives the path to a handoff with top10 populated, articles empty.
 *           → reads the top-10 to evaluate coverage (has this topic been covered recently?).
 *
 *   Step 2: hermes-agent decides which clusters to synthesize.
 *           Factors: coverage store (CoverageStore), topic freshness,
 *           ARDUR_AI_MAX_GENERATIONS budget, user-configured gates.
 *
 *   Step 3: hermes-agent calls `npm run hermes` (full run, with synthesis).
 *           → receives the path to the complete handoff.
 *
 *   Step 4: ardur.ai build reads the handoff via ARDUR_NEWS_ENGINE_ARTIFACT.
 *
 * For the full spec see: ardur-pipeline/docs/hermes.md (forthcoming)
 * For the feasibility study: ardur-pipeline PR#17
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/log.ts';
import { createCliRunners } from '../src/runners.ts';
import { cycleFor } from '../src/cycle.ts';
import type { AggregationArtifact, Top10Artifact, ArticleArtifact } from '@ardurai/contracts';

// Handoff format consumed by ardur.ai via ARDUR_NEWS_ENGINE_ARTIFACT.
// Schema: ardur-news-handoff/v1 (see src/lib/newsEngineSource.ts in ardur.ai)
interface NewsEngineHandoff {
  schemaVersion: 'ardur-news-handoff/v1';
  generatedAt: string;
  top10: Top10Artifact;
  articles: ArticleArtifact;
}

function parseAt(argv: string[]): Date {
  const i = argv.indexOf('--at');
  if (i === -1) return new Date();
  const raw = argv[i + 1];
  if (!raw) throw new Error('--at requires an ISO 8601 timestamp');
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) throw new Error(`invalid --at: ${raw}`);
  return at;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ format: config.observability.logFormat });
  const argv = process.argv.slice(2);
  const prepareOnly = argv.includes('--prepare-only');
  const at = parseAt(argv);
  const cycle = cycleFor(at);

  const workDirIdx = argv.indexOf('--work-dir');
  const workDir = resolve(workDirIdx >= 0 ? argv[workDirIdx + 1] : '.artifacts/prepared');

  const outIdx = argv.indexOf('--out');
  const outPath = resolve(outIdx >= 0 ? argv[outIdx + 1] : '.artifacts/hermes-handoff.json');

  const runners = createCliRunners(config, cycle, logger);
  await mkdir(workDir, { recursive: true });

  const write = async (name: string, data: unknown): Promise<void> => {
    await writeFile(join(workDir, `${name}.json`), JSON.stringify(data, null, 2));
  };
  const read = async <T>(name: string): Promise<T> => {
    const raw = await readFile(join(workDir, `${name}.json`), 'utf-8');
    return JSON.parse(raw) as T;
  };

  logger.info('[hermes] start', { cycleId: cycle.id, prepareOnly, workDir, outPath });
  const t0 = performance.now();

  // ── Segment 1: deterministic (ZERO tokens) ──────────────────────────────────
  logger.info('[hermes] prepare: aggregate → rank → top10');

  const agg = await runners.aggregate(cycle);
  await write('aggregation', agg);
  logger.info('[hermes] aggregate done', {
    clusters: Object.values(agg.data.clustersByTopic).flat().length,
    facts: Object.values(agg.data.factsByCluster ?? {}).flat().length,
  });

  const ranking = await runners.rank(agg);
  await write('ranking', ranking);
  logger.info('[hermes] rank done');

  const top10 = await runners.selectTop10(ranking, null, agg);
  await write('top10', top10);
  logger.info('[hermes] top10 done', { entries: top10.data.global.length });

  // ── Segment 2: AI synthesis (tokens here) ───────────────────────────────────
  let articles: ArticleArtifact;

  if (prepareOnly) {
    // Emit an empty ArticleArtifact so the handoff schema is satisfied.
    // ardur.ai renders the top-10 list without article pages.
    logger.info('[hermes] --prepare-only: skipping synthesis');
    const preparedAgg = await read<AggregationArtifact>('aggregation');
    articles = {
      schemaVersion: preparedAgg.schemaVersion,
      stage: 'articles',
      cycle: preparedAgg.cycle,
      runId: preparedAgg.runId,
      generatedAt: new Date(at).toISOString(),
      warnings: ['prepare-only: synthesis skipped — no articles written'],
      data: { articles: [] },
    } as unknown as ArticleArtifact;
  } else {
    logger.info('[hermes] synthesize (AI step)');
    articles = await runners.synthesize(top10, agg);
    await write('articles', articles);
    const published = articles.data.articles.filter(
      (a) =>
        !('editorialStatus' in a) || (a as { editorialStatus?: string }).editorialStatus !== 'held',
    ).length;
    const held = articles.data.articles.length - published;
    logger.info('[hermes] synthesize done', { published, held });
  }

  // ── Assemble and write the handoff ─────────────────────────────────────────
  const handoff: NewsEngineHandoff = {
    schemaVersion: 'ardur-news-handoff/v1',
    generatedAt: new Date(at).toISOString(),
    top10,
    // Strip held articles from the handoff — ardur.ai must not serve them.
    articles: {
      ...articles,
      data: {
        ...articles.data,
        articles: articles.data.articles.filter(
          (a) =>
            !('editorialStatus' in a) ||
            (a as { editorialStatus?: string }).editorialStatus !== 'held',
        ),
      },
    },
  };

  await mkdir(resolve(outPath, '..'), { recursive: true });
  await writeFile(outPath, JSON.stringify(handoff, null, 2));

  const ms = Math.round(performance.now() - t0);
  logger.info('[hermes] handoff written', {
    outPath,
    cycleId: cycle.id,
    top10Count: top10.data.global.length,
    articleCount: handoff.articles.data.articles.length,
    prepareOnly,
    ms,
  });

  // Emit the handoff path on stdout — caller sets this as ARDUR_NEWS_ENGINE_ARTIFACT.
  process.stdout.write(outPath + '\n');
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
