/**
 * Typed tool-manifest for each pipeline engine.
 *
 * Each engine is a pure JSON-in/JSON-out CLI. This manifest makes that interface
 * machine-discoverable so an agent layer (Hermes, MCP shim, or any orchestrator)
 * can call the four CLIs in order without reading engine source code.
 *
 * Manifests are static JSON files under docs/tool-manifests/. This module provides
 * the TypeScript type and a loader so the orchestrator (and test harnesses) can
 * validate and use them programmatically.
 *
 * ABI guarantee: the `outputArtifact` stage matches the value of
 * `ArtifactEnvelope.artifact` in the engine's stdout JSON. The `inputArtifact`
 * stage (if present) must be gated with `assertCompatibleArtifact` before use.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Describes how a single engine CLI is invoked. */
export interface CliSpec {
  /**
   * Positional arguments in order. Each entry is either a literal flag string
   * ("--top10") or a placeholder like "<aggregation.json>" indicating a file path
   * that the caller must supply.
   */
  args: string[];
  /**
   * Environment variable names that the engine reads. Values not listed here are
   * ignored by the engine even if forwarded.
   */
  env: string[];
  /**
   * How stdout is structured. Always "json" for Ardur engines — the full
   * ArtifactEnvelope<TData> serialised as a single JSON object.
   */
  stdout: 'json';
}

/**
 * Minimal JSON Schema fragment used to describe ArtifactEnvelope shapes.
 * Not a full validator — enough for an agent to understand the wire format.
 */
export interface ArtifactSchema {
  /** Always "object" for ArtifactEnvelope wrappers. */
  type: 'object';
  /** Always present: schemaVersion, artifact, runId, cycle, data. */
  required: string[];
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
}

/** One tool-manifest entry; one file per engine under docs/tool-manifests/. */
export interface ToolManifest {
  /** Machine-readable engine name (matches the engine repo name sans "ardur-"). */
  name: string;
  /** Human-readable description of the engine's role. */
  description: string;
  /** Semantic version of the manifest itself (not the engine). */
  manifestVersion: string;
  /**
   * @ardurai/contracts revision this manifest was authored against.
   * A consumer should warn (not fail) if its local revision differs.
   */
  contractRevision: number;
  /** CLI invocation spec. */
  cli: CliSpec;
  /**
   * Stage name of the artifact this engine CONSUMES as its primary input.
   * null for the aggregator (it has no upstream artifact).
   */
  inputArtifact: string | null;
  /** Stage name of the artifact this engine PRODUCES on stdout. */
  outputArtifact: string;
  /**
   * Abbreviated JSON Schema for the output envelope.
   * The full type is `ArtifactEnvelope<TData>` from @ardurai/contracts.
   */
  outputSchema: ArtifactSchema;
  /**
   * Idempotency guarantee. "cycle" means the engine produces identical output
   * for the same cycle.id regardless of how many times it is called.
   */
  idempotency: 'cycle';
  /** True: the engine holds no session state between invocations. */
  stateless: true;
}

/** Load and parse a tool manifest from the docs/tool-manifests/ directory. */
export async function loadToolManifest(docsDir: string, engineName: string): Promise<ToolManifest> {
  const path = join(docsDir, 'tool-manifests', `${engineName}.json`);
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as ToolManifest;
}

/** Validate that a manifest's contractRevision is compatible with the local build. */
export function assertManifestCompatible(manifest: ToolManifest, localRevision: number): void {
  if (manifest.contractRevision > localRevision) {
    throw new Error(
      `tool-manifest for '${manifest.name}' requires contractRevision ` +
        `${manifest.contractRevision} but local contracts are at revision ${localRevision}`,
    );
  }
}
