import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { yuanToCents } from './money.mjs';

export const MENU_TTL_MS = 5 * 60 * 1000;
export const QUOTE_TTL_MS = 2 * 60 * 1000;
const MAX_SNAPSHOTS = 32;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validCode = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const text = (value, limit = 160) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

function shape(condition) {
  if (!condition) throw new AppError('LIVE_SHAPE', '官方返回的字段或金额格式暂不支持，未生成有效核价；请刷新或使用只读工作台检查。', 502);
}

function input(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new AppError('INVALID_LIVE_INPUT', '请求包含不支持的字段。真实预算页只支持到店自取，不支持领券、特调或下单。');
  }
}

export function businessData(response, tool) {
  shape(response?.source === 'mcp' && response.tool === tool && object(response.result));
  if (response.result.isError) throw new AppError('MCP_BUSINESS_ERROR', '官方工具未成功，未使用菜单标价或演示数据代替核价。', 502);
  let envelope = response.result.structuredContent;
  if (envelope === undefined) {
    shape(Array.isArray(response.result.content));
    const blocks = response.result.content.filter(block => object(block) && block.type === 'text');
    shape(blocks?.length === 1);
    try { envelope = JSON.parse(blocks[0].text); } catch { shape(false); }
  }
  shape(object(envelope));
  if (envelope.success !== true || envelope.code !== 200) {
    throw new AppError('MCP_BUSINESS_ERROR', '官方业务未成功：可能已停售、规格不可用或账号条件不满足。请重新查询；未回退到演示价格。', 502);
  }
  shape(envelope.data !== undefined && Number.isFinite(Date.parse(response.receivedAt)));
  return envelope.data;
}

export function normalizeStores(data) {
  shape(Array.isArray(data) && data.length <= 100);
  const seen = new Set();
  return data.map(store => {
    shape(object(store) && validCode(store.storeCode) && text(store.storeName) && typeof store.businessStatus === 'boolean' && !seen.has(store.storeCode));
    seen.add(store.storeCode);
    return { code: store.storeCode, name: store.storeName,
      address: text(store.address, 300) ? store.address : '', open: store.businessStatus,
      distanceMeters: Number.isFinite(store.distance) && store.distance >= 0 ? store.distance : null,
      hours: text(store.businessStartTime, 10) && text(store.businessEndTime, 10) ? `${store.businessStartTime}–${store.businessEndTime}` : '',
      reservation: store.reservation === true,
      reservationTimeOptions: (Array.isArray(store.reservationTimeOptions) ? store.reservationTimeOptions : []).slice(0, 14).filter(object).map(option => ({
        date: text(option.date, 10) ? option.date : '', today: option.today === true,
        text: text(option.reservationOptionText, 1000) ? option.reservationOptionText : '',
      })) };
  });
}

export function normalizeMenu(data) {
  shape(object(data) && object(data.meals) && Object.keys(data.meals).length <= 500 && Array.isArray(data.categories) && data.categories.length <= 100);
  const categories = new Map(), order = new Set();
  for (const category of data.categories) {
    shape(object(category) && text(category.name) && Array.isArray(category.meals) && category.meals.length <= 500);
    for (const meal of category.meals) {
      shape(object(meal) && validCode(meal.code));
      if (!Object.hasOwn(data.meals, meal.code)) continue;
      order.add(meal.code);
      if (!categories.has(meal.code)) categories.set(meal.code, new Set());
      categories.get(meal.code).add(category.name.replace(/\s+/g, ' '));
    }
  }
  for (const code of Object.keys(data.meals)) order.add(code);
  return [...order].map(code => {
    const meal = data.meals[code];
    shape(validCode(code) && object(meal) && text(meal.name));
    const price = typeof meal.currentPrice === 'number' && Number.isFinite(meal.currentPrice) ? String(meal.currentPrice) : meal.currentPrice;
    return { code, name: meal.name, priceText: text(price, 80) ? price : null, categories: [...(categories.get(code) ?? [])] };
  });
}

