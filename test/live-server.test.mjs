import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.mjs';
import { MENU_TTL_MS } from '../src/live.mjs';
import { fixtureMcp } from './fixtures/live.mjs';

async function app(context, options = {}) {
  const mcp = options.mcpClient ?? fixtureMcp();
  const server = createApp({ ...options, mcpClient: mcp });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(`${origin}/api/session`)).json();
  const post = async (path, body, headers = {}) => {
    const result = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: result.status, body: await result.json() };
  };
  return { post, origin, mcp };
}

async function setup(post) {
  const search = await post('/api/live/stores', { city: '上海', keyword: '人民广场' });
  assert.equal(search.status, 200);
  const menu = await post('/api/live/menu', { searchId: search.body.searchId, storeCode: 'fixture-store' });
  assert.equal(menu.status, 200);
  const detail = await post('/api/live/detail', { menuId: menu.body.menuId, code: 'drink' });
  assert.equal(detail.status, 200);
  return { search: search.body, menu: menu.body, detail: detail.body };
}

test('HTTP live endpoints inherit CSRF and same-origin enforcement without touching MCP', async context => {
  const { post, mcp } = await app(context);
  for (const route of ['stores', 'menu', 'detail', 'quote']) {
    const invalid = await post(`/api/live/${route}`, {}, { 'X-CSRF-Token': 'wrong' });
    assert.equal(invalid.status, 403); assert.equal(invalid.body.error.code, 'CSRF');
    assert.equal((await post(`/api/live/${route}`, {}, { Origin: 'https://evil.example' })).status, 403);
  }
  assert.equal(mcp.calls.length, 0);
});

test('HTTP live assets and health advertise capabilities without marking demo results as real', async context => {
  const { origin, mcp } = await app(context, { token: 'fixture-token-not-a-real-secret' });
  const health = await (await fetch(`${origin}/api/health`)).json();
  assert.equal(health.liveBudget, true); assert.equal(health.mode, 'demo');
  for (const name of ['live.js', 'live.css']) {
    const result = await fetch(`${origin}/${name}`);
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.ok(!(await result.text()).includes('fixture-token-not-a-real-secret'));
  }
  assert.equal(mcp.calls.length, 0);
});

test('HTTP live search/menu/detail/quote closes the typed read-only flow and omits raw metadata', async context => {
  const { post, mcp } = await app(context);
  const { menu, detail } = await setup(post);
  assert.equal(detail.rounds[0].defaultCode, 'small');
  const quote = await post('/api/live/quote', { menuId: menu.menuId, budget: '9.50', people: 1,
    items: [{ code: 'drink', quantity: 1, choices: [{ round: '1', code: 'small' }] }] });
  assert.equal(quote.status, 200); assert.equal(quote.body.payableCents, 950); assert.equal(quote.body.withinBudget, true);
  assert.ok(!JSON.stringify(quote.body).includes('traceId') && !JSON.stringify(quote.body).includes('privateAccount'));
  assert.deepEqual(mcp.calls.map(call => call.tool), ['query-nearby-stores', 'query-meals', 'query-meal-detail', 'calculate-price']);
});

test('HTTP live arbitrary tools, guessed identifiers and coupon injection cannot reach calculate-price', async context => {
  const { post, mcp } = await app(context);
  const { menu } = await setup(post);
  const before = mcp.calls.length;
  assert.equal((await post('/api/live/create-order', {})).status, 404);
  const injected = await post('/api/live/quote', { menuId: menu.menuId, budget: '25', people: 1, items: [], couponId: 'injected' });
  assert.equal(injected.status, 400); assert.equal(injected.body.error.code, 'INVALID_LIVE_INPUT');
  const guessed = await post('/api/live/detail', { menuId: menu.menuId, code: 'not-returned' });
  assert.equal(guessed.status, 400); assert.equal(guessed.body.error.code, 'INVALID_PRODUCT');
  assert.equal(mcp.calls.length, before);
});

test('HTTP live stale snapshots fail explicitly and do not initiate hidden refreshes', async context => {
  let now = Date.now();
  const { post, mcp } = await app(context, { clock: () => now, mcpClient: fixtureMcp({ clock: () => now }) });
  const { menu } = await setup(post);
  now += MENU_TTL_MS;
  const before = mcp.calls.length;
  const result = await post('/api/live/quote', { menuId: menu.menuId, budget: '25', people: 1, items: [] });
  assert.equal(result.status, 409); assert.equal(result.body.error.code, 'LIVE_SNAPSHOT_EXPIRED');
  assert.equal(mcp.calls.length, before);
});

test('HTTP live business errors stay errors rather than successful zero or demo prices', async context => {
  const mcp = fixtureMcp({ transform: result => {
    if (result.tool === 'calculate-price') result.result.structuredContent = { success: false, code: 500, data: {} };
    return result;
  } });
  const { post } = await app(context, { mcpClient: mcp });
  const { menu } = await setup(post);
  const result = await post('/api/live/quote', { menuId: menu.menuId, budget: '25', people: 1,
    items: [{ code: 'drink', quantity: 1, choices: [{ round: '1', code: 'small' }] }] });
  assert.equal(result.status, 502); assert.equal(result.body.error.code, 'MCP_BUSINESS_ERROR');
  assert.equal(result.body.payableCents, undefined);
});

test('HTTP live and raw MCP routes share the same rate limit; demo remains independent', async context => {
  const { post } = await app(context);
  for (let index = 0; index < 30; index++) assert.equal((await post('/api/live/stores', { city: '上海', keyword: '人民广场' })).status, 200);
  const limited = await post('/api/mcp/tools', {});
  assert.equal(limited.status, 429); assert.equal(limited.body.error.code, 'LOCAL_RATE_LIMIT');
  assert.equal((await post('/api/demo/plan', { budget: '25' })).status, 200);
});

test('HTTP live shares the two-request concurrency cap and frees slots after completion', async context => {
  let release;
  const gate = new Promise(resolveGate => { release = resolveGate; });
  context.after(() => release());
  const mcp = fixtureMcp({ transform: async result => { await gate; return result; } });
  const { post } = await app(context, { mcpClient: mcp });
  const first = post('/api/live/stores', { city: '上海', keyword: '人民广场' });
  const second = post('/api/live/stores', { city: '上海', keyword: '人民广场' });
  for (let attempt = 0; attempt < 100 && mcp.calls.length < 2; attempt++) await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
  const third = await post('/api/mcp/tools', {});
  assert.equal(third.status, 429); assert.equal(third.body.error.code, 'MCP_BUSY');
  release();
  assert.deepEqual((await Promise.all([first, second])).map(result => result.status), [200, 200]);
  assert.equal((await post('/api/live/stores', { city: '上海', keyword: '人民广场' })).status, 200);
});
