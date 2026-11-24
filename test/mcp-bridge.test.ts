// Unit tests for src/mcp-bridge.ts (T4). The MCP side is exercised with a REAL
// MCP client from @modelcontextprotocol/sdk over loopback HTTP only (AGENTS.md
// §4): the bridge under test is a real 127.0.0.1 server, the client is the
// SDK's own StreamableHTTPClientTransport. No real vibe-acp, no network
// beyond 127.0.0.1. Time-sensitive behaviour uses short REAL timeouts
// (batchWindowMs / toolPreTimeoutMs are constructor knobs) instead of fake
// timers, because the HTTP client and server need real event-loop time.
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMcpBridge,
  MAX_BODY_BYTES,
  type BridgeTool,
  type CreateMcpBridgeOptions,
  type McpBridge,
  type ParkedCall,
} from '../src/mcp-bridge.ts';

const TOOLS: readonly BridgeTool[] = [
  {
    name: 'read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'echo',
    description: 'Echo text back',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

const bridges: McpBridge[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const bridge of bridges.splice(0)) await bridge.close().catch(() => {});
});

async function makeBridge(
  options: Partial<CreateMcpBridgeOptions> = {},
  logLines?: string[]
): Promise<McpBridge> {
  const bridge = await createMcpBridge({
    tools: TOOLS,
    batchWindowMs: 40,
    toolPreTimeoutMs: 1_000,
    ...options,
    logger: logLines ? (line) => logLines.push(line) : undefined,
  });
  bridges.push(bridge);
  return bridge;
}

/** Connects a real MCP client (fresh session) with the bridge's bearer token. */
async function connect(bridge: McpBridge, token: string = bridge.token): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'mcp-bridge-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** Records every emitted batch; returns the live array. */
function recordBatches(bridge: McpBridge): ParkedCall[][] {
  const batches: ParkedCall[][] = [];
  bridge.onBatch((calls) => batches.push([...calls]));
  return batches;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(5);
  }
}

