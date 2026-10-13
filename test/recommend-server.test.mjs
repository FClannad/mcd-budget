import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.mjs';
import { recommendationMcp, FIXTURE_TIME } from './fixtures/recommend.mjs';

async function app(context, options = {}) {
  let now = FIXTURE_TIME;
  const clock = () => now;
  const mcp = recommendationMcp({ clock, ...options });
  const server = createApp({ mcpClient: mcp, clock });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  context.after(async () => { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { csrfToken } = await (await fetch(`${origin}/api/session`)).json();
  const post = async (path, body, headers = {}) => {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const search = await post('/api/live/stores', { city: '上海', keyword: '人民广场' });
  const menu = await post('/api/live/menu', { searchId: search.body.searchId, storeCode: 'fixture-store' });
  return { post, mcp, origin, advance: delta => { now += delta; }, args: { menuId: menu.body.menuId, budget: '25', people: 1, mainKind: 'any', wantDrink: true, useCoupons: true } };
}

test('HTTP automatic recommendation requires CSRF and same origin before any coupon access', async context => {
  const { post, args, mcp } = await app(context);
  const count = mcp.calls.length;
  for (const headers of [{ 'X-CSRF-Token': 'wrong' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await post('/api/live/recommend', args, headers)).status, 403);
  }
  assert.equal(mcp.calls.length, count);
});

test('HTTP recommendation returns price-ranked actual fixtures and only a public coupon projection', async context => {
  const { post, args, origin } = await app(context);
  assert.equal((await (await fetch(`${origin}/api/health`)).json()).liveRecommendations, true);
  const result = await post('/api/live/recommend', args);
  assert.equal(result.status, 200); assert.equal(result.body.plans[0].payableCents, 1400);
  assert.ok(result.body.coupons.offers.some(offer => offer.comparisonToCheapestCents > 0));
  assert.ok(!/fixture-private|couponCode|couponId|traceId/.test(JSON.stringify(result.body)));
});

test('HTTP recommendation rejects price, coupon and channel injection before fan-out', async context => {
  const { post, args, mcp } = await app(context);
  const before = mcp.calls.length;
  for (const override of [{ couponId: 'injected' }, { items: [] }, { price: 0 }, { beType: 2 }, { people: 7 }, { menuId: 'guessed' }]) {
    const result = await post('/api/live/recommend', { ...args, ...override });
    assert.ok(result.status === 400 || result.status === 409);
  }
  assert.equal(mcp.calls.length, before);
});

test('HTTP batching cannot bypass the shared upstream-call limit, which resets after a minute', async context => {
  const { post, args, mcp, advance } = await app(context);
  assert.equal((await post('/api/live/recommend', args)).status, 200);
  const partial = await post('/api/live/recommend', args);
  assert.equal(partial.status, 200); assert.ok(partial.body.warnings.some(warning => warning.includes('限流')));
  assert.equal(mcp.calls.length, 30);
  const raw = await post('/api/mcp/tools', {});
  assert.equal(raw.status, 429); assert.equal(raw.body.error.code, 'LOCAL_UPSTREAM_LIMIT');
  assert.equal((await post('/api/demo/plan', { budget: '25' })).status, 200);
  assert.equal(mcp.calls.length, 30);
  advance(61000);
  assert.equal((await post('/api/mcp/tools', {})).status, 200);
  assert.equal(mcp.calls.length, 31);
});

test('HTTP permits only one automatic batch while keeping its completion slot releasable', async context => {
  let release, signal;
  const entered = new Promise(resolve => { signal = resolve; });
  const { post, args } = await app(context, { transform: async result => {
    if (result.tool === 'query-store-coupons') { signal(); await new Promise(resolve => { release = resolve; }); }
    return result;
  } });
  const pending = post('/api/live/recommend', args); await entered;
  try {
    const busy = await post('/api/live/recommend', args);
    assert.equal(busy.status, 429); assert.equal(busy.body.error.code, 'RECOMMEND_BUSY');
  } finally { release(); }
  assert.equal((await pending).status, 200);
});

test('HTTP rejects expired recommendation snapshots without refreshing or reading coupons', async context => {
  const { post, args, advance, mcp } = await app(context);
  advance(300000);
  const count = mcp.calls.length;
  const result = await post('/api/live/recommend', args);
  assert.equal(result.status, 409); assert.equal(result.body.error.code, 'LIVE_SNAPSHOT_EXPIRED');
  assert.equal(mcp.calls.length, count);
});
