import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../src/server.mjs';
import { ROOT } from '../src/config.mjs';
import { launchBrowser, until, delay } from './lib/browser.mjs';

// Deliberately do NOT load .env or use process.env.MCD_MCP_TOKEN. This is an offline demo test.
const server = createApp({ token: '' });
const base = resolve(ROOT, '.local/browser-check');
mkdirSync(base, { recursive: true });
const output = mkdtempSync(join(base, 'run-'));
const report = { source: 'offline-browser-test', liveMcpTested: false, timeZone: 'Asia/Shanghai',
  startedAt: new Date().toISOString(), node: process.version, assertions: [], artifacts: {} };
let browser, page, heldPlan, holdNextPlan = false;
const issues = [], externalRequests = [], requests = [], downloads = new Map();

async function step(name, work) {
  const start = Date.now();
  try { await work(); report.assertions.push({ name, passed: true, durationMs: Date.now() - start }); console.log(`OK   ${name}`); }
  catch (error) { report.assertions.push({ name, passed: false, error: error.message }); throw error; }
}

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();
  const { cdp } = browser;
  report.browser = (await cdp.send('Browser.getVersion')).product;
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output, eventsEnabled: true });
  cdp.on('Browser.downloadWillBegin', event => downloads.set(event.guid, { ...event, state: 'started' }));
  cdp.on('Browser.downloadProgress', event => Object.assign(downloads.get(event.guid) ?? {}, event));
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  page = (method, params = {}) => cdp.send(method, params, sessionId);
  const evaluate = async expression => {
    const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = (expression, label) => until(() => evaluate(expression), label);
  const click = async selector => {
    const point = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) throw new Error('Missing or disabled control: ' + ${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = element.getBoundingClientRect(); if (!r.width || !r.height) throw new Error('Hidden control');
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const input = async (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const ready = () => wait(`document.querySelector('#plan-cards').getAttribute('aria-busy') === 'false' && !document.querySelector('#plan-button').disabled`, 'planner settled');
  const submit = async () => { await click('#plan-button'); await ready(); };
  const screenshot = async name => {
    await evaluate('document.fonts.ready');
    await wait(`document.querySelector('#toast').hidden`, 'toast cleared for screenshot');
    await evaluate('window.scrollTo({ top: 0, behavior: "instant" })');
    await delay(100);
    const layout = await page('Page.getLayoutMetrics');
    const size = layout.cssContentSize;
    const image = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 } });
    writeFileSync(join(output, name), Buffer.from(image.data, 'base64'));
    report.artifacts[name] = name;
  };
  const viewport = (width, height, mobile = false) => page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  const noOverflow = async () => assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'page must not overflow horizontally');
  const releasePlan = async fail => {
    assert.ok(heldPlan, 'expected a held request');
    const requestId = heldPlan.requestId;
    heldPlan = null;
    if (fail) await page('Fetch.fulfillRequest', { requestId, responseCode: 503,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify({ error: { code: 'OFFLINE_TEST', message: '离线测试注入的旧请求错误' } })).toString('base64') });
    else await page('Fetch.continueRequest', { requestId });
  };
  cdp.on('Runtime.exceptionThrown', event => issues.push(`JS: ${event.exceptionDetails.exception?.description ?? event.exceptionDetails.text}`));
  cdp.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') issues.push('console.error: ' + event.args.map(arg => arg.value ?? arg.description).join(' ')); });
  cdp.on('Log.entryAdded', ({ entry }) => { if (entry.source === 'security' && entry.level === 'error') issues.push(`Security: ${entry.text}`); });
  cdp.on('Network.requestWillBeSent', event => { if (event.request.url.startsWith(origin)) requests.push(event.request.url); });
  cdp.on('Fetch.requestPaused', event => {
    (async () => {
      const url = new URL(event.request.url);
      if (url.origin !== origin) {
        externalRequests.push(event.request.url);
        await page('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); return;
      }
      if (holdNextPlan && url.pathname === '/api/demo/plan') {
        holdNextPlan = false; heldPlan = event; return;
      }
      await page('Fetch.continueRequest', { requestId: event.requestId });
    })().catch(error => issues.push(`Interception: ${error.message}`));
  });
  await page('Page.enable'); await page('Runtime.enable'); await page('Network.enable'); await page('Log.enable');
  await page('Fetch.enable', { patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }] });
  await page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await viewport(1440, 1000);
  await page('Page.navigate', { url: origin });

  await step('desktop: initial demo results and transparent top-up arithmetic', async () => {
    await wait(`document.querySelectorAll('.plan-card').length === 3`, 'three plan cards');
    await ready(); await noOverflow();
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.card-price')].map(el => el.textContent)`), ['¥22', '¥24', '¥25']);
    assert.match(await evaluate(`document.querySelector('#top-up').textContent`), /多花 3 块/);
    assert.match(await evaluate(`document.querySelector('.source-notice').textContent`), /固定演示/);
    assert.ok(await evaluate('[...document.images].every(image => image.complete && image.naturalWidth > 0)'));
    await screenshot('desktop.png');
  });
  await step('desktop: price breakdown and accessible receipt dialog', async () => {
    await click('.price-details summary');
    assert.ok(await evaluate(`document.querySelector('.price-details').open`));
    await click('[data-select-plan="0"]');
    assert.ok(await evaluate(`document.querySelector('#receipt-dialog').open`));
    const text = await evaluate(`document.querySelector('#receipt-content').textContent`);
    assert.match(text, /DEMO · 非真实售价/); assert.match(text, /22\.00/); assert.match(text, /未执行任何下单/);
  });
  await step('receipt: copy action retains demo markers (clipboard stub, not OS clipboard)', async () => {
    await evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { globalThis.__copiedText = text; } } })`);
    await click('#copy-receipt');
    const text = await wait('globalThis.__copiedText', 'copy handler');
    assert.match(text, /固定演示餐单（非真实售价）/); assert.match(text, /演示合计：¥22\.00/); assert.match(text, /未下单、未付款/);
  });
  await step('receipt: actual PNG download includes source watermark and price', async () => {
    await evaluate(`globalThis.__drawnText = []; const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, ...args) { globalThis.__drawnText.push(String(text)); return original.call(this, text, ...args); };`);
    await click('#download-receipt');
    const download = await until(() => [...downloads.values()].find(item => item.state === 'completed'), 'PNG download');
    assert.match(download.suggestedFilename, /^mcd-budget-demo-\d{4}-\d{2}-\d{2}\.png$/);
    const png = readFileSync(join(output, download.suggestedFilename));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), 1000); assert.ok(png.readUInt32BE(20) > 1000);
    assert.ok(png.length > 10000);
    const texts = await evaluate('globalThis.__drawnText');
    assert.ok(texts.includes('DEMO · 非真实售价') && texts.includes('¥22.00') && texts.some(text => text.includes('不自动下单')));
    report.artifacts.receipt = download.suggestedFilename;
    await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.ok(await evaluate(`!document.querySelector('#receipt-dialog').open`));
  });
  await step('planner: changed budget disables old receipt buttons', async () => {
    await input('#budget', 10);
    assert.ok(await evaluate(`!document.querySelector('#stale-notice').hidden`));
    assert.ok(await evaluate(`[...document.querySelectorAll('[data-select-plan]')].every(button => button.disabled)`));
  });
  await step('planner: no solution does not increase budget without user action', async () => {
    await submit();
    assert.ok(await evaluate(`!document.querySelector('#empty-state').hidden`));
    assert.equal(await evaluate(`document.querySelector('#budget').value`), '10');
    assert.match(await evaluate(`document.querySelector('#empty-message').textContent`), /22\.00/);
    assert.equal(await evaluate(`document.querySelectorAll('.plan-card').length`), 0);
    await click('#minimum-button'); await ready();
    assert.equal(await evaluate(`document.querySelector('#budget').value`), '22.00');
    assert.equal(await evaluate(`document.querySelectorAll('.plan-card').length`), 1);
    assert.match(await evaluate(`document.querySelector('.top-up-budget-note').textContent`), /超出总预算 ¥3\.00，不纳入推荐/);
  });
  await step('planner: group quantity and actual coupon saving are consistent', async () => {
    await input('#budget', 25); await click('#people-plus'); await submit();
    assert.match(await evaluate(`document.querySelector('.card-price').textContent`), /38/);
    assert.match(await evaluate(`document.querySelector('.price-details').textContent`), /冰柠檬茶 ×2/);
    assert.match(await evaluate(`document.querySelector('.price-details').textContent`), /演示满45减8/);
    await click('#want-side'); await submit();
    assert.match(await evaluate(`document.querySelector('.price-details').textContent`), /金黄小薯条 ×2/);
    await click('#use-coupons'); await submit();
    assert.ok(await evaluate(`!document.querySelector('#empty-state').hidden`));
    assert.match(await evaluate(`document.querySelector('#empty-message').textContent`), /60\.00/);
    await click('#people-minus'); await click('#want-side'); await click('#use-coupons'); await submit();
  });
  await step('planner: edits during an in-flight request leave its result stale', async () => {
    holdNextPlan = true; await click('#plan-button');
    await until(() => heldPlan, 'paused plan request');
    await input('#budget', 30); await releasePlan(false); await ready();
    assert.ok(await evaluate(`!document.querySelector('#stale-notice').hidden`));
    assert.ok(await evaluate(`[...document.querySelectorAll('[data-select-plan]')].every(button => button.disabled)`));
    await submit();
  });
  await step('planner: an older failed request cannot invalidate a newer success', async () => {
    holdNextPlan = true; await click('#plan-button');
    await until(() => heldPlan, 'older paused request');
    await input('#budget', 25);
    await evaluate(`document.querySelector('#budget-form').requestSubmit()`);
    await ready();
    assert.match(await evaluate(`document.querySelector('#results-summary').textContent`), /25\.00/);
    const networkId = heldPlan.networkId;
    let finished = false;
    const remove = cdp.on('Network.loadingFinished', event => { if (event.requestId === networkId) finished = true; });
    try { await releasePlan(true); await until(() => finished, 'old failure delivered'); }
    finally { remove(); }
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.ok(await evaluate(`document.querySelector('#form-error').hidden`), 'old errors must be ignored after a newer successful result');
    assert.ok(await evaluate(`document.querySelector('#stale-notice').hidden`));
  });
  await step('planner: current request failure invalidates old results and retry recovers', async () => {
    holdNextPlan = true; await click('#plan-button'); await until(() => heldPlan, 'failing current request');
    await releasePlan(true); await ready();
    assert.ok(await evaluate(`!document.querySelector('#form-error').hidden && !document.querySelector('#stale-notice').hidden`));
    await submit();
    assert.ok(await evaluate(`document.querySelector('#form-error').hidden && document.querySelector('#stale-notice').hidden`));
  });
  await step('MCP: missing Token is explicit and cannot turn demo output into a real result', async () => {
    await click('.main-nav [data-nav="mcp"]');
    assert.match(await evaluate(`document.querySelector('#mcp-connection-status').textContent`), /尚未配置 Token/);
    await click('#mcp-connect');
    await wait(`!document.querySelector('#mcp-error').hidden`, 'missing Token error');
    assert.match(await evaluate(`document.querySelector('#mcp-error').textContent`), /尚未配置 MCP Token/);
    assert.equal(await evaluate(`document.querySelector('#mcp-tool').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('#mcp-call').disabled`), true);
    assert.match(await evaluate(`document.querySelector('#mcp-output').textContent`), /没有有效真实结果/);
    await noOverflow(); await screenshot('mcp-unconfigured.png');
    await click('.main-nav [data-nav="planner"]');
  });
  for (const [width, height] of [[1024, 900], [768, 1024], [390, 844], [320, 740]]) {
    await step(`responsive: ${width}px has no horizontal page overflow`, async () => {
      await viewport(width, height, width < 600); await noOverflow();
      if (width === 390) {
        await screenshot('mobile.png');
        await click('[data-select-plan="0"]'); await noOverflow();
        assert.ok(await evaluate(`document.querySelector('#receipt-dialog').open`));
        await click('[data-close="receipt-dialog"]');
        await click('#menu-button'); await noOverflow();
        assert.match(await evaluate(`document.querySelector('#menu-content').textContent`), /演示满30减5/);
        await click('[data-close="menu-dialog"]');
        await click('.main-nav [data-nav="mcp"]'); await noOverflow();
        await click('.main-nav [data-nav="about"]'); await noOverflow();
        await click('.main-nav [data-nav="planner"]');
      }
    });
  }
  await step('safety: no external page requests, unhandled JS errors or CSP violations', async () => {
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(issues, []);
    assert.ok(requests.some(url => url.endsWith('/assets/food.svg')));
    assert.equal(readdirSync(output).filter(name => name.startsWith('mcd-budget-demo-')).length, 1);
  });
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message;
  console.error(`FAIL ${error.message}`); process.exitCode = 1;
  if (page) {
    try { const shot = await page('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(output, 'failure.png'), Buffer.from(shot.data, 'base64')); }
    catch { /* Preserve the original failure if the browser has already exited. */ }
  }
} finally {
  try { await browser?.close(); } catch (error) { console.error(`Cleanup failed: ${error.message}`); report.passed = false; process.exitCode = 1; }
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  report.finishedAt = new Date().toISOString(); report.externalRequests = externalRequests; report.issues = issues;
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(base, 'latest.json'), JSON.stringify({ output, passed: report.passed }, null, 2) + '\n');
  console.log(`\n浏览器检查：${report.assertions.filter(item => item.passed).length}/${report.assertions.length}；${report.passed ? '通过' : '未通过'}。`);
  console.log(`本地演示截图和报告：${output}`);
  console.log('未读取 Token、未调用真实 MCP；剪贴板使用测试替身。');
}