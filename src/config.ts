/**
 * Runtime configuration, resolved once from the environment.
 *
 * Every field has a safe default so that an empty environment yields a
 * deterministic, budget=0 cycle (no paid API calls, no network surprises). The
 * orchestrator never reads `process.env` directly past this module — pass a
 * `PipelineConfig` everywhere so cycles are reproducible and testable.
 */

import { join, resolve } from 'node:path';

export interface EngineLocations {
  aggregator: string;
  ranking: string;
  top10: string;
  synthesizer: string;
}

export interface StageBudget {
  timeoutMs: number;
}

export interface PipelineConfig {
  /** Absolute paths to each engine checkout. */
  engines: EngineLocations;
  /** Absolute path to the artifact store root. */
  artifactStore: string;
  /** AI knobs forwarded verbatim to all engine child processes. */
  ai: {
    provider: string;
    maxGenerations: number;
    timeoutMs: number;
  };
  /** Ollama connection settings forwarded to engines that support it. */
  ollama: {
    /** Base URL of the Ollama API, e.g. http://localhost:11434. Empty = not configured. */
    host: string;
    /** Model tag to use for Ollama inference, e.g. "llama3.2". */
    model: string;
    /** Bearer key for Ollama Cloud. When set, engines use cloud inference instead of local. */
    apiKey: string;
  };
  /** ETL full-text fetch+extract. When enabled the aggregator fetches source bodies. */
  etl: {
    enabled: boolean;
    /** Per-article fetch+extraction timeout forwarded to the aggregator. */
    timeoutMs: number;
  };
  /** Per-stage spawn timeouts (wall-clock, includes the engine's own internal timeout). */
  stageTimeouts: {
    aggregate: number;
    rank: number;
    top10: number;
    synthesize: number;
  };
  retry: {
    attempts: number; // additional tries after the first
    backoffMs: number; // base for exponential backoff
  };
  hermes: {
    /**
     * Absolute path for the Hermes coverage SQLite DB.
     * Defaults to `<artifactStore>/coverage.db`.
     * Set HERMES_COVERAGE_DB to override.
     */
    coverageDbPath: string;
    /**
     * When true, dark-launch gate verdicts are logged at INFO level every cycle
     * and engine-spawning MCP tools (aggregate/rank/select_top10/synthesize) are
     * exposed. Default false — engine tools are opt-in (#40).
     * Set HERMES_DARK_LAUNCH=true to enable in development/staging.
     */
    darkLaunchEnabled: boolean;
  };
  mcp: {
    /**
     * Optional bearer API key for MCP server authentication (CWE-306).
     * Set MCP_API_KEY to require clients to pass the key in initialize params.
     * Null / empty string = no auth required (local / trusted-process use).
     */
    apiKey: string | null;
  };
  observability: {
    alertWebhookUrl: string | null;
    /** Optional POST target for per-cycle CycleMetrics JSON (same shape as alert.ts). */
    metricsWebhookUrl: string | null;
    logFormat: 'json' | 'pretty';
  };
  /** Optional GitHub personal-access token for the projects API fetch (GAP-6). */
  githubToken?: string;
}

