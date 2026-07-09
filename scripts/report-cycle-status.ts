#!/usr/bin/env node
/**
 * Read pipeline cycle result JSON (from cli stdout) and emit a sanitized
 * status report for GitHub step summary / optional Kanban handoff.
 *
 * Usage:
 *   node --experimental-strip-types scripts/report-cycle-status.ts \
 *     --result /tmp/result.json --out .artifacts/status.json
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  buildCycleStatusReport,
  postKanbanStatus,
  type CycleStatusReport,
} from '../src/cycle-status.ts';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const resultPath = arg('--result');
  const outPath = arg('--out') ?? '.artifacts/status.json';
  const deployHook = (arg('--deploy-hook') as CycleStatusReport['deployHook'] | undefined) ?? 'unknown';

  let raw: Record<string, unknown> = {};
  if (resultPath) {
    try {
      raw = JSON.parse(await readFile(resultPath, 'utf8')) as Record<string, unknown>;
    } catch {
      raw = { status: 'failed', warnings: [`unable to parse result file: ${resultPath}`] };
    }
  }

  const cycle = (raw['cycle'] as { id?: string } | undefined) ?? undefined;
  const report = buildCycleStatusReport({
    cycleId: cycle?.id ?? (raw['cycleId'] as string | undefined) ?? null,
    status: (raw['status'] as string | undefined) ?? 'unknown',
    warnings: (raw['warnings'] as string[] | undefined) ?? [],
    articleCount:
      typeof raw['articleCount'] === 'number'
        ? raw['articleCount']
        : ((raw['summary'] as { articleCount?: number } | undefined)?.articleCount ?? null),
    topicsCovered:
      (raw['topicsCovered'] as string[] | undefined) ??
      ((raw['summary'] as { topicsCovered?: string[] } | undefined)?.topicsCovered ?? []),
    dryRun: Boolean(raw['dryRun']),
    deployHook,
  });

  const required = process.env['ARDUR_KANBAN_REQUIRED'] === 'true';
  const kanban = await postKanbanStatus({
    report,
    token: process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'] ?? null,
    issueUrl: process.env['ARDUR_KANBAN_ISSUE_URL'] ?? null,
    required,
  });
  report.kanban = kanban;

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');

  // Human-readable summary for Actions
  const lines = [
    '### sanitized cycle status',
    `- status: \`${report.status}\``,
    `- failure_class: \`${report.failureClass}\``,
    `- cycle_id: \`${report.cycleId ?? 'unknown'}\``,
    `- ai_provider: \`${report.provider.ai_provider}\``,
    `- hermes_proxy_configured: \`${report.provider.hermes_proxy_configured}\``,
    `- warnings: ${report.warningCount}`,
    `- last_good_preserved: \`${report.lastGoodPreserved}\``,
    `- kanban: \`${report.kanban}\``,
  ];
  console.log(lines.join('\n'));
  if (process.env['GITHUB_STEP_SUMMARY']) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env['GITHUB_STEP_SUMMARY'], lines.join('\n') + '\n');
  }

  if (required && kanban === 'failed') process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
