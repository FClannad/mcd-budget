import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.mjs';
import { planMeals } from '../src/planner.mjs';
import { formatMoney } from '../src/money.mjs';

try {
  const args = process.argv.slice(2), input = { drink: false }, flags = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (['--budget', '--people', '--main'].includes(key) && (args[i + 1] === undefined || args[i + 1].startsWith('--'))) {
      throw new Error(`${key} 后需要提供一个值，不能省略或使用下一个选项代替。`);
    }
    if (key === '--budget') input.budget = args[++i];
    else if (key === '--people') input.people = Number(args[++i]);
    else if (key === '--drink') input.drink = true;
    else if (key === '--side') input.side = true;
    else if (key === '--no-coupons') input.useCoupons = false;
    else if (key === '--main') input.mainKind = args[++i];
    else if (key === '--json') flags.add('json');
    else if (key === '--demo') continue;
    else throw new Error(`未知参数：${key}`);
  }
  const catalogue = JSON.parse(readFileSync(resolve(ROOT, 'data/demo.json'), 'utf8'));
  const result = planMeals(input, catalogue);
  if (flags.has('json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('【固定演示数据，不是官方实时价格】');
    console.log(`总预算 ¥${formatMoney(result.request.totalBudgetCents)} / ${result.request.people} 人`);
    for (const [i, plan] of result.plans.entries()) {
      console.log(`${i + 1}. ${plan.lines.map(item => `${item.name} ×${item.quantity}`).join(' + ')}`);
      console.log(`   样例实付 ¥${formatMoney(plan.payableCents)}；预算剩余 ¥${formatMoney(plan.remainingCents)}`);
    }
    if (!result.plans.length) console.log(result.minimumTotalCents === null ? '没有符合条件的候选。' : `暂时无解，样例最低总价 ¥${formatMoney(result.minimumTotalCents)}，不会自动提高预算。`);
    if (result.topUp?.kind === 'costs-more') console.log(`凑单提醒：多加 ${result.topUp.extra.name} 可多优惠 ¥${formatMoney(result.topUp.additionalDiscountCents)}，但实付反而增加 ¥${formatMoney(result.topUp.extraSpendCents)}。`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