export function normalizeDetail(data, code) {
  shape(object(data) && data.code === code && text(data.name) && Array.isArray(data.rounds) && data.rounds.length <= 20);
  const ids = new Set();
  let supported = true;
  const rounds = data.rounds.map(round => {
    shape(object(round) && (typeof round.id === 'string' || Number.isSafeInteger(round.id)) && validCode(String(round.id)) && text(round.name) && Array.isArray(round.choices) && round.choices.length <= 100);
    const id = String(round.id);
    shape(!ids.has(id)); ids.add(id);
    if (round.minQuantity !== 1 || round.maxQuantity !== 1 || round.quantity !== 1 || !round.choices.length) supported = false;
    const codes = new Set();
    const choices = round.choices.map(choice => {
      shape(object(choice) && validCode(choice.code) && text(choice.name) && !codes.has(choice.code));
      codes.add(choice.code);
      shape(Number.isSafeInteger(choice.quantity) && choice.quantity >= 0 && Number.isSafeInteger(choice.maxQuantity) && choice.maxQuantity >= -1);
      return { code: choice.code, name: choice.name, quantity: choice.quantity,
        available: choice.maxQuantity === -1 || choice.maxQuantity >= 1,
        supportModify: choice.supportModify === true, priceDifferenceText: text(choice.diffPrice, 80) ? choice.diffPrice : null };
    });
    const defaults = choices.filter(choice => choice.quantity > 0);
    const defaultCode = defaults.length === 1 && defaults[0].quantity === 1 && defaults[0].available ? defaults[0].code : null;
    return { id, name: round.name, choices, defaultCode };
  });
  return { code, name: data.name, supportModify: data.supportModify === true, rounds, supported,
    limitation: supported ? '支持原配方与每组选一项；不修改特调。默认项取自返回的实际 quantity，提交前可更换。' : '该餐品包含多选或尚未适配的规格，暂不能加入真实餐单。可在只读 MCP 工作台检查。' };
}

export function quoteItem(item, detail, people) {
  input(item, ['code', 'quantity', 'choices']);
  if (!detail || !detail.supported) throw new AppError('DETAIL_REQUIRED', '请先读取当前菜单中的餐品详情；未适配规格的餐品不能核价。');
  if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 6 || !Array.isArray(item.choices) || item.choices.length !== detail.rounds.length) {
    throw new AppError('INVALID_SELECTION', '每人每种餐品限 1–6 份，并须明确选择每组规格。');
  }
  const selected = new Map();
  for (const choice of item.choices) {
    input(choice, ['round', 'code']);
    if (!validCode(choice.round) || !validCode(choice.code) || selected.has(choice.round)) throw new AppError('INVALID_SELECTION', '规格选择有重复或无效编码。');
    selected.set(choice.round, choice.code);
  }
  const options = [], roundList = detail.rounds.map(round => {
    const choice = round.choices.find(value => value.code === selected.get(round.id) && value.available);
    if (!choice) throw new AppError('INVALID_SELECTION', '请选择详情返回的有效规格，不接受猜测或跨餐品的编码。');
    options.push({ round: round.name, name: choice.name, supportModify: choice.supportModify });
    return { round: round.id, comboItemList: [{ code: choice.code, quantity: 1 }] };
  });
  return { request: { productCode: detail.code, quantity: item.quantity * people, ...(roundList.length ? { roundList } : {}) },
    options, name: detail.name, supportModify: detail.supportModify, perPersonQuantity: item.quantity };
}

export function normalizeQuote(data, items) {
  shape(object(data));
  for (const key of ['price', 'originalPrice', 'discount', 'productPrice', 'productOriginalPrice']) {
    shape(Number.isSafeInteger(data[key]) && data[key] >= 0 && data[key] <= 100000000);
  }
  shape(data.originalPrice - data.discount === data.price && Array.isArray(data.productList) && data.productList.length === items.length);
  const seen = new Set();
  const lines = data.productList.map(product => {
    shape(object(product) && validCode(product.productCode) && text(product.productName) && !seen.has(product.productCode));
    seen.add(product.productCode);
    const expected = items.find(item => item.request.productCode === product.productCode);
    shape(expected && product.quantity === expected.request.quantity);
    shape(Number.isSafeInteger(product.subtotal) && product.subtotal >= 0 && Number.isSafeInteger(product.originalSubtotal) && product.originalSubtotal >= product.subtotal);
    return { code: product.productCode, name: product.productName, quantity: product.quantity,
      perPersonQuantity: expected.perPersonQuantity, options: expected.options, supportModify: expected.supportModify,
      subtotalCents: product.subtotal, originalSubtotalCents: product.originalSubtotal };
  });
  shape(lines.reduce((sum, line) => sum + line.subtotalCents, 0) === data.productPrice);
  shape(lines.reduce((sum, line) => sum + line.originalSubtotalCents, 0) === data.productOriginalPrice);
  return { lines, payableCents: data.price, originalCents: data.originalPrice, discountCents: data.discount,
    productCents: data.productPrice, adjustmentCents: data.price - data.productPrice };
}

export class LiveBudgetService {
  constructor({ mcp, clock = Date.now } = {}) {
    this.mcp = mcp;
    this.clock = clock;
    this.searches = new Map();
    this.menus = new Map();
  }

  save(map, value) {
    for (const [id, snapshot] of map) if (snapshot.expires <= this.clock()) map.delete(id);
    while (map.size >= MAX_SNAPSHOTS) map.delete(map.keys().next().value);
    const id = randomUUID();
    map.set(id, { ...value, expires: this.clock() + MENU_TTL_MS });
    return id;
  }

