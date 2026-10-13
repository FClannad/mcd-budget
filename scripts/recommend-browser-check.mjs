import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../src/server.mjs';
import { AppError } from '../src/errors.mjs';
import { ROOT } from '../src/config.mjs';
import { QUOTE_TTL_MS } from '../src/live.mjs';
import { recommendationMcp, FIXTURE_TIME } from '../test/fixtures/recommend.mjs';
import { launchBrowser, until } from './lib/browser.mjs';

let now = FIXTURE_TIME, holdCoupon = false, failCoupon = false, rejectToken = false, releaseCoupon;
const mcp = recommendationMcp({ clock: () => now, transform: async result => {
  if (result.tool === 'query-store-coupons') {
    if (holdCoupon) { holdCoupon = false; await new Promise(resolveCoupon => { releaseCoupon = resolveCoupon; }); }
    if (rejectToken) { rejectToken = false; throw new AppError('TOKEN_REJECTED', '模拟凭证无效', 502); }
    if (failCoupon) { failCoupon = false; throw new AppError('MCP_TOOL_ERROR', 'fixture-private-error', 502); }
    result.result.structuredContent.data[0].title += ' <img src=x onerror=alert(1)>';
  }
  return result;
} });
const server = createApp({ mcpClient: mcp, clock: () => now });
const base = resolve(ROOT, '.local/recommend-browser-check');
mkdirSync(base, { recursive: true });
const output = mkdtempSync(join(base, 'run-'));
const report = { source: 'offline-recommendation-ui-fixture', liveMcpTested: false, startedAt: new Date().toISOString(), timeZone: 'Asia/Shanghai', assertions: [], artifacts: [] };
const issues = [], externalRequests = [];
let browser;
async function step(name, work) {
  try { await work(); report.assertions.push({ name, passed: true }); console.log(`OK   ${name}`); }
  catch (failure) { report.assertions.push({ name, passed: false, message: failure.message }); throw failure; }
}

