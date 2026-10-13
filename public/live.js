const element = selector => document.querySelector(selector);
const elements = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const money = cents => `${cents < 0 ? '−' : ''}¥${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
const time = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
const modified = item => `${item.name}${item.supportModify ? '【可特调】' : ''}`;
const couponComparisonText = comparison => comparison
  ? `同餐品、同规格不用券 ${money(comparison.withoutCouponCents)}；携券${comparison.savingCents > 0 ? '少付' : comparison.savingCents < 0 ? '多付' : '没有额外节省'}${comparison.savingCents ? ` ${money(Math.abs(comparison.savingCents))}` : ''}。`
  : '没有同餐品、同规格的有效无券核价，不能把官方优惠合计当作这张券额外省的钱。';

export function initializeLive({ api, toast, configured }) {
  const state = { search: null, menu: null, detail: null, basket: [], current: null, saved: [], recommendations: null, pending: false, revision: 0 };
  const expired = value => !value || Date.now() >= Date.parse(value.expiresAt);
  const status = message => { element('#live-status').textContent = message; };
  const error = (message = '') => { element('#live-error').textContent = message; element('#live-error').hidden = !message; };
  let expirySignature = '';

  function sync() {
    element('#live-search').disabled = !configured || state.pending;
    element('#live-refresh').disabled = state.pending;
    element('#live-quote').disabled = state.pending || !state.basket.length || expired(state.menu);
    element('#live-add').disabled = state.pending || !state.detail?.supported || expired(state.menu);
    element('#live-save').disabled = state.pending || expired(state.current) || state.saved.length >= 3 || state.saved.some(quote => quote.id === state.current?.id);
    element('#live-copy').disabled = state.pending || expired(state.current);
    element('#live-recommend').disabled = state.pending || expired(state.menu);
    for (const button of elements('[data-live-plan-save], [data-live-plan-copy]')) {
      const id = button.dataset.livePlanSave ?? button.dataset.livePlanCopy;
      const quote = findPlan(id);
      button.disabled = state.pending || expired(state.recommendations) || expired(quote) ||
        (button.hasAttribute('data-live-plan-save') && (state.saved.length >= 3 || state.saved.some(saved => saved.id === id)));
    }
    for (const button of elements('[data-live-store]')) button.disabled = state.pending || !state.search?.stores.find(store => store.code === button.dataset.liveStore)?.open;
    for (const button of elements('[data-live-product]')) button.disabled = state.pending || expired(state.menu);
    element('#live-workspace').setAttribute('aria-busy', String(state.pending));
    if (state.menu) element('#live-menu-meta').textContent = `${state.menu.store.address} · ${state.menu.items.length} 种餐品 · ${time(state.menu.receivedAt)}（北京时间）读取 · ${expired(state.menu) ? '菜单已过期，请重新搜索并选店' : '菜单快照保留 5 分钟'}`;
  }

  function invalidateCurrent(message = '餐单或条件已更改，请重新核价。', clearSaved = false) {
    state.revision++;
    state.current = null;
    element('#live-current').replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: message }));
    if (clearSaved) { state.saved = []; renderSaved(); }
    sync();
  }

  function clearMenu() {
    state.menu = null; state.detail = null; state.basket = [];
    element('#live-workspace').hidden = true;
    element('#live-detail-form').hidden = true;
    clearRecommendations();
    invalidateCurrent('没有有效核价。菜单标价不会被当作实付。', true);
    renderBasket();
  }

  async function run(message, request, consume, onFailure) {
    if (state.pending) return;
    const revision = state.revision;
    state.pending = true; error(); status(message); sync();
    try {
      const result = await request();
      if (revision !== state.revision) return;
      consume(result);
    } catch (failure) {
      if (revision !== state.revision) return;
      error(failure.message);
      onFailure?.();
      status('本次查询失败，没有生成或替换为演示结果。');
    } finally {
      state.pending = false;
      if (revision !== state.revision) status('条件已修改，旧请求的返回已忽略；请按当前条件重新查询。');
      sync();
    }
  }

  function renderStores() {
    element('#live-stores').innerHTML = state.search.stores.length ? state.search.stores.map(store => `<article class="live-store-card">
      <h3>${escapeHtml(store.name)}</h3><p>${escapeHtml(store.address)}</p>
      <p class="muted">${store.open ? '营业中' : '当前不可选'}${store.distanceMeters === null ? '' : ` · 接口距离 ${store.distanceMeters} 米`} · ${escapeHtml(store.hours || '营业时间未返回')}</p>
      <p class="live-code">门店编码 ${escapeHtml(store.code)}</p>
      ${store.reservation && store.reservationTimeOptions.length ? `<details><summary>官方预约时段（本页仅支持当前时段）</summary>${store.reservationTimeOptions.map(option => `<p>${escapeHtml(option.date)}${option.today ? '（今天）' : ''}：${escapeHtml(option.text)}</p>`).join('')}</details>` : ''}
      <button type="button" class="secondary-button" data-live-store="${escapeHtml(store.code)}" ${store.open ? '' : 'disabled'}>选择此店并读菜单</button></article>`).join('') : '<p class="muted">没有返回可选门店，请换一个公共地标重试。</p>';
  }

  function renderProducts() {
    if (!state.menu) return;
    const keyword = element('#live-filter').value.trim().toLocaleLowerCase();
    const category = element('#live-category').value;
    const items = state.menu.items.filter(item => (!category || item.categories.includes(category)) && `${item.name} ${item.code}`.toLocaleLowerCase().includes(keyword));
    element('#live-products').innerHTML = items.length ? items.map(item => `<button type="button" class="live-product ${state.detail?.code === item.code ? 'selected' : ''}" data-live-product="${escapeHtml(item.code)}">
      <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.categories.join(' / ') || '其他餐品')}</small></span>
      <span class="live-reference">${item.priceText === null ? '未提供标价' : `¥${escapeHtml(item.priceText)}`}<small>菜单参考 · 非核价</small></span></button>`).join('') : '<p class="muted">此次菜单没有匹配的餐品。不会从昨天的菜单补入。</p>';
    sync();
  }

  function renderDetail() {
    const detail = state.detail;
    element('#live-detail-form').hidden = false;
    element('#live-detail-title').textContent = modified(detail);
    element('#live-detail-note').textContent = detail.limitation;
    element('#live-quantity').value = '1';
    element('#live-options').innerHTML = detail.rounds.length ? detail.rounds.map(round => `<label class="field-label" for="live-round-${escapeHtml(round.id)}">${escapeHtml(round.name)} · 选一项
      <select id="live-round-${escapeHtml(round.id)}" data-live-round="${escapeHtml(round.id)}" required>
        <option value="" disabled ${round.defaultCode ? '' : 'selected'}>请明确选择规格</option>
        ${round.choices.map(choice => `<option value="${escapeHtml(choice.code)}" ${choice.code === round.defaultCode ? 'selected' : ''} ${choice.available ? '' : 'disabled'}>${escapeHtml(modified(choice))}${choice.priceDifferenceText ? ` · 参考差价 ${escapeHtml(choice.priceDifferenceText)}` : ''}</option>`).join('')}
      </select></label>`).join('') : '<p class="muted">单品，无套餐子项；使用原配方。</p>';
    element('#live-add').textContent = state.basket.some(item => item.code === detail.code) ? '更新餐单中的这份餐品' : '加入每人餐单 +';
    sync();
  }

  function selectedNames(item) {
    return item.choices.map(selected => {
      const round = item.detail.rounds.find(value => value.id === selected.round);
      const choice = round.choices.find(value => value.code === selected.code);
      return `${round.name}：${modified(choice)}`;
    }).join('；');
  }

  function renderBasket() {
    element('#live-basket').innerHTML = state.basket.length ? state.basket.map(item => `<div class="live-basket-line">
      <div><strong>${escapeHtml(modified(item.detail))}</strong><p>${escapeHtml(selectedNames(item) || '默认原配方')}</p></div>
      <label>每人份数<input type="number" data-live-quantity="${escapeHtml(item.code)}" aria-label="${escapeHtml(item.detail.name)}每人份数" value="${item.quantity}" min="1" max="6" step="1" required></label>
      <button type="button" class="text-button" data-live-remove="${escapeHtml(item.code)}" aria-label="移除${escapeHtml(item.detail.name)}">移除</button></div>`).join('') : '<p class="muted">还没有选餐。先点击左侧餐品，查看并确认规格。</p>';
    sync();
  }

  function quoteMarkup(quote, compact = false, groupExpired = false) {
    const isExpired = groupExpired || expired(quote);
    return `<div class="live-quote-card ${quote.withinBudget ? 'within-budget' : 'over-budget'} ${isExpired ? 'is-expired' : ''}">
      <p class="section-kicker">官方核价 / 非订单</p><p class="live-quote-status">${isExpired ? '已过期，仅作历史记录，请重新核价' : quote.withinBudget ? '这份餐单，在预算内' : '这份餐单超预算，不纳入预算内方案'}</p>
      <strong class="live-total">${money(quote.payableCents)}</strong><span class="muted"> / ${quote.request.people} 人合计</span>
      <p>${quote.withinBudget ? `预算剩余 ${money(quote.remainingCents)}` : `超出预算 ${money(-quote.remainingCents)}`} · 总预算 ${money(quote.request.totalBudgetCents)}</p>
      <p class="live-coupon-badge">${quote.coupon ? `携券核价 · ${escapeHtml(quote.coupon.title)}` : '不用个人券'}</p>
      ${quote.coupon ? `<p class="live-coupon-comparison">${escapeHtml(couponComparisonText(quote.couponComparison))}</p>` : ''}
      <ul class="live-quote-lines">${quote.lines.map(line => `<li><span>${escapeHtml(modified(line))} ×${line.quantity}</span><strong>${money(line.subtotalCents)}</strong><small>${escapeHtml(line.options.map(option => `${option.round}：${modified(option)}`).join('；') || '默认原配方')}</small></li>`).join('')}</ul>
      ${compact ? '<details class="live-bill"><summary>查看原价与优惠明细</summary>' : ''}
      <dl class="live-breakdown"><div><dt>官方原总价</dt><dd>${money(quote.originalCents)}</dd></div><div><dt>官方优惠合计</dt><dd>${money(quote.discountCents)}</dd></div><div><dt>餐品小计（优惠后）</dt><dd>${money(quote.productCents)}</dd></div><div><dt>其他费用 / 整单调整</dt><dd>${money(quote.adjustmentCents)}</dd></div><div><dt>官方应付总额</dt><dd>${money(quote.payableCents)}</dd></div></dl>
      <p class="privacy-note">其他费用 / 整单调整 = 官方应付 − 餐品小计，不擅自猜测费用名称。金额取自官方整数分，不用菜单标价推算。</p>
      ${compact ? '</details>' : ''}
      <p class="live-timestamp">${time(quote.receivedAt)} 核价 · ${time(quote.expiresAt)} 后需重查（北京时间）</p>
      ${compact ? '' : `<p class="privacy-note">${escapeHtml(quote.note)}</p>`}</div>`;
  }

  function findPlan(id) {
    return [...(state.recommendations?.plans ?? []), ...(state.recommendations?.overBudget ?? [])].find(quote => quote.id === id);
  }

  function clearRecommendations(message = '选好预算后点自动推荐；未核价的菜单标价不会参与排序。') {
    state.recommendations = null;
    element('#live-recommend-status').textContent = message;
    element('#live-recommend-results').replaceChildren();
    element('#live-coupon-results').replaceChildren();
  }

  function renderRecommendations() {
    const result = state.recommendations;
    if (!result) return;
    const isExpired = expired(result);
    const renderPlan = (quote, index, over = false) => `<article class="live-recommendation" data-live-plan="${quote.id}" data-payable="${quote.payableCents}">
      <div class="live-recommend-heading"><span class="live-rank">${over ? '↑' : String(index + 1).padStart(2, '0')}</span><h3>${escapeHtml(quote.title)}</h3></div>
      ${quoteMarkup(quote, true, isExpired)}<div class="live-result-actions"><button type="button" class="secondary-button" data-live-plan-save="${quote.id}">保存对比</button><button type="button" class="text-button" data-live-plan-copy="${quote.id}">复制这份餐单 ↗</button></div></article>`;
    element('#live-recommend-status').textContent = isExpired ? '本轮推荐已过期，仅作历史参考；请重新推荐，不沿用旧券价。' :
      `本轮 ${result.coverage.attemptedQuotes} 次核价，${result.coverage.successfulQuotes} 次取得有效价格；展示 ${result.plans.length} 份预算内方案，按官方实付从低到高。`;
    element('#live-recommend-results').innerHTML = `${result.warnings.length ? `<div class="live-recommend-warning"><ul>${result.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></div>` : ''}
      ${!result.plans.length ? '<p class="live-over-heading">本轮没有找到预算内的已核价方案，不代表整个菜单无解；不会擅自提高预算。</p>' : ''}
      <div class="live-recommend-grid" id="live-ranked-plans">${result.plans.map((quote, index) => renderPlan(quote, index)).join('')}</div>
      ${result.overBudget.length ? `<h3 class="live-over-heading">超预算参考 · 不纳入上方推荐</h3><div class="live-recommend-grid" id="live-over-plans">${result.overBudget.map((quote, index) => renderPlan(quote, index, true)).join('')}</div>` : ''}
      <p class="privacy-note">${escapeHtml(result.note)} 本轮读取 ${result.coverage.details} 项详情，最多核对 12 个餐单，不穷举全菜单。未要求饮品时不强行加饮品凑券，但已有套餐可能包含饮品。</p>
      <p class="live-timestamp">${time(result.receivedAt)} 完成本轮 · ${time(result.expiresAt)} 后整轮需重新查询（北京时间）</p>`;
    const coupons = result.coupons;
    const statuses = { 'not-checked': '本轮未核价，不参与排名', pending: '本轮未完成核价，不参与排名',
      'outside-validity': '不在券有效期内，未使用', 'unknown-validity': '有效期格式不能确认，未使用',
      'group-limit': '未确认可用张数，多人方案不复用这张券', 'no-matching-meal': '本轮没有匹配到满足偏好的可核价整餐',
      'quote-failed': '未取得完整有效的携券核价，不参与排名', 'expired-quote': '携券核价已过期，需重新查询', quoted: '已取得携券整餐核价，未消耗券' };
    const couponIntro = coupons.status === 'disabled' ? '本次未查询个人券；这里只比较不用个人券的方案。' : coupons.status === 'failed'
      ? '门店券查询失败或格式暂不支持，不等于没有券。本轮仅比较不用券候选。'
      : coupons.count ? `本店券返回 ${coupons.count} 张，展示前 ${coupons.offers.length} 张。券面折扣不是整顿省下的金额。` : coupons.ignored ? '有券字段未适配，不能确认是否有可用券。' : '本次门店券查询没有返回可用券，不读取其他门店或完整券包。';
    element('#live-coupon-results').innerHTML = `<section class="live-coupon-panel"><h3>这些券，真的让整顿更便宜吗？</h3><p class="privacy-note">${couponIntro}${coupons.ignored ? ` 另有 ${coupons.ignored} 项重复或格式未支持，未用于核价。` : ''}</p>
      ${isExpired ? '<p class="live-recommend-warning">以下券价对比已过期，请重新推荐。</p>' : ''}<div class="live-coupon-list">${coupons.offers.map(offer => `<article class="live-coupon-offer">
        <h4>${escapeHtml(offer.title)}</h4><p>${escapeHtml(offer.products.join(' / '))}</p><p>${escapeHtml(statuses[offer.status] ?? '尚未验证')}</p>
        ${offer.lowestMealCents === null ? '' : `<p class="live-coupon-total">本轮携券整餐最低 ${money(offer.lowestMealCents)} · ${offer.withinBudget ? '预算内' : '超预算'}</p><p>${offer.comparisonToCheapestCents > 0 ? `有券，但整顿比本轮最低方案贵 ${money(offer.comparisonToCheapestCents)}` : '与本轮最低方案同价'}；餐品可能不同，差额不等于券优惠。</p><p>${escapeHtml(couponComparisonText(offer.couponComparison))}</p>`}
        <p class="privacy-note">${escapeHtml(offer.validityText || '未返回可确认的有效期')}（北京时间）</p></article>`).join('')}</div>
      <p class="privacy-note">券码仅用于服务端核价，不进入本页、复制文本或公开记录。不领券，不下单；最终优惠以实际结算为准。</p></section>`;
    sync();
  }

  function renderCurrent() {
    if (state.current) element('#live-current').innerHTML = quoteMarkup(state.current);
    sync();
  }

  function renderSaved() {
    element('#live-clear').hidden = !state.saved.length;
    element('#live-comparisons').innerHTML = state.saved.map((quote, index) => {
      const difference = quote.payableCents - state.saved[0].payableCents;
      const comparison = index === 0 ? '第一份餐单作为对比基准。' : `比第一份${difference > 0 ? '多付' : difference < 0 ? '少付' : '相同金额'}${difference ? ` ${money(Math.abs(difference))}` : ''}。餐品不同，差额不等于优惠。`;
      return `<article><div class="live-saved-heading"><h3>方案 ${index + 1}</h3><button type="button" class="text-button" data-live-forget="${quote.id}" aria-label="移除对比方案${index + 1}">移除</button></div><p class="live-difference">${comparison}</p>${quoteMarkup(quote)}</article>`;
    }).join('');
    sync();
  }

  element('#live-search-form').addEventListener('submit', event => {
    event.preventDefault();
    if (state.pending || !configured) return;
    const payload = { city: element('#live-city').value, keyword: element('#live-keyword').value };
    state.search = null; element('#live-stores').replaceChildren(); clearMenu();
    run('正在查询真实门店，不读取收藏或家庭地址…', () => api('/api/live/stores', payload), result => {
      state.search = result; renderStores();
      status(`${time(result.receivedAt)}（北京时间）查询返回 ${result.stores.length} 家门店。请选择一家；查询不代表购买。`);
    });
  });

  for (const control of elements('#live-city, #live-keyword')) control.addEventListener('input', () => {
    state.search = null; element('#live-stores').replaceChildren(); clearMenu(); error();
    status('地点已修改，请重新查询。');
  });

  element('#live-stores').addEventListener('click', event => {
    const button = event.target.closest('[data-live-store]');
    if (!button || state.pending || !state.search) return;
    const payload = { searchId: state.search.searchId, storeCode: button.dataset.liveStore };
    clearMenu();
    run('正在读取所选门店的当前菜单…', () => api('/api/live/menu', payload), result => {
      state.menu = result;
      element('#live-workspace').hidden = false;
      element('#live-store-title').textContent = result.store.name;
      element('#live-filter').value = '';
      const categories = [...new Set(result.items.flatMap(item => item.categories))];
      element('#live-category').replaceChildren(new Option('全部分类', ''), ...categories.map(category => new Option(category, category)));
      renderProducts();
      status(`已读取 ${result.items.length} 种真实餐品。现在可以一键自动推荐，或继续手动选餐核价。`);
    });
  });

  element('#live-refresh').addEventListener('click', () => element('#live-search-form').requestSubmit());
  element('#live-filter').addEventListener('input', renderProducts);
  element('#live-category').addEventListener('change', renderProducts);
  element('#live-products').addEventListener('click', event => {
    const button = event.target.closest('[data-live-product]');
    if (!button || state.pending || expired(state.menu)) return;
    const payload = { menuId: state.menu.menuId, code: button.dataset.liveProduct };
    state.detail = null; element('#live-detail-form').hidden = true;
    run('正在读取餐品详情与真实规格…', () => api('/api/live/detail', payload), result => {
      state.detail = result; renderDetail(); renderProducts();
      status(result.supported ? '详情已读取，请确认规格后加入餐单；标有【可特调】的餐品仍使用原配方。' : result.limitation);
    });
  });

  element('#live-detail-form').addEventListener('submit', event => {
    event.preventDefault();
    if (state.pending || expired(state.menu) || !state.detail?.supported || !element('#live-detail-form').reportValidity()) return;
    const item = { code: state.detail.code, quantity: Number(element('#live-quantity').value), detail: state.detail,
      choices: elements('[data-live-round]').map(control => ({ round: control.dataset.liveRound, code: control.value })) };
    const next = state.basket.filter(value => value.code !== item.code);
    next.push(item);
    if (next.length > 8 || next.reduce((sum, value) => sum + value.quantity, 0) > 12) { error('每人餐单最多 8 种、共 12 份，请先移除或减少餐品。'); return; }
    state.basket = next; error(); invalidateCurrent(); renderBasket();
    element('#live-add').textContent = '更新餐单中的这份餐品';
    toast('已更新每人餐单，尚未核价或下单。');
  });

  element('#live-basket').addEventListener('input', event => {
    const control = event.target.closest('[data-live-quantity]');
    if (!control) return;
    const item = state.basket.find(value => value.code === control.dataset.liveQuantity);
    if (item) { item.quantity = Number(control.value); invalidateCurrent(); }
  });
  element('#live-basket').addEventListener('click', event => {
    const button = event.target.closest('[data-live-remove]');
    if (!button) return;
    state.basket = state.basket.filter(item => item.code !== button.dataset.liveRemove);
    invalidateCurrent(); renderBasket();
  });
  for (const control of elements('#live-budget, #live-people')) control.addEventListener('input', () => {
    clearRecommendations('预算或人数已更改，请按新条件重新推荐。');
    invalidateCurrent('预算或人数已变更，旧核价与对比已清空，请重新核价。', true);
  });
  for (const control of elements('#live-main-kind, #live-want-drink, #live-use-coupons')) control.addEventListener('change', () => {
    clearRecommendations('推荐偏好已更改，旧券价与推荐已清空，请重新推荐。');
    invalidateCurrent('推荐偏好已更改，已清空旧核价与对比。', true);
  });

  element('#live-budget-form').addEventListener('submit', event => {
    event.preventDefault();
    if (state.pending || expired(state.menu) || !element('#live-budget-form').reportValidity()) return;
    if (event.submitter?.id !== 'live-quote') {
      const payload = { menuId: state.menu.menuId, budget: element('#live-budget').value, people: Number(element('#live-people').value),
        mainKind: element('#live-main-kind').value, wantDrink: element('#live-want-drink').checked, useCoupons: element('#live-use-coupons').checked };
      clearRecommendations('正在查详情、参考门店券并逐单核价，通常需要几十秒；旧推荐已清空。');
      run('正在自动搭配并核价，含无券与携券比较；不领券、不下单…', () => api('/api/live/recommend', payload), result => {
        state.recommendations = result; renderRecommendations();
        status('本轮自动推荐完成，按已验证的官方应付排序；券只作价格参考，没有被领取或消耗。');
      }, () => clearRecommendations('本次推荐失败，没有可用的新结果；请检查错误提示后重试。'));
      return;
    }
    if (!state.basket.length) return;
    const payload = { menuId: state.menu.menuId, budget: element('#live-budget').value, people: Number(element('#live-people').value),
      items: state.basket.map(item => ({ code: item.code, quantity: item.quantity, choices: item.choices })) };
    invalidateCurrent('正在等待官方核价；暂时没有有效结果。');
    run('正在调用官方 calculate-price，只核价，不下单…', () => api('/api/live/quote', payload), result => {
      state.current = result; renderCurrent();
      status(result.withinBudget ? '本次官方核价在预算内。可以保存作比较，但不保证全菜单最低价，也不锁价。' : '本次官方核价超出预算。不会提高预算或删掉你选的餐品，请自行调整后重查。');
    });
  });

  element('#live-save').addEventListener('click', () => {
    if (state.pending || expired(state.current) || state.saved.length >= 3 || state.saved.some(quote => quote.id === state.current.id)) return;
    state.saved.push(structuredClone(state.current)); renderSaved();
    toast('已保存本页对比方案，不是保存订单。');
  });
  element('#live-clear').addEventListener('click', () => { state.saved = []; renderSaved(); });
  element('#live-comparisons').addEventListener('click', event => {
    const button = event.target.closest('[data-live-forget]');
    if (button) { state.saved = state.saved.filter(quote => quote.id !== button.dataset.liveForget); renderSaved(); }
  });
  element('#live-recommend-results').addEventListener('click', event => {
    const button = event.target.closest('[data-live-plan-save], [data-live-plan-copy]');
    if (!button || state.pending || expired(state.recommendations)) return;
    const quote = findPlan(button.dataset.livePlanSave ?? button.dataset.livePlanCopy);
    if (expired(quote)) { sync(); return; }
    if (button.hasAttribute('data-live-plan-copy')) { copyQuote(quote); return; }
    if (state.saved.length >= 3 || state.saved.some(saved => saved.id === quote.id)) return;
    state.saved.push(structuredClone(quote)); renderSaved();
    toast('已保存本页对比，保留规格、券参考和核价时间。');
  });
  async function copyQuote(quote) {
    if (state.pending || expired(quote)) { toast('核价已失效，请重新核价再复制。'); sync(); return; }
    const lines = quote.lines.map(line => `${modified(line)} ×${line.quantity}：${money(line.subtotalCents)}${line.options.length ? `（${line.options.map(option => `${option.round}：${modified(option)}`).join('；')}）` : ''}`);
    const record = ['麦麦不超支 · 官方核价记录（非订单，不锁价）', quote.store.name, quote.store.address, quote.fulfillment,
      `核价：${time(quote.receivedAt)}；${time(quote.expiresAt)} 后需重查（北京时间）`,
      ...lines, `官方应付：${money(quote.payableCents)}；总预算：${money(quote.request.totalBudgetCents)}（${quote.request.people} 人）`,
      quote.coupon ? `携券核价：${quote.coupon.title}；对应 ${quote.coupon.productName}；${quote.coupon.validityText}（北京时间）；未消耗券。${couponComparisonText(quote.couponComparison)}` : '未使用个人券。',
      quote.withinBudget ? `预算剩余：${money(quote.remainingCents)}` : `超预算：${money(-quote.remainingCents)}`,
      '来源：https://mcp.mcd.cn / calculate-price，金额单位由分转元。', quote.note].join('\n');
    try { await navigator.clipboard.writeText(record); toast('已复制核价时间、规格与非订单说明。'); }
    catch { toast('浏览器未开放剪贴板权限，可直接选择页面文字复制。'); }
  }
  element('#live-copy').addEventListener('click', () => copyQuote(state.current));

  setInterval(() => {
    const signature = [state.menu?.menuId, expired(state.menu), state.current?.id, expired(state.current),
      state.recommendations?.receivedAt, expired(state.recommendations), ...state.saved.map(quote => `${quote.id}:${expired(quote)}`)].join(',');
    if (signature !== expirySignature) {
      expirySignature = signature; renderCurrent(); renderSaved(); renderRecommendations(); sync();
    }
  }, 1000);
  status(configured ? '本机已配置 Token；点击查询后才访问官方接口。预填地点来自你的选择，不会自动选择门店。' : '尚未配置 MCP Token。请在本机 .env 配置后重启服务；演示实验室仍可离线使用。');
  sync();
}
