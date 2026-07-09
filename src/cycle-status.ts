/**
 * Sanitized cycle status report for workflow summaries + Kanban handoff.
 *
 * Never include secrets, proxy keys, prompts, completions, or raw model output.
 */

export type CycleStatusKind = 'published' | 'degraded' | 'failed' | 'skipped';

export type FailureClass = 'none' | 'validation' | 'stage' | 'publish' | 'deploy' | 'unknown';

export interface SanitizedProviderStatus {
  ai_provider: string;
  ai_max_generations: number;
  hermes_proxy_configured: boolean;
}

export interface CycleStatusReport {
  schemaVersion: 'ardur-pipeline-status/v1';
  cycleId: string | null;
  status: CycleStatusKind | 'unknown';
  failureClass: FailureClass;
  warningCount: number;
  warnings: string[];
  articleCount: number | null;
  topicsCovered: string[];
  dryRun: boolean;
  lastGoodPreserved: boolean;
  provider: SanitizedProviderStatus;
  deployHook: 'not_run' | 'skipped_missing' | 'ok' | 'failed' | 'unknown';
  kanban: 'not_requested' | 'skipped' | 'ok' | 'failed';
  generatedAt: string;
}

export interface BuildCycleStatusInput {
  cycleId?: string | null;
  status?: string | null;
  warnings?: string[] | null;
  articleCount?: number | null;
  topicsCovered?: string[] | null;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  deployHook?: CycleStatusReport['deployHook'];
  kanban?: CycleStatusReport['kanban'];
  now?: Date;
}

function classifyFailure(status: string, warnings: string[]): FailureClass {
  if (status === 'published' || status === 'degraded' || status === 'skipped') return 'none';
  const joined = warnings.join('\n').toLowerCase();
  if (joined.includes('validation failure') || joined.includes('cycle mismatch'))
    return 'validation';
  if (joined.includes('publish failed')) return 'publish';
  if (joined.includes('deploy') && joined.includes('fail')) return 'deploy';
  if (joined.includes('stage failed')) return 'stage';
  if (status === 'failed') return 'unknown';
  return 'none';
}

export function buildSanitizedProviderStatus(
  env: NodeJS.ProcessEnv = process.env,
): SanitizedProviderStatus {
  const proxyConfigured = Boolean(
    (env['GATEWAY_PROXY_URL'] || env['HERMES_PROXY_URL'] || '').trim(),
  );
  const max = Number.parseInt(env['ARDUR_AI_MAX_GENERATIONS'] ?? '0', 10);
  return {
    ai_provider: (env['ARDUR_AI_PROVIDER'] || 'deterministic').trim() || 'deterministic',
    ai_max_generations: Number.isFinite(max) ? max : 0,
    hermes_proxy_configured: proxyConfigured,
  };
}

export function buildCycleStatusReport(input: BuildCycleStatusInput = {}): CycleStatusReport {
  const warnings = [...(input.warnings ?? [])].filter(Boolean);
  const status = (input.status as CycleStatusKind | undefined) ?? 'unknown';
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  return {
    schemaVersion: 'ardur-pipeline-status/v1',
    cycleId: input.cycleId ?? null,
    status,
    failureClass: classifyFailure(status, warnings),
    warningCount: warnings.length,
    warnings: warnings.slice(0, 50),
    articleCount: input.articleCount ?? null,
    topicsCovered: [...(input.topicsCovered ?? [])],
    dryRun: Boolean(input.dryRun),
    lastGoodPreserved: status === 'failed' || status === 'skipped',
    provider: buildSanitizedProviderStatus(env),
    deployHook: input.deployHook ?? 'not_run',
    kanban: input.kanban ?? 'not_requested',
    generatedAt: now.toISOString(),
  };
}

/** Optional best-effort Kanban comment; never throws. */
export async function postKanbanStatus(opts: {
  report: CycleStatusReport;
  issueUrl?: string | null;
  token?: string | null;
  required?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<'ok' | 'skipped' | 'failed'> {
  const token = opts.token?.trim();
  const issueUrl = opts.issueUrl?.trim();
  if (!token || !issueUrl) return 'skipped';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = [
    '### status-event',
    `- event: pipeline.${opts.report.status}`,
    `- cycle_id: ${opts.report.cycleId ?? 'unknown'}`,
    `- failure_class: ${opts.report.failureClass}`,
    `- ai_provider: ${opts.report.provider.ai_provider}`,
    `- hermes_proxy_configured: ${opts.report.provider.hermes_proxy_configured}`,
    `- warning_count: ${opts.report.warningCount}`,
    `- article_count: ${opts.report.articleCount ?? 'n/a'}`,
    `- notes: sanitized pipeline status handoff`,
  ].join('\n');

  try {
    // issueUrl can be API or html URL; only support api.github.com/repos/.../issues/N
    const m =
      issueUrl.match(/github\.com\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)/) ||
      issueUrl.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!m) return opts.required ? 'failed' : 'skipped';
    const [, owner, repo, number] = m;
    const res = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
      {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'ardur-pipeline-status',
        },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!res.ok) return opts.required ? 'failed' : 'failed';
    return 'ok';
  } catch {
    return opts.required ? 'failed' : 'failed';
  }
}
