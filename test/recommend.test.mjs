import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.mjs';
import { LiveBudgetService, MENU_TTL_MS, QUOTE_TTL_MS, normalizeDetail } from '../src/live.mjs';
import { RecommendationService, referenceAmount, foodKind, mealVariants, normalizeStoreCoupons } from '../src/recommend.mjs';
import { recommendationMcp, recommendationDetails, recommendationCoupons, FIXTURE_TIME } from './fixtures/recommend.mjs';

const hasCode = code => failure => failure.code === code;
const quotes = result => [...result.plans, ...result.overBudget];
async function ready(options = {}) {
  const clock = options.clock ?? (() => FIXTURE_TIME);
  const mcp = recommendationMcp({ ...options, clock });
  const live = new LiveBudgetService({ mcp, clock });
  const search = await live.stores({ city: '上海', keyword: '人民广场' });
  const menu = await live.menu({ searchId: search.searchId, storeCode: 'fixture-store' });
  const service = new RecommendationService({ live, mcp, clock });
  return { live, mcp, service, args: { menuId: menu.menuId, budget: '25', people: 1, wantDrink: true, mainKind: 'any', useCoupons: true } };
}

test('recommendation reference strings are only bounded signed priorities, not invented prices', () => {
  for (const [input, expected] of [['14.9起', 1490], ['+ ¥0.5', 50], ['- ￥1', -100], ['0', 0]]) assert.equal(referenceAmount(input), expected);
  for (const value of [null, 12, '免费', '99折', '0.001', '999999999999999999999999', '1e9', 'NaN']) assert.equal(referenceAmount(value), null);
});

test('recommendation classification rejects merchandise and never infers hidden bundle contents', () => {
  assert.equal(foodKind('麦满分'), 'main'); assert.equal(foodKind('麦咖啡美式中杯'), 'drink');
  assert.equal(foodKind('可乐杯套'), 'other'); assert.equal(foodKind('麦香鸡双人餐'), 'other');
  assert.deepEqual(mealVariants({ supported: true, rounds: [], name: '麦香鸡套餐' }, [], 'any'), []);
});

test('recommendation variants respect real rounds, preference, availability and a main-plus-drink constraint', () => {
  const detail = normalizeDetail(recommendationDetails.bundle, 'bundle');
  const variants = mealVariants(detail, [], 'fish');
  const complete = variants.filter(variant => variant.components.some(item => item.kind === 'main') && variant.components.some(item => item.kind === 'drink'));
  assert.ok(complete.length > 0);
  for (const variant of complete) {
    assert.equal(variant.item.choices.length, 2);
    assert.equal(variant.item.choices[0].code, 'fish');
    assert.ok(['cola', 'tea'].includes(variant.item.choices[1].code));
  }
  for (const selected of detail.rounds[0].choices) selected.available = false;
  assert.deepEqual(mealVariants(detail, [], 'any'), []);
});

test('store coupons require explicit private identifiers, exact string codes and valid Beijing dates', () => {
  const valid = recommendationCoupons[0];
  const data = [valid, valid, { ...valid, couponId: 'expired', tradeDateTime: '2026-10-01 00:00:00-2026-10-12 23:59:59' },
    { ...valid, couponId: 'future', tradeDateTime: '2026-10-14 00:00:00-2026-11-01 23:59:59' },
    { ...valid, couponId: 'invalid', tradeDateTime: '2026-02-31 00:00:00-2026-11-01 23:59:59' },
    { ...valid, couponId: 'unknown', tradeDateTime: '长期' }, { ...valid, couponId: 'wrong-product', products: [{ productCode: 123, productName: 'fake' }] }];
  const result = normalizeStoreCoupons(data, FIXTURE_TIME);
  assert.equal(result.ignored, 2);
  assert.deepEqual(result.coupons.map(coupon => coupon.status), ['not-checked', 'outside-validity', 'outside-validity', 'unknown-validity', 'unknown-validity']);
  const endpoint = normalizeStoreCoupons([valid], Date.parse('2026-11-01T23:59:59+08:00'));
  assert.equal(endpoint.coupons[0].available, false);
  assert.throws(() => normalizeStoreCoupons({}, FIXTURE_TIME), hasCode('COUPON_SHAPE'));
});

