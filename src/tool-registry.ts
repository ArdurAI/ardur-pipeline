/**
 * Tool registry — typed wrappers for the four pipeline engine CLIs + coverage check.
 *
 * Each engine is a "tool" with a declared JSON-Schema description, an
 * availability check (engine repo present + CLI exists), and a result-size
 * budget that protects the agent context window. The registry is the single
 * seam between agent consumers (MCP server, dark-launch hooks) and the
 * pipeline CLI runners — they never call runners.ts directly.
 *
 * The conductor (orchestrate.ts) still calls createCliRunners() directly; the
 * registry wraps those same runners so tool-call output is identical.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { assertCompatibleArtifact } from '@ardurai/contracts';
import { createCliRunners } from './runners.ts';
import { cycleFor } from './cycle.ts';
import { CoverageStore } from './coverage-store.ts';
import type { PipelineConfig } from './config.ts';
import type { Logger } from './log.ts';
import type {
  AggregationArtifact,
  RankingArtifact,
  Top10Artifact,
  ArticleArtifact,
  CycleMeta,
} from '@ardurai/contracts';
import type { CoverageResult } from './coverage-store.ts';

// ---------------------------------------------------------------------------
// Schema + descriptor types
// ---------------------------------------------------------------------------

export interface JSONSchemaObject {
  type: string;
  description?: string;
  properties?: Record<string, JSONSchemaObject>;
  required?: string[];
  items?: JSONSchemaObject;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JSONSchemaObject;
  outputSchema: JSONSchemaObject;
  availability: () => Promise<{ available: boolean; reason?: string }>;
  /** Maximum acceptable output JSON size in bytes. */
  sizeBudget: number;
}

export type ToolResult<T> =
  | { ok: true; data: T; sizeBytes: number }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

// ---------------------------------------------------------------------------
// Per-tool input types (loose — the registry does a best-effort cast)
// ---------------------------------------------------------------------------

interface AggregateInput {
  cycleId?: string;
  etl?: boolean;
}

interface RankInput {
  aggregation?: AggregationArtifact;
}

interface Top10Input {
  ranking?: RankingArtifact;
  previous?: Top10Artifact | null;
  aggregation?: AggregationArtifact;
}

interface SynthesizeInput {
  top10?: Top10Artifact;
  aggregation?: AggregationArtifact;
}

interface CheckCoverageInput {
  topic?: string;
  fingerprint?: string;
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private readonly config: PipelineConfig;
  private readonly logger: Logger;
  private readonly getNow: () => Date;

  constructor(config: PipelineConfig, logger: Logger, opts?: { now?: () => Date }) {
    this.config = config;
    this.logger = logger;
    this.getNow = opts?.now ?? (() => new Date());
  }

