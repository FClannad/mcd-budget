import { stores, response } from './live.mjs';

const choice = (code, name, difference = '+ ¥0', quantity = 0) => ({ code, name, diffPrice: difference, quantity, maxQuantity: -1, isDefault: 1 });
const round = (id, name, choices) => ({ id, name, choices, quantity: 1, minQuantity: 1, maxQuantity: 1 });
const mainChoices = [choice('chicken', '模拟麦香鸡', '+ ¥0', 1), choice('beef', '模拟双层吉士汉堡'), choice('fish', '模拟麦香鱼', '+ ¥1'), choice('fries', '模拟小薯条', '- ¥9')];
const drinkChoices = [choice('cola', '模拟可乐', '+ ¥0', 1), choice('tea', '模拟红茶'), choice('icecream', '模拟冰淇淋', '- ¥9')];
export const recommendationMenu = { categories: [], meals: {
  chicken: { name: '模拟麦香鸡', currentPrice: '2' }, beef: { name: '模拟双层吉士汉堡', currentPrice: '3' },
  fish: { name: '模拟麦香鱼', currentPrice: '4' }, water: { name: '模拟纯悦', currentPrice: '7.5' }, drink: { name: '模拟可乐', currentPrice: '9.5' },
  bundle: { name: '模拟随心配', currentPrice: '99起' }, bundle2: { name: '模拟经典套餐', currentPrice: '0.1起' },
  side: { name: '模拟小薯条', currentPrice: '1' }, complex: { name: '模拟多选套餐', currentPrice: '5' },
} };
export const recommendationDetails = Object.fromEntries(Object.entries(recommendationMenu.meals).map(([code, item]) => [code, { code, name: item.name, rounds: [] }]));
recommendationDetails.bundle.rounds = [round(1, '主食区', mainChoices), round(2, '饮品区', drinkChoices)];
recommendationDetails.bundle2.rounds = [round(1, '主食区', mainChoices), round(2, '饮品区', drinkChoices)];
recommendationDetails.complex.rounds = [{ ...round(1, '多选区', mainChoices), quantity: 2, minQuantity: 2, maxQuantity: 2 }];
recommendationDetails['coupon-coffee'] = { code: 'coupon-coffee', name: '模拟美式中杯', rounds: [round(1, '冷热', [choice('hot', '模拟热美式中杯', '+ ¥0', 1), choice('iced', '模拟冰美式中杯')])] };
export const recommendationCoupons = [
  { title: '模拟鸡堡减5元券', couponId: 'fixture-private-id-chicken', couponCode: 'fixture-private-code-chicken', tradeDateTime: '2026-10-01 00:00:00-2026-11-01 23:59:59', products: [{ productCode: 'chicken', productName: '模拟麦香鸡' }] },
  { title: '模拟美式7折券', couponId: 'fixture-private-id-coffee', couponCode: 'fixture-private-code-coffee', tradeDateTime: '2026-10-01 00:00:00-2026-11-01 23:59:59', products: [{ productCode: 'coupon-coffee', productName: '模拟美式中杯' }] },
  { title: '模拟小食券', couponId: 'fixture-private-id-side', couponCode: 'fixture-private-code-side', tradeDateTime: '2026-10-01 00:00:00-2026-11-01 23:59:59', products: [{ productCode: 'side', productName: '模拟小薯条' }] },
];
export const FIXTURE_TIME = Date.parse('2026-10-13T03:30:00Z');

export function recommendationMcp({ clock = () => FIXTURE_TIME, transform, coupons = recommendationCoupons, unitPrice } = {}) {
  const calls = [];
  return { configured: true, calls, async listTools() { calls.push({ tool: 'listTools' }); return []; }, async callTool(tool, args) {
    calls.push({ tool, args: structuredClone(args) });
    let data;
    if (tool === 'query-nearby-stores') data = stores;
    else if (tool === 'query-meals') data = recommendationMenu;
    else if (tool === 'query-meal-detail') data = recommendationDetails[args.code];
    else if (tool === 'query-store-coupons') data = coupons;
    else if (tool === 'calculate-price') {
      const productList = args.items.map(item => {
        const base = { chicken: 1700, beef: 1800, fish: 2000, water: 750, drink: 950, bundle: 1400, bundle2: 2400, side: 600, 'coupon-coffee': 1900 }[item.productCode];
        const selection = item.roundList?.flatMap(value => value.comboItemList.map(selected => selected.code)) ?? [];
        const original = base + (selection.includes('fish') ? 100 : 0) - (selection.includes('fries') ? 900 : 0) - (selection.includes('icecream') ? 900 : 0);
        const priced = unitPrice ? unitPrice(item, original) : original - (item.couponId ? item.productCode === 'coupon-coffee' ? 570 : 500 : 0);
        return { productCode: item.productCode, productName: recommendationDetails[item.productCode].name, quantity: item.quantity,
          subtotal: priced * item.quantity, originalSubtotal: Math.max(original, priced) * item.quantity, privateField: 'fixture-private-product-metadata' };
      });
      const price = productList.reduce((sum, item) => sum + item.subtotal, 0);
      const originalPrice = productList.reduce((sum, item) => sum + item.originalSubtotal, 0);
      data = { price, originalPrice, discount: originalPrice - price, productPrice: price, productOriginalPrice: originalPrice, productList };
      if (args.items.some(item => item.productCode === 'coupon-coffee' && !item.couponId)) data = { price: 0, originalPrice: 0, discount: 0, productPrice: 0, productOriginalPrice: 0, productList: [] };
    } else throw new Error(`Unexpected read-only fixture tool: ${tool}`);
    const result = response(tool, data, clock());
    return transform ? await transform(result, args) : result;
  } };
}
