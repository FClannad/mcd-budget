import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveBudgetService, MENU_TTL_MS, QUOTE_TTL_MS, businessData, normalizeMenu, normalizeStores, normalizeDetail } from '../src/live.mjs';
import { stores, menu, details, response, fixtureMcp } from './fixtures/live.mjs';

const hasCode = code => failure => failure.code === code;
const single = { code: 'main', quantity: 1, choices: [] };
const drink = { code: 'drink', quantity: 1, choices: [{ round: '1', code: 'small' }] };

async function ready(options = {}) {
  const mcp = fixtureMcp(options);
  const service = new LiveBudgetService({ mcp, clock: options.clock });
  const search = await service.stores({ city: '上海', keyword: '人民广场' });
  const result = await service.menu({ searchId: search.searchId, storeCode: 'fixture-store' });
  await service.detail({ menuId: result.menuId, code: 'main' });
  await service.detail({ menuId: result.menuId, code: 'drink' });
  const args = { menuId: result.menuId, budget: '25', people: 1, items: [single, drink] };
  return { service, mcp, search, menu: result, args };
}

test('live business parser requires provenance, tool identity and explicit business success', () => {
  const valid = response('query-meals', menu);
  assert.deepEqual(businessData(valid, 'query-meals'), menu);
  for (const change of [value => { value.result.structuredContent.success = false; },
    value => { value.result.structuredContent.success = 'true'; },
    value => { value.result.structuredContent.code = '200'; },
    value => { value.result.isError = true; }]) {
    const invalid = structuredClone(valid); change(invalid);
    assert.throws(() => businessData(invalid, 'query-meals'), hasCode('MCP_BUSINESS_ERROR'));
  }
  for (const change of [value => { value.source = 'demo'; }, value => { value.tool = 'wrong'; },
    value => { value.receivedAt = 'yesterday'; }, value => { delete value.result.structuredContent.data; }]) {
    const invalid = structuredClone(valid); change(invalid);
    assert.throws(() => businessData(invalid, 'query-meals'), hasCode('LIVE_SHAPE'));
  }
});

test('live business text fallback accepts one JSON envelope, not ambiguous fragments', () => {
  const result = response('query-meals', menu);
  result.result.content = [{ type: 'text', text: JSON.stringify(result.result.structuredContent) }];
  delete result.result.structuredContent;
  assert.deepEqual(businessData(result, 'query-meals'), menu);
  result.result.content.push({ type: 'text', text: '{}' });
  assert.throws(() => businessData(result, 'query-meals'), hasCode('LIVE_SHAPE'));
  result.result.content = [{ type: 'text', text: 'not JSON' }];
  assert.throws(() => businessData(result, 'query-meals'), hasCode('LIVE_SHAPE'));
});

test('live store projection preserves business/reservation facts and drops coordinates/account fields', () => {
  const result = normalizeStores(stores);
  assert.equal(result[0].open, true);
  assert.equal(result[0].reservationTimeOptions[0].text, stores[0].reservationTimeOptions[0].reservationOptionText);
  assert.equal(result[1].open, false);
  assert.ok(!JSON.stringify(result).includes('privateAccount') && !JSON.stringify(result).includes('latitude'));
  assert.throws(() => normalizeStores([stores[0], stores[0]]), hasCode('LIVE_SHAPE'));
});

test('live menu keys supply product codes while price strings remain references, never integer fen', () => {
  const result = normalizeMenu(menu);
  assert.equal(result[0].code, 'main');
  assert.equal(result[0].priceText, '17');
  assert.deepEqual(result[0].categories, ['鸡肉汉堡 /卷']);
  assert.equal(result.find(item => item.code === 'bundle').priceText, '14起');
  assert.equal(result.find(item => item.code === 'complex').priceText, null);
  assert.throws(() => normalizeMenu({ meals: [], categories: [] }), hasCode('LIVE_SHAPE'));
});

