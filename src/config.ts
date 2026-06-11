/**
 * Runtime configuration, resolved once from the environment.
 *
 * Every field has a safe default so that an empty environment yields a
 * deterministic, budget=0 cycle (no paid API calls, no network surprises). The
 * orchestrator never reads `process.env` directly past this module — pass a
 * `PipelineConfig` everywhere so cycles are reproducible and testable.
 */

import { resolve } from 'node:path';

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
  const join = (name: string, fallback: string) => resolve(enginesDir, str(name, fallback));

  return {
    engines: {
      aggregator: join('ENGINE_AGGREGATOR', 'ardur-news-aggregator'),
      ranking: join('ENGINE_RANKING', 'ardur-ranking-engine'),
      top10: join('ENGINE_TOP10', 'ardur-top10-engine'),
      synthesizer: join('ENGINE_SYNTHESIZER', 'ardur-article-synthesizer'),
    },
    artifactStore: resolve(str('ARTIFACT_STORE', '.artifacts')),
    ai: {
      // Default to ollama; engines fall back to deterministic when maxGenerations=0.
      provider: str('ARDUR_AI_PROVIDER', 'ollama'),
      maxGenerations: num('ARDUR_AI_MAX_GENERATIONS', 0),
      timeoutMs: num('ARDUR_AI_TIMEOUT_MS', 20_000),
    },
    ollama: {
      host: str('OLLAMA_HOST', ''),
      model: str('OLLAMA_MODEL', ''),
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
  return env;
}