  /** Return the static descriptor list for all 5 tools. Used by MCP `tools/list`. */
  descriptors(): ToolDescriptor[] {
    const { engines } = this.config;
    return [
      {
        name: 'aggregate',
        description:
          'Stage 1: ingest ≥20–30 sources per topic, dedup, cluster, optionally ETL-fetch bodies for fact extraction.',
        inputSchema: {
          type: 'object',
          properties: {
            cycleId: {
              type: 'string',
              description:
                'ISO 8601 UTC window-start id (e.g. "2026-06-11T06:00:00.000Z"). Defaults to current cycle.',
            },
            etl: {
              type: 'boolean',
              description: 'Enable ETL full-text fetch + fact extraction (ARDUR_ETL_ENABLED).',
            },
          },
        },
        outputSchema: { type: 'object', description: 'AggregationArtifact' },
        availability: async () => checkEngineAvailable(engines.aggregator),
        sizeBudget: 50 * 1024 * 1024,
      },
      {
        name: 'rank',
        description:
          'Stage 2: score each cluster on 5 signals (interaction, credibility, recency, diversity, corroboration).',
        inputSchema: {
          type: 'object',
          required: ['aggregation'],
          properties: {
            aggregation: { type: 'object', description: 'AggregationArtifact from stage 1.' },
          },
        },
        outputSchema: { type: 'object', description: 'RankingArtifact' },
        availability: async () => checkEngineAvailable(engines.ranking),
        sizeBudget: 5 * 1024 * 1024,
      },
      {
        name: 'select_top10',
        description:
          'Stage 3: select top-10 clusters per topic with hysteresis, category-cap balancing, and delta tracking.',
        inputSchema: {
          type: 'object',
          required: ['ranking', 'aggregation'],
          properties: {
            ranking: { type: 'object', description: 'RankingArtifact from stage 2.' },
            previous: {
              type: 'object',
              description:
                'Previous Top10Artifact for delta/hysteresis. Omit or null for fresh start.',
            },
            aggregation: { type: 'object', description: 'AggregationArtifact from stage 1.' },
          },
        },
        outputSchema: { type: 'object', description: 'Top10Artifact' },
        availability: async () => checkEngineAvailable(engines.top10),
        sizeBudget: 2 * 1024 * 1024,
      },
      {
        name: 'synthesize',
        description:
          'Stage 4: write one fact-grounded, copyright-safe article per top-10 entry. Articles failing provenance gate are emitted with editorialStatus: "held".',
        inputSchema: {
          type: 'object',
          required: ['top10', 'aggregation'],
          properties: {
            top10: { type: 'object', description: 'Top10Artifact from stage 3.' },
            aggregation: { type: 'object', description: 'AggregationArtifact from stage 1.' },
          },
        },
        outputSchema: { type: 'object', description: 'ArticleArtifact' },
        availability: async () => checkEngineAvailable(engines.synthesizer),
        sizeBudget: 20 * 1024 * 1024,
      },
      {
        name: 'check_coverage',
        description:
          'Query coverage memory: has this topic/fingerprint been published before, and is the topic exhausted (seen in ≥3 recent cycles)?',
        inputSchema: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description: 'Topic label (FTS5 full-text search on recorded topics).',
            },
            fingerprint: {
              type: 'string',
              description: 'Exact AggregatedItem.fingerprint for an indexed lookup.',
            },
          },
        },
        outputSchema: { type: 'object', description: 'CoverageResult' },
        availability: async () => ({ available: true }),
        sizeBudget: 64 * 1024,
      },
    ];
  }

  /**
   * Invoke a tool by name. Returns a structured `ToolResult` — never throws.
   * Unknown tools or bad inputs get an `ok: false` error envelope.
   *
   * Guards (in order):
   *  1. Tool must exist (#23)
   *  2. Engine-spawning tools require darkLaunchEnabled (#22)
   *  3. Required-field check — MISSING_INPUT before hitting the filesystem (#23)
   *  4. Engine must be present (availability check) (#23)
   *  5. Run the tool (includes INVALID_INPUT artifact format check)
   *  6. Enforce sizeBudget on the result (#23)
   */
  async call(name: string, args: unknown): Promise<ToolResult<unknown>> {
    const descriptor = this.descriptors().find((d) => d.name === name);
    if (!descriptor) return err('UNKNOWN_TOOL', `Unknown tool: ${name}`);

    // Engine-spawning tools are gated by dark-launch mode (#22).
    const ENGINE_TOOLS = new Set(['aggregate', 'rank', 'select_top10', 'synthesize']);
    if (ENGINE_TOOLS.has(name) && !this.config.hermes.darkLaunchEnabled) {
      return err(
        'DARK_LAUNCH_DISABLED',
        'Engine tools require HERMES_DARK_LAUNCH=true — they are only available in dark-launch mode.',
      );
    }

    // Required-field check before availability: fail fast on missing inputs without
    // touching the filesystem (#23). This must precede the availability guard so that
    // MISSING_INPUT is deterministic even when engine repos are absent (e.g. in CI).
    const inputErr = checkRequiredInputs(name, args);
    if (inputErr) return inputErr;

    // Availability check: ensure the engine repo is present before spawning (#23).
    const avail = await descriptor.availability();
    if (!avail.available) {
      return err('ENGINE_UNAVAILABLE', avail.reason ?? 'Engine not available');
    }

    try {
      let result: ToolResult<unknown>;
      switch (name) {
        case 'aggregate':
          result = await this._aggregate(args as Partial<AggregateInput>);
          break;
        case 'rank':
          result = await this._rank(args as Partial<RankInput>);
          break;
        case 'select_top10':
          result = await this._top10(args as Partial<Top10Input>);
          break;
        case 'synthesize':
          result = await this._synthesize(args as Partial<SynthesizeInput>);
          break;
        case 'check_coverage':
          result = this._checkCoverage(args as Partial<CheckCoverageInput>);
          break;
        default:
          return err('UNKNOWN_TOOL', `Unknown tool: ${name}`);
      }

      // Enforce sizeBudget: protect agent context window from oversized artifacts (#23).
      if (result.ok && result.sizeBytes > descriptor.sizeBudget) {
        return err(
          'SIZE_EXCEEDED',
          `Result size ${result.sizeBytes} bytes exceeds budget of ${descriptor.sizeBudget} bytes for tool '${name}'`,
        );
      }
      return result;
    } catch (e) {
      return err('TOOL_ERROR', e instanceof Error ? e.message : String(e));
    }
  }

  // -------------------------------------------------------------------------
  // Per-tool implementations
  // -------------------------------------------------------------------------

  private async _aggregate(
    input: Partial<AggregateInput>,
  ): Promise<ToolResult<AggregationArtifact>> {
    const atDate = input.cycleId ? new Date(input.cycleId) : this.getNow();
    const cycle = cycleFor(atDate);
    const runners = this._runners(cycle, { etl: input.etl });
    const data = await runners.aggregate(cycle);
    return ok(data);
  }

  private async _rank(input: Partial<RankInput>): Promise<ToolResult<RankingArtifact>> {
    if (!input.aggregation) return err('MISSING_INPUT', 'aggregation is required');
    // Gate-before-stamp: validate the caller-supplied artifact before spawning the engine (#21).
    try {
      assertCompatibleArtifact(input.aggregation, 'aggregation');
    } catch (e) {
      return err('INVALID_INPUT', e instanceof Error ? e.message : String(e));
    }
    const cycle = cycleFor(this.getNow());
    const data = await this._runners(cycle).rank(input.aggregation);
    return ok(data);
  }

  private async _top10(input: Partial<Top10Input>): Promise<ToolResult<Top10Artifact>> {
    if (!input.ranking) return err('MISSING_INPUT', 'ranking is required');
    if (!input.aggregation) return err('MISSING_INPUT', 'aggregation is required');
    // Gate-before-stamp: validate caller-supplied artifacts before spawning (#21).
    try {
      assertCompatibleArtifact(input.ranking, 'ranking');
    } catch (e) {
      return err('INVALID_INPUT', e instanceof Error ? e.message : String(e));
    }
    try {
      assertCompatibleArtifact(input.aggregation, 'aggregation');
    } catch (e) {
      return err('INVALID_INPUT', e instanceof Error ? e.message : String(e));
    }
    const cycle = cycleFor(this.getNow());
    const data = await this._runners(cycle).selectTop10(
      input.ranking,
      input.previous ?? null,
      input.aggregation,
    );
    return ok(data);
  }

  private async _synthesize(input: Partial<SynthesizeInput>): Promise<ToolResult<ArticleArtifact>> {
    if (!input.top10) return err('MISSING_INPUT', 'top10 is required');
    if (!input.aggregation) return err('MISSING_INPUT', 'aggregation is required');
    // Gate-before-stamp: validate caller-supplied artifacts before spawning (#21).
    try {
      assertCompatibleArtifact(input.top10, 'top10');
    } catch (e) {
      return err('INVALID_INPUT', e instanceof Error ? e.message : String(e));
    }
    try {
      assertCompatibleArtifact(input.aggregation, 'aggregation');
    } catch (e) {
      return err('INVALID_INPUT', e instanceof Error ? e.message : String(e));
    }
    const cycle = cycleFor(this.getNow());
    const data = await this._runners(cycle).synthesize(input.top10, input.aggregation);
    return ok(data);
  }

  private _checkCoverage(input: Partial<CheckCoverageInput>): ToolResult<CoverageResult> {
    if (!input.topic && !input.fingerprint) {
      return err('MISSING_INPUT', 'topic or fingerprint is required');
    }
    if (!this.config.hermes.coverageDbPath) {
      return err(
        'COVERAGE_DISABLED',
        'Coverage store not configured — set HERMES_COVERAGE_DB to enable.',
      );
    }
    // Open a short-lived connection per call (SQLite WAL is safe for this)
    const store = new CoverageStore(this.config.hermes.coverageDbPath);
    try {
      const data = store.check({ topic: input.topic, fingerprint: input.fingerprint });
      return ok(data);
    } finally {
      store.close();
    }
  }

  private _runners(cycle: CycleMeta, opts?: { etl?: boolean }) {
    if (opts?.etl !== undefined) {
      const patched: PipelineConfig = {
        ...this.config,
        etl: { ...this.config.etl, enabled: opts.etl },
      };
      return createCliRunners(patched, cycle, this.logger);
    }
    return createCliRunners(this.config, cycle, this.logger);
  }
}