test('live defaults follow positive quantity, not every isDefault flag', () => {
  const result = normalizeDetail(details.drink, 'drink');
  assert.equal(result.rounds[0].defaultCode, 'small');
  assert.equal(result.rounds[0].choices[1].quantity, 0);
  assert.equal(result.rounds[0].choices[0].supportModify, true);
  const ambiguous = structuredClone(details.drink);
  ambiguous.rounds[0].choices[1].quantity = 1;
  assert.equal(normalizeDetail(ambiguous, 'drink').rounds[0].defaultCode, null);
  const none = structuredClone(details.drink);
  none.rounds[0].choices[0].quantity = 0;
  assert.equal(normalizeDetail(none, 'drink').rounds[0].defaultCode, null);
});

test('live detail rejects wrong identities, missing rounds and unsupported multi-select instead of guessing', () => {
  assert.throws(() => normalizeDetail(details.main, 'wrong-store-code'), hasCode('LIVE_SHAPE'));
  assert.throws(() => normalizeDetail({ code: 'main', name: 'test' }, 'main'), hasCode('LIVE_SHAPE'));
  assert.equal(normalizeDetail(details.complex, 'complex').supported, false);
  assert.ok(!Object.hasOwn(normalizeDetail(details.main, 'main'), 'modification'));
});

test('live end-to-end fixture produces official integer-fen totals, not menu estimates', async () => {
  const { service, mcp, args } = await ready();
  const quote = await service.quote(args);
  assert.equal(quote.source, 'mcp'); assert.equal(quote.readOnly, true);
  assert.equal(quote.payableCents, 2650); assert.equal(quote.withinBudget, false); assert.equal(quote.remainingCents, -150);
  assert.ok(!JSON.stringify(quote).includes('private-trace') && !JSON.stringify(quote).includes('privateAccount'));
  assert.equal(Date.parse(quote.expiresAt) - Date.parse(quote.receivedAt) <= QUOTE_TTL_MS + 100, true);
  assert.deepEqual(mcp.calls.at(-1), { tool: 'calculate-price', args: { storeCode: 'fixture-store', orderType: 1, beType: 1,
    items: [{ productCode: 'main', quantity: 1 }, { productCode: 'drink', quantity: 1, roundList: [{ round: '1', comboItemList: [{ code: 'small', quantity: 1 }] }] }] } });
  assert.equal(mcp.calls[0].args.searchType, 2);
  assert.ok(mcp.calls.every(call => !['couponId', 'beCode', 'modification', 'withOrder'].some(key => Object.hasOwn(call.args, key))));
});

test('live budget is inclusive at a one-fen boundary without rounding the requested budget up', async () => {
  const { service, args } = await ready();
  assert.equal((await service.quote({ ...args, budget: '26.50' })).withinBudget, true);
  const over = await service.quote({ ...args, budget: '26.49' });
  assert.equal(over.withinBudget, false); assert.equal(over.remainingCents, -1);
  assert.equal(over.request.totalBudgetCents, 2649);
});

test('live quantity multiplies parent items by people, not each bundle choice twice', async () => {
  const { service, mcp, args } = await ready();
  const quote = await service.quote({ ...args, people: 3, budget: '60', items: [single, { ...drink, quantity: 2, choices: [{ round: '1', code: 'medium' }] }] });
  assert.equal(quote.payableCents, 11100); assert.equal(quote.request.totalBudgetCents, 18000);
  assert.deepEqual(mcp.calls.at(-1).args.items.map(item => item.quantity), [3, 6]);
  assert.equal(mcp.calls.at(-1).args.items[1].roundList[0].comboItemList[0].quantity, 1);
  assert.match(quote.lines[1].options[0].name, /中杯/);
});

test('live details can be cached but each explicit quote calls calculate-price again', async () => {
  const { service, mcp, args } = await ready();
  await service.detail({ menuId: args.menuId, code: 'drink' });
  assert.equal(mcp.calls.filter(call => call.tool === 'query-meal-detail').length, 2);
  await service.quote(args); await service.quote(args);
  assert.equal(mcp.calls.filter(call => call.tool === 'calculate-price').length, 2);
});