  lookup(map, id) {
    const snapshot = typeof id === 'string' ? map.get(id) : null;
    if (!snapshot || snapshot.expires <= this.clock()) {
      if (snapshot) map.delete(id);
      throw new AppError('LIVE_SNAPSHOT_EXPIRED', '门店或菜单快照已失效（有效期 5 分钟），请重新搜索门店并读取菜单；未沿用旧编码。', 409);
    }
    return snapshot;
  }

  async stores(args) {
    input(args, ['city', 'keyword']);
    if (!text(args.city, 60) || !text(args.keyword, 100) || /[\x00-\x1f]/.test(args.city + args.keyword)) {
      throw new AppError('INVALID_LOCATION', '请填写城市和附近公共地标，不需要提供家庭地址。');
    }
    const response = await this.mcp.callTool('query-nearby-stores', { city: args.city.trim(), keyword: args.keyword.trim(), beType: 1, searchType: 2 });
    const stores = normalizeStores(businessData(response, 'query-nearby-stores'));
    const searchId = this.save(this.searches, { stores });
    return { source: 'mcp', readOnly: true, receivedAt: response.receivedAt, searchId, stores };
  }

  async menu(args) {
    input(args, ['searchId', 'storeCode']);
    const search = this.lookup(this.searches, args.searchId);
    const store = search.stores.find(value => value.code === args.storeCode);
    if (!store?.open) throw new AppError('INVALID_STORE', '请选择刚刚搜索返回的营业中门店；暂不支持预约。');
    const response = await this.mcp.callTool('query-meals', { storeCode: store.code, orderType: 1, beType: 1 });
    const items = normalizeMenu(businessData(response, 'query-meals'));
    const menuId = this.save(this.menus, { store, items, details: new Map() });
    return { source: 'mcp', readOnly: true, receivedAt: response.receivedAt, menuId, store, items,
      expiresAt: new Date(this.menus.get(menuId).expires).toISOString() };
  }

  async detail(args) {
    input(args, ['menuId', 'code']);
    const menu = this.lookup(this.menus, args.menuId);
    if (!menu.items.some(item => item.code === args.code)) throw new AppError('INVALID_PRODUCT', '餐品不在当前门店菜单中，请重新选择。');
    if (menu.details.has(args.code)) return menu.details.get(args.code);
    const response = await this.mcp.callTool('query-meal-detail', { storeCode: menu.store.code, orderType: 1, beType: 1, code: args.code });
    const detail = normalizeDetail(businessData(response, 'query-meal-detail'), args.code);
    this.lookup(this.menus, args.menuId);
    const result = { source: 'mcp', readOnly: true, receivedAt: response.receivedAt, ...detail };
    menu.details.set(args.code, result);
    return result;
  }

  async quote(args) {
    input(args, ['menuId', 'budget', 'people', 'items']);
    const menu = this.lookup(this.menus, args.menuId);
    const budgetCents = yuanToCents(args.budget);
    if (budgetCents < 100 || budgetCents > 50000 || !Number.isInteger(args.people) || args.people < 1 || args.people > 6) {
      throw new AppError('INVALID_BUDGET', '人均预算限 1–500 元，用餐人数限 1–6 人。');
    }
    if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > 8) throw new AppError('INVALID_BASKET', '请先选餐，每份餐单限 1–8 种餐品。');
    const codes = new Set();
    const items = args.items.map(item => {
      input(item, ['code', 'quantity', 'choices']);
      if (!validCode(item.code) || codes.has(item.code)) throw new AppError('INVALID_BASKET', '同一餐品不能重复加入；请直接修改份数。');
      codes.add(item.code);
      return quoteItem(item, menu.details.get(item.code), args.people);
    });
    if (items.reduce((sum, item) => sum + item.perPersonQuantity, 0) > 12) throw new AppError('INVALID_BASKET', '每人最多选择 12 份餐品。');
    const response = await this.mcp.callTool('calculate-price', { storeCode: menu.store.code, orderType: 1, beType: 1, items: items.map(item => item.request) });
    const quote = normalizeQuote(businessData(response, 'calculate-price'), items);
    this.lookup(this.menus, args.menuId);
    const totalBudgetCents = budgetCents * args.people;
    return { source: 'mcp', readOnly: true, id: randomUUID(), menuId: args.menuId, store: menu.store,
      receivedAt: response.receivedAt, expiresAt: new Date(this.clock() + QUOTE_TTL_MS).toISOString(),
      fulfillment: '到店自取 · 非预约', request: { budgetCents, totalBudgetCents, people: args.people }, ...quote,
      withinBudget: quote.payableCents <= totalBudgetCents, remainingCents: totalBudgetCents - quote.payableCents,
      note: '官方 calculate-price 本次返回，金额由整数分换算。仅供当前餐单比较，不锁价、不保证可售；无个人券、领券、特调、预约或下单。' };
  }
}
