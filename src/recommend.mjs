import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { yuanToCents } from './money.mjs';
import { businessData, normalizeDetail, normalizeQuote, quoteItem, QUOTE_TTL_MS } from './live.mjs';

const MAX_DETAILS = 12;
const MAX_PLAIN = 8;
const MAX_COUPON = 4;
const MAX_CALLS = 28;
const MAX_DURATION_MS = 60000;
const mainKinds = new Set(['any', 'chicken', 'beef', 'fish']);
const codePattern = /^[a-zA-Z0-9_-]{1,80}$/;
const bundlePattern = /套餐|随心配|件套|组合|单人餐|乐园餐/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 180) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\x00-\x1f]/.test(value);
const signature = items => JSON.stringify(items.map(item => ({ code: item.code, quantity: item.quantity, choices: item.choices })).sort((left, right) => left.code.localeCompare(right.code)));

export function referenceAmount(value) {
  if (typeof value !== 'string') return null;
  const match = /^\s*([+-]?)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|起)?\s*$/.exec(value);
  if (!match) return null;
  try {
    const amount = yuanToCents(match[2]);
    return match[1] === '-' ? -amount : amount;
  } catch { return null; }
}

export function foodKind(name, categories = []) {
  if (/帽|玩具|玩偶|杯套|手办|周边|提袋|拼盘|双人|多人|[2-9二三四五六七八九十]人餐/.test(name)) return 'other';
  if (/麦满分|汉堡|牛堡|鸡腿堡|鱼堡|虾堡|麦香鸡|麦香鱼|板烧鸡|鸡肉卷|鸡腿卷|帕尼尼|贝果|麦饼/.test(name)) return 'main';
  if (/可乐|可口可乐|雪碧|咖啡|美式|奶铁|拿铁|冰咖|红茶|柠檬茶|绿茶|牛奶|豆浆|苹果汁|橙汁|纯悦|怡泉|柠柠|橙橙|饮品|饮料/.test(name)) return 'drink';
  if (categories.some(category => category === '饮品')) return 'drink';
  return 'other';
}

function matchesMain(name, kind) {
  if (kind === 'any') return true;
  return ({ chicken: /鸡|板烧/, beef: /牛|安格斯|双层吉士|吉士汉堡/, fish: /鱼|鳕/ })[kind].test(name);
}

export function mealVariants(detail, categories, mainKind) {
  if (!detail.supported || detail.rounds.length > 6 || (!detail.rounds.length && bundlePattern.test(detail.name))) return [];
  const leaf = choice => ({ name: choice.name, kind: foodKind(choice.name, detail.rounds.length ? [] : categories) });
  if (!detail.rounds.length) {
    const component = leaf(detail);
    if (component.kind === 'main' && !matchesMain(component.name, mainKind)) return [];
    return [{ item: { code: detail.code, quantity: 1, choices: [] }, components: [component], delta: 0 }];
  }
  let variants = [{ choices: [], components: [], delta: 0 }];
  for (const round of detail.rounds) {
    const options = round.choices.filter(choice => choice.available)
      .filter(choice => foodKind(choice.name) !== 'main' || matchesMain(choice.name, mainKind))
      .sort((left, right) => (referenceAmount(left.priceDifferenceText) ?? 0) - (referenceAmount(right.priceDifferenceText) ?? 0) || Number(right.code === round.defaultCode) - Number(left.code === round.defaultCode));
    const shortlist = ['main', 'drink', 'other'].flatMap(kind => options.filter(choice => foodKind(choice.name) === kind).slice(0, 3));
    const next = variants.flatMap(variant => shortlist.map(choice => ({
      choices: [...variant.choices, { round: round.id, code: choice.code }], components: [...variant.components, leaf(choice)],
      delta: variant.delta + (referenceAmount(choice.priceDifferenceText) ?? 0),
    }))).sort((left, right) => left.delta - right.delta);
    const groups = new Map();
    variants = next.filter(variant => {
      const key = [variant.components.some(item => item.kind === 'main'), variant.components.some(item => item.kind === 'drink')].join(':');
      const count = groups.get(key) ?? 0;
      groups.set(key, count + 1);
      return count < 6;
    });
  }
  return variants.map(variant => ({ item: { code: detail.code, quantity: 1, choices: variant.choices }, components: variant.components, delta: variant.delta }));
}