test('live snapshots expire at the boundary and never refresh implicitly during a quote', async () => {
  let now = Date.now();
  const { service, mcp, args, search } = await ready({ clock: () => now });
  now += MENU_TTL_MS;
  const before = mcp.calls.length;
  await assert.rejects(service.quote(args), hasCode('LIVE_SNAPSHOT_EXPIRED'));
  await assert.rejects(service.detail({ menuId: args.menuId, code: 'main' }), hasCode('LIVE_SNAPSHOT_EXPIRED'));
  await assert.rejects(service.menu({ searchId: search.searchId, storeCode: 'fixture-store' }), hasCode('LIVE_SNAPSHOT_EXPIRED'));
  assert.equal(mcp.calls.length, before);
});

test('live snapshot storage is bounded and evicted identifiers cannot be reused', async () => {
  const service = new LiveBudgetService({ mcp: fixtureMcp() });
  const first = await service.stores({ city: '上海', keyword: '人民广场' });
  for (let index = 0; index < 32; index++) await service.stores({ city: '上海', keyword: '人民广场' });
  assert.equal(service.searches.size, 32);
  await assert.rejects(service.menu({ searchId: first.searchId, storeCode: 'fixture-store' }), hasCode('LIVE_SNAPSHOT_EXPIRED'));
});

test('live rejects a store not returned by search, closed stores, guessed products and unread details', async () => {
  const { service, mcp, search, args } = await ready();
  const before = mcp.calls.length;
  for (const code of ['guessed-store', 'closed-store']) await assert.rejects(service.menu({ searchId: search.searchId, storeCode: code }), hasCode('INVALID_STORE'));
  await assert.rejects(service.detail({ menuId: args.menuId, code: 'guessed-product' }), hasCode('INVALID_PRODUCT'));
  await assert.rejects(service.quote({ ...args, items: [{ code: 'side', quantity: 1, choices: [] }] }), hasCode('DETAIL_REQUIRED'));
  assert.equal(mcp.calls.length, before);
});

test('live details are scoped to one menu and cannot be borrowed from another snapshot', async () => {
  const { service, search, args } = await ready();
  const another = await service.menu({ searchId: search.searchId, storeCode: 'fixture-store' });
  await assert.rejects(service.quote({ ...args, menuId: another.menuId }), hasCode('DETAIL_REQUIRED'));
});

test('live disallows coupon, customisation, channel and arbitrary request fields before networking', async () => {
  const { service, mcp, args, search } = await ready();
  const before = mcp.calls.length;
  const invalid = [
    () => service.stores({ city: '上海', keyword: '人民广场', searchType: 1 }),
    () => service.menu({ searchId: search.searchId, storeCode: 'fixture-store', beType: 5 }),
    () => service.detail({ menuId: args.menuId, code: 'main', modification: {} }),
    () => service.quote({ ...args, couponId: 'not-authorised' }),
    () => service.quote({ ...args, items: [{ ...single, priceCents: 1 }] }),
    () => service.quote({ ...args, items: [{ ...drink, choices: [{ round: '1', code: 'small', quantity: 100 }] }] }),
  ];
  for (const attempt of invalid) await assert.rejects(attempt(), hasCode('INVALID_LIVE_INPUT'));
  assert.equal(mcp.calls.length, before);
});

test('live rejects unsafe or incomplete baskets and unknown/duplicate/missing options', async () => {
  const { service, mcp, args } = await ready();
  const before = mcp.calls.length;
  for (const items of [[], [single, single], [{ ...single, quantity: 0 }], [{ ...single, quantity: 1.5 }],
    [{ ...single, quantity: '1' }], [{ ...single, quantity: 7 }], [{ ...drink, choices: [] }],
    [{ ...drink, choices: [{ round: '1', code: 'fake-small' }] }],
    [{ ...drink, choices: [{ round: 'wrong-round', code: 'small' }] }]]) {
    await assert.rejects(service.quote({ ...args, items }), failure => ['INVALID_BASKET', 'INVALID_SELECTION'].includes(failure.code));
  }
  for (const patch of [{ budget: '0.99' }, { budget: '500.01' }, { people: 0 }, { people: 7 }, { people: '2' }]) {
    await assert.rejects(service.quote({ ...args, ...patch }), hasCode('INVALID_BUDGET'));
  }
  await assert.rejects(service.quote({ ...args, budget: '25.001' }), hasCode('INVALID_MONEY'));
  assert.equal(mcp.calls.length, before);
});

