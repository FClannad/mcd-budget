import { initializeLive } from './live.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { csrf: '', catalogue: null, result: null, people: 1, selected: null, tools: [], dirty: false, requestId: 0 };
const money = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const shortMoney = cents => money(cents).replace(/\.00$/, '');
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const labels = { main: '主食', drink: '饮品', side: '小食' };
let toastTimer;

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200);
}
function showError(selector, message = '') {
  $(selector).textContent = message;
  $(selector).hidden = !message;
}
async function api(path, body) {
  let response;
  try {
    response = await fetch(path, body === undefined ? { signal: AbortSignal.timeout(90000) } : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf },
      body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
    });
  } catch { throw new Error('无法连接本地服务或请求超时，请确认服务仍在运行。'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('本地服务返回了无法读取的内容。'); }
  if (!response.ok) throw new Error(data.error?.message ?? '请求失败，请稍后重试。');
  return data;
}

function currentInput() {
  return { budget: $('#budget').value, people: state.people, drink: $('#want-drink').checked,
    side: $('#want-side').checked, useCoupons: $('#use-coupons').checked, mainKind: $('#main-kind').value };
}
function syncBudget() {
  const budget = Number($('#budget').value);
  $('#budget-range').value = Math.max(10, Math.min(60, budget || 10));
  for (const button of $$('[data-budget]')) {
    const selected = Number(button.dataset.budget) === budget;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}
function setDirty(dirty) {
  state.dirty = dirty && !!state.result;
  if (state.dirty) { state.selected = null; $('#receipt-dialog').close(); }
  $('#stale-notice').hidden = !state.dirty;
  $('.results-panel').classList.toggle('is-stale', state.dirty);
  for (const button of $$('[data-select-plan]')) button.disabled = state.dirty;
  $('#minimum-button').disabled = state.dirty;
}
function adjustPeople(delta) {
  state.people = Math.max(1, Math.min(6, state.people + delta));
  $('#people').value = String(state.people);
  $('#people-minus').disabled = state.people <= 1;
  $('#people-plus').disabled = state.people >= 6;
  setDirty(true);
}
function priceMarkup(cents) {
  const [whole, fraction] = money(cents).split('.');
  return `<small>¥</small>${whole}${fraction === '00' ? '' : `<span class="decimal">.${fraction}</span>`}`;
}
function artMarkup(plan, index) {
  const hasDrink = plan.lines.some(line => line.category === 'drink');
  const hasSide = plan.lines.some(line => line.category === 'side');
  return `<div class="card-art ${hasDrink ? '' : 'no-drink'} ${hasSide ? 'has-side' : ''}">
    <div class="card-flags"><span class="card-tag">${['最省预算', '换个口味', '另一种搭配'][index]}</span><span class="card-index">0${index + 1} /</span></div>
    ${hasDrink ? '<svg class="food-drink" aria-hidden="true"><use href="/assets/food.svg#drink"></use></svg>' : ''}
    ${hasSide ? '<svg class="food-side" aria-hidden="true"><use href="/assets/food.svg#fries"></use></svg>' : ''}
    <svg class="food-burger" aria-hidden="true"><use href="/assets/food.svg#burger"></use></svg></div>`;
}
function renderPlan(plan, index, result) {
  const items = plan.lines.filter(line => line.category !== 'main').map(line => line.name).join(' · ');
  return `<article class="plan-card ${index === 0 ? 'recommended' : ''}" aria-labelledby="plan-title-${index}">
    ${artMarkup(plan, index)}<div class="card-body"><h3 id="plan-title-${index}">${escapeHtml(plan.title)}</h3>
    <p class="card-items">${escapeHtml(items || '只要一份主食，也很好')}${result.request.people > 1 ? `<br>每人一份，共 ${result.request.people} 人` : ''}</p>
    <div class="card-price-line"><span class="card-price">${priceMarkup(plan.payableCents)}</span><span class="price-unit">${result.request.people > 1 ? `${result.request.people} 人合计` : '演示实付'}</span></div>
    <p class="remaining">预算还剩 ¥${money(plan.remainingCents)} <span aria-hidden="true">↗</span></p>
    <details class="price-details"><summary>这笔钱，怎么算的</summary><dl>${plan.lines.map(line => `<div><dt>${escapeHtml(line.name)} ×${line.quantity}</dt><dd>¥${money(line.priceCents * line.quantity)}</dd></div>`).join('')}
    ${plan.coupon ? `<div class="discount-row"><dt>${escapeHtml(plan.coupon.name)}</dt><dd>−¥${money(plan.discountCents)}</dd></div>` : ''}
    </dl><p class="source-line">演示核算，非官方实时核价。</p></details>
    <button class="${index === 0 ? 'primary-button' : 'secondary-button'} select-plan" data-select-plan="${index}">选这个 · 生成餐单 <span aria-hidden="true">↗</span></button></div></article>`;
}
function renderTopUp(result) {
  const topUp = result.topUp;
  $('#top-up').hidden = !topUp;
  if (!topUp) { $('#top-up').replaceChildren(); return; }
  const isTrap = topUp.kind === 'costs-more';
  const title = isTrap ? `别为了省 ${shortMoney(topUp.additionalDiscountCents)} 块，<strong>多花 ${shortMoney(topUp.extraSpendCents)} 块。</strong>` :
    `加一份后，实付${topUp.extraSpendCents < 0 ? `<strong>少了 ${shortMoney(-topUp.extraSpendCents)} 元。</strong>` : '<strong>没有增加。</strong>'}`;
  const text = isTrap ? `以最省预算方案为例：再买一份${topUp.extra.name}，虽然触发更大的满减，但你的实付反而增加。优惠数字，不等于真正省下的钱。` :
    `这是演示规则下的真实差额比较，不代表你必须多买。不需要的餐品，也可以不选。`;
  const budgetNote = topUp.afterCents > result.request.totalBudgetCents ?
    `凑单后超出总预算 ¥${money(topUp.afterCents - result.request.totalBudgetCents)}，不纳入推荐。` :
    '这里只做凑单对照，不会把额外餐品加入推荐。';
  $('#top-up').innerHTML = `<span class="top-up-icon" aria-hidden="true">${isTrap ? '↗' : '='}</span><div><p class="section-kicker">THE TOP-UP TRAP / 凑单前，算一笔</p><h3>${title}</h3><p>${escapeHtml(text)}</p><div class="top-up-comparison"><span>按需购买<strong>¥${money(topUp.beforeCents)}</strong></span><span class="arrow" aria-hidden="true">→</span><span>加小食凑单<strong>¥${money(topUp.afterCents)}</strong></span></div><p class="top-up-budget-note">${escapeHtml(budgetNote)}</p></div>`;
}
function renderResults(result) {
  state.result = result;
  state.selected = null;
  $('#receipt-dialog').close();
  $('#plan-count').textContent = result.plans.length ? String(result.plans.length).padStart(2, '0') : '00';
  $('#results-summary').textContent = `总预算 ¥${money(result.request.totalBudgetCents)} · ${result.request.people} 人 · ${result.searchedCount} 种样例组合中 ${result.feasibleCount} 种符合`;
  $('#plan-cards').innerHTML = result.plans.map((plan, index) => renderPlan(plan, index, result)).join('');
  $('#empty-state').hidden = result.plans.length > 0;
  if (!result.plans.length) {
    $('#empty-message').textContent = result.minimumTotalCents === null ? '演示菜单里没有满足当前主食与搭配要求的餐品。可以尝试更换条件。' :
      `按当前条件，演示最低合计 ¥${money(result.minimumTotalCents)}，比你的总预算多 ¥${money(result.shortfallCents)}。`;
    $('#minimum-button').hidden = result.minimumPerPersonCents === null;
    $('#minimum-button').textContent = result.minimumPerPersonCents === null ? '' : `我愿意调整到 ¥${money(result.minimumPerPersonCents)} / 人，再算一次`;
  }
  renderTopUp(result);
  setDirty(false);
}
async function calculate() {
  if (!$('#budget-form').reportValidity()) return;
  if (!state.csrf) { showError('#form-error', '本地服务尚未就绪，请刷新页面重试。'); return; }
  const payload = currentInput(), signature = JSON.stringify(payload), requestId = ++state.requestId;
  $('#plan-button').disabled = true;
  $('#plan-button').firstElementChild.textContent = '认真算账中…';
  $('#plan-cards').setAttribute('aria-busy', 'true');
  showError('#form-error');
  try {
    const result = await api('/api/demo/plan', payload);
    if (requestId !== state.requestId) return;
    renderResults(result);
    if (JSON.stringify(currentInput()) !== signature) setDirty(true);
  } catch (error) {
    // A late failure belongs to the old request, not to the newer result on screen.
    if (requestId !== state.requestId) return;
    showError('#form-error', error.message); setDirty(true);
  }
  finally {
    if (requestId === state.requestId) {
      $('#plan-button').disabled = false;
      $('#plan-button').firstElementChild.textContent = '帮我算一顿';
      $('#plan-cards').setAttribute('aria-busy', 'false');
    }
  }
}

function showReceipt(index) {
  if (state.dirty || !state.result?.plans[index]) return;
  const plan = state.result.plans[index], result = state.result;
  state.selected = { plan, result };
  $('#receipt-content').innerHTML = `<div class="receipt-header"><img src="/assets/icon.svg" alt=""><p>THE LITTLE BUDGET CLUB</p><h2 id="receipt-title">这一顿，安排好了。</h2><span class="receipt-stamp">DEMO · 非真实售价</span></div>
  <div class="receipt-info"><span>街角演示餐厅 · 自取样例</span><span>${result.request.people} 人同一组合</span></div>
  <div class="receipt-lines">${plan.lines.map(line => `<div class="receipt-line"><span>${escapeHtml(line.name)} ×${line.quantity}</span><span>¥${money(line.priceCents * line.quantity)}</span></div>`).join('')}
  ${plan.coupon ? `<div class="receipt-line receipt-coupon"><span>${escapeHtml(plan.coupon.name)}</span><span>−¥${money(plan.discountCents)}</span></div>` : ''}</div>
  <div class="receipt-total"><span>演示合计</span><strong>¥${money(plan.payableCents)}</strong></div><div class="receipt-budget"><span>总预算 ¥${money(result.request.totalBudgetCents)}</span><span>还剩 ¥${money(plan.remainingCents)}</span></div>
  <p class="receipt-disclaimer">此餐单仅用于项目演示，不是订单、优惠凭证或真实价格承诺。未执行任何下单或付款。</p>`;
  $('#receipt-dialog').showModal();
}
function receiptText() {
  if (!state.selected) return '';
  const { plan, result } = state.selected;
  return ['麦麦不超支｜固定演示餐单（非真实售价）', `街角演示餐厅 · ${result.request.people} 人同一组合`,
    ...plan.lines.map(line => `${line.name} ×${line.quantity}：¥${money(line.priceCents * line.quantity)}`),
    plan.coupon ? `${plan.coupon.name}：−¥${money(plan.discountCents)}` : '未使用演示优惠券',
    `演示合计：¥${money(plan.payableCents)}`, `总预算：¥${money(result.request.totalBudgetCents)}；还剩 ¥${money(plan.remainingCents)}`,
    '预算是上限，不是目标。', '此餐单仅为演示；未下单、未付款，不是优惠凭证。'].join('\n');
}
async function downloadReceipt() {
  if (!state.selected) return;
  const { plan, result } = state.selected;
  const canvas = document.createElement('canvas');
  canvas.width = 1000;
  canvas.height = 1050 + plan.lines.length * 66 + (plan.coupon ? 66 : 0);
  const ctx = canvas.getContext('2d');
  const text = (value, x, y, size = 26, color = '#322d28', weight = '400', align = 'left') => {
    ctx.font = `${weight} ${size}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(value, x, y);
  };
  ctx.fillStyle = '#f8f5ee'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#a34336'; ctx.fillRect(0, 0, 1000, 265);
  text('THE LITTLE BUDGET CLUB', 500, 76, 19, '#f2d7b4', '600', 'center');
  text('麦麦不超支', 500, 154, 61, '#fff7e6', '700', 'center');
  text('预算是上限，不是目标。', 500, 212, 23, '#f2d7b4', '400', 'center');
  ctx.strokeStyle = '#b87853'; ctx.lineWidth = 2;
  ctx.strokeRect(319, 311, 362, 57);
  text('DEMO · 非真实售价', 500, 349, 26, '#a34336', '600', 'center');
  text('这一顿，安排好了。', 500, 447, 42, '#322d28', '700', 'center');
  text(`街角演示餐厅 · ${result.request.people} 人同一组合`, 500, 498, 23, '#80776a', '400', 'center');
  const rule = y => { ctx.beginPath(); ctx.setLineDash([7, 8]); ctx.moveTo(85, y); ctx.lineTo(915, y); ctx.strokeStyle = '#c6b79f'; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]); };
  rule(535);
  let y = 597;
  for (const line of plan.lines) {
    text(`${line.name} ×${line.quantity}`, 85, y, 29);
    text(`¥${money(line.priceCents * line.quantity)}`, 915, y, 29, '#322d28', '400', 'right'); y += 66;
  }
  if (plan.coupon) { text(plan.coupon.name, 85, y, 27, '#5d775b'); text(`−¥${money(plan.discountCents)}`, 915, y, 28, '#5d775b', '400', 'right'); y += 66; }
  rule(y - 15);
  y += 63;
  text('演示合计', 85, y, 27);
  text(`¥${money(plan.payableCents)}`, 915, y + 5, 62, '#a34336', '700', 'right');
  y += 71;
  text(`总预算 ¥${money(result.request.totalBudgetCents)}`, 85, y, 25, '#80776a');
  text(`还剩 ¥${money(plan.remainingCents)}`, 915, y, 25, '#5d775b', '600', 'right');
  y += 76;
  ctx.fillStyle = '#ece5d9'; ctx.beginPath(); ctx.roundRect(70, y, 860, 112, 16); ctx.fill();
  text('仅为演示餐单，不是订单、优惠凭证或真实价格承诺。', 500, y + 44, 22, '#847460', '400', 'center');
  text('不自动下单 · 未付款 · 不上传数据', 500, y + 82, 20, '#847460', '400', 'center');
  text('MADE FOR A LITTLE LESS SPENDING.', 500, canvas.height - 63, 17, '#a18a6a', '600', 'center');
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('图片生成失败，请尝试复制餐单。');
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `mcd-budget-demo-${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())}.png`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('演示餐单图片已生成，正在交给浏览器保存。');
}
function renderMenu() {
  if (!state.catalogue) return;
  const menu = state.catalogue;
  $('#menu-content').innerHTML = Object.entries(labels).map(([category, label]) => `<div class="menu-category">${label}</div>${menu.items.filter(item => item.category === category).map(item => `<div class="menu-item"><span>${escapeHtml(item.name)}</span><span>¥${money(item.priceCents)}</span></div>`).join('')}`).join('') +
    `<p class="menu-coupon-note">演示券：${menu.coupons.map(coupon => escapeHtml(coupon.name)).join(' / ')}。每单最多使用一张；仅作用于当前演示门店、自取样例。</p>`;
}

function showView(view, updateHash = true) {
  if (!['planner', 'live', 'mcp', 'about'].includes(view)) view = 'planner';
  for (const section of $$('[data-view]')) section.hidden = section.dataset.view !== view;
  for (const button of $$('.main-nav [data-nav]')) {
    const active = button.dataset.nav === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  if (updateHash) history.replaceState(null, '', view === 'planner' ? location.pathname : `#${view}`);
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function showTool() {
  const tool = state.tools.find(item => item.name === $('#mcp-tool').value);
  if (!tool) return;
  $('#mcp-schema').textContent = JSON.stringify(tool.inputSchema, null, 2);
  $('#mcp-tool-description').textContent = tool.description;
  const defaults = Object.fromEntries(Object.entries(tool.inputSchema.properties ?? {}).filter(([, property]) => property && Object.hasOwn(property, 'default')).map(([key, property]) => [key, property.default]));
  $('#mcp-args').value = JSON.stringify(defaults, null, 2);
  $('#mcp-args').disabled = false;
  $('#mcp-call').disabled = false;
  $('#mcp-result-status').textContent = '尚未调用所选工具';
  $('#mcp-output').textContent = '填写真实参数后，再点击执行。不会猜测门店编码、金额单位或套餐结构。';
}
async function connectMcp() {
  showError('#mcp-error');
  $('#mcp-connect').disabled = true;
  $('#mcp-connect').textContent = '正在读取真实工具…';
  $('#mcp-tool').disabled = true; $('#mcp-call').disabled = true; $('#mcp-args').disabled = true;
  $('#mcp-result-status').textContent = '正在连接';
  $('#mcp-output').textContent = '正在连接官方 MCP；失败不会使用演示数据替代。';
  state.tools = [];
  try {
    const data = await api('/api/mcp/tools', {});
    state.tools = data.tools;
    $('#mcp-tool').replaceChildren(...state.tools.map(tool => new Option(tool.name, tool.name)));
    $('#mcp-tool').disabled = !state.tools.length;
    $('#mcp-connection-status').textContent = `已连接官方 MCP，当前可用只读工具 ${state.tools.length} 个。`;
    if (!state.tools.length) {
      $('#mcp-result-status').textContent = '没有白名单内工具';
      $('#mcp-output').textContent = '服务端没有返回本项目支持的工具，请检查权限或接口版本。';
    } else showTool();
  } catch (error) {
    showError('#mcp-error', error.message);
    $('#mcp-connection-status').textContent = '连接未完成，未获取真实数据。';
    $('#mcp-result-status').textContent = '连接失败';
    $('#mcp-output').textContent = '没有有效真实结果。演示页数据没有被当作接口返回。';
  } finally {
    $('#mcp-connect').disabled = false;
    $('#mcp-connect').textContent = '连接并读取工具 →';
  }
}
async function callMcp() {
  showError('#mcp-error');
  let args;
  try { args = JSON.parse($('#mcp-args').value); } catch { showError('#mcp-error', '参数不是有效 JSON，请先检查逗号、引号和括号。'); return; }
  $('#mcp-call').disabled = true;
  $('#mcp-tool').disabled = true;
  $('#mcp-result-status').textContent = '只读查询中…';
  $('#mcp-output').textContent = '等待官方返回…';
  try {
    const result = await api('/api/mcp/call', { name: $('#mcp-tool').value, arguments: args });
    $('#mcp-output').textContent = JSON.stringify(result, null, 2);
    $('#mcp-result-status').textContent = '工具已返回 · 仍需检查业务状态与金额单位';
  } catch (error) {
    showError('#mcp-error', error.message);
    $('#mcp-result-status').textContent = '请求失败';
    $('#mcp-output').textContent = '此次调用没有有效结果，未回退到演示数据。';
  } finally { $('#mcp-call').disabled = false; $('#mcp-tool').disabled = false; }
}

$('#budget-form').addEventListener('submit', event => { event.preventDefault(); calculate(); });
$('#budget').addEventListener('input', () => { syncBudget(); setDirty(true); });
$('#budget-range').addEventListener('input', event => { $('#budget').value = event.target.value; syncBudget(); setDirty(true); });
for (const button of $$('[data-budget]')) button.addEventListener('click', () => { $('#budget').value = button.dataset.budget; syncBudget(); setDirty(true); });
for (const control of $$('#main-kind, #want-drink, #want-side, #use-coupons')) control.addEventListener('change', () => setDirty(true));
$('#people-minus').addEventListener('click', () => adjustPeople(-1));
$('#people-plus').addEventListener('click', () => adjustPeople(1));
$('#plan-cards').addEventListener('click', event => { const button = event.target.closest('[data-select-plan]'); if (button) showReceipt(Number(button.dataset.selectPlan)); });
$('#minimum-button').addEventListener('click', () => {
  if (state.dirty || !state.result || state.result.minimumPerPersonCents === null) return;
  $('#budget').value = money(state.result.minimumPerPersonCents); syncBudget(); calculate();
});
$('#menu-button').addEventListener('click', () => { if (!state.catalogue) { toast('菜单尚未加载，请刷新页面。'); return; } renderMenu(); $('#menu-dialog').showModal(); });
for (const button of $$('[data-close]')) button.addEventListener('click', () => document.getElementById(button.dataset.close).close());
for (const dialog of $$('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
$('#copy-receipt').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(receiptText()); toast('餐单已复制，演示标记也一起保留了。'); }
  catch { toast('浏览器未开放剪贴板权限，可以选择保存餐单图片。'); }
});
$('#download-receipt').addEventListener('click', () => downloadReceipt().catch(error => toast(error.message)));
for (const button of $$('[data-nav]')) button.addEventListener('click', () => showView(button.dataset.nav));
window.addEventListener('hashchange', () => showView(location.hash.slice(1), false));
$('#mcp-connect').addEventListener('click', connectMcp);
$('#mcp-tool').addEventListener('change', showTool);
$('#mcp-call').addEventListener('click', callMcp);

async function start() {
  syncBudget();
  if (['live', 'mcp', 'about'].includes(location.hash.slice(1))) showView(location.hash.slice(1), false);
  try {
    const [session, health, catalogue] = await Promise.all([api('/api/session'), api('/api/health'), api('/api/demo/catalogue')]);
    state.csrf = session.csrfToken;
    initializeLive({ api, toast, configured: health.mcpConfigured });
    state.catalogue = catalogue;
    $('#mcp-connection-status').textContent = health.mcpConfigured ? '本地已配置凭证。尚未联网验证，请手动连接。' : '尚未配置 Token；预算演示仍可完整使用。';
    await calculate();
  } catch (error) {
    showError('#form-error', error.message);
    $('#results-summary').textContent = '加载失败，请确认本地服务仍在运行。';
    $('#plan-cards').setAttribute('aria-busy', 'false');
    $('#mcp-connection-status').textContent = '无法读取本地配置状态。';
  }
}
start();
