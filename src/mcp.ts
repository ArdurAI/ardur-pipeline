/**
 * MCP server CLI entry-point — stdio transport.
 *
 * Usage:
 *   node --experimental-strip-types --experimental-sqlite src/mcp.ts
 *
 * Reads pipeline config from environment (same vars as cycle CLI). Starts an
 * MCP server on stdin/stdout; structured logs go to stderr. Clients connect
 * by launching this process as a subprocess (the standard MCP stdio transport).
 *
 * Tools exposed: aggregate, rank, select_top10, synthesize, check_coverage.
 */
import { loadConfig } from './config.ts';
import { createLogger } from './log.ts';
import { createToolRegistry } from './tool-registry.ts';
import { startMcpServer } from './mcp-server.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ format: config.observability.logFormat });
  const registry = createToolRegistry(config, logger);

  logger.info('ardur-pipeline mcp server started', {
    tools: registry.descriptors().map((d) => d.name),
    coverageDb: config.hermes.coverageDbPath || '(disabled)',
    darkLaunch: config.hermes.darkLaunchEnabled,
  });

  await startMcpServer(registry, logger);

  logger.info('ardur-pipeline mcp server stopped');
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