test('live supports two-round bundles only after actual choices are supplied', async () => {
  const { service, mcp, args } = await ready();
  await service.detail({ menuId: args.menuId, code: 'bundle' });
  const bundle = { code: 'bundle', quantity: 1, choices: [{ round: '1', code: 'main' }, { round: '2', code: 'medium' }] };
  const quote = await service.quote({ ...args, items: [bundle] });
  assert.equal(quote.payableCents, 1450); assert.equal(quote.withinBudget, true);
  assert.equal(quote.lines[0].options.length, 2);
  assert.deepEqual(mcp.calls.at(-1).args.items[0].roundList.map(round => round.round), ['1', '2']);
  await assert.rejects(service.quote({ ...args, items: [{ ...bundle, choices: [{ round: '1', code: 'main' }, { round: '1', code: 'small' }] }] }), hasCode('INVALID_SELECTION'));
  await service.detail({ menuId: args.menuId, code: 'complex' });
  await assert.rejects(service.quote({ ...args, items: [{ code: 'complex', quantity: 1, choices: [] }] }), hasCode('DETAIL_REQUIRED'));
});

for (const [name, modify] of [
  ['missing payable', data => { delete data.price; }],
  ['decimal yuan disguised as fen', data => { data.price = 26.5; }],
  ['string price', data => { data.price = '2650'; }],
  ['negative price', data => { data.price = -1; }],
  ['wrong total discount', data => { data.discount = 1; }],
  ['missing product', data => { data.productList.pop(); }],
  ['substituted code', data => { data.productList[0].productCode = 'another'; }],
  ['changed quantity', data => { data.productList[0].quantity = 2; }],
  ['unreconciled line amount', data => { data.productList[0].subtotal = 1; }],
  ['mismatched original subtotal', data => { data.productOriginalPrice = 9999; }],
  ['unsafe integer', data => { data.price = Number.MAX_SAFE_INTEGER + 1; }],
]) {
  test(`live rejects invalid official quotes: ${name}`, async () => {
    const { service, args } = await ready({ transform: result => {
      if (result.tool === 'calculate-price') modify(result.result.structuredContent.data);
      return result;
    } });
    await assert.rejects(service.quote(args), hasCode('LIVE_SHAPE'));
  });
}

test('live total includes official other fees even when menu/product subtotal fits budget', async () => {
  const { service, args } = await ready({ transform: result => {
    if (result.tool === 'calculate-price') {
      result.result.structuredContent.data.price += 150;
      result.result.structuredContent.data.originalPrice += 150;
    }
    return result;
  } });
  const quote = await service.quote({ ...args, budget: '27' });
  assert.equal(quote.productCents, 2650); assert.equal(quote.payableCents, 2800);
  assert.equal(quote.adjustmentCents, 150); assert.equal(quote.withinBudget, false);
});

test('live reports an order-wide discount without applying demo coupons a second time', async () => {
  const { service, args } = await ready({ transform: result => {
    if (result.tool === 'calculate-price') { result.result.structuredContent.data.price -= 200; result.result.structuredContent.data.discount = 200; }
    return result;
  } });
  const quote = await service.quote(args);
  assert.equal(quote.payableCents, 2450); assert.equal(quote.adjustmentCents, -200); assert.equal(quote.withinBudget, true);
});

test('live business failures never turn an empty response into a free basket', async () => {
  const { service, args } = await ready({ transform: result => {
    if (result.tool === 'calculate-price') result.result.structuredContent = { success: false, code: 409, data: {} };
    return result;
  } });
  await assert.rejects(service.quote(args), hasCode('MCP_BUSINESS_ERROR'));
});