try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();
  const { cdp } = browser;
  report.browser = (await cdp.send('Browser.getVersion')).product;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params = {}) => cdp.send(method, params, sessionId);
  const evaluate = async expression => {
    const result = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = (expression, description) => until(() => evaluate(expression), description);
  const input = (selector, value) => evaluate(`(() => { const control = document.querySelector(${JSON.stringify(selector)}); control.value = ${JSON.stringify(String(value))}; control.dispatchEvent(new Event('input', {bubbles:true})); control.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  const check = (selector, value) => evaluate(`(() => { const control = document.querySelector(${JSON.stringify(selector)}); control.checked = ${Boolean(value)}; control.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  const click = async selector => {
    const point = await evaluate(`(() => { const control = document.querySelector(${JSON.stringify(selector)}); if (!control || control.disabled) throw new Error('Missing or disabled control: ' + ${JSON.stringify(selector)}); control.scrollIntoView({block:'center',behavior:'instant'}); const bounds = control.getBoundingClientRect(); if (!bounds.width || !bounds.height) throw new Error('Hidden control'); return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2}; })()`);
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const settled = () => wait(`document.querySelector('#live-workspace').getAttribute('aria-busy') === 'false'`, 'recommendation request settled');
  const advance = async delta => { now += delta; await evaluate(`window.__mockNow = ${now}`); };
  const reset = async () => {
    await advance(61000);
    await click('#live-search'); await settled(); await click('[data-live-store="fixture-store"]'); await settled();
    await input('#live-budget', 25); await input('#live-people', 1); await input('#live-main-kind', 'any');
    await check('#live-want-drink', true); await check('#live-use-coupons', true);
  };
  const recommend = async () => { await click('#live-recommend'); await settled(); };
  const screenshot = async name => {
    await evaluate(`document.querySelector('.live-auto').scrollIntoView({block:'start',behavior:'instant'}); document.querySelector('#toast').hidden = true`);
    const image = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(output, name), Buffer.from(image.data, 'base64')); report.artifacts.push(name);
  };
  cdp.on('Runtime.exceptionThrown', event => issues.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text));
  cdp.on('Log.entryAdded', ({ entry }) => { if (entry.source === 'security' && entry.level === 'error') issues.push(entry.text); });
  cdp.on('Fetch.requestPaused', event => {
    const local = new URL(event.request.url).origin === origin;
    if (!local) externalRequests.push(event.request.url);
    page(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: event.requestId, ...(local ? {} : { errorReason: 'BlockedByClient' }) }).catch(failure => issues.push(failure.message));
  });
  await page('Page.enable'); await page('Runtime.enable'); await page('Log.enable');
  await page('Fetch.enable', { patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }] });
  await page('Page.addScriptToEvaluateOnNewDocument', { source: `window.__mockNow = ${now}; Date.now = () => window.__mockNow; window.__copied = ''; Object.defineProperty(navigator, 'clipboard', {value:{writeText:async value => {window.__copied = value;}}});` });
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page('Page.navigate', { url: `${origin}/#live` });

  await step('recommendation UI: page loading does not access account coupons or select a store', async () => {
    await wait(`!document.querySelector('#live-search')?.disabled`, 'live UI initialized');
    assert.equal(mcp.calls.length, 0); assert.equal(await evaluate(`document.querySelector('#live-recommend').disabled`), true);
    await reset(); assert.equal(await evaluate(`document.querySelector('#live-recommend').disabled`), false);
    assert.ok(!mcp.calls.some(call => call.tool === 'query-store-coupons'));
  });
  await step('recommendation UI: one click generates ranked meals without manually adding products', async () => {
    await recommend();
    const prices = await evaluate(`[...document.querySelectorAll('#live-ranked-plans [data-payable]')].map(element => Number(element.dataset.payable))`);
    assert.ok(prices.length > 0 && prices.length <= 5); assert.equal(prices[0], 1400);
    assert.deepEqual(prices, [...prices].sort((left, right) => left - right));
    assert.equal(await evaluate(`document.querySelector('#live-quote').disabled`), true);
    assert.match(await evaluate(`document.querySelector('#live-recommend-status').textContent`), /实付从低到高/);
    await screenshot('desktop-recommend-fixture.png');
  });
  await step('recommendation UI: coupon reference distinguishes extra savings from a more expensive whole meal', async () => {
    const content = await evaluate(`document.querySelector('#live-coupon-results').textContent`);
    assert.match(content, /¥19\.50/); assert.match(content, /比本轮最低方案贵 ¥5\.50/);
    assert.match(content, /少付 ¥5\.00/); assert.match(content, /不能把官方优惠合计/);
    assert.equal(await evaluate(`document.querySelectorAll('img[src="x"]').length`), 0);
    assert.equal(await evaluate(`document.body.textContent.includes('fixture-private')`), false);
  });
  await step('recommendation UI: save and copy preserve coupon, exact options, source and non-order disclaimer', async () => {
    const selector = await evaluate(`(() => { const card = [...document.querySelectorAll('#live-ranked-plans .live-recommendation')].find(element => element.textContent.includes('携券核价')); return '[data-live-plan-copy="' + card.dataset.livePlan + '"]'; })()`);
    await click(selector);
    const copied = await evaluate('window.__copied');
    assert.match(copied, /非订单/); assert.match(copied, /携券核价/); assert.match(copied, /¥19\.50/);
    assert.match(copied, /calculate-price/); assert.ok(!/fixture-private|couponId|couponCode/.test(copied));
    await click('[data-live-plan-save]');
    assert.equal(await evaluate(`document.querySelectorAll('#live-comparisons article').length`), 1);
    assert.equal(await evaluate(`document.querySelector('[data-live-plan-save]').disabled`), true);
  });
  for (const width of [1024, 768, 390, 320]) await step(`recommendation UI: ${width}px layout has no horizontal overflow`, async () => {
    await page('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width < 600 });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true);
    if (width === 390) await screenshot('mobile-recommend-fixture.png');
  });
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await step('recommendation UI: edited budgets clear old rankings and show over-budget references separately', async () => {
    const before = mcp.calls.length; await input('#live-budget', 1);
    assert.equal(await evaluate(`document.querySelectorAll('[data-live-plan]').length`), 0);
    assert.equal(await evaluate(`document.querySelectorAll('#live-comparisons article').length`), 0); assert.equal(mcp.calls.length, before);
    await reset(); await input('#live-budget', 1); await recommend();
    assert.equal(await evaluate(`document.querySelectorAll('#live-ranked-plans [data-live-plan]').length`), 0);
    assert.ok(await evaluate(`document.querySelectorAll('#live-over-plans [data-live-plan]').length > 0`));
    assert.match(await evaluate(`document.querySelector('#live-recommend-results').textContent`), /不代表整个菜单无解/);
    assert.equal(await evaluate(`document.querySelector('#live-budget').value`), '1');
  });
  await step('recommendation UI: multiple people never reuse one coupon asset', async () => {
    await reset(); await input('#live-people', 2); await recommend();
    assert.match(await evaluate(`document.querySelector('#live-coupon-results').textContent`), /多人方案不复用这张券/);
    assert.match(await evaluate(`document.querySelector('#live-ranked-plans').textContent`), /2 人合计/);
  });
  await step('recommendation UI: disabling coupon reference stops the account lookup', async () => {
    await reset(); await check('#live-use-coupons', false);
    const before = mcp.calls.filter(call => call.tool === 'query-store-coupons').length;
    await recommend();
    assert.equal(mcp.calls.filter(call => call.tool === 'query-store-coupons').length, before);
    assert.match(await evaluate(`document.querySelector('#live-coupon-results').textContent`), /本次未查询个人券/);
  });
  await step('recommendation UI: a failed new request removes old results and leaves no stuck loading label', async () => {
    await reset(); await recommend(); rejectToken = true; await recommend();
    assert.equal(await evaluate(`document.querySelectorAll('[data-live-plan]').length`), 0);
    assert.equal(await evaluate(`document.querySelector('#live-error').hidden`), false);
    assert.match(await evaluate(`document.querySelector('#live-recommend-status').textContent`), /推荐失败/);
  });
  await step('recommendation UI: preference edits ignore both late success and late errors', async () => {
    for (const fail of [false, true]) {
      await reset(); holdCoupon = true; releaseCoupon = null;
      await click('#live-recommend'); await until(() => releaseCoupon, 'held coupon query');
      await input('#live-main-kind', 'fish'); rejectToken = fail; releaseCoupon(); await settled();
      assert.equal(await evaluate(`document.querySelectorAll('[data-live-plan]').length`), 0);
      assert.equal(await evaluate(`document.querySelector('#live-error').hidden`), true);
      assert.match(await evaluate(`document.querySelector('#live-status').textContent`), /旧请求的返回已忽略/);
    }
  });
  await step('recommendation UI: expiration disables old coupon cards without automatic network refresh', async () => {
    await reset(); await recommend();
    const before = mcp.calls.length; await advance(QUOTE_TTL_MS + 1);
    await wait(`document.querySelector('[data-live-plan-copy]').disabled`, 'recommendation expiry');
    assert.match(await evaluate(`document.querySelector('#live-recommend-status').textContent`), /已过期/);
    assert.equal(mcp.calls.length, before);
    await recommend(); assert.equal(await evaluate(`document.querySelector('[data-live-plan-copy]').disabled`), false);
  });
  await step('recommendation UI: failed coupon lookup is explicit but valid no-coupon meals remain useful', async () => {
    await reset(); failCoupon = true; await recommend();
    assert.match(await evaluate(`document.querySelector('#live-coupon-results').textContent`), /不等于没有券/);
    assert.ok(await evaluate(`document.querySelectorAll('#live-ranked-plans [data-live-plan]').length > 0`));
  });
  await step('recommendation UI: changing location clears coupons, results and saved comparisons', async () => {
    await input('#live-keyword', '另一个公共地标');
    assert.equal(await evaluate(`document.querySelector('#live-workspace').hidden`), true);
    assert.equal(await evaluate(`document.querySelector('#live-coupon-results').textContent`), '');
    assert.equal(await evaluate(`document.querySelectorAll('[data-live-plan]').length`), 0);
  });
  await step('recommendation UI: no external page traffic, secret fields, unsafe tool calls or script errors', async () => {
    assert.deepEqual(externalRequests, []); assert.deepEqual(issues, []);
    assert.equal(await evaluate(`document.body.textContent.includes('fixture-private')`), false);
    assert.ok(mcp.calls.every(call => ['query-nearby-stores', 'query-meals', 'query-meal-detail', 'query-store-coupons', 'calculate-price'].includes(call.tool)));
  });
  report.passed = true;
} catch (failure) {
  report.passed = false; report.error = failure.stack; process.exitCode = 1; console.error(failure.stack);
} finally {
  releaseCoupon?.(); await browser?.close();
  server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
  report.completedAt = new Date().toISOString();
  writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n自动推荐离线浏览器检查：${report.assertions.filter(item => item.passed).length}/${report.assertions.length}。${output}`);
  console.log('合成 fixture，不读取 .env，不调用真实 MCP；剪贴板为测试替身。');
}
