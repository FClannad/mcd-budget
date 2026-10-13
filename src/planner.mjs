import { AppError } from './errors.mjs';
import { yuanToCents } from './money.mjs';

export function validateRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('INVALID_REQUEST', '请提供用餐条件。');
  }
  const allowed = new Set(['budget', 'people', 'drink', 'side', 'useCoupons', 'mainKind']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new AppError('UNKNOWN_FIELD', `不支持的条件：${key}`);
  }
  const budgetPerPersonCents = yuanToCents(input.budget ?? 25);
  if (budgetPerPersonCents < 100 || budgetPerPersonCents > 50000) {
    throw new AppError('INVALID_BUDGET', '人均预算需在 1 至 500 元之间。');
  }
  const people = input.people ?? 1;
  if (!Number.isInteger(people) || people < 1 || people > 6) {
    throw new AppError('INVALID_PEOPLE', '用餐人数需为 1 至 6 的整数。');
  }
  const flags = {};
  for (const [key, fallback] of [['drink', true], ['side', false], ['useCoupons', true]]) {
    flags[key] = input[key] ?? fallback;
    if (typeof flags[key] !== 'boolean') throw new AppError('INVALID_OPTION', `${key} 必须是布尔值。`);
  }
  const mainKind = input.mainKind ?? 'any';
  if (!['any', 'chicken', 'beef', 'fish'].includes(mainKind)) {
    throw new AppError('INVALID_MAIN', '请选择支持的主食类型。');
  }
  return { budgetPerPersonCents, people, totalBudgetCents: budgetPerPersonCents * people, ...flags, mainKind };
}

export function validateCatalogue(catalogue) {
  if (catalogue?.source !== 'demo') {
    throw new AppError('SOURCE_MISMATCH', '本地优惠模型只用于演示，真实金额必须由官方 calculate-price 返回。');
  }
  if (!catalogue.store?.id || !Array.isArray(catalogue.items) || catalogue.items.length > 120) {
    throw new AppError('INVALID_CATALOGUE', '演示菜单无效或过大。');
  }
  const ids = new Set();
  for (const item of catalogue.items) {
    if (!item.id || ids.has(item.id) || typeof item.name !== 'string' ||
        !['main', 'drink', 'side'].includes(item.category) ||
        !Number.isSafeInteger(item.priceCents) || item.priceCents < 0 || item.priceCents > 100000) {
      throw new AppError('INVALID_CATALOGUE', '菜单包含重复编码或无效餐品、金额。');
    }
    ids.add(item.id);
  }
  if (!Array.isArray(catalogue.coupons) || catalogue.coupons.length > 100) {
    throw new AppError('INVALID_CATALOGUE', '演示优惠券列表无效。');
  }
  const couponIds = new Set();
  for (const coupon of catalogue.coupons) {
    if (!coupon.id || couponIds.has(coupon.id) || typeof coupon.name !== 'string' ||
        !Number.isSafeInteger(coupon.minSpendCents) || coupon.minSpendCents < 0 ||
        !Number.isSafeInteger(coupon.discountCents) || coupon.discountCents < 0 ||
        (coupon.storeIds !== undefined && !Array.isArray(coupon.storeIds)) ||
        (coupon.orderTypes !== undefined && !Array.isArray(coupon.orderTypes)) ||
        (coupon.validFrom !== undefined && !Number.isFinite(Date.parse(coupon.validFrom))) ||
        (coupon.expiresAt !== undefined && !Number.isFinite(Date.parse(coupon.expiresAt)))) {
      throw new AppError('INVALID_CATALOGUE', '演示优惠券包含无效规则。');
    }
    couponIds.add(coupon.id);
  }
}

export function quoteBasket(lines, coupons, context, now = Date.now()) {
  if (!lines.length || lines.some(line => !Number.isSafeInteger(line.quantity) || line.quantity < 1 ||
      line.quantity > 100 || !Number.isSafeInteger(line.priceCents) || line.priceCents < 0)) {
    throw new AppError('INVALID_BASKET', '餐品数量或金额不正确。');
  }
  const subtotalCents = lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);
  if (!Number.isSafeInteger(subtotalCents)) throw new AppError('INVALID_BASKET', '餐单金额过大。');
  const eligible = coupons.filter(coupon =>
    subtotalCents >= coupon.minSpendCents &&
    (!coupon.storeIds || coupon.storeIds.includes(context.storeId)) &&
    (!coupon.orderTypes || coupon.orderTypes.includes(context.orderType)) &&
    (!coupon.validFrom || now >= Date.parse(coupon.validFrom)) &&
    (!coupon.expiresAt || now < Date.parse(coupon.expiresAt))
  ).sort((a, b) => b.discountCents - a.discountCents || a.id.localeCompare(b.id));
  const coupon = eligible.find(item => item.discountCents > 0) ?? null;
  const discountCents = Math.min(subtotalCents, coupon?.discountCents ?? 0);
  return { subtotalCents, discountCents, payableCents: subtotalCents - discountCents,
    coupon: coupon ? { id: coupon.id, name: coupon.name, minSpendCents: coupon.minSpendCents } : null };
}

