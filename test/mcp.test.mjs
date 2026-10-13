import test from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, MCP_ENDPOINT, READ_ONLY_TOOLS, redact, validateToolArguments } from '../src/mcp.mjs';
const TOKEN = 'fixture-token-not-a-real-credential';
const schema = { type: 'object', required: ['storeCode'], properties: { storeCode: { type: 'string' }, count: { type: 'integer' }, mode: { enum: ['pickup'] } }, additionalProperties: false };
const toolList = [{ name: 'query-meals', description: 'fixture menu', inputSchema: schema },
  { name: 'calculate-price', inputSchema: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } } },
  { name: 'create-order', inputSchema: { type: 'object' } }];
const reply = (body, result, headers = {}) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
  status: 200, headers: { 'Content-Type': 'application/json', ...headers },
});
function fixture(custom = () => undefined) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, options, body });
    const override = await custom(body, calls, options);
    if (override) return override;
    if (body.method === 'initialize') return reply(body, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '0' } }, { 'Mcp-Session-Id': 'fixture-session' });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return reply(body, { tools: toolList });
    if (body.method === 'tools/call') return reply(body, { content: [{ type: 'text', text: '{"fixture":true}' }], isError: false });
    throw new Error('unexpected fixture method');
  };
  return { client: new McpClient({ token: TOKEN, fetchImpl }), calls };
}
function sseResponse(body, result, { multiline = false, chunkSize = 3 } = {}) {
  const json = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
  const event = multiline ? `data: ${json.slice(0, 17)}\r\ndata: ${json.slice(17)}\r\n\r\n` : `event: message\ndata: ${json}\n\n`;
  const before = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n';
  const bytes = new TextEncoder().encode(`: keepalive\n\n${before}${event}`);
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset + chunkSize)); offset += chunkSize;
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('no Token stops before any networking', async () => {
  let requests = 0;
  const client = new McpClient({ fetchImpl: () => { requests++; } });
  await assert.rejects(client.listTools(), { code: 'TOKEN_MISSING' }); assert.equal(requests, 0);
});
test('template placeholders are not usable credentials', () => {
  assert.equal(new McpClient({ token: '${MCD_MCP_TOKEN}' }).configured, false);
  assert.equal(new McpClient({ token: 'YOUR_MCP_TOKEN' }).configured, false);
});
test('dangerous tools are denied before init, credentials or network', async () => {
  let requests = 0;
  const client = new McpClient({ fetchImpl: () => { requests++; } });
  for (const name of ['create-order', 'auto-bind-coupons', 'draw-lottery', 'mall-create-order', 'delivery-create-address', 'cancel-order']) {
    await assert.rejects(client.callTool(name, {}), { code: 'TOOL_BLOCKED', status: 403 });
  }
  assert.equal(requests, 0); assert.equal(READ_ONLY_TOOLS.length, 6);
});
test('JSON handshake propagates session, version and fixed endpoint', async () => {
  const { client, calls } = fixture();
  const tools = await client.listTools();
  assert.deepEqual(tools.map(t => t.name), ['query-meals', 'calculate-price']);
  assert.deepEqual(calls.map(c => c.body.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.ok(calls.every(c => c.url === MCP_ENDPOINT && c.options.redirect === 'error'));
  assert.ok(calls.every(c => c.options.headers.Authorization === `Bearer ${TOKEN}`));
  assert.equal(calls[1].body.id, undefined);
  assert.equal(calls[2].options.headers['Mcp-Session-Id'], 'fixture-session');
  assert.equal(calls[2].options.headers['MCP-Protocol-Version'], '2025-06-18');
});
test('concurrent callers share initialization and cached tools', async () => {
  const { client, calls } = fixture();
  await Promise.all([client.listTools(), client.listTools(), client.listTools()]);
  assert.equal(calls.filter(c => c.body.method === 'initialize').length, 1);
  assert.equal(calls.filter(c => c.body.method === 'tools/list').length, 1);
});
test('explicit refresh reloads tools without duplicate initialization', async () => {
  const { client, calls } = fixture();
  await client.listTools(); await client.listTools(); await client.listTools({ refresh: true });
  assert.equal(calls.filter(c => c.body.method === 'tools/list').length, 2);
  assert.equal(calls.filter(c => c.body.method === 'initialize').length, 1);
});
test('supported protocol negotiation is reflected on later requests', async () => {
  const { client, calls } = fixture(body => body.method === 'initialize' ? reply(body, { protocolVersion: '2025-03-26' }) : undefined);
  await client.listTools(); assert.equal(calls[2].options.headers['MCP-Protocol-Version'], '2025-03-26');
});
test('unsupported negotiated version fails closed', async () => {
  const { client } = fixture(body => body.method === 'initialize' ? reply(body, { protocolVersion: '1900-01-01' }) : undefined);
  await assert.rejects(client.listTools(), { code: 'MCP_VERSION' });
});
test('SSE handles chunked UTF-8, keepalive and unrelated notifications', async () => {
  const { client } = fixture(body => body.method === 'tools/call' ? sseResponse(body, { content: [{ type: 'text', text: '汉堡🍔的样例' }] }, { chunkSize: 1 }) : undefined);
  const result = await client.callTool('query-meals', { storeCode: 'fixture' });
  assert.equal(result.result.content[0].text, '汉堡🍔的样例'); assert.equal(result.source, 'mcp');
});
test('SSE accepts CRLF and multiline JSON data', async () => {
  const { client } = fixture(body => body.method === 'tools/list' ? sseResponse(body, { tools: toolList }, { multiline: true, chunkSize: 2 }) : undefined);
  assert.equal((await client.listTools()).length, 2);
});
test('paginated schemas are collected and dangerous tools stay hidden', async () => {
  const { client, calls } = fixture(body => {
    if (body.method !== 'tools/list') return;
    return reply(body, body.params.cursor ? { tools: [toolList[1], toolList[2]] } : { tools: [toolList[0]], nextCursor: 'second' });
  });
  assert.equal((await client.listTools()).length, 2);
  assert.equal(calls.filter(c => c.body.method === 'tools/list')[1].body.params.cursor, 'second');
});
test('repeated pagination cursor cannot cause an infinite loop', async () => {
  const { client } = fixture(body => body.method === 'tools/list' ? reply(body, { tools: [], nextCursor: 'again' }) : undefined);
  await assert.rejects(client.listTools(), { code: 'MCP_PAGINATION' });
});
test('more than ten pages is explicitly rejected, not truncated silently', async () => {
  let page = 0;
  const { client } = fixture(body => body.method === 'tools/list' ? reply(body, { tools: [], nextCursor: String(++page) }) : undefined);
  await assert.rejects(client.listTools(), { code: 'MCP_PAGINATION' }); assert.equal(page, 10);
});
test('missing required input never reaches tools/call', async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.callTool('query-meals', {}), { code: 'MISSING_TOOL_ARG' });
  assert.equal(calls.filter(c => c.body.method === 'tools/call').length, 0);
});
test('input shape/type/enum/additional-property checks reject bad arguments', () => {
  for (const args of [[], null, { storeCode: 1 }, { storeCode: 'x', count: 1.5 }, { storeCode: 'x', mode: 'delivery' }, { storeCode: 'x', surprise: true }]) {
    assert.throws(() => validateToolArguments(args, schema));
  }
  assert.doesNotThrow(() => validateToolArguments({ storeCode: 'x', count: 2, mode: 'pickup' }, schema));
});
test('a missing current allowed tool is not called speculatively', async () => {
  const { client } = fixture();
  await assert.rejects(client.callTool('query-nearby-stores', {}), { code: 'TOOL_UNAVAILABLE' });
});
test('valid call preserves raw structured content without treating it as verified price', async () => {
  const { client, calls } = fixture(body => body.method === 'tools/call' ? reply(body, { structuredContent: { fixturePrice: 25, unit: 'unknown' }, isError: false }) : undefined);
  const result = await client.callTool('query-meals', { storeCode: 'fixture' });
  assert.equal(result.result.structuredContent.unit, 'unknown'); assert.match(result.note, /不代表业务必然成功/);
  assert.equal(calls.at(-1).body.params.arguments.storeCode, 'fixture');
  assert.equal(result.payableCents, undefined);
});
test('isError tools are rejected rather than becoming a price', async () => {
  const { client } = fixture(body => body.method === 'tools/call' ? reply(body, { isError: true, content: [{ type: 'text', text: 'failed' }] }) : undefined);
  await assert.rejects(client.callTool('query-meals', { storeCode: 'fixture' }), { code: 'MCP_TOOL_ERROR' });
});
for (const [status, code] of [[401, 'TOKEN_REJECTED'], [403, 'TOKEN_REJECTED'], [429, 'MCP_RATE_LIMIT'], [500, 'MCP_HTTP_ERROR']]) {
  test(`upstream HTTP ${status} is explicit and does not auto-retry`, async () => {
    const { client, calls } = fixture(() => new Response('not-used', { status }));
    await assert.rejects(client.listTools(), { code }); assert.equal(calls.length, 1);
  });
}
test('session expiry clears state and requests a manual reconnect', async () => {
  const { client } = fixture(body => body.method === 'tools/list' ? new Response('', { status: 404 }) : undefined);
  await assert.rejects(client.listTools(), { code: 'MCP_SESSION_EXPIRED' });
  assert.equal(client.sessionId, null); assert.equal(client.initPromise, null);
});
test('network errors do not leak secrets or raw network internals', async () => {
  const client = new McpClient({ token: TOKEN, fetchImpl: async () => { throw new Error(`credentials: ${TOKEN}`); } });
  await assert.rejects(client.listTools(), error => error.code === 'MCP_NETWORK' && !error.message.includes(TOKEN));
});
test('abort is reported as timeout', async () => {
  const client = new McpClient({ token: TOKEN, fetchImpl: async () => { throw new DOMException('timed out', 'TimeoutError'); } });
  await assert.rejects(client.listTools(), { code: 'MCP_TIMEOUT' });
});
test('server-echoed token and Bearer values are redacted', async () => {
  const { client } = fixture(body => body.method === 'tools/call' ? reply(body, { content: [{ type: 'text', text: `${TOKEN} Bearer another-fixture-token` }] }) : undefined);
  const value = JSON.stringify(await client.callTool('query-meals', { storeCode: 'fixture' }));
  assert.ok(!value.includes(TOKEN)); assert.ok(!value.includes('another-fixture-token'));
  assert.deepEqual(redact({ x: TOKEN }, TOKEN), { x: '[REDACTED]' });
});
test('RPC error messages also redact echoed credentials', async () => {
  const { client } = fixture(body => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -1, message: `bad ${TOKEN}` } }), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(client.listTools(), error => error.code === 'MCP_RPC_ERROR' && !error.message.includes(TOKEN));
});
test('wrong JSON-RPC id and malformed JSON fail closed', async () => {
  const first = fixture(body => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id + 5, result: {} }), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(first.client.listTools(), { code: 'MCP_PROTOCOL' });
  const second = fixture(() => new Response('{invalid', { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(second.client.listTools(), { code: 'MCP_PROTOCOL' });
});
test('oversized response is cancelled and rejected', async () => {
  const { client } = fixture(() => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(client.listTools(), { code: 'MCP_RESPONSE_LIMIT' });
});
