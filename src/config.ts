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
    /** ETL timeout is per-document inside the aggregator; this is the total aggregator budget. */
    extract: number;
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
     * When true (default), dark-launch gate verdicts are logged at INFO level
     * every cycle. Set HERMES_DARK_LAUNCH=false to suppress.
     * Engine-spawning MCP tools (aggregate/rank/select_top10/synthesize) are only
     * available when this flag is true.
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
}

/** Resolve configuration from the given environment (defaults to the process env). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PipelineConfig {
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
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
      aggregate: num('STAGE_TIMEOUT_AGGREGATE_MS', 600_000),
      extract: num('STAGE_TIMEOUT_EXTRACT_MS', 600_000),
      rank: num('STAGE_TIMEOUT_RANK_MS', 120_000),
      top10: num('STAGE_TIMEOUT_TOP10_MS', 120_000),
      synthesize: num('STAGE_TIMEOUT_SYNTHESIZE_MS', 900_000),
    },
    retry: {
      attempts: num('STAGE_RETRIES', 2),
      backoffMs: num('STAGE_BACKOFF_MS', 5_000),
    },
    hermes: {
      coverageDbPath: str('HERMES_COVERAGE_DB', join(artifactStoreBase, 'coverage.db')),
      darkLaunchEnabled: bool('HERMES_DARK_LAUNCH', true),
    },
    mcp: {
      apiKey: str('MCP_API_KEY', '') || null,
    },
    observability: {
      alertWebhookUrl: str('ALERT_WEBHOOK_URL', '') || null,
      metricsWebhookUrl: str('METRICS_WEBHOOK_URL', '') || null,
      logFormat: str('LOG_FORMAT', 'json') === 'pretty' ? 'pretty' : 'json',
    },
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
  // Forward Ollama connection only when configured — engines skip it when blank.
  if (config.ollama.host) env['OLLAMA_HOST'] = config.ollama.host;
  if (config.ollama.model) env['OLLAMA_MODEL'] = config.ollama.model;
  if (config.ollama.apiKey) env['OLLAMA_API_KEY'] = config.ollama.apiKey;
  return env;
}
