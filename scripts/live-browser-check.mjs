import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../src/server.mjs';
import { ROOT } from '../src/config.mjs';
import { MENU_TTL_MS, QUOTE_TTL_MS } from '../src/live.mjs';
import { fixtureMcp } from '../test/fixtures/live.mjs';
import { launchBrowser, until } from './lib/browser.mjs';

let clockOffset = 0, failNextQuote = false, holdNextQuote = false, releaseQuote;
const mcp = fixtureMcp({ clock: () => Date.now() + clockOffset, transform: async result => {
  if (result.tool === 'query-meals') result.result.structuredContent.data.meals.side.name = '模拟小食 <img src=x onerror=alert(1)>';
  if (result.tool === 'calculate-price') {
    if (holdNextQuote) { holdNextQuote = false; await new Promise(resolveQuote => { releaseQuote = resolveQuote; }); }
    if (failNextQuote) { failNextQuote = false; result.result.structuredContent = { success: false, code: 409, data: {} }; }
  }
  return result;
} });
const server = createApp({ mcpClient: mcp, clock: () => Date.now() + clockOffset });
const base = resolve(ROOT, '.local/live-browser-check');
mkdirSync(base, { recursive: true });
const output = mkdtempSync(join(base, 'run-'));
const report = { source: 'offline-live-ui-fixture', liveMcpTested: false, startedAt: new Date().toISOString(), timeZone: 'Asia/Shanghai', assertions: [], artifacts: [] };
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
  const wait = (expression, name) => until(() => evaluate(expression), name);
  const input = (selector, value) => evaluate(`(() => { const control = document.querySelector(${JSON.stringify(selector)}); control.value = ${JSON.stringify(String(value))}; control.dispatchEvent(new Event('input', {bubbles:true})); control.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  const click = async selector => {
    const point = await evaluate(`(() => { const control = document.querySelector(${JSON.stringify(selector)}); if (!control || control.disabled) throw new Error('Missing or disabled: ' + ${JSON.stringify(selector)}); control.scrollIntoView({block:'center',behavior:'instant'}); const bounds = control.getBoundingClientRect(); if (!bounds.width || !bounds.height) throw new Error('Hidden control'); return {x:bounds.x+bounds.width/2, y:bounds.y+bounds.height/2}; })()`);
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const settled = () => wait(`document.querySelector('#live-workspace').getAttribute('aria-busy') === 'false'`, 'live request settled');
  const quote = async () => { await click('#live-quote'); await settled(); };
  const select = async code => { await click(`[data-live-product="${code}"]`); await settled(); };
  const screenshot = async name => {
    await evaluate('document.fonts.ready');
    await evaluate(`document.querySelector('#toast').hidden = true; window.scrollTo({top:0,behavior:'instant'})`);
    const { cssContentSize: size } = await page('Page.getLayoutMetrics');
    const image = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 } });
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
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page('Page.navigate', { url: `${origin}/#live` });

  await step('live UI: deep link is readable and never auto-calls the MCP fixture', async () => {
    await wait(`!document.querySelector('#live-search').disabled`, 'live UI initialized');
    assert.equal(await evaluate(`document.querySelector('#live-view').hidden`), false);
    assert.equal(await evaluate(`document.querySelector('#live-city').value`), '上海');
    assert.equal(mcp.calls.length, 0);
  });
  await step('live UI: explicit search and store selection precede all menu calls', async () => {
    await click('#live-search'); await settled();
    assert.equal(await evaluate(`document.querySelectorAll('.live-store-card').length`), 2);
    assert.equal(await evaluate(`document.querySelector('[data-live-store="closed-store"]').disabled`), true);
    assert.equal(mcp.calls.length, 1);
    await click('[data-live-store="fixture-store"]'); await settled();
    assert.equal(await evaluate(`document.querySelectorAll('[data-live-product]').length`), 5);
    assert.match(await evaluate(`document.querySelector('#live-store-title').textContent`), /模拟/);
  });
  await step('live UI: reference prices and untrusted names do not become quotes or HTML', async () => {
    assert.match(await evaluate(`document.querySelector('#live-products').textContent`), /菜单参考 · 非核价/);
    assert.match(await evaluate(`document.querySelector('#live-products').textContent`), /<img/);
    assert.equal(await evaluate(`document.querySelectorAll('#live-products img').length`), 0);
    assert.equal(await evaluate(`document.querySelector('#live-quote').disabled`), true);
    await input('#live-filter', '不存在的餐品');
    assert.match(await evaluate(`document.querySelector('#live-products').textContent`), /不会从昨天/);
    await input('#live-filter', '');
  });
  await step('live UI: real round selections use quantity defaults, not duplicate default flags', async () => {
    await select('main'); await click('#live-add');
    await select('drink');
    assert.equal(await evaluate(`document.querySelector('[data-live-round="1"]').value`), 'small');
    assert.match(await evaluate(`document.querySelector('#live-options').textContent`), /可特调/);
    await click('#live-add');
    assert.equal(await evaluate(`document.querySelectorAll('.live-basket-line').length`), 2);
  });
  await step('live UI: official quote over budget is never presented as a budget-fit recommendation', async () => {
    await quote();
    assert.equal(await evaluate(`document.querySelector('#live-current .live-total').textContent`), '¥26.50');
    assert.match(await evaluate(`document.querySelector('#live-current').textContent`), /超出预算 ¥1\.50/);
    assert.match(await evaluate(`document.querySelector('#live-current').textContent`), /不纳入预算内方案/);
    assert.equal(await evaluate(`document.querySelector('#live-budget').value`), '25');
    await click('#live-save');
  });
  await step('live UI: copy includes source, exact options, time and non-order disclaimer', async () => {
    await evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{globalThis.__copiedLive=text;}}})`);
    await click('#live-copy');
    const record = await wait('globalThis.__copiedLive', 'live copy');
    assert.match(record, /官方核价记录（非订单，不锁价）/); assert.match(record, /模拟饮品小杯/);
    assert.match(record, /北京时间/); assert.match(record, /calculate-price/); assert.match(record, /超预算：¥1\.50/);
  });
  await step('live UI: chosen bundle changes are officially requoted and compared, not treated as discounts', async () => {
    await click('[data-live-remove="main"]'); await click('[data-live-remove="drink"]');
    assert.equal(await evaluate(`document.querySelector('#live-copy').disabled`), true);
    await select('bundle'); await input('[data-live-round="2"]', 'medium'); await click('#live-add');
    await quote(); await click('#live-save');
    assert.equal(await evaluate(`document.querySelector('#live-current .live-total').textContent`), '¥14.50');
    assert.match(await evaluate(`document.querySelector('#live-comparisons').textContent`), /少付 ¥12\.00/);
    assert.match(await evaluate(`document.querySelector('#live-comparisons').textContent`), /差额不等于优惠/);
    assert.equal(mcp.calls.at(-1).args.items[0].roundList[1].comboItemList[0].code, 'medium');
    await screenshot('desktop-live-fixture.png');
  });
  for (const [width, height] of [[1024, 900], [768, 1000], [390, 844], [320, 780]]) {
    await step(`live UI: ${width}px layout has no horizontal overflow`, async () => {
      await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true);
      if (width === 390) await screenshot('mobile-live-fixture.png');
    });
  }
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await step('live UI: changing budget or people clears old quotes and multiplies parent quantities correctly', async () => {
    await input('#live-budget', '15'); await input('#live-people', '2');
    assert.equal(await evaluate(`document.querySelectorAll('#live-comparisons article').length`), 0);
    assert.equal(await evaluate(`document.querySelector('#live-copy').disabled`), true);
    await quote();
    assert.equal(await evaluate(`document.querySelector('#live-current .live-total').textContent`), '¥29.00');
    assert.match(await evaluate(`document.querySelector('#live-current').textContent`), /总预算 ¥30\.00/);
    assert.equal(mcp.calls.at(-1).args.items[0].quantity, 2);
    assert.equal(mcp.calls.at(-1).args.items[0].roundList[0].comboItemList[0].quantity, 1);
  });
  await step('live UI: business failure removes the previous quote without demo fallback; retry recovers', async () => {
    failNextQuote = true; await quote();
    assert.equal(await evaluate(`document.querySelectorAll('#live-current .live-total').length`), 0);
    assert.equal(await evaluate(`document.querySelector('#live-copy').disabled`), true);
    assert.match(await evaluate(`document.querySelector('#live-error').textContent`), /官方业务未成功/);
    await quote();
    assert.equal(await evaluate(`document.querySelector('#live-error').hidden`), true);
  });
  await step('live UI: edits during a held quote ignore both late success and failure', async () => {
    for (const fail of [false, true]) {
      holdNextQuote = true; releaseQuote = null;
      await click('#live-quote'); await until(() => releaseQuote, 'held quote');
      await input('#live-budget', fail ? '17' : '16');
      failNextQuote = fail; releaseQuote(); await settled();
      assert.equal(await evaluate(`document.querySelectorAll('#live-current .live-total').length`), 0);
      assert.equal(await evaluate(`document.querySelector('#live-error').hidden`), true);
      assert.match(await evaluate(`document.querySelector('#live-status').textContent`), /旧请求的返回已忽略/);
      await quote();
      assert.equal(await evaluate(`document.querySelector('#live-current .live-total').textContent`), '¥29.00');
    }
  });
  await step('live UI: expired quotes cannot be copied or saved and never auto-refresh', async () => {
    const before = mcp.calls.length;
    clockOffset = QUOTE_TTL_MS + 1000;
    await evaluate(`globalThis.__originalNow = Date.now; globalThis.__clockOffset = ${clockOffset}; Date.now = () => globalThis.__originalNow() + globalThis.__clockOffset`);
    await wait(`document.querySelector('#live-copy').disabled`, 'quote expiration');
    assert.match(await evaluate(`document.querySelector('#live-current').textContent`), /已过期/);
    assert.equal(mcp.calls.length, before);
    await quote();
    assert.equal(await evaluate(`document.querySelector('#live-copy').disabled`), false);
  });
  await step('live UI: expired menu prevents quote and product actions until explicit store refresh', async () => {
    clockOffset += MENU_TTL_MS;
    await evaluate(`globalThis.__clockOffset = ${clockOffset}`);
    await wait(`document.querySelector('#live-quote').disabled`, 'menu expiration');
    assert.match(await evaluate(`document.querySelector('#live-menu-meta').textContent`), /菜单已过期/);
    await click('#live-refresh'); await settled();
    assert.equal(await evaluate(`document.querySelector('#live-workspace').hidden`), true);
    assert.equal(await evaluate(`document.querySelectorAll('#live-comparisons article').length`), 0);
  });
  await step('live UI: no external requests, account fields, script injection or security errors', async () => {
    assert.deepEqual(externalRequests, []); assert.deepEqual(issues, []);
    const body = await evaluate('document.body.textContent');
    assert.ok(!body.includes('private-trace') && !body.includes('must-not-leave-server'));
    assert.ok(mcp.calls.every(call => ['query-nearby-stores', 'query-meals', 'query-meal-detail', 'calculate-price'].includes(call.tool)));
  });
  report.passed = true;
} catch (failure) {
  report.passed = false; report.error = failure.stack; process.exitCode = 1; console.error(failure.stack);
} finally {
  releaseQuote?.();
  await browser?.close();
  server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
  report.completedAt = new Date().toISOString();
  writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n真实预算页离线浏览器检查：${report.assertions.filter(item => item.passed).length}/${report.assertions.length}。${output}`);
  console.log('仅使用明确标记的模拟接口；不读取 .env，不调用官方 MCP，不代表真实核价证据。');
}