export function compareTopUp(plan, catalogue, useCoupons, now = Date.now()) {
  if (!useCoupons) return null;
  const context = { storeId: catalogue.store.id, orderType: catalogue.store.orderType };
  const extras = catalogue.items.filter(item => item.category === 'side');
  const comparisons = extras.map(item => {
    const added = { ...item, quantity: 1 };
    const next = quoteBasket([...plan.lines, added], catalogue.coupons, context, now);
    if (!next.coupon || next.discountCents <= plan.discountCents) return null;
    return { extra: added, beforeCents: plan.payableCents, afterCents: next.payableCents,
      extraSpendCents: next.payableCents - plan.payableCents,
      additionalDiscountCents: next.discountCents - plan.discountCents,
      coupon: next.coupon, kind: next.payableCents > plan.payableCents ? 'costs-more' : 'not-more' };
  }).filter(Boolean).sort((a, b) => a.extra.priceCents - b.extra.priceCents || a.afterCents - b.afterCents);
  return comparisons[0] ?? null;
}

export function planMeals(input, catalogue, { now = Date.now() } = {}) {
  const request = validateRequest(input);
  validateCatalogue(catalogue);
  const mains = catalogue.items.filter(item => item.category === 'main' &&
    (request.mainKind === 'any' || item.kind === request.mainKind));
  const drinks = request.drink ? catalogue.items.filter(item => item.category === 'drink') : [null];
  const sides = request.side ? catalogue.items.filter(item => item.category === 'side') : [null];
  const context = { storeId: catalogue.store.id, orderType: catalogue.store.orderType };
  const coupons = request.useCoupons ? catalogue.coupons : [];
  const candidates = [];
  for (const main of mains) for (const drink of drinks) for (const side of sides) {
    const lines = [main, drink, side].filter(Boolean).map(item => ({ ...item, quantity: request.people }));
    const quote = quoteBasket(lines, coupons, context, now);
    candidates.push({ id: lines.map(line => line.id).join('__'), mainId: main.id, mainKind: main.kind,
      title: main.name, lines, ...quote, remainingCents: request.totalBudgetCents - quote.payableCents });
  }
  candidates.sort((a, b) => a.payableCents - b.payableCents || a.subtotalCents - b.subtotalCents || a.id.localeCompare(b.id));
  const feasible = candidates.filter(candidate => candidate.payableCents <= request.totalBudgetCents);
  // Choose the cheapest basket per main, then diversify; never spend more just to use the budget.
  const seenMains = new Set();
  const plans = [];
  for (const candidate of feasible) {
    if (seenMains.has(candidate.mainId)) continue;
    seenMains.add(candidate.mainId);
    plans.push(candidate);
    if (plans.length === 3) break;
  }
  const minimumTotalCents = candidates[0]?.payableCents ?? null;
  return { source: 'demo', sourceLabel: catalogue.sourceLabel, store: catalogue.store,
    generatedAt: new Date(now).toISOString(), request, catalogueSize: catalogue.items.length,
    searchedCount: candidates.length, feasibleCount: feasible.length, plans,
    minimumTotalCents,
    shortfallCents: minimumTotalCents === null ? null : Math.max(0, minimumTotalCents - request.totalBudgetCents),
    minimumPerPersonCents: minimumTotalCents === null ? null : Math.ceil(minimumTotalCents / request.people),
    topUp: plans.length ? compareTopUp(plans[0], catalogue, request.useCoupons, now) : null,
    limitations: ['所有菜单、门店及优惠均为固定演示数据，不代表官方实时价格。',
      '多人模式为每人同一组合、同一订单；不支持逐人定制或优惠券叠加。',
      '只在列出的演示候选中计算，不承诺全菜单或跨渠道最低价。'] };
}
