/**
 * Minimal MCP (Model Context Protocol) server — stdio transport.
 *
 * Exposes 5 pipeline tools: aggregate, rank, select_top10, synthesize, check_coverage.
 *
 * Protocol: line-delimited JSON-RPC 2.0 over stdin/stdout (MCP spec §Transport).
 * Handles: initialize, notifications/initialized (no response), tools/list,
 * tools/call, ping. Unknown methods get a JSON-RPC METHOD_NOT_FOUND response.
 *
 * No external MCP SDK dependency — the protocol is simple enough to implement
 * directly and keeps the dependency surface minimal.
 */
import { createInterface } from 'node:readline';
import type { Logger } from './log.ts';
import type { ToolRegistry } from './tool-registry.ts';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'ardur-pipeline';
const SERVER_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface ToolCallParams {
  name?: string;
  arguments?: unknown;
}

// ---------------------------------------------------------------------------
// JSON-RPC error codes (standard)
// ---------------------------------------------------------------------------

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
// Application-level auth error in the server-error range (CWE-306 fix, #22).
const UNAUTHORIZED = -32001;

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function jsonLine(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

function okResponse(id: JsonRpcId, result: unknown): string {
  return jsonLine({ jsonrpc: '2.0', id, result });
}

function errResponse(id: JsonRpcId, code: number, message: string, data?: unknown): string {
  return jsonLine({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the MCP server. Reads from `input` (default stdin) and writes to
 * `output` (default stdout). Returns when the input stream ends.
 *
 * This function is intentionally agnostic about the transport direction —
 * tests can pass in-memory streams.
 *
 * Authentication (#22 / CWE-306): if `opts.apiKey` is set, clients must pass
 * the matching key in `initialize` params as `params.credentials.apiKey`.
 * All non-auth requests before a successful initialize are rejected with -32001.
 * `ping` is exempted (health check only; no tool invocation).
 */
export function startMcpServer(
  registry: ToolRegistry,
  logger: Logger,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  opts?: { apiKey?: string | null },
): Promise<void> {
  return new Promise<void>((resolve) => {
    const rl = createInterface({ input, terminal: false });

    // Build the static tool list once on startup
    const tools = registry.descriptors().map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
    }));

    const write = (msg: string) => output.write(msg);
    const requiredKey = opts?.apiKey ?? null;
    // If no key is configured the session starts pre-authenticated (dev / trusted-process mode).
    let authenticated = !requiredKey;

    // Track in-flight async tool calls. The server must not resolve until all
    // async responses have been written — otherwise the test helper (and any
    // real client that closes stdin immediately) would miss responses.
    let pendingCalls = 0;
    let streamClosed = false;
    const tryResolve = () => {
      if (streamClosed && pendingCalls === 0) resolve();
    };

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let req: JsonRpcRequest;
      try {
        req = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        write(errResponse(null, PARSE_ERROR, 'Parse error'));
        return;
      }

      // Notifications (no id) — spec says do NOT respond
      if (req.id === undefined) return;

      const id = req.id ?? null;

      // Auth gate: allow initialize (for the handshake) and ping (health check).
      // All other methods require a successful initialize first.
      if (!authenticated && req.method !== 'initialize' && req.method !== 'ping') {
        write(
          errResponse(
            id,
            UNAUTHORIZED,
            'Not authenticated — send initialize with valid credentials',
          ),
        );
        return;
      }

      handleRequest(
        req,
        id,
        tools,
        registry,
        logger,
        write,
        requiredKey,
        authenticated,
        (v) => {
          authenticated = v;
        },
        (delta) => {
          pendingCalls += delta;
          tryResolve();
        },
      );
    });

    rl.on('close', () => {
      streamClosed = true;
      tryResolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

function handleRequest(
  req: JsonRpcRequest,
  id: JsonRpcId,
  tools: { name: string; description: string; inputSchema: unknown }[],
  registry: ToolRegistry,
  logger: Logger,
  write: (msg: string) => void,
  requiredKey: string | null,
  authenticated: boolean,
  setAuthenticated: (v: boolean) => void,
  trackPending: (delta: 1 | -1) => void,
): void {
  switch (req.method) {
    case 'initialize': {
      // Validate API key during initialize if one is required (#22).
      if (requiredKey && !authenticated) {
        const params = req.params as { credentials?: { apiKey?: string } } | undefined;
        if (params?.credentials?.apiKey !== requiredKey) {
          write(
            errResponse(
              id,
              UNAUTHORIZED,
              'Invalid or missing API key in initialize params.credentials.apiKey',
            ),
          );
          return;
        }
        setAuthenticated(true);
      }
      write(
        okResponse(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      );
      break;
    }

    case 'ping':
      write(okResponse(id, {}));
      break;

    case 'tools/list':
      write(okResponse(id, { tools }));
      break;

    case 'tools/call': {
      const params = req.params as ToolCallParams | undefined;
      if (!params?.name) {
        write(errResponse(id, INVALID_PARAMS, 'tools/call requires params.name'));
        return;
      }
      trackPending(1);
      registry
        .call(params.name, params.arguments ?? {})
        .then((result) => {
          if (result.ok) {
            write(
              okResponse(id, {
                content: [{ type: 'text', text: JSON.stringify(result.data) }],
              }),
            );
          } else {
            write(
              okResponse(id, {
                content: [
                  { type: 'text', text: `Error [${result.error.code}]: ${result.error.message}` },
                ],
                isError: true,
              }),
            );
          }
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          logger.error('mcp tools/call unhandled error', { tool: params.name, error: message });
          write(errResponse(id, INTERNAL_ERROR, message));
        })
        .finally(() => {
          trackPending(-1);
        });
      break;
    }

    default:
      write(errResponse(id, METHOD_NOT_FOUND, `Method not found: ${req.method}`));
  }
}