test('automatic recommendations sort by actual official totals, not reversed menu reference prices', async () => {
  const { service, args, mcp } = await ready();
  const result = await service.recommend(args);
  assert.equal(result.source, 'mcp'); assert.equal(result.readOnly, true);
  assert.equal(result.plans[0].payableCents, 1400);
  assert.equal(result.plans[0].lines[0].code, 'bundle');
  assert.ok(result.plans.length <= 5 && result.overBudget.length <= 2);
  assert.deepEqual(result.plans.map(quote => quote.payableCents), result.plans.map(quote => quote.payableCents).sort((left, right) => left - right));
  for (const quote of result.plans) assert.ok(quote.payableCents <= 2500);
  for (const quote of result.overBudget) assert.ok(quote.payableCents > 2500);
  for (const quote of quotes(result)) assert.ok(quote.lines.flatMap(line => line.options).every(option => !/薯条|冰淇淋/.test(option.name)));
  assert.ok(mcp.calls.length - 2 <= 28 && result.coverage.details <= 12);
  assert.ok(result.note.includes('不是实付'));
});

test('coupons attach only to their exact product and compare identical baskets without leaking secrets', async () => {
  const { service, args, mcp } = await ready();
  const result = await service.recommend(args);
  const chicken = result.coupons.offers.find(offer => offer.title.includes('鸡堡'));
  assert.equal(chicken.status, 'quoted'); assert.equal(chicken.lowestMealCents, 1950);
  assert.deepEqual(chicken.couponComparison, { withoutCouponCents: 2450, savingCents: 500 });
  assert.equal(chicken.comparisonToCheapestCents, 550);
  for (const call of mcp.calls.filter(call => call.tool === 'calculate-price')) {
    assert.equal(call.args.couponId, undefined);
    const couponItems = call.args.items.filter(item => item.couponId);
    assert.ok(couponItems.length <= 1);
    for (const item of couponItems) {
      assert.equal(item.quantity, 1);
      const coupon = recommendationCoupons.find(value => value.couponId === item.couponId);
      assert.equal(coupon.couponCode, item.couponCode);
      assert.ok(coupon.products.some(product => product.productCode === item.productCode));
    }
  }
  assert.ok(!/fixture-private|couponId|couponCode|traceId|promotionId/.test(JSON.stringify(result)));
  assert.ok(!mcp.calls.some(call => ['query-my-coupons', 'create-order', 'receive-coupon'].includes(call.tool)));
});

test('coupon-only products use returned codes, reject empty zero-price baselines and do not fabricate extra savings', async () => {
  const { service, args, live, mcp } = await ready();
  const result = await service.recommend({ ...args, budget: '50' });
  const coffee = result.coupons.offers.find(offer => offer.title.includes('美式'));
  assert.equal(coffee.lowestMealCents, 3030); assert.equal(coffee.couponComparison, null);
  assert.ok(result.warnings.some(warning => warning.includes('零价')));
  assert.ok(quotes(result).every(quote => quote.payableCents > 0));
  assert.ok(mcp.calls.some(call => call.tool === 'query-meal-detail' && call.args.code === 'coupon-coffee'));
  assert.equal(live.menus.get(args.menuId).details.has('coupon-coffee'), false);
  await assert.rejects(live.detail({ menuId: args.menuId, code: 'coupon-coffee' }), hasCode('INVALID_PRODUCT'));
});

test('a coupon with a worse or equal total never replaces the cheaper no-coupon version', async () => {
  for (const extra of [0, 200]) {
    const { service, args } = await ready({ unitPrice: (item, base) => item.couponId ? base + extra : base });
    const result = await service.recommend({ ...args, budget: '50' });
    const chicken = result.coupons.offers.find(offer => offer.title.includes('鸡堡'));
    assert.equal(chicken.couponComparison.savingCents, -extra || 0);
    assert.ok(!quotes(result).some(quote => quote.coupon?.title.includes('鸡堡')));
  }
});