async function rawPost(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const textOf = (result: unknown): string => {
  if (typeof result !== 'object' || result === null || !('content' in result)) return '';
  const content: unknown = result.content;
  if (!Array.isArray(content) || content.length === 0) return '';
  const first: unknown = content[0];
  if (typeof first !== 'object' || first === null || !('text' in first)) return '';
  return String(first.text);
};

describe('createMcpBridge', () => {
  it('serves on loopback with a random port and a per-session bearer token', async () => {
    const bridge = await makeBridge();
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(bridge.token).toMatch(/^[0-9a-f]{64}$/);
    expect(bridge.serverName).toBe('pi');
  });

  it('answers 401 without/with a wrong token, counts them, and never logs the token', async () => {
    const lines: string[] = [];
    const bridge = await makeBridge({}, lines);
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

    const noAuth = await rawPost(bridge.url, ping);
    expect(noAuth.status).toBe(401);
    await noAuth.text();

    const wrong = await rawPost(bridge.url, ping, { authorization: 'Bearer wrong-token' });
    expect(wrong.status).toBe(401);
    await wrong.text();

    // auth is checked before the method: even a GET without a token is a 401
    const get = await fetch(bridge.url);
    expect(get.status).toBe(401);
    await get.text();

    expect(bridge.stats.unauthorizedRequests).toBe(3);

    // the right token is accepted; a non-POST method with a valid token is a 405
    const ok = await rawPost(bridge.url, ping, { authorization: `Bearer ${bridge.token}` });
    expect(ok.status).toBe(200);
    await ok.text();
    const del = await fetch(bridge.url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bridge.token}` },
    });
    expect(del.status).toBe(405);
    await del.text();
    expect(bridge.stats.unauthorizedRequests).toBe(3);

    // exercise the full park/resume path, then check every log line
    const client = await connect(bridge);
    await client.listTools();
    const batches = recordBatches(bridge);
    const pending = client.callTool({ name: 'pi__echo', arguments: { text: 'x' } });
    await waitFor(() => batches.length === 1, 'batch');
    bridge.deliverResults([
      { callId: batches[0][0].callId, content: [{ type: 'text', text: 'ok' }] },
    ]);
    await pending;
    await bridge.close();

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(bridge.token);
    expect(lines.some((l) => l.includes('unauthorized'))).toBe(true);
  });

  it('checks Authorization BEFORE reading the body: an unauthorized oversized body gets 401 without being consumed', async () => {
    const lines: string[] = [];
    const bridge = await makeBridge({}, lines);
    const total = 5 * 1024 * 1024; // over the 4 MiB cap
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const n = Math.min(64 * 1024, total - pulled);
        pulled += n;
        controller.enqueue(new Uint8Array(n));
        if (pulled >= total) controller.close();
      },
    });
    const res = await fetch(bridge.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer wrong-token',
      },
      body,
      duplex: 'half',
    } as unknown as RequestInit);
    expect(res.status).toBe(401); // not 413: the cap is only reached after auth
    await res.text();
    expect(bridge.stats.unauthorizedRequests).toBe(1);
    expect(lines.some((l) => l.includes('"ev":"unauthorized"'))).toBe(true);
    // the server answered before consuming the body (auth checked first):
    // the stream was pulled far less than the full 5 MiB
    expect(pulled).toBeLessThan(total);
  });

  it('answers 413 for an authorized body over 4 MiB without buffering it, and accepts one just under the cap', async () => {
    const lines: string[] = [];
    const bridge = await makeBridge({}, lines);
    const postRaw = (payload: string): Promise<Response> =>
      fetch(bridge.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${bridge.token}`,
        },
        body: payload,
      });

    const oversized = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'pi__echo', arguments: { text: 'x'.repeat(5 * 1024 * 1024) } },
    });
    expect(oversized.length).toBeGreaterThan(MAX_BODY_BYTES);
    const big = await postRaw(oversized);
    expect(big.status).toBe(413);
    await big.text();
    expect(lines.some((l) => l.includes('"ev":"body_too_large"'))).toBe(true);

    // just under the cap reaches the MCP layer: the call parks and the
    // pre-timeout (1 s in makeBridge) answers it, so the request completes
    const under = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'pi__echo', arguments: { text: 'x'.repeat(MAX_BODY_BYTES - 8192) } },
    });
    expect(under.length).toBeLessThan(MAX_BODY_BYTES);
    const res = await postRaw(under);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('did not finish within'); // pre-timeout answered the parked call
  }, 15_000);

  it('lists the current Pi tools as pi__<name> with their JSON schemas and mirrors setTools', async () => {
    const bridge = await makeBridge();
    const client = await connect(bridge);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['pi__echo', 'pi__read']);
    const read = tools.find((t) => t.name === 'pi__read');
    expect(read?.description).toBe('Read a file');
    expect(read?.inputSchema).toEqual(TOOLS[0].parameters);

    bridge.setTools([
      {
        name: 'write',
        description: 'Write a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);
    const { tools: after } = await client.listTools();
    expect(after.map((t) => t.name)).toEqual(['pi__write']);
    expect(after[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
    });
  });

  it('works with a fresh MCP session (new client) per tool call', async () => {
    const bridge = await makeBridge();
    const batches = recordBatches(bridge);
    let expected = 0;
    for (const text of ['a', 'b']) {
      expected += 1;
      const client = await connect(bridge); // fresh session per call, like Vibe
      const pending = client.callTool({ name: 'pi__echo', arguments: { text } });
      await waitFor(() => batches.length === expected, `batch ${expected}`);
      expect(batches[expected - 1]).toHaveLength(1);
      bridge.deliverResults([
        {
          callId: batches[expected - 1][0].callId,
          content: [{ type: 'text', text: `done-${text}` }],
        },
      ]);
      const result = await pending;
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toBe(`done-${text}`);
      await client.close();
    }
  });

  it('parks a tools/call, emits one batch entry, and resumes with text and image content', async () => {
    const bridge = await makeBridge();
    const client = await connect(bridge);
    const batches = recordBatches(bridge);

    const pending = client.callTool({ name: 'pi__read', arguments: { path: '/tmp/x' } });
    await waitFor(() => batches.length === 1, 'batch');
    const call = batches[0][0];
    expect(call.piToolName).toBe('read'); // pi__ prefix stripped
    expect(call.args).toEqual({ path: '/tmp/x' });
    expect(call.callId).toMatch(/^[0-9a-f]{64}$/);

    bridge.deliverResults([
      {
        callId: call.callId,
        content: [
          { type: 'text', text: 'file body' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ],
      },
    ]);
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: 'text', text: 'file body' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);
  });

  it('batches parallel calls within the window into exactly one batch', async () => {
    const bridge = await makeBridge({ batchWindowMs: 120 });
    const client = await connect(bridge);
    const batches = recordBatches(bridge);

    const pendings = ['a', 'b', 'c'].map((text) =>
      client.callTool({ name: 'pi__echo', arguments: { text } })
    );
    await waitFor(() => batches.length === 1, 'batch');
    await sleep(3 * 120); // the quiet window passed: no second batch
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    expect(batches[0].map((c) => (c.args as { text: string }).text).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);

    for (const call of batches[0]) {
      bridge.deliverResults([
        {
          callId: call.callId,
          content: [{ type: 'text', text: `done-${(call.args as { text: string }).text}` }],
        },
      ]);
    }
    const results = await Promise.all(pendings);
    for (const result of results) expect(result.isError).toBeFalsy();
  });

  it('emits two batches when calls are separated by more than the window', async () => {
    const bridge = await makeBridge({ batchWindowMs: 40 });
    const client = await connect(bridge);
    const batches = recordBatches(bridge);

    const first = client.callTool({ name: 'pi__echo', arguments: { text: 'one' } });
    await waitFor(() => batches.length === 1, 'first batch');
    const second = client.callTool({ name: 'pi__echo', arguments: { text: 'two' } });
    await waitFor(() => batches.length === 2, 'second batch');

    expect(batches[0]).toHaveLength(1);
    expect(batches[1]).toHaveLength(1);
    bridge.deliverResults(
      batches.flat().map((c) => ({ callId: c.callId, content: [{ type: 'text', text: 'ok' }] }))
    );
    await Promise.all([first, second]);
  });

  it('answers an unknown tool with an isError result, never a crash', async () => {
    const bridge = await makeBridge();
    const client = await connect(bridge);

    const unknown = await client.callTool({ name: 'pi__nope', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('pi__nope');

    // a name without the pi__ prefix is unknown too (map by MCP request name only)
    const unprefixed = await client.callTool({ name: 'read', arguments: { path: 'x' } });
    expect(unprefixed.isError).toBe(true);

    // a tool removed via setTools is unknown as well
    bridge.setTools([]);
    const removed = await client.callTool({ name: 'pi__echo', arguments: { text: 'x' } });
    expect(removed.isError).toBe(true);

    // the server is still alive and serving afterwards
    bridge.setTools(TOOLS);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(2);
  });

  it('de-dups an identical call while parked: one batch entry, both requests get the same result', async () => {
    const bridge = await makeBridge({ batchWindowMs: 80 });
    const client = await connect(bridge);
    const batches = recordBatches(bridge);

    const args = { text: 'dup' };
    const p1 = client.callTool({ name: 'pi__echo', arguments: args });
    const p2 = client.callTool({ name: 'pi__echo', arguments: args });
    await waitFor(() => batches.length === 1, 'batch');
    await sleep(2 * 80);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);

    bridge.deliverResults([
      { callId: batches[0][0].callId, content: [{ type: 'text', text: 'shared' }] },
    ]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(textOf(r1)).toBe('shared');
    expect(textOf(r2)).toBe('shared');
  });

  it('returns the cached result for a repeat after resolution in the same turn, without a new batch', async () => {
    const bridge = await makeBridge({ batchWindowMs: 40 });
    const client = await connect(bridge);
    const batches = recordBatches(bridge);

    const args = { text: 'once' };
    const pending = client.callTool({ name: 'pi__echo', arguments: args });
    await waitFor(() => batches.length === 1, 'batch');
    bridge.deliverResults([
      { callId: batches[0][0].callId, content: [{ type: 'text', text: 'cached' }] },
    ]);
    const first = await pending;
    expect(textOf(first)).toBe('cached');

    const second = await client.callTool({ name: 'pi__echo', arguments: args });
    expect(textOf(second)).toBe('cached');
    await sleep(3 * 40);
    expect(batches).toHaveLength(1); // the cached repeat emitted no new batch
  });

  it('parks the same call again after newTurn()', async () => {
    const bridge = await makeBridge({ batchWindowMs: 40 });
    const client = await connect(bridge);
    const batches = recordBatches(bridge);

    const args = { text: 'turn' };
    const pending = client.callTool({ name: 'pi__echo', arguments: args });
    await waitFor(() => batches.length === 1, 'first batch');
    bridge.deliverResults([
      { callId: batches[0][0].callId, content: [{ type: 'text', text: 'turn-1' }] },
    ]);
    expect(textOf(await pending)).toBe('turn-1');

    bridge.newTurn();
    const pending2 = client.callTool({ name: 'pi__echo', arguments: args });
    await waitFor(() => batches.length === 2, 'second batch after newTurn');
    expect(batches[1][0].callId).not.toBe(batches[0][0].callId); // per-turn scope in the hash
    bridge.deliverResults([
      { callId: batches[1][0].callId, content: [{ type: 'text', text: 'turn-2' }] },
    ]);
    expect(textOf(await pending2)).toBe('turn-2');
  });

  it('answers a parked call with isError after toolPreTimeoutMs and ignores a late delivery', async () => {
    const lines: string[] = [];
    const bridge = await makeBridge({ toolPreTimeoutMs: 60, batchWindowMs: 30 }, lines);
    const client = await connect(bridge);
    const batches = recordBatches(bridge);

    const pending = client.callTool({ name: 'pi__echo', arguments: { text: 'slow' } });
    await waitFor(() => batches.length === 1, 'batch');
    const result = await pending; // resolved by the pre-emptive timeout, not by Pi
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('did not finish within 60 ms');
    expect(textOf(result)).toContain('60 s');

    // a late deliverResults for the timed-out call is ignored and logged
    bridge.deliverResults([
      { callId: batches[0][0].callId, content: [{ type: 'text', text: 'late' }] },
    ]);
    expect(lines.some((l) => l.includes('delivery_ignored'))).toBe(true);
  });

  it('releaseParked answers all parked calls with isError and drops the unbatched queue', async () => {
    const lines: string[] = [];
    // long batch window: the calls stay queued (not yet batched) when released
    const bridge = await makeBridge({ batchWindowMs: 10_000 }, lines);
    const client = await connect(bridge);
    const batches = recordBatches(bridge);

    const p1 = client.callTool({ name: 'pi__echo', arguments: { text: 'a' } });
    const p2 = client.callTool({ name: 'pi__read', arguments: { path: '/x' } });
    await waitFor(
      () => lines.filter((l) => l.includes('"ev":"parked"')).length === 2,
      'both calls parked'
    );
    await sleep(50); // still inside the window: queued, no batch yet
    expect(batches).toHaveLength(0);

    bridge.releaseParked('turn abandoned (steering/rebuild)');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.isError).toBe(true);
    expect(textOf(r1)).toBe('turn abandoned (steering/rebuild)');
    expect(r2.isError).toBe(true);
    expect(textOf(r2)).toBe('turn abandoned (steering/rebuild)');
    await sleep(50);
    expect(batches).toHaveLength(0); // released calls are not batched afterwards
    expect(lines.filter((l) => l.includes('released_parked')).length).toBe(2);

    // a late delivery for a released call is ignored + logged
    bridge.deliverResults([{ callId: 'unknown', content: [{ type: 'text', text: 'late' }] }]);
    expect(lines.some((l) => l.includes('delivery_ignored'))).toBe(true);
  });

  it('close() answers parked calls with an error result and frees the port', async () => {
    const bridge = await makeBridge();
    const client = await connect(bridge);
    const batches = recordBatches(bridge);

    const pending = client.callTool({ name: 'pi__echo', arguments: { text: 'parked' } });
    await waitFor(() => batches.length === 1, 'batch');
    await bridge.close();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('closed');

    // the port is freed: new connections are refused
    await expect(
      rawPost(
        bridge.url,
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { authorization: `Bearer ${bridge.token}` }
      )
    ).rejects.toThrow();
  });
});