/** Resolve configuration from the given environment (defaults to the process env). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PipelineConfig {
  // min: reject values strictly below this threshold (e.g. 1 for timeouts) (#32).
  const num = (name: string, fallback: number, min = -Infinity): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return parsed;
  };
  const str = (name: string, fallback: string): string => {
    const raw = env[name];
    return raw === undefined || raw === '' ? fallback : raw;
  };
  const bool = (name: string, fallback: boolean): boolean => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    return raw === '1' || raw.toLowerCase() === 'true';
  };

  const enginesDir = resolve(str('ENGINES_DIR', '..'));
  const enginePath = (name: string, fallback: string) => resolve(enginesDir, str(name, fallback));
  const artifactStoreBase = resolve(str('ARTIFACT_STORE', '.artifacts'));

  return {
    engines: {
      aggregator: enginePath('ENGINE_AGGREGATOR', 'ardur-news-aggregator'),
      ranking: enginePath('ENGINE_RANKING', 'ardur-ranking-engine'),
      top10: enginePath('ENGINE_TOP10', 'ardur-top10-engine'),
      synthesizer: enginePath('ENGINE_SYNTHESIZER', 'ardur-article-synthesizer'),
    },
    artifactStore: artifactStoreBase,
    ai: {
      // Default to ollama; engines fall back to deterministic when maxGenerations=0.
      provider: str('ARDUR_AI_PROVIDER', 'ollama'),
      maxGenerations: num('ARDUR_AI_MAX_GENERATIONS', 0),
      timeoutMs: num('ARDUR_AI_TIMEOUT_MS', 20_000),
    },
    ollama: {
      host: str('OLLAMA_HOST', ''),
      model: str('OLLAMA_MODEL', ''),
      apiKey: str('OLLAMA_API_KEY', ''),
    },
    etl: {
      enabled: bool('ARDUR_ETL_ENABLED', false),
      timeoutMs: num('ARDUR_ETL_TIMEOUT_MS', 30_000),
    },
    stageTimeouts: {
      aggregate: num('STAGE_TIMEOUT_AGGREGATE_MS', 600_000, 1),
      rank: num('STAGE_TIMEOUT_RANK_MS', 120_000, 1),
      top10: num('STAGE_TIMEOUT_TOP10_MS', 120_000, 1),
      synthesize: num('STAGE_TIMEOUT_SYNTHESIZE_MS', 900_000, 1),
    },
    retry: {
      attempts: num('STAGE_RETRIES', 2, 0),
      backoffMs: num('STAGE_BACKOFF_MS', 5_000, 0),
    },
    hermes: {
      coverageDbPath: str('HERMES_COVERAGE_DB', join(artifactStoreBase, 'coverage.db')),
      // Default false so engine-spawning MCP tools are opt-in (#40).
      darkLaunchEnabled: bool('HERMES_DARK_LAUNCH', false),
    },
    mcp: {
      apiKey: str('MCP_API_KEY', '') || null,
    },
    observability: {
      alertWebhookUrl: str('ALERT_WEBHOOK_URL', '') || null,
      metricsWebhookUrl: str('METRICS_WEBHOOK_URL', '') || null,
      logFormat: str('LOG_FORMAT', 'json') === 'pretty' ? 'pretty' : 'json',
    },
    githubToken: str('GITHUB_TOKEN', '') || undefined,
  };
}

/** The AI environment forwarded to every engine child process. */
export function aiEnv(config: PipelineConfig): Record<string, string> {
  const env: Record<string, string> = {
    ARDUR_AI_PROVIDER: config.ai.provider,
    ARDUR_AI_MAX_GENERATIONS: String(config.ai.maxGenerations),
    ARDUR_AI_TIMEOUT_MS: String(config.ai.timeoutMs),
    // ETL knobs consumed by the aggregator.
    ARDUR_ETL_ENABLED: config.etl.enabled ? 'true' : 'false',
    ARDUR_ETL_TIMEOUT_MS: String(config.etl.timeoutMs),
  };
  // Forward Hermes availability — engines auto-detect hermes on PATH.
  // In CI (GitHub Actions), HERMES_AVAILABLE=0 so engines skip Hermes.
  // In local cron, Hermes is on PATH and engines use it as primary LLM.
  if (process.env['HERMES_AVAILABLE'] !== '0' && process.env['CI'] !== 'true') {
    env['HERMES_AVAILABLE'] = '1';
    if (process.env['HERMES_MODEL']) env['HERMES_MODEL'] = process.env['HERMES_MODEL'];
    if (process.env['HERMES_TIMEOUT_MS'])
      env['HERMES_TIMEOUT_MS'] = process.env['HERMES_TIMEOUT_MS'];
  }
  // Explicit Hermes proxy allowlist only (PIPE-HERMES-001 / issue #44).
  // Never forward arbitrary process.env — secrets stay limited to named keys.
  for (const key of [
    'GATEWAY_PROXY_URL',
    'GATEWAY_PROXY_KEY',
    'HERMES_PROXY_URL',
    'HERMES_PROXY_KEY',
  ] as const) {
    const value = process.env[key];
    if (value && value.trim()) env[key] = value.trim();
  }
  // Forward Ollama connection only when configured — engines skip it when blank.
  if (config.ollama.host) env['OLLAMA_HOST'] = config.ollama.host;
  if (config.ollama.model) env['OLLAMA_MODEL'] = config.ollama.model;
  if (config.ollama.apiKey) env['OLLAMA_API_KEY'] = config.ollama.apiKey;
  return env;
}