function couponDate(value) {
  const timestamp = Date.parse(value.replace(' ', 'T') + '+08:00');
  if (!Number.isFinite(timestamp)) return NaN;
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') === value ? timestamp : NaN;
}

export function normalizeStoreCoupons(data, now) {
  if (!Array.isArray(data) || data.length > 200) throw new AppError('COUPON_SHAPE', '门店券结构暂不支持，不能确认优惠。', 502);
  const seen = new Set();
  let ignored = 0;
  const coupons = [];
  for (const entry of data) {
    if (!object(entry) || !text(entry.title) || !text(entry.couponId, 256) || !text(entry.couponCode, 256) || !Array.isArray(entry.products) || entry.products.length > 50) { ignored++; continue; }
    const key = JSON.stringify([entry.couponId, entry.couponCode]);
    if (seen.has(key)) { ignored++; continue; }
    seen.add(key);
    const products = entry.products.filter(product => object(product) && typeof product.productCode === 'string' && codePattern.test(product.productCode) && text(product.productName))
      .map(product => ({ code: product.productCode, name: product.productName }));
    if (!products.length) { ignored++; continue; }
    const validityText = text(entry.tradeDateTime, 100) ? entry.tradeDateTime : '';
    const dates = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})-(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$/.exec(validityText);
    const startsAt = dates ? couponDate(dates[1]) : NaN;
    const endsAt = dates ? couponDate(dates[2]) : NaN;
    const validRange = Number.isFinite(startsAt) && Number.isFinite(endsAt) && startsAt < endsAt;
    const available = validRange && startsAt <= now && now < endsAt;
    coupons.push({ title: entry.title, couponId: entry.couponId, couponCode: entry.couponCode, products, validityText, startsAt, endsAt,
      available, status: available ? 'not-checked' : validRange ? 'outside-validity' : 'unknown-validity', verified: [] });
  }
  return { coupons, ignored };
}

function validRequest(args) {
  const fields = ['menuId', 'budget', 'people', 'wantDrink', 'mainKind', 'useCoupons'];
  if (!object(args) || Object.keys(args).some(key => !fields.includes(key)) || typeof args.wantDrink !== 'boolean' || typeof args.useCoupons !== 'boolean' || !mainKinds.has(args.mainKind)) {
    throw new AppError('INVALID_RECOMMEND_INPUT', '请提供预算、人数、主食偏好及是否参考门店券，不接受自填券码或价格。');
  }
  const budgetCents = yuanToCents(args.budget);
  if (budgetCents < 100 || budgetCents > 50000 || !Number.isInteger(args.people) || args.people < 1 || args.people > 6) throw new AppError('INVALID_BUDGET', '人均预算限 1–500 元，用餐人数限 1–6 人。');
  return budgetCents;
}

function candidateLabel(candidate, detailMap) {
  return candidate.items.map(item => detailMap.get(item.code).name).join(' + ');
}

export class RecommendationService {
  constructor({ live, mcp, clock = Date.now }) {
    this.live = live;
    this.mcp = mcp;
    this.clock = clock;
    this.active = false;
  }

  async recommend(args) {
    const budgetCents = validRequest(args);
    const menu = this.live.lookup(this.live.menus, args.menuId);
    if (this.active) throw new AppError('RECOMMEND_BUSY', '已有自动推荐正在核价，请等待本次完成。', 429);
    this.active = true;
    try { return await this.build(args, menu, budgetCents); }
    finally { this.active = false; }
  }