test('turning off coupon reference performs no account coupon lookup', async () => {
  const { service, args, mcp } = await ready();
  const result = await service.recommend({ ...args, useCoupons: false });
  assert.equal(result.coupons.status, 'disabled'); assert.deepEqual(result.coupons.offers, []);
  assert.ok(!mcp.calls.some(call => call.tool === 'query-store-coupons'));
  assert.ok(quotes(result).every(quote => !quote.coupon));
});

test('each person receives a whole meal; uncounted coupon assets are never multiplied', async () => {
  const { service, args, mcp } = await ready();
  const result = await service.recommend({ ...args, people: 3 });
  assert.equal(result.request.totalBudgetCents, 7500);
  assert.ok(result.coupons.offers.every(offer => offer.status === 'group-limit'));
  for (const call of mcp.calls.filter(call => call.tool === 'calculate-price')) for (const item of call.args.items) {
    assert.equal(item.quantity, 3); assert.equal(item.couponId, undefined);
    for (const selected of item.roundList ?? []) assert.equal(selected.comboItemList[0].quantity, 1);
  }
});

test('main preference is checked against selected contents, including coupon candidates', async () => {
  const { service, args } = await ready();
  const result = await service.recommend({ ...args, mainKind: 'fish' });
  assert.ok(result.plans.length);
  for (const quote of quotes(result)) {
    const mains = quote.lines.flatMap(line => line.options.length ? line.options.map(option => option.name) : [line.name]).filter(name => foodKind(name) === 'main');
    assert.ok(mains.length && mains.every(name => name.includes('鱼')));
  }
  assert.equal(result.coupons.offers[0].status, 'no-matching-meal');
});

test('not requiring a drink never adds a coffee merely to use its coupon', async () => {
  const { service, args, mcp } = await ready();
  const result = await service.recommend({ ...args, wantDrink: false });
  assert.ok(result.plans.length);
  assert.ok(!mcp.calls.filter(call => call.tool === 'calculate-price').some(call => call.args.items.some(item => item.productCode === 'coupon-coffee')));
  assert.equal(result.coupons.offers.find(offer => offer.title.includes('美式')).status, 'no-matching-meal');
});

test('budget failure is explicit, keeps the requested budget and separates over-budget references', async () => {
  const { service, args } = await ready();
  const result = await service.recommend({ ...args, budget: '1' });
  assert.deepEqual(result.plans, []); assert.equal(result.minimumVerifiedCents, 1400);
  assert.equal(result.request.budgetCents, 100); assert.ok(result.overBudget.length > 0);
});

test('coupon-query errors are not an empty wallet and raw server error text stays private', async () => {
  const { service, args } = await ready({ transform: result => {
    if (result.tool === 'query-store-coupons') throw new AppError('MCP_TOOL_ERROR', 'fixture-private-error');
    return result;
  } });
  const result = await service.recommend(args);
  assert.equal(result.coupons.status, 'failed'); assert.ok(result.plans.length);
  assert.ok(result.warnings.some(warning => warning.includes('不等于没有')));
  assert.ok(!JSON.stringify(result).includes('fixture-private'));
});

test('expired and unknown-validity coupons are reference-only, never applied in pricing', async () => {
  const coupons = recommendationCoupons.map((coupon, index) => ({ ...coupon, tradeDateTime: index ? '未知有效期' : '2026-10-01 00:00:00-2026-10-12 23:59:59' }));
  const { service, args, mcp } = await ready({ coupons });
  const result = await service.recommend(args);
  assert.ok(result.coupons.offers.every(offer => offer.lowestMealCents === null));
  assert.ok(mcp.calls.filter(call => call.tool === 'calculate-price').every(call => call.args.items.every(item => !item.couponId)));
});

