/**
 * Unit tests for the MCP server (minimal stdio JSON-RPC transport).
 *
 * Tests tool listing, initialize handshake, and error responses. Does NOT
 * test tools/call for engine tools (requires engine repos to be checked out).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createToolRegistry } from './tool-registry.ts';
import { startMcpServer } from './mcp-server.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './log.ts';

const silent = createLogger({ format: 'json', write: () => {} });

/** Send one or more JSON-RPC lines to the server; collect the response lines. */
async function runMcpLines(
  inputLines: string[],
  opts?: { apiKey?: string },
): Promise<unknown[]> {
  const config = loadConfig({});
  const registry = createToolRegistry(config, silent);

  const outputChunks: string[] = [];
  const output = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      outputChunks.push(chunk.toString());
      cb();
    },
  });

  const input = new Readable({ read() {} });

  const serverDone = startMcpServer(registry, silent, input, output, { apiKey: opts?.apiKey });

  // Push all lines then signal EOF
  for (const line of inputLines) {
    input.push(line + '\n');
  }
  input.push(null);

  await serverDone;

  // Parse all non-empty lines as JSON
  return outputChunks
    .join('')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown);
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

test('MCP initialize returns server info and protocol version', async () => {
  const responses = await runMcpLines([
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.1' },
      },
    }),
  ]);

  assert.equal(responses.length, 1);
  const resp = responses[0] as {
    id: number;
    result: {
      protocolVersion: string;
      serverInfo: { name: string };
      capabilities: { tools: object };
    };
  };
  assert.equal(resp.id, 1);
  assert.equal(resp.result.protocolVersion, '2024-11-05');
  assert.equal(resp.result.serverInfo.name, 'ardur-pipeline');
  assert.ok(resp.result.capabilities.tools !== undefined);
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

test('MCP tools/list returns 5 tools with required fields', async () => {
  const responses = await runMcpLines([
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  ]);

  assert.equal(responses.length, 1);
  const resp = responses[0] as {
    id: number;
    result: { tools: Array<{ name: string; description: string; inputSchema: { type: string } }> };
  };
  assert.equal(resp.id, 2);

  const { tools } = resp.result;
  assert.equal(tools.length, 5);

  const names = tools.map((t) => t.name);
  assert.deepEqual(names, ['aggregate', 'rank', 'select_top10', 'synthesize', 'check_coverage']);

  for (const tool of tools) {
    assert.ok(tool.description.length > 0, `${tool.name}: description missing`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name}: inputSchema.type`);
  }
});

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

test('MCP ping returns empty result', async () => {
  const responses = await runMcpLines([JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })]);

  assert.equal(responses.length, 1);
  const resp = responses[0] as { id: number; result: object };
  assert.equal(resp.id, 3);
  assert.deepEqual(resp.result, {});
});

// ---------------------------------------------------------------------------
// Unknown method → method-not-found error
// ---------------------------------------------------------------------------

test('MCP unknown method returns JSON-RPC error -32601', async () => {
  const responses = await runMcpLines([
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'unknown/foo', params: {} }),
  ]);

  assert.equal(responses.length, 1);
  const resp = responses[0] as { id: number; error: { code: number; message: string } };
  assert.equal(resp.id, 4);
  assert.equal(resp.error.code, -32601);
  assert.ok(resp.error.message.includes('unknown/foo'));
});

// ---------------------------------------------------------------------------
// Notifications (no id) → no response
// ---------------------------------------------------------------------------

test('MCP notification (no id) produces no response', async () => {
  const responses = await runMcpLines([
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  ]);

  assert.equal(responses.length, 0, 'notifications must not elicit a response');
});

// ---------------------------------------------------------------------------
// Multiple requests in sequence
// ---------------------------------------------------------------------------

test('MCP handles multiple requests and correlates ids', async () => {
  const responses = await runMcpLines([
    JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping' }),
    JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} }),
  ]);

  assert.equal(responses.length, 2);
  const ids = (responses as Array<{ id: number }>).map((r) => r.id);
  assert.ok(ids.includes(10));
  assert.ok(ids.includes(11));
});

// ---------------------------------------------------------------------------
// tools/call for check_coverage (synchronous path — no engine spawn)
// ---------------------------------------------------------------------------

test('MCP tools/call check_coverage missing args returns isError content', async () => {
  const responses = await runMcpLines([
    JSON.stringify({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'check_coverage', arguments: {} },
    }),
  ]);

  // The server responds with ok (isError: true in content) not a JSON-RPC error
  assert.equal(responses.length, 1);
  const resp = responses[0] as {
    id: number;
    result: { content: Array<{ type: string; text: string }>; isError: boolean };
  };
  assert.equal(resp.id, 20);
  assert.equal(resp.result.isError, true);
  assert.ok(resp.result.content[0]?.text.includes('MISSING_INPUT'));
});

// ---------------------------------------------------------------------------
// #22 — MCP server authentication (CWE-306)
// ---------------------------------------------------------------------------

test('#22: tools/list is rejected before authenticate when apiKey is required', async () => {
  const responses = await runMcpLines(
    [JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'tools/list', params: {} })],
    { apiKey: 'secret-key' },
  );
  assert.equal(responses.length, 1);
  const resp = responses[0] as { id: number; error: { code: number } };
  assert.equal(resp.id, 30);
  assert.equal(resp.error.code, -32001);
});

test('#22: initialize without correct key returns auth error', async () => {
  const responses = await runMcpLines(
    [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 31,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.1' },
          credentials: { apiKey: 'wrong-key' },
        },
      }),
    ],
    { apiKey: 'secret-key' },
  );
  assert.equal(responses.length, 1);
  const resp = responses[0] as { id: number; error: { code: number } };
  assert.equal(resp.id, 31);
  assert.equal(resp.error.code, -32001);
});

test('#22: correct key in initialize allows subsequent tools/list', async () => {
  const responses = await runMcpLines(
    [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 32,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.1' },
          credentials: { apiKey: 'secret-key' },
        },
      }),
      JSON.stringify({ jsonrpc: '2.0', id: 33, method: 'tools/list', params: {} }),
    ],
    { apiKey: 'secret-key' },
  );

  // Both requests must get responses.
  assert.equal(responses.length, 2);
  const [initResp, listResp] = responses as [
    { id: number; result: { serverInfo: { name: string } } },
    { id: number; result: { tools: unknown[] } },
  ];
  assert.equal(initResp.id, 32);
  assert.equal(initResp.result.serverInfo.name, 'ardur-pipeline');
  assert.equal(listResp.id, 33);
  assert.equal(listResp.result.tools.length, 5);
});

test('#22: no apiKey configured → open access (no auth required)', async () => {
  // When apiKey is undefined/null, tools/list works without initialize.
  const responses = await runMcpLines(
    [JSON.stringify({ jsonrpc: '2.0', id: 34, method: 'tools/list', params: {} })],
    // no apiKey opt
  );
  assert.equal(responses.length, 1);
  const resp = responses[0] as { id: number; result: { tools: unknown[] } };
  assert.equal(resp.id, 34);
  assert.equal(resp.result.tools.length, 5);
});

test('#22: ping is allowed before authenticate even when apiKey is required', async () => {
  const responses = await runMcpLines(
    [JSON.stringify({ jsonrpc: '2.0', id: 35, method: 'ping' })],
    { apiKey: 'secret-key' },
  );
  assert.equal(responses.length, 1);
  const resp = responses[0] as { id: number; result: object };
  assert.equal(resp.id, 35);
  assert.deepEqual(resp.result, {});
});
