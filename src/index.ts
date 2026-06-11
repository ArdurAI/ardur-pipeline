/**
 * Public API of `@ardurai/pipeline`.
 *
 * The package is primarily a runtime (see `src/cli.ts`), but the conductor and
 * its building blocks are exported so they can be embedded or tested.
 */

export { runCycle } from './orchestrate.ts';
export type { RunResult, RunCycleDeps, CycleStatus, StageTiming } from './orchestrate.ts';
export { loadConfig, aiEnv } from './config.ts';
export type { PipelineConfig, EngineLocations } from './config.ts';
export { ArtifactStore, buildManifest, categorizeWarnings } from './store.ts';
export type {
  PublishManifest,
  CyclePublishSet,
  PublishStatus,
  WarningCategory,
  HealthRollup,
  PublishOptions,
} from './store.ts';
export { createCliRunners } from './runners.ts';
export type { StageRunners } from './runners.ts';
export { createLogger } from './log.ts';
export type { Logger } from './log.ts';
export { cycleFor, nextRefreshAt, windowStart, cycleId } from './cycle.ts';
export { buildCycleMetrics, emitMetrics } from './metrics.ts';
export type { CycleMetrics, MetricsEmitOptions } from './metrics.ts';
export { CoverageStore, openCoverageStore } from './coverage-store.ts';
export type { CoverageRecord, CoverageHit, CoverageResult } from './coverage-store.ts';
export { ToolRegistry, createToolRegistry } from './tool-registry.ts';
export type { ToolDescriptor, ToolResult, JSONSchemaObject } from './tool-registry.ts';
export { startMcpServer } from './mcp-server.ts';
export * from '@ardurai/contracts';