test('rate limits stop fan-out and preserve only already verified prices', async () => {
  let count = 0;
  const { service, args } = await ready({ transform: result => {
    if (result.tool === 'calculate-price' && ++count === 3) throw new AppError('MCP_RATE_LIMIT', '限流', 429);
    return result;
  } });
  const result = await service.recommend(args);
  assert.equal(count, 3); assert.ok(result.coverage.successfulQuotes <= 2);
  assert.ok(result.warnings.some(warning => warning.includes('限流')));
});

test('token rejection aborts recommendations rather than masquerading as no coupons', async () => {
  const { service, args } = await ready({ transform: result => {
    if (result.tool === 'query-store-coupons') throw new AppError('TOKEN_REJECTED', '凭证无效', 502);
    return result;
  } });
  await assert.rejects(service.recommend(args), hasCode('TOKEN_REJECTED'));
  assert.equal(service.active, false);
});

test('menu expiration during fan-out rejects all results without silently changing the menu', async () => {
  let now = FIXTURE_TIME;
  const { service, args } = await ready({ clock: () => now, transform: result => {
    if (result.tool === 'query-meal-detail') now += MENU_TTL_MS;
    return result;
  } });
  await assert.rejects(service.recommend(args), hasCode('LIVE_SNAPSHOT_EXPIRED'));
});

test('time budget drops expired quotes instead of allowing stale ranking', async () => {
  let now = FIXTURE_TIME, count = 0;
  const { service, args } = await ready({ clock: () => now, transform: result => {
    if (result.tool === 'calculate-price' && ++count === 2) now += QUOTE_TTL_MS;
    return result;
  } });
  const result = await service.recommend(args);
  assert.equal(count, 2); assert.deepEqual(result.plans, []); assert.equal(result.minimumVerifiedCents, null);
  assert.ok(result.warnings.some(warning => warning.includes('时间')));
});

test('only one recommendation batch runs concurrently and the slot is released', async () => {
  let release, signal;
  const started = new Promise(resolve => { signal = resolve; });
  const { service, args } = await ready({ transform: async result => {
    if (result.tool === 'query-store-coupons') { signal(); await new Promise(resolve => { release = resolve; }); }
    return result;
  } });
  const first = service.recommend(args); await started;
  await assert.rejects(service.recommend(args), hasCode('RECOMMEND_BUSY'));
  release(); await first; assert.equal(service.active, false);
});

test('recommendation input rejects guessed prices, coupon identifiers and invalid constraints before networking', async () => {
  const { service, args, mcp } = await ready();
  const before = mcp.calls.length;
  for (const override of [{ couponCode: 'injected' }, { price: 0 }, { storeCode: 'other' }, { mainKind: 'unknown' },
    { wantDrink: 'true' }, { useCoupons: 1 }, { people: 7 }, { budget: '1e3' }, { menuId: 'guessed' }]) await assert.rejects(service.recommend({ ...args, ...override }));
  assert.equal(mcp.calls.length, before);
});

test('mismatched coupon product details cannot be replaced with a similarly named menu code', async () => {
  const coupons = [{ ...recommendationCoupons[0], products: [{ productCode: 'unreturned-code', productName: '模拟麦香鸡' }] }];
  const { service, args, mcp } = await ready({ coupons });
  const result = await service.recommend(args);
  assert.equal(result.coupons.offers[0].status, 'no-matching-meal');
  assert.ok(mcp.calls.filter(call => call.tool === 'calculate-price').every(call => call.args.items.every(item => !item.couponId)));
});

test('cached recommendation details retain provenance and remain usable by the manual flow', async () => {
  const { service, live, args, mcp } = await ready();
  await service.recommend(args);
  const count = mcp.calls.length;
  const detail = await live.detail({ menuId: args.menuId, code: 'chicken' });
  assert.equal(detail.receivedAt, new Date(FIXTURE_TIME).toISOString()); assert.equal(detail.source, 'mcp');
  assert.equal(mcp.calls.length, count);
});
