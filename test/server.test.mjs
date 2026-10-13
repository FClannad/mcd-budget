import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../src/server.mjs';
import { McpClient, READ_ONLY_TOOLS } from '../src/mcp.mjs';
import { AppError } from '../src/errors.mjs';

async function app(t, options = {}) {
  const server = createApp(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const request = (path, { method = 'GET', headers = {}, body, raw, chunks } = {}) => new Promise((resolve, reject) => {
    const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, agent: false,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* Static assets and HEAD are not JSON. */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTP fixture timed out')));
    req.on('error', reject);
    for (const chunk of chunks ?? []) req.write(chunk);
    req.end(data);
  });
  const session = await request('/api/session');
  assert.equal(session.status, 200);
  const post = (path, body, headers = {}) => request(path, { method: 'POST', body,
    headers: { 'X-CSRF-Token': session.json.csrfToken, ...headers } });
  return { server, port, request, post, csrf: session.json.csrfToken };
}

function errorIs(response, status, code) {
  assert.equal(response.status, status, response.text);
  assert.equal(response.json?.error?.code, code);
}

const dangerous = ['create-order', 'submit-order', 'pay-order', 'auto-bind-coupons', 'bind-coupon',
  'lottery', 'redeem-points', 'query-my-account', '__proto__'];

test('HTTP health is explicit demo metadata and never exposes credentials', async t => {
  const token = 'http-fixture-not-a-real-token';
  const { request, csrf } = await app(t, { token });
  const response = await request('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.json.mode, 'demo');
  assert.equal(response.json.mcpConfigured, true);
  assert.deepEqual(response.json.readOnlyTools, READ_ONLY_TOOLS);
  assert.ok(!response.text.includes(token) && !response.text.includes(csrf));
  assert.match(csrf, /^[0-9a-f]{64}$/);
});

test('HTTP assets have security headers, correct MIME, and HEAD does not send a body', async t => {
  const { request } = await app(t);
  for (const path of ['/', '/index.html', '/styles.css', '/app.js', '/assets/hero.svg', '/assets/food.svg', '/assets/icon.svg']) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
    assert.match(response.headers['content-security-policy'], /connect-src 'self'/);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.ok(!response.headers['access-control-allow-origin']);
    assert.ok(response.text.length > 0);
    const head = await request(path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(head.headers['content-length'], response.headers['content-length']);
  }
  assert.match((await request('/app.js')).headers['content-type'], /javascript/);
});

test('HTTP private files, traversal and unknown methods are never served', async t => {
  const { request } = await app(t);
  for (const path of ['/.env', '/.env.example', '/src/config.mjs', '/package.json', '/.git/config',
    '/.local/private.json', '/../.env', '/%2e%2e/.env', '/assets/../../.env', '/assets/%2e%2e/%2e%2e/.env', '/%2e%2e%5c.env']) {
    errorIs(await request(path), 404, 'NOT_FOUND');
  }
  for (const method of ['PUT', 'DELETE', 'OPTIONS']) errorIs(await request('/api/demo/plan', { method }), 404, 'NOT_FOUND');
});

test('HTTP Host and Origin checks reject DNS rebinding and cross-site requests', async t => {
  const { request, port } = await app(t);
  for (const host of ['evil.test', `evil.test:${port}`, '127.0.0.1:1', `127.0.0.1:${port}.evil.test`]) {
    errorIs(await request('/api/session', { headers: { Host: host } }), 403, 'BAD_HOST');
  }
  for (const origin of ['https://evil.test', 'null', `http://localhost:${port}`, `http://127.0.0.1:${port + 1}`]) {
    errorIs(await request('/api/session', { headers: { Origin: origin } }), 403, 'BAD_ORIGIN');
  }
  errorIs(await request('/api/session', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'BAD_ORIGIN');
  assert.equal((await request('/api/session', { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await request('/api/session', { headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` } })).status, 200);
});

test('HTTP POST requires the current server CSRF token', async t => {
  const first = await app(t), second = await app(t);
  for (const token of ['', 'a', '0'.repeat(64), second.csrf]) {
    errorIs(await first.request('/api/demo/plan', { method: 'POST', body: {}, headers: { 'X-CSRF-Token': token } }), 403, 'CSRF');
  }
  errorIs(await first.request('/api/mcp/tools', { method: 'POST', body: {} }), 403, 'CSRF');
  assert.equal((await first.post('/api/demo/plan', {})).status, 200);
});

test('HTTP planner returns verifiable demo prices and refuses live/invalid conditions', async t => {
  const { request, post } = await app(t);
  assert.equal((await request('/api/demo/catalogue')).json.source, 'demo');
  const result = await post('/api/demo/plan', { budget: 25 });
  assert.equal(result.status, 200);
  assert.equal(result.json.source, 'demo');
  assert.deepEqual(result.json.plans.map(plan => plan.payableCents), [2200, 2400, 2500]);
  const noPlan = await post('/api/demo/plan', { budget: 10 });
  assert.equal(noPlan.json.plans.length, 0);
  assert.equal(noPlan.json.request.totalBudgetCents, 1000);
  assert.equal(noPlan.json.shortfallCents, 1200);
  for (const input of [null, [], { budget: 'NaN' }, { people: 7 }, { mode: 'live' }, { storeCode: 'guessed' }]) {
    assert.equal((await post('/api/demo/plan', input)).status, 400);
  }
});

test('HTTP JSON parsing rejects invalid content types and malformed bodies', async t => {
  const { request, csrf } = await app(t);
  const send = (raw, type) => request('/api/demo/plan', { method: 'POST', raw,
    headers: { 'X-CSRF-Token': csrf, ...(type ? { 'Content-Type': type } : {}) } });
  errorIs(await send('{}'), 415, 'CONTENT_TYPE');
  errorIs(await send('{}', 'text/plain'), 415, 'CONTENT_TYPE');
  errorIs(await send('{broken', 'application/json'), 400, 'INVALID_JSON');
  errorIs(await send('', 'application/json'), 400, 'INVALID_JSON');
  assert.equal((await send('{}', 'application/json; charset=utf-8')).status, 200);
});

test('HTTP rejects oversized fixed-length and chunked JSON without hanging', async t => {
  const { request, csrf } = await app(t);
  const raw = JSON.stringify({ padding: 'x'.repeat(65536) });
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
  errorIs(await request('/api/demo/plan', { method: 'POST', raw,
    headers: { ...headers, 'Content-Length': Buffer.byteLength(raw) } }), 413, 'BODY_TOO_LARGE');
  errorIs(await request('/api/demo/plan', { method: 'POST', chunks: [raw.slice(0, 33000), raw.slice(33000)], headers }), 413, 'BODY_TOO_LARGE');
});

test('HTTP no-Token MCP failures stay failures; demo data is never substituted', async t => {
  const { post } = await app(t);
  errorIs(await post('/api/mcp/tools', {}), 503, 'TOKEN_MISSING');
  const result = await post('/api/mcp/call', { name: 'query-meals', arguments: {} });
  errorIs(result, 503, 'TOKEN_MISSING');
  assert.ok(!result.text.includes('demo-chicken'));
  for (const input of [null, [], 'bad']) errorIs(await post('/api/mcp/tools', input), 400, 'INVALID_REQUEST');
});

test('HTTP dangerous MCP tools are blocked before credentials or network calls', async t => {
  let calls = 0;
  const mcpClient = new McpClient({ token: 'mock-http-only', fetchImpl: async () => { calls++; throw new Error('No network allowed'); } });
  const { post } = await app(t, { mcpClient });
  for (const name of dangerous) errorIs(await post('/api/mcp/call', { name, arguments: {} }), 403, 'TOOL_BLOCKED');
  assert.equal(calls, 0);
});

test('HTTP preserves raw mock MCP responses and redacts echoed Token values', async t => {
  const token = 'mock-http-credential-not-real';
  const invoked = [];
  const mcpClient = new McpClient({ token, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); invoked.push(body.method);
    if (!body.id) return new Response(null, { status: 202 });
    const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'http-mock', version: '0' } } :
      body.method === 'tools/list' ? { tools: [{ name: 'calculate-price', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { name: 'create-order', inputSchema: { type: 'object' } }] } :
        { isError: false, structuredContent: { success: false, explanation: 'business not verified', echoed: token }, content: [] };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  } });
  const { post } = await app(t, { token, mcpClient });
  const tools = await post('/api/mcp/tools', {});
  assert.deepEqual(tools.json.tools.map(tool => tool.name), ['calculate-price']);
  const response = await post('/api/mcp/call', { name: 'calculate-price', arguments: {} });
  assert.equal(response.status, 200);
  assert.equal(response.json.source, 'mcp');
  assert.equal(response.json.result.structuredContent.success, false);
  assert.equal(response.json.result.structuredContent.echoed, '[REDACTED]');
  assert.ok(!response.text.includes(token));
  assert.ok(!Object.hasOwn(response.json, 'payableCents'));
  assert.equal(invoked.filter(method => method === 'tools/call').length, 1);
});

test('HTTP error responses do not expose internal stacks or echoed credentials', async t => {
  const token = 'error-fixture-secret';
  let expected = true;
  const mcpClient = { configured: true, async listTools() {
    if (expected) throw new AppError('MOCK_UPSTREAM', `rejected ${token}`, 502);
    throw new Error(`private internals ${token}`);
  } };
  const { post } = await app(t, { token, mcpClient });
  const known = await post('/api/mcp/tools', {});
  errorIs(known, 502, 'MOCK_UPSTREAM');
  assert.ok(!known.text.includes(token));
  expected = false;
  const unknown = await post('/api/mcp/tools', {});
  errorIs(unknown, 500, 'INTERNAL_ERROR');
  assert.ok(!unknown.text.includes(token) && !unknown.text.includes('private internals') && !unknown.text.includes('stack'));
});

test('HTTP MCP request throttling does not disable offline planning', async t => {
  let count = 0;
  const { post } = await app(t, { mcpClient: { configured: true, async listTools() { count++; return []; } } });
  for (let i = 0; i < 30; i++) assert.equal((await post('/api/mcp/tools', {})).status, 200);
  errorIs(await post('/api/mcp/tools', {}), 429, 'LOCAL_RATE_LIMIT');
  assert.equal(count, 30);
  assert.equal((await post('/api/demo/plan', { budget: 25 })).status, 200);
});

test('HTTP allows at most two MCP requests in flight and releases slots afterwards', async t => {
  let release, bothStarted, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { bothStarted = resolve; });
  const { post } = await app(t, { mcpClient: { configured: true, async listTools() {
    if (++calls === 2) bothStarted();
    await gate; return [];
  } } });
  const pending = [post('/api/mcp/tools', {}), post('/api/mcp/tools', {})];
  const timer = setTimeout(() => { release(); bothStarted(); }, 3000);
  try {
    await started;
    assert.equal(calls, 2);
    errorIs(await post('/api/mcp/tools', {}), 429, 'MCP_BUSY');
  } finally { clearTimeout(timer); release(); }
  assert.ok((await Promise.all(pending)).every(response => response.status === 200));
  assert.equal((await post('/api/mcp/tools', {})).status, 200);
});