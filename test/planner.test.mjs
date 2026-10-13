import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { yuanToCents, formatMoney } from '../src/money.mjs';
import { validateRequest, planMeals, quoteBasket, compareTopUp } from '../src/planner.mjs';
import { loadConfig, ROOT } from '../src/config.mjs';
const demo = JSON.parse(readFileSync(new URL('../data/demo.json', import.meta.url), 'utf8'));
const context = { storeId: 'demo-corner', orderType: 'pickup' };
const lines = [{ id: 'x', priceCents: 3000, quantity: 1 }];
const fresh = () => structuredClone(demo);

test('integer fen handles decimal amounts without float arithmetic', () => {
  assert.equal(yuanToCents('0.29'), 29);
  assert.equal(yuanToCents(25), 2500);
  assert.equal(yuanToCents('25.5'), 2550);
  assert.equal(yuanToCents(' 10.01 '), 1001);
  assert.equal(formatMoney(1001), '10.01');
  assert.equal(formatMoney(0), '0.00');
});
for (const value of ['1.001', '-2', '1e3', '', 'NaN', 'Infinity', '01', {}, null]) {
  test(`money rejects invalid input ${JSON.stringify(value)}`, () => assert.throws(() => yuanToCents(value), { code: 'INVALID_MONEY' }));
}
test('formatMoney rejects fractional and negative fen', () => {
  assert.throws(() => formatMoney(-1)); assert.throws(() => formatMoney(0.5));
});
test('default request is explicit about per-person budget and drink', () => {
  const request = validateRequest();
  assert.equal(request.totalBudgetCents, 2500); assert.equal(request.people, 1); assert.equal(request.drink, true);
});
for (const input of [{ budget: 0 }, { budget: 501 }, { people: 0 }, { people: 7 }, { people: 1.5 }, { people: '2' }, { drink: 'false' }, { side: 1 }, { mainKind: 'vegan' }, { mode: 'live' }, []]) {
  test(`request rejects unsupported/unsafe conditions ${JSON.stringify(input)}`, () => assert.throws(() => validateRequest(input)));
}
test('25-yuan default returns 22, 24 and 25, one minimum basket per main', () => {
  const result = planMeals({ budget: 25 }, demo);
  assert.deepEqual(result.plans.map(p => p.payableCents), [2200, 2400, 2500]);
  assert.equal(new Set(result.plans.map(p => p.mainId)).size, 3);
  assert.equal(result.searchedCount, 12);
  assert.equal(result.source, 'demo');
});
test('hard budget is inclusive at one-fen boundary', () => {
  assert.equal(planMeals({ budget: '21.99' }, demo).plans.length, 0);
  assert.equal(planMeals({ budget: '22.00' }, demo).plans.length, 1);
});
test('low budget reports shortage and does not mutate the request', () => {
  const input = { budget: 10, people: 1 };
  const result = planMeals(input, demo);
  assert.equal(result.plans.length, 0); assert.equal(result.minimumTotalCents, 2200);
  assert.equal(result.shortfallCents, 1200); assert.deepEqual(input, { budget: 10, people: 1 });
});
test('no main candidates returns null minimum, never zero price', () => {
  const menu = fresh(); menu.items = menu.items.filter(i => i.kind !== 'fish');
  const result = planMeals({ mainKind: 'fish' }, menu);
  assert.equal(result.minimumTotalCents, null); assert.equal(result.plans.length, 0);
});
test('drink and side requirements are never removed to fit budget', () => {
  assert.equal(planMeals({ budget: 22, side: true }, demo).plans.length, 0);
  const result = planMeals({ budget: 25, side: true }, demo);
  assert.equal(result.plans.length, 1);
  assert.deepEqual(result.plans[0].lines.map(i => i.category), ['main', 'drink', 'side']);
  assert.equal(result.plans[0].payableCents, 2500);
});
test('disabling coupons actually changes feasibility', () => {
  const result = planMeals({ budget: 25, side: true, useCoupons: false }, demo);
  assert.equal(result.plans.length, 0); assert.equal(result.minimumTotalCents, 3000);
});
test('main preference filters returned candidates', () => {
  const result = planMeals({ budget: 50, mainKind: 'beef' }, demo);
  assert.equal(result.plans.length, 2); assert.ok(result.plans.every(p => p.mainKind === 'beef'));
});
test('multiple people share one order but each gets every selected item', () => {
  const result = planMeals({ budget: 25, people: 2 }, demo);
  assert.equal(result.request.totalBudgetCents, 5000);
  assert.ok(result.plans.every(plan => plan.lines.every(line => line.quantity === 2)));
  // Two teas cost 2 yuan more than two sodas, but unlock 3 yuan more discount.
  assert.equal(result.plans[0].lines.find(line => line.category === 'drink').id, 'demo-tea');
  assert.equal(result.plans[0].subtotalCents, 4600);
  assert.equal(result.plans[0].discountCents, 800);
  assert.equal(result.plans[0].payableCents, 3800);
  const soda = quoteBasket(demo.items.filter(item => ['demo-chicken', 'demo-soda'].includes(item.id)).map(item => ({ ...item, quantity: 2 })), demo.coupons, context);
  assert.equal(soda.payableCents, 3900);
  assert.ok(result.plans[0].payableCents < soda.payableCents);
});
test('coupons do not stack; greatest eligible discount wins', () => {
  const quote = quoteBasket([{ priceCents: 6000, quantity: 1 }], demo.coupons, context);
  assert.equal(quote.discountCents, 1200); assert.equal(quote.payableCents, 4800);
});
test('coupon threshold is checked in cents before the discount', () => {
  assert.equal(quoteBasket([{ priceCents: 2999, quantity: 1 }], demo.coupons, context).discountCents, 0);
  assert.equal(quoteBasket(lines, demo.coupons, context).discountCents, 500);
});
test('wrong store and wrong channel cannot use a coupon', () => {
  assert.equal(quoteBasket(lines, demo.coupons, { ...context, storeId: 'other' }).discountCents, 0);
  assert.equal(quoteBasket(lines, demo.coupons, { ...context, orderType: 'delivery' }).discountCents, 0);
});
test('expired and not-yet-valid coupons are excluded, including exact expiry', () => {
  const coupons = [{ ...demo.coupons[0], validFrom: '2026-10-10T10:00:00+08:00', expiresAt: '2026-10-11T10:00:00+08:00' }];
  assert.equal(quoteBasket(lines, coupons, context, Date.parse('2026-10-10T09:59:59+08:00')).discountCents, 0);
  assert.equal(quoteBasket(lines, coupons, context, Date.parse('2026-10-10T10:00:00+08:00')).discountCents, 500);
  assert.equal(quoteBasket(lines, coupons, context, Date.parse('2026-10-11T10:00:00+08:00')).discountCents, 0);
});
test('payable never goes negative, even for an oversized demo discount', () => {
  const quote = quoteBasket(lines, [{ ...demo.coupons[0], discountCents: 9000 }], context);
  assert.equal(quote.payableCents, 0); assert.equal(quote.discountCents, 3000);
});
test('invalid quantity cannot enter a basket', () => {
  assert.throws(() => quoteBasket([{ priceCents: 1, quantity: 0 }], [], context));
  assert.throws(() => quoteBasket([{ priceCents: 1.5, quantity: 1 }], [], context));
});
test('top-up warning compares actual payments, not the coupon label', () => {
  const result = planMeals({ budget: 25 }, demo), warning = result.topUp;
  assert.equal(warning.beforeCents, 2200); assert.equal(warning.afterCents, 2500);
  assert.equal(warning.additionalDiscountCents, 500); assert.equal(warning.extraSpendCents, 300);
  assert.equal(warning.kind, 'costs-more');
  assert.ok(result.plans[0].lines.every(line => line.category !== 'side'));
});
test('a top-up that reduces payment is not mislabeled as a trap', () => {
  const menu = fresh(); menu.coupons = [{ ...menu.coupons[0], discountCents: 1000 }];
  // Keep the main fixed; unrestricted search already finds a different discounted meal.
  const result = planMeals({ budget: 25, mainKind: 'chicken' }, menu);
  assert.equal(result.topUp.kind, 'not-more'); assert.equal(result.topUp.extraSpendCents, -200);
});
test('disabled coupons yield no top-up marketing comparison', () => {
  const result = planMeals({ useCoupons: false }, demo); assert.equal(result.topUp, null);
  assert.equal(compareTopUp(result.plans[0], demo, false), null);
});
test('minimum per-person amount rounds up, never below feasible total', () => {
  const menu = fresh(); menu.items = [{ ...menu.items[0], priceCents: 1001 }];
  menu.coupons = [{ ...menu.coupons[0], minSpendCents: 0, discountCents: 1000 }];
  const result = planMeals({ budget: 1, people: 3, drink: false }, menu);
  assert.equal(result.minimumTotalCents, 2003); assert.equal(result.minimumPerPersonCents, 668);
});
test('the demo solver refuses purported live data', () => {
  const menu = fresh(); menu.source = 'mcp';
  assert.throws(() => planMeals({}, menu), { code: 'SOURCE_MISMATCH' });
});
test('duplicate product identifiers and invalid prices fail closed', () => {
  const menu = fresh(); menu.items.push({ ...menu.items[0] }); assert.throws(() => planMeals({}, menu));
  const bad = fresh(); bad.items[0].priceCents = -100; assert.throws(() => planMeals({}, bad));
});
test('malformed coupon time is not silently treated as valid', () => {
  const menu = fresh(); menu.coupons[0].expiresAt = 'invalid'; assert.throws(() => planMeals({}, menu));
});
test('deterministic property checks across budgets, people, flags and preferences', () => {
  for (const budget of [1, 10, 21.99, 22, 25, 30, 50, 100, 500])
  for (let people = 1; people <= 6; people++)
  for (const drink of [true, false]) for (const side of [true, false]) for (const useCoupons of [true, false])
  for (const mainKind of ['any', 'chicken', 'beef', 'fish']) {
    const result = planMeals({ budget, people, drink, side, useCoupons, mainKind }, demo);
    assert.ok(result.plans.length <= 3);
    for (const plan of result.plans) {
      assert.ok(Number.isSafeInteger(plan.payableCents));
      assert.ok(plan.payableCents >= 0 && plan.payableCents <= result.request.totalBudgetCents);
      assert.equal(plan.remainingCents + plan.payableCents, result.request.totalBudgetCents);
      assert.equal(plan.subtotalCents - plan.discountCents, plan.payableCents);
      assert.equal(plan.lines.filter(line => line.category === 'drink').length, Number(drink));
      assert.equal(plan.lines.filter(line => line.category === 'side').length, Number(side));
    }
    assert.deepEqual(result.plans.map(p => p.payableCents), result.plans.map(p => p.payableCents).toSorted((a,b) => a-b));
  }
});
test('configuration uses process env over local file and never exports token globally', () => {
  const dir = resolve(ROOT, '.local', 'config-tests'); mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${randomUUID()}.env`);
  writeFileSync(file, 'MCD_MCP_TOKEN="fixture-only"\nPORT=3333\nUNRELATED=ignored\n');
  try {
    assert.deepEqual(loadConfig({}, file), { token: 'fixture-only', port: 3333 });
    assert.deepEqual(loadConfig({ PORT: '3211', MCD_MCP_TOKEN: 'override-fixture' }, file), { token: 'override-fixture', port: 3211 });
    assert.throws(() => loadConfig({ PORT: 'bad' }, file), { code: 'INVALID_PORT' });
  } finally { unlinkSync(file); }
});