/** Factory shorthand — preferred entry point. */
export function createToolRegistry(
  config: PipelineConfig,
  logger: Logger,
  opts?: { now?: () => Date },
): ToolRegistry {
  return new ToolRegistry(config, logger, opts);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok<T>(data: T): ToolResult<T> {
  // Use Buffer.byteLength for accurate UTF-8 byte count (#30 — String.length is UTF-16 code units).
  const json = JSON.stringify(data);
  return { ok: true, data, sizeBytes: Buffer.byteLength(json, 'utf8') };
}

function err(code: string, message: string, details?: unknown): ToolResult<never> {
  return { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

function checkRequiredInputs(name: string, args: unknown): ToolResult<never> | null {
  const a = args as Record<string, unknown>;
  if (name === 'rank' && !a?.aggregation) return err('MISSING_INPUT', 'aggregation is required');
  if (name === 'select_top10' && !a?.ranking) return err('MISSING_INPUT', 'ranking is required');
  if (name === 'select_top10' && !a?.aggregation)
    return err('MISSING_INPUT', 'aggregation is required');
  if (name === 'synthesize' && !a?.top10) return err('MISSING_INPUT', 'top10 is required');
  if (name === 'synthesize' && !a?.aggregation)
    return err('MISSING_INPUT', 'aggregation is required');
  if (name === 'check_coverage' && !a?.topic && !a?.fingerprint)
    return err('MISSING_INPUT', 'topic or fingerprint is required');
  return null;
}

function checkEngineAvailable(dir: string): { available: boolean; reason?: string } {
  const cliPath = join(dir, 'src', 'cli.ts');
  if (!existsSync(dir)) return { available: false, reason: `engine not checked out at ${dir}` };
  if (!existsSync(cliPath)) {
    return { available: false, reason: `engine cli.ts missing at ${cliPath}` };
  }
  return { available: true };
}
