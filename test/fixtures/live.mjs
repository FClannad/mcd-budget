export const stores = [{ storeCode: 'fixture-store', storeName: '适配测试餐厅（模拟）', address: '公共地标测试路 1 号',
  businessStatus: true, distance: 120, businessStartTime: '00:00', businessEndTime: '23:59',
  reservation: true, reservationTimeOptions: [{ date: '2026-10-13', today: true, reservationOptionText: '午餐(10:30至14:00)' }],
  latitude: 0, longitude: 0, privateAccount: 'must-not-leave-server' },
{ storeCode: 'closed-store', storeName: '未营业测试店（模拟）', businessStatus: false }];

export const menu = {
  categories: [{ name: '鸡肉汉堡\n/卷', meals: [{ code: 'main' }] },
    { name: '饮品', meals: [{ code: 'drink' }] }, { name: '随心配', meals: [{ code: 'bundle' }] },
    { name: '其他', meals: [{ code: 'side' }, { code: 'complex' }] }],
  meals: { main: { name: '模拟汉堡', currentPrice: '17', originalPrice: '17' },
    drink: { name: '模拟饮品', currentPrice: '9.5', originalPrice: '9.5' },
    bundle: { name: '模拟随心配', currentPrice: '14起', originalPrice: '14起' },
    side: { name: '模拟小食', currentPrice: '8' }, complex: { name: '模拟复杂套餐' } },
};

const choices = [
  { code: 'small', name: '模拟饮品小杯', quantity: 1, maxQuantity: -1, isDefault: 1, diffPrice: '+ ¥0', supportModify: true },
  { code: 'medium', name: '模拟饮品中杯', quantity: 0, maxQuantity: -1, isDefault: 1, diffPrice: '+ ¥0.5', supportModify: true },
];
export const details = {
  main: { code: 'main', name: '模拟汉堡', rounds: [], supportModify: true, modification: { privateOption: 'not-in-the-ui' } },
  side: { code: 'side', name: '模拟小食', rounds: [], supportModify: false },
  drink: { code: 'drink', name: '模拟饮品', supportModify: false,
    rounds: [{ id: 1, name: '选择饮品', quantity: 1, maxQuantity: 1, minQuantity: 1, choices }] },
  bundle: { code: 'bundle', name: '模拟随心配', supportModify: false, rounds: [
    { id: 1, name: '主食区', quantity: 1, maxQuantity: 1, minQuantity: 1,
      choices: [{ code: 'main', name: '模拟汉堡', quantity: 1, maxQuantity: -1, isDefault: 1, diffPrice: '+ ¥0', supportModify: true }] },
    { id: 2, name: '饮品区', quantity: 1, maxQuantity: 1, minQuantity: 1, choices },
  ] },
  complex: { code: 'complex', name: '模拟复杂套餐', rounds: [{ id: 1, name: '多选区', quantity: 2, maxQuantity: 2, minQuantity: 2, choices }] },
};

export function response(tool, data, now = Date.now()) {
  return { source: 'mcp', tool, receivedAt: new Date(now).toISOString(), result: { isError: false,
    structuredContent: { success: true, code: 200, message: '请求成功', traceId: 'private-trace-not-for-browser', data: structuredClone(data) } } };
}

export function fixtureMcp({ clock = Date.now, transform } = {}) {
  const calls = [];
  return { configured: true, calls, async callTool(tool, args) {
    calls.push({ tool, args: structuredClone(args) });
    let data;
    if (tool === 'query-nearby-stores') data = stores;
    else if (tool === 'query-meals') data = menu;
    else if (tool === 'query-meal-detail') data = details[args.code];
    else if (tool === 'calculate-price') {
      const productList = args.items.map(item => {
        const medium = item.roundList?.some(round => round.comboItemList.some(choice => choice.code === 'medium'));
        const subtotal = ({ main: 1700, drink: 950, side: 800, bundle: 1400 }[item.productCode] + (medium ? 50 : 0)) * item.quantity;
        return { productCode: item.productCode, productName: menu.meals[item.productCode].name, quantity: item.quantity, originalSubtotal: subtotal, subtotal };
      });
      const price = productList.reduce((sum, product) => sum + product.subtotal, 0);
      data = { productList, price, productPrice: price, productOriginalPrice: price, originalPrice: price, discount: 0 };
    } else throw new Error(`Unexpected fixture tool: ${tool}`);
    const result = response(tool, data, clock());
    return transform ? await transform(result, args) : result;
  } };
}