  async build(args, menu, budgetCents) {
    const startedAt = this.clock();
    let calls = 0, unavailableDetails = 0, failedQuotes = 0, stopped = false;
    const warnings = [], details = new Map();
    const common = { storeCode: menu.store.code, orderType: 1, beType: 1 };
    const checkpoint = () => {
      this.live.lookup(this.live.menus, args.menuId);
      if (calls >= MAX_CALLS || this.clock() - startedAt >= MAX_DURATION_MS) throw new AppError('RECOMMEND_LIMIT', '本轮查询已达到数量或时间上限，尚未核价的候选不参与排名。', 429);
    };
    const call = async (tool, input) => { checkpoint(); calls++; return this.mcp.callTool(tool, input); };
    const fatal = failure => ['LIVE_SNAPSHOT_EXPIRED', 'TOKEN_MISSING', 'TOKEN_REJECTED', 'MCP_SESSION_EXPIRED'].includes(failure.code);
    const limited = failure => ['RECOMMEND_LIMIT', 'LOCAL_UPSTREAM_LIMIT', 'MCP_RATE_LIMIT'].includes(failure.code);
    let couponStatus = args.useCoupons ? 'queried' : 'disabled', couponTime = null, coupons = [], ignoredCoupons = 0;
    if (args.useCoupons) {
      try {
        const response = await call('query-store-coupons', common);
        const normalized = normalizeStoreCoupons(businessData(response, 'query-store-coupons'), this.clock());
        coupons = normalized.coupons; ignoredCoupons = normalized.ignored; couponTime = response.receivedAt;
      } catch (failure) {
        if (fatal(failure)) throw failure;
        if (limited(failure)) stopped = true;
        couponStatus = 'failed';
        warnings.push('门店券查询失败或格式未适配；本次仅比较不用券候选，不等于没有可用券。');
      }
    }
    if (args.people > 1 && coupons.some(coupon => coupon.available)) warnings.push('当前券接口未提供可重复使用张数；多人推荐不自动复用一张券，本次多人价格不含券。');
    const byReference = (left, right) => (referenceAmount(left.priceText) ?? 1000000) - (referenceAmount(right.priceText) ?? 1000000) || left.code.localeCompare(right.code);
    const ordinary = menu.items.filter(item => !/双人|多人|[2-9二三四五六七八九十]人餐|拼盘|玩具|玩偶|周边|手办/.test(item.name));
    const bundles = ordinary.filter(item => bundlePattern.test(item.name)).sort(byReference).slice(0, 4);
    const singles = ordinary.filter(item => !bundlePattern.test(item.name));
    const mains = singles.filter(item => foodKind(item.name, item.categories) === 'main' && matchesMain(item.name, args.mainKind)).sort(byReference).slice(0, 3);
    const drinks = args.wantDrink ? singles.filter(item => foodKind(item.name, item.categories) === 'drink').sort(byReference).slice(0, 2) : [];
    const selected = new Map([...bundles, ...mains, ...drinks].map(item => [item.code, item]));
    if (args.people > 1) for (const coupon of coupons.filter(value => value.available)) coupon.status = 'group-limit';
    for (const coupon of coupons.filter(value => value.available).slice(0, 4)) {
      if (args.people > 1) continue;
      for (const product of coupon.products.slice(0, 2)) {
        if (!selected.has(product.code) && selected.size >= MAX_DETAILS) continue;
        if (!selected.has(product.code)) selected.set(product.code, menu.items.find(item => item.code === product.code) ?? { ...product, categories: [], priceText: null });
      }
    }
    for (const item of selected.values()) {
      if (stopped) break;
      try {
        checkpoint();
        const cached = menu.details.get(item.code);
        const response = cached ? null : await call('query-meal-detail', { ...common, code: item.code });
        const detail = cached ?? { source: 'mcp', readOnly: true, receivedAt: response.receivedAt,
          ...normalizeDetail(businessData(response, 'query-meal-detail'), item.code) };
        this.live.lookup(this.live.menus, args.menuId);
        if (!cached && menu.items.some(product => product.code === item.code)) menu.details.set(item.code, detail);
        if (!detail.supported) { unavailableDetails++; continue; }
        details.set(item.code, detail);
      } catch (failure) {
        if (fatal(failure)) throw failure;
        unavailableDetails++;
        if (limited(failure)) { stopped = true; break; }
      }
    }
    const variants = new Map([...details].map(([code, detail]) => [code, mealVariants(detail, selected.get(code).categories, args.mainKind).map(variant => ({ ...variant, estimate: (referenceAmount(selected.get(code).priceText) ?? 1000000) + variant.delta }))]));
    const has = (variant, kind) => variant.components.some(component => component.kind === kind);
    const complete = values => values.some(value => has(value, 'main')) && (!args.wantDrink || values.some(value => has(value, 'drink')));
    const mainVariants = mains.flatMap(item => (variants.get(item.code) ?? []).filter(value => has(value, 'main')).slice(0, 1));
    const drinkVariants = drinks.flatMap(item => (variants.get(item.code) ?? []).filter(value => has(value, 'drink')).slice(0, 1));
    const make = (values, coupon = null, couponProduct = null) => ({ items: values.map(value => value.item), estimate: values.reduce((sum, value) => sum + value.estimate, 0), coupon, couponProduct });
    const ordinaryCandidates = [];
    for (const item of bundles) {
      const distinct = new Map();
      for (const variant of (variants.get(item.code) ?? []).filter(value => complete([value]))) {
        const key = variant.components.filter(component => component.kind === 'main').map(component => component.name).join('|');
        if (!distinct.has(key)) distinct.set(key, variant);
      }
      ordinaryCandidates.push(...[...distinct.values()].slice(0, 2).map(value => make([value])));
    }
    for (const main of mainVariants) {
      if (complete([main])) ordinaryCandidates.push(make([main]));
      else for (const drink of drinkVariants) if (main.item.code !== drink.item.code) ordinaryCandidates.push(make([main, drink]));
    }
    const couponCandidates = [];
    for (const coupon of coupons.filter(value => value.available && args.people === 1).slice(0, 4)) {
      const available = [];
      for (const product of coupon.products) {
        for (const variant of (variants.get(product.code) ?? []).slice(0, 8)) {
          if (complete([variant])) {
            available.push(make([variant], coupon, product));
          } else if (has(variant, 'main')) {
            for (const drink of drinkVariants.slice(0, 1)) if (drink.item.code !== product.code && complete([variant, drink])) available.push(make([variant, drink], coupon, product));
          } else if (has(variant, 'drink') && args.wantDrink) {
            for (const main of mainVariants.slice(0, 1)) if (main.item.code !== product.code && complete([main, variant])) available.push(make([main, variant], coupon, product));
          }
        }
        for (const candidate of ordinaryCandidates) if (candidate.items.some(item => item.code === product.code)) available.push({ ...candidate, coupon, couponProduct: product });
      }
      coupon.status = available.length ? 'pending' : 'no-matching-meal';
      couponCandidates.push(...available.sort((left, right) => left.estimate - right.estimate).slice(0, 1));
    }
    const sorted = ordinaryCandidates.sort((left, right) => left.estimate - right.estimate);
    const baselines = couponCandidates.map(candidate => ({ ...candidate, coupon: null, couponProduct: null }));
    const firstPerBundle = bundles.map(item => sorted.find(candidate => candidate.items.length === 1 && candidate.items[0].code === item.code)).filter(Boolean);
    const firstPerMain = mains.map(item => sorted.find(candidate => candidate.items.some(selected => selected.code === item.code))).filter(Boolean);
    const plain = [...baselines, ...firstPerBundle, ...firstPerMain, ...sorted];
    const seen = new Set();
    const uniquePlain = plain.filter(candidate => { const key = signature(candidate.items); if (seen.has(key)) return false; seen.add(key); return true; });
    const selectedPlain = uniquePlain.slice(0, MAX_PLAIN);
    const selectedCoupons = couponCandidates.slice(0, MAX_COUPON);
    const quoted = [];
    for (const candidate of [...selectedPlain, ...selectedCoupons]) {
      if (stopped) break;
      const coupon = candidate.coupon;
      if (coupon && (this.clock() < coupon.startsAt || this.clock() >= coupon.endsAt)) { coupon.status = 'outside-validity'; continue; }
      try {
        const items = candidate.items.map(item => quoteItem(item, details.get(item.code), args.people));
        if (coupon) {
          const target = items.find(item => item.request.productCode === candidate.couponProduct.code);
          if (!target || target.request.quantity !== 1) throw new AppError('COUPON_QUANTITY', '券不能重复用于多人餐单。');
          target.request.couponId = coupon.couponId; target.request.couponCode = coupon.couponCode;
        }
        const response = await call('calculate-price', { ...common, items: items.map(item => item.request) });
        const normalized = normalizeQuote(businessData(response, 'calculate-price'), items);
        this.live.lookup(this.live.menus, args.menuId);
        if (coupon && this.clock() >= coupon.endsAt) { coupon.status = 'outside-validity'; continue; }
        const totalBudgetCents = budgetCents * args.people;
        const quote = { source: 'mcp', readOnly: true, id: randomUUID(), menuId: args.menuId, store: menu.store,
          title: candidateLabel(candidate, details), receivedAt: response.receivedAt,
          expiresAt: new Date(Math.min(this.clock() + QUOTE_TTL_MS, Date.parse(response.receivedAt) + QUOTE_TTL_MS, menu.expires, coupon?.endsAt ?? Infinity)).toISOString(),
          fulfillment: '到店自取 · 非预约', request: { budgetCents, totalBudgetCents, people: args.people }, ...normalized,
          withinBudget: normalized.payableCents <= totalBudgetCents, remainingCents: totalBudgetCents - normalized.payableCents,
          coupon: coupon ? { title: coupon.title, productName: candidate.couponProduct.name, validityText: coupon.validityText, source: 'query-store-coupons' } : null,
          couponComparison: null, note: '官方逐篮核价，仅按本次已验证候选排序，非全菜单最低价；不锁价、不领券、不下单。用券结果仅核价，不消耗券。' };
        quoted.push({ candidate, quote });
        if (coupon) { coupon.status = 'quoted'; coupon.verified.push(quote); }
      } catch (failure) {
        if (fatal(failure)) throw failure;
        failedQuotes++;
        if (coupon) coupon.status = 'quote-failed';
        if (limited(failure)) { stopped = true; break; }
      }
    }
    this.live.lookup(this.live.menus, args.menuId);
    const fresh = quoted.filter(value => Date.parse(value.quote.expiresAt) > this.clock());
    for (const { candidate, quote } of fresh) {
      if (!candidate.coupon) continue;
      const baseline = fresh.find(value => !value.candidate.coupon && signature(value.candidate.items) === signature(candidate.items));
      if (baseline) quote.couponComparison = { withoutCouponCents: baseline.quote.payableCents, savingCents: baseline.quote.payableCents - quote.payableCents };
    }
    const bestByMeal = new Map();
    for (const entry of fresh) {
      const key = signature(entry.candidate.items), previous = bestByMeal.get(key);
      if (!previous || entry.quote.payableCents < previous.quote.payableCents || (entry.quote.payableCents === previous.quote.payableCents && !entry.candidate.coupon)) bestByMeal.set(key, entry);
    }
    const ranked = [...bestByMeal.values()].map(value => value.quote).sort((left, right) => left.payableCents - right.payableCents || left.title.localeCompare(right.title));
    if (unavailableDetails) warnings.push(`${unavailableDetails} 项详情失败或规格暂不支持，未编造搭配。`);
    if (failedQuotes) warnings.push(`${failedQuotes} 个候选未取得完整有效的官方核价（包括缺餐品的零价返回），未参与排序。`);
    if (stopped) warnings.push('本轮达到查询数量、时间或限流上限；仅显示已成功核价部分，请稍后重试。');
    const publicCoupons = coupons.slice(0, 30).map(coupon => {
      const verified = coupon.verified.filter(quote => Date.parse(quote.expiresAt) > this.clock());
      const best = verified.sort((left, right) => left.payableCents - right.payableCents)[0];
      const lowest = best?.payableCents ?? null;
      return { title: coupon.title, products: coupon.products.map(product => product.name), validityText: coupon.validityText,
        status: coupon.status === 'quoted' && !verified.length ? 'expired-quote' : coupon.status,
        lowestMealCents: lowest, withinBudget: lowest === null ? null : lowest <= budgetCents * args.people,
        couponComparison: best?.couponComparison ?? null,
        comparisonToCheapestCents: lowest === null || !ranked.length ? null : lowest - ranked[0].payableCents };
    });
    return { source: 'mcp', readOnly: true, menuId: args.menuId, store: menu.store,
      receivedAt: new Date(this.clock()).toISOString(), expiresAt: new Date(Math.min(menu.expires, this.clock() + QUOTE_TTL_MS, ...fresh.map(value => Date.parse(value.quote.expiresAt)))).toISOString(),
      request: { budgetCents, totalBudgetCents: budgetCents * args.people, people: args.people, mainKind: args.mainKind, wantDrink: args.wantDrink, useCoupons: args.useCoupons },
      plans: ranked.filter(quote => quote.withinBudget).slice(0, 5), overBudget: ranked.filter(quote => !quote.withinBudget).slice(0, 2),
      minimumVerifiedCents: ranked[0]?.payableCents ?? null,
      coupons: { status: couponStatus, receivedAt: couponTime, count: coupons.length, ignored: ignoredCoupons, offers: publicCoupons },
      coverage: { menuItems: menu.items.length, details: details.size, plainCandidates: uniquePlain.length, couponCandidates: couponCandidates.length,
        attemptedQuotes: quoted.length + failedQuotes, successfulQuotes: fresh.length, upstreamCalls: calls, limited: true }, warnings,
      note: '菜单标价和规格差价只用于有限候选的查询优先级，不是实付；展示顺序完全依据官方最终应付。没有合适候选不等于整个菜单无解。' };
  }
}
