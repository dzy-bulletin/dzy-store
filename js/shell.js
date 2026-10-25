import { MOCK, EMBED, EMBED_ORIGIN, DZY_ORIGIN, DZY_LOGIN_URL, ONLY } from './config.js';
// 管理系統考勤管理（出勤核定統一後的去處，2026-10-24 總審：網址改用 config 常數，不寫死）
const ATT_URL = DZY_ORIGIN + '/#/attendance';
// 已搬到管理系統的功能（舊網址與一般模式的側邊欄用；2026-10-24，duty＝spec §17.3、schedule＝hr-move-spec §3）
const MOVED = {
  duty: { title: '出勤核定', where: '人資部門 → 考勤管理', btn: '前往考勤管理', url: ATT_URL, mid: 'dutyMoved' },
  schedule: { title: '自動排班', where: '人資部門 → 排班管理', btn: '前往排班管理', url: DZY_ORIGIN + '/#/schedule', mid: 'scheduleMoved' }
};
const ONLY_LABEL = { duty: '出勤核定', schedule: '排班' };
const attLinkAttr = () => (EMBED ? 'target="_top"' : 'target="_blank" rel="noopener"');
import { api } from './api.js';
import { initAuth, getSession, setSession, clearSession, rememberedCode, login, logout, changePassword, toSession, ssoRedeem, ssoSelect, ssoSwitch, adoptResult, schedPart, pickSchedStore, rememberSchedStore } from './auth.js';
import { MODULES, ADMIN_TABS } from './registry.js';
import { esc, busy, setMsg, applyUi } from './ui.js';
import { applyTheme } from './theme.js';

const app = document.getElementById('app');
let UI = { systemName: '鼎兆元｜門市營運系統', logoUrl: '', colors: {}, cards: [], banner: '' };
let renderToken = 0;

export function currentUi() { return UI; }
export async function loadUi() {
  try { UI = await api('GET', '/ui'); } catch (e) { /* 連不上就用預設外觀 */ }
  applyUi(UI);
  return UI;
}
const cardOf = id => (UI.cards || []).find(c => c.id === id);
const labelOf = m => (cardOf(m.id) || {}).label || m.label;

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { page: parts[0] || '', tab: parts[1] || '' };
}
export function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

const NAV_ICONS = { staffperm: '👥', home: '🏠', purchase: '🧾', cashbook: '💰', duty: '🕒', transfer: '🔄', loss: '🗑️', inventory: '📦', board: '📋', schedule: '📅', admin: '⚙️' };
// 左側深色側邊欄（外觀正本 ~/mala-clock-in/payroll.html .sidebar）：品牌→首頁→有開的系統→（管理者）後台管理→使用者區
function sidebarHtml(s, cur) {
  const feats = new Set(s.features || []);
  const mods = [...(UI.cards || [])].sort((a, b) => a.order - b.order)
    .filter(c => c.visible && feats.has(c.id) && MODULES.some(m => m.id === c.id) && (ONLY ? c.id === ONLY : !MOVED[c.id]));   // ?only=…：只剩該功能；一般模式不列已移到管理系統的出勤核定、自動排班（2026-10-24）
  const p = s.person, many = p && (s.stores || []).length > 1;
  const item = (key, href, label) => `<a href="${href}" data-nav="${key}" class="${cur === key ? 'on' : ''}"${cur === key ? ' aria-current="page"' : ''}><span class="ic">${NAV_ICONS[key] || '•'}</span>${esc(label)}</a>`;
  return `<aside class="sidebar" id="sidebar">
    <a class="brand" href="#/" id="brand"><div class="logos"></div><div><div class="bt js-bt" id="brandName"></div><div class="bs js-bs"></div></div></a>
    <nav id="nav" aria-label="系統選單">
      ${ONLY ? '' : item('home', '#/', '首頁')}
      ${mods.length ? '<div class="nav-label">系統</div>' : ''}
      ${mods.map(c => item(c.id, `#/${c.id}/`, c.label)).join('')}
      ${!ONLY && canStaffPerm(s) ? item('staffperm', '#/staffperm', '本店同仁權限') : ''}
      ${ONLY ? '' : s.role === 'admin' ? `<div class="nav-label">管理</div>${item('admin', '#/admin/accounts', '後台管理').replace('<a ', '<a id="adminLink" ')}` : ''}
    </nav>
    <div class="side-user"><div class="av">🙂</div>
      <div class="su-main"><div class="nm" id="whoName">${p ? esc(p.name + '・' + s.name) : esc(s.name)}</div><div class="rl">${p ? '管理系統帳號' : esc(s.code || '') + (s.role === 'admin' ? '・管理者' : '')}</div></div>
      <div class="su-act">${!s.mustChangePassword && !p ? '<a href="#/password" id="pwLink">改密碼</a>' : ''}${!s.mustChangePassword && s.role === 'store' && (!p || s.isManager) && !ONLY ? '<a href="#/features" id="featLink">功能開關</a>' : ''}${many ? '<a href="#/switch" id="switchLink">換店</a>' : ''}<button id="logoutBtn" type="button">登出</button></div></div>
  </aside>`;
}
// 「本店同仁權限」：只有個人登入的店長（管理系統管理員也算店長）；門市登入、後台管理者帳號都沒有
const canStaffPerm = s => !!(s.person && s.isManager);
function bannerHtml() { return UI.banner ? `<div class="banner" id="uiBanner">${esc(UI.banner)}</div>` : ''; }
function tabsHtml(base, tabs, cur) {
  return `<nav class="tabs">${tabs.map(t => `<a href="#/${base}/${t.id}" data-tab="${t.id}" class="${t.id === cur ? 'on' : ''}">${esc(t.label)}</a>`).join('')}</nav>`;
}

// opts: { cur: 側邊欄高亮項, title: 內容區頂端頁名, sub: 副標 }；沒有 s（登入頁）或強制改密碼時不顯示側邊欄
function frame(s, inner, nav, opts) {
  opts = opts || {};
  if (!s || opts.bare) {
    // 登入／強制改密碼：最上方深色頂條（照貨單辨識系統）＋置中白卡
    app.innerHTML = `<header class="hdr"><div class="logos"></div><span class="ttl" id="sysName">${esc(UI.systemName)}</span></header><section class="login-view">${inner}</section>`;
  } else {
    const embedBar = EMBED && s.person ? `<div class="embed-who"><span id="embedWho">${esc(s.person.name + '・' + s.name)}</span>${(s.stores || []).length > 1 ? '<a href="#/switch" id="embedSwitch">換店</a>' : ''}</div>` : '';
    app.innerHTML = `<div class="app">${sidebarHtml(s, opts.cur)}<div class="main-wrap"><div class="topbar"><h1 class="page-title" id="pageTitle">${esc(opts.title || '')}</h1>${opts.sub ? `<div class="sub">${esc(opts.sub)}</div>` : ''}${embedBar}</div>${nav || ''}<main>${inner}</main></div></div>`;
  }
  applyTheme(s ? s.brand : null, UI.logoUrl);
  bindLogout();
  postNav();
  return app.querySelector('main') || app.querySelector('.login-view');
}
function bindLogout() {
  const lb = document.getElementById('logoutBtn');
  // 登出後整頁重新載入：上一個帳號還沒回來的請求、各模組暫存的資料一起清掉，換別店登入不會看到上一店的東西（2026-10-10 Codex 審查）
  if (lb) lb.onclick = async () => { await logout(); location.hash = '#/'; location.reload(); };
}

// ---------- 登入 ----------
// 已建檔門市清單（GET /ui 的 stores；連不上或沒有就不顯示）
function storeListHtml() {
  const list = Array.isArray(UI.stores) ? UI.stores : [];
  if (!list.length) return '';
  return `<div class="store-list" id="storeList"><div class="sl-ttl">已建檔的門市</div><ul>${list.map(x => `<li><span>${esc(x.name)}</span><b>${esc(x.code)}</b></li>`).join('')}</ul></div>`;
}
function viewLogin() {
  const main = frame(null, `<div class="page">${bannerHtml()}<div class="lcard"><h1>${esc(UI.systemName)}</h1>
    <p class="muted">請用門市代號登入（例如 MDGF）</p>${storeListHtml()}
    <form id="loginForm" autocomplete="off"><label class="f" for="code">門市代號<input id="code" type="text" autocapitalize="characters" autocomplete="username" value="${esc(rememberedCode())}"></label>
    <label class="f" for="password">密碼<input id="password" type="password" autocomplete="current-password"></label>
    <p class="pwhint" id="pwHint">第一次使用的預設密碼是 000000，登入後系統會請你設定自己的新密碼。</p>
    <div id="loginErr" class="err" role="alert"></div><button class="lbtn" id="loginBtn" type="submit">登入</button></form>
    ${UI.sso ? '<div class="sso-or"><span>或</span></div><button class="lbtn plain" id="ssoBtn" type="button">用管理系統帳號登入</button>' : ''}
    <div class="login-links"><button type="button" id="forgotBtn" class="linkbtn" aria-expanded="false" aria-controls="forgotBox">忘記密碼</button>
      <a id="guideLink" href="guide.html" target="_blank" rel="noopener">操作手冊</a></div>
    <div class="note" id="forgotBox" hidden>忘記密碼請找管理者，在後台重設。重設後密碼會回到 000000，登入後再自己設定新密碼。</div></div></div></div>`);
  const codeEl = main.querySelector('#code');
  codeEl.oninput = () => { const p = codeEl.selectionStart; codeEl.value = codeEl.value.toUpperCase(); try { codeEl.setSelectionRange(p, p); } catch (e) {} };
  const fb = main.querySelector('#forgotBtn'), fbox = main.querySelector('#forgotBox');
  fb.onclick = () => { fbox.hidden = !fbox.hidden; fb.setAttribute('aria-expanded', String(!fbox.hidden)); };
  const f = main.querySelector('#loginForm');
  const sb = main.querySelector('#ssoBtn');
  if (sb) sb.onclick = () => { SSO_ERR = ''; goDzyLogin(); };
  if (SSO_ERR) setMsg(f.querySelector('#loginErr'), SSO_ERR);
  if (rememberedCode() && !SSO_ERR) main.querySelector('#password').focus();
  f.onsubmit = e => {
    e.preventDefault();
    busy(f.querySelector('#loginBtn'), async () => {
      try {
        await login(f.code.value.trim().toUpperCase(), f.password.value);
        render();
      } catch (er) { setMsg(f.querySelector('#loginErr'), er.message); f.password.value = ''; }
    });
  };
}

// ---------- 改密碼 ----------
function viewPassword(s) {
  const forced = s.mustChangePassword;
  const inner = `<div class="${forced ? 'page' : 'auth-wrap'}"${forced ? '' : ' style="margin-top:8px;padding:0"'}><div class="${forced ? 'lcard' : 'card'}">${forced ? '<h1>請先設定自己的密碼</h1>' : '<h2>改密碼</h2>'}
    <p class="${forced ? 'muted' : 'hint'}">${forced ? '你現在用的是預設密碼（000000），請改成只有你知道的密碼，不可以再用 000000。' : ''}新密碼至少 8 碼。</p>
    <form id="pwForm"><label class="f" for="oldPw">${forced ? '目前的密碼（預設密碼）' : '目前的密碼'}<input id="oldPw" type="password" autocomplete="current-password"></label>
    <label class="f" for="newPw">新密碼（8 碼以上）<input id="newPw" type="password" autocomplete="new-password"></label>
    <label class="f" for="newPw2">再輸入一次新密碼<input id="newPw2" type="password" autocomplete="new-password"></label>
    <div id="pwErr" class="err" role="alert"></div><button class="${forced ? 'lbtn' : 'btn'}" id="pwBtn" type="submit">${forced ? '設定密碼並進入' : '儲存新密碼'}</button>
    ${forced ? '<button class="lbtn plain" id="logoutBtn" type="button">登出</button>' : ''}</form></div></div>`;
  const main = frame(s, inner, '', { bare: forced, cur: '', title: '改密碼' });
  const f = main.querySelector('#pwForm');
  f.onsubmit = e => {
    e.preventDefault();
    const err = main.querySelector('#pwErr');
    if (f.newPw.value === '000000') return setMsg(err, '新密碼不可以是預設密碼 000000');
    if (f.newPw.value.length < 8) return setMsg(err, '新密碼至少要 8 碼');
    if (f.newPw.value !== f.newPw2.value) return setMsg(err, '兩次輸入的新密碼不一樣');
    busy(f.querySelector('#pwBtn'), async () => {
      try { await changePassword(f.oldPw.value, f.newPw.value); go('#/'); }
      catch (er) { setMsg(err, er.message); }
    });
  };
}

// ---------- 首頁 ----------
// 首頁內容區＝「待辦與異常」，依系統分組（順序照後台「介面設定」的卡片順序，與側邊欄同一份）；先畫分組骨架再非同步讀 /home。
// 側邊欄各系統名稱右側顯示件數徽章（0 不顯示、含 error 紅色）。
const rowHtml = it => `<a class="todo-row lv-${esc(it.level)}" href="${esc(it.link)}" data-module="${esc(it.module)}" data-level="${esc(it.level)}"><span class="tx">${esc(it.text)}</span><span class="go" aria-hidden="true">›</span></a>`;
const noteHtml = (id, text) => `<div class="todo-row lv-note" data-module="${esc(id)}" data-level="note"><span class="tx">${esc(text)}</span></div>`;
function fillGroups(d) {   // d＝null 表示整個讀不到
  document.querySelectorAll('#todoBody .todo-group').forEach(g => {
    const id = g.dataset.module, body = g.querySelector('.todo-body');
    const its = d ? (d.items || []).filter(i => i.module === id) : [];
    const failed = !d || (d.errors || []).some(e => e.module === id);
    body.innerHTML = its.map(rowHtml).join('') + (failed ? noteHtml(id, '暫時讀不到') : '') || '<div class="todo-empty">沒有待辦</div>';
  });
}
function applyBadges(items) {
  document.querySelectorAll('#nav .badge').forEach(b => b.remove());
  const by = {};
  (items || []).forEach(it => { const b = by[it.module] || (by[it.module] = { n: 0, err: false }); b.n += Number(it.count) || 0; if (it.level === 'error') b.err = true; });
  Object.keys(by).forEach(id => {
    const a = document.querySelector(`#nav a[data-nav="${id}"]`);
    if (!a || !by[id].n) return;
    const i = document.createElement('i');
    i.className = 'badge' + (by[id].err ? ' err' : ''); i.textContent = String(by[id].n); i.setAttribute('aria-label', `${by[id].n} 件待處理`);
    a.appendChild(i);
  });
  postNav();
}
// ---------- 嵌入管理系統：選單交給管理系統畫在頁頂（2026-10-20） ----------
// 每次畫面或待辦數字變了，就把 #nav 目前的項目（id＝data-nav、名稱、數字）送給管理系統；
// 管理系統回 dzy-store-tabs 才加 embed-tabs 藏自己的選單；點管理系統的分頁會送 dzy-store-go 過來。
// 考勤管理（?only=duty）：送出勤核定的子分頁（nav.tabs，#/duty/<tab>）；申請審核的待審數字由 duty/state.js setReqBadge 改完發 dzystore-nav 事件再送一次（2026-10-20）
function navItems() {
  const sel = ONLY ? 'nav.tabs a[data-tab]' : '#nav a[data-nav]';
  return [...document.querySelectorAll(sel)].map(a => {
    const b = a.querySelector('.badge');
    const label = [...a.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    return { id: ONLY ? a.dataset.tab : a.dataset.nav, label, badge: b ? Number(b.textContent) || 0 : 0, err: !!(b && b.classList.contains('err')) };
  });
}
function postNav() {
  if (!EMBED) return;
  const on = ONLY ? document.querySelector('nav.tabs a[data-tab].on') : document.querySelector('#nav a[data-nav].on');
  try { window.parent.postMessage({ type: 'dzy-store-nav', v: 1, items: navItems(), cur: on ? (ONLY ? on.dataset.tab : on.dataset.nav) : '' }, EMBED_ORIGIN); } catch (e) { /* parent 不接受就算了 */ }
}
function goNav(id) {
  const ok = typeof id === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(id);
  const a = !ok ? null : ONLY ? document.querySelector(`nav.tabs a[data-tab="${id}"]`) : document.querySelector(`#nav a[data-nav="${id}"]`);
  if (a) return go(a.getAttribute('href'));
  // 管理系統首頁提醒（self／approve／fixed／fixedstaff）：目前這家店的分頁沒有這個 id（例如人資主管停在門市）→ 直接改網址，交給 render()
  // 「分頁屬於別種排班的店 → 自動換店」接手（有權限才換；沒權限顯示沒有權限畫面，不是悄悄留在原地）
  if (ok && ONLY === 'schedule' && Object.prototype.hasOwnProperty.call(SCHED_TAB_MODE, id)) go('#/schedule/' + id);
}

async function loadTodos(tok) {
  let d = null;
  try { d = await api('GET', '/home'); } catch (e) { /* 讀不到：每組顯示「暫時讀不到」 */ }
  if (tok !== renderToken || !document.getElementById('todoBody')) return;
  fillGroups(d);
  applyBadges(d ? d.items : []);
}
const HOME_MOVED_TEXT = { duty: ['homeOnlyDuty', '出勤相關的工作在管理系統：人資部門 → 考勤管理'], schedule: ['homeOnlySchedule', '排班的工作在管理系統：人資部門 → 排班管理'] };
const homeMovedHtml = k => { const [id, t] = HOME_MOVED_TEXT[k]; return `<p id="${id}">${t}</p><a class="btn" id="${id}Go" href="${MOVED[k].url}" ${attLinkAttr()}>${MOVED[k].btn}</a>`; };
function viewHome(s, tok) {
  const feats = new Set(s.features || []);
  const cards = [...(UI.cards || [])].sort((a, b) => a.order - b.order)
    .filter(c => c.visible && feats.has(c.id) && MODULES.some(m => m.id === c.id) && !MOVED[c.id]);   // 首頁不列出勤核定、自動排班（已移到管理系統）
  // 個人登入且功能只剩已搬走的（出勤核定、自動排班）：指去管理系統，不說「沒有開通任何功能」（2026-10-24 總審；排班同理）
  const movedIds = Object.keys(MOVED).filter(k => feats.has(k));
  const onlyMoved = !!s.person && feats.size > 0 && movedIds.length === feats.size;
  const html = cards.length
    ? `<div id="todoBody" aria-live="polite">${cards.map(c => `<section class="card todo-group" data-module="${c.id}"><h2>${esc(c.label)}</h2><div class="todo-body"><div class="hint">讀取中…</div></div></section>`).join('')}</div>`
    : onlyMoved ? `<div class="card">${movedIds.map(k => homeMovedHtml(k)).join('')}</div>`
    : `<div class="card"><p>目前還沒有開通任何功能，請洽管理者。</p>${s.role === 'store' && (!s.person || s.isManager) ? '<p class="hint" id="noFeatHint">如果是自己關掉的，可到選單裡你的店名旁「功能開關」打開。</p>' : ''}</div>`;
  frame(s, bannerHtml() + html, '', { cur: 'home', title: '待辦與異常', sub: s.person ? s.person.name + '・' + s.name : s.name });
  if (cards.length) loadTodos(tok);
}

// ---------- 功能開關（門市自己開關，只影響自己這一店；2026-10-14） ----------
// 管理者在後台開通的才會列出來；關掉＝這家店的側邊欄與首頁不再出現、直接打網址也進不去。每個開關一切就送出，失敗就復原
async function viewFeatures(s) {
  if (s.role !== 'store' || (s.person && !s.isManager)) return go('#/');      // 個人登入只有店長可以開關整店功能
  const main = frame(s, `${bannerHtml()}<div class="card"><h2>功能開關</h2>
    <p class="hint">只影響你這家店。管理者沒有開通的功能不會出現在這裡，要開請洽管理者。</p>
    <div id="ftMsg" class="err" role="alert"></div><div id="ftList"><div class="hint">讀取中…</div></div></div>`, '', { cur: '', title: '功能開關' });
  const list = main.querySelector('#ftList'), msg = main.querySelector('#ftMsg');
  let items;
  try { items = (await api('GET', '/my/features')).items || []; } catch (e) { list.innerHTML = ''; return setMsg(msg, e.message); }
  if (!document.body.contains(list)) return;
  const rows = [...(UI.cards || [])].sort((a, b) => a.order - b.order).filter(c => c.visible && items.some(i => i.id === c.id));
  if (!rows.length) { list.innerHTML = '<div class="hint">管理者還沒有替這家店開通任何功能。</div>'; return; }
  list.innerHTML = rows.map(c => `<label class="ft-row"><input type="checkbox" class="ft-chk" data-feat="${esc(c.id)}"${items.find(i => i.id === c.id).on ? ' checked' : ''}><span>${esc(c.label)}</span></label>`).join('');
  list.querySelectorAll('.ft-chk').forEach(box => {
    box.onchange = async () => {
      const want = box.checked;
      box.disabled = true; setMsg(msg, '');
      try {
        const d = await api('POST', '/my/features', { feature: box.dataset.feat, on: want });
        const cur = getSession();
        if (cur) { cur.features = d.features || []; setSession(cur); refreshSidebar(cur); }
      } catch (e) { box.checked = !want; setMsg(msg, e.message); }
      box.disabled = false;
    };
  });
}
// 只重畫側邊欄（功能開關切了之後，不動內容區）
function refreshSidebar(s) {
  const old = document.getElementById('sidebar');
  if (!old) return;
  old.outerHTML = sidebarHtml(s, '');
  applyTheme(s.brand, UI.logoUrl);
  bindLogout();
}

// ---------- 模組 ----------
async function viewModule(s, id, tab, tok) {
  const reg = MODULES.find(m => m.id === id);
  if (!reg || !(s.features || []).includes(id) || (cardOf(id) && !cardOf(id).visible)) return go('#/');
  const mod = (await reg.load()).default;
  if (tok !== renderToken) return;
  const tabs = mod.tabsFor ? mod.tabsFor(s) : mod.tabs;   // 依角色不同分頁（出勤核定：管理者多「各店總覽」）
  const cur = tabs.some(t => t.id === tab) ? tab : tabs[0].id;
  if (cur !== tab) return history.replaceState(null, '', `#/${id}/${cur}`), render();
  const locked = mod.locked && mod.locked();
  const main = frame(s, `${bannerHtml()}<div id="modBody"></div>`, locked || tabs.length < 2 ? '' : tabsHtml(id, tabs, cur), { cur: id, title: labelOf(reg) });
  const ctx = { el: main.querySelector('#modBody'), tab: cur, session: s, api, rerender: render };
  if (locked) mod.renderGate(ctx); else mod.render(ctx);
}

// ---------- 後台 ----------
async function viewAdmin(s, tab, tok) {
  if (s.role !== 'admin') return go('#/');
  const cur = ADMIN_TABS.some(t => t.id === tab) ? tab : 'accounts';
  const main = frame(s, `<div id="admBody"></div>`, tabsHtml('admin', ADMIN_TABS, cur), { cur: 'admin', title: '後台管理' });
  const view = (await import(`../admin/${cur}.js`)).default;
  if (tok !== renderToken) return;
  view({ el: main.querySelector('#admBody'), api, session: s, ui: UI, refreshUi: async () => { await loadUi(); } });
}

// ---------- 個人帳號登入（管理系統帳號）----------
// 入場券一次性、60 秒：從網址 #sso=<64 hex> 或嵌入時 parent 的 postMessage 拿到，立刻兌換成營運系統自己的登入。
let SSO_ERR = '';        // 個人登入失敗的白話訊息（登入頁／嵌入等待畫面顯示）
let PENDING = null;      // 多店要選時：{ select_token, stores }（只放記憶體，不進任何儲存）
let SSO_BUSY = false;
const TICKET_RE = /^[0-9a-f]{64}$/;

// 網址帶 #sso= 就讀走並「立刻」用 replaceState 清掉（券不留在網址列、歷史紀錄）。回 ticket、'' 表示格式不對、null 表示網址沒有券
function takeTicketFromHash() {
  if (!/^#sso=/.test(location.hash)) return null;
  const m = /^#sso=([0-9a-f]{64})$/.exec(location.hash);
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 舊瀏覽器 */ }
  return m ? m[1] : '';
}
async function goDzyLogin() {
  if (MOCK) { const m = await import('./mock.js'); location.hash = '#sso=' + await m.mintTicket(m.mockPersona()); return; }   // 示範模式：假的管理系統，直接發一張假券
  location.href = DZY_LOGIN_URL + '?return=' + encodeURIComponent(location.origin + location.pathname + location.search);
}
// 兌換並採用。fromParent＝嵌入握手：已有登入時，伺服器回的 sub 相同就保留原本的（可能已換過店），不同就先登出舊的再換
async function runTicket(ticket, fromParent) {
  if (SSO_BUSY) return;
  SSO_BUSY = true; SSO_ERR = '';
  try {
    let r = await ssoRedeem(ticket);
    const old = getSession();
    if (r.select_token) {
      if (fromParent && old && (r.stores || []).some(x => x.code === old.code)) r = await ssoSelect(r.select_token, old.code);   // 重新握手：先試著進原本那家店
      else { PENDING = { select_token: r.select_token, stores: r.stores || [] }; return; }
    }
    const { kept } = await adoptResult(r, fromParent);
    PENDING = null;
    if (!kept && old) { location.hash = ONLY ? `#/${ONLY}/` : '#/'; location.reload(); return; }   // 換了人／換了登入方式：整頁重載，不留上一個人的畫面與暫存
    if (!kept) location.hash = ONLY ? `#/${ONLY}/` : '#/';
  } catch (e) {
    if (getSession() && fromParent) console.error('嵌入重新握手失敗：' + e.message);   // 已有登入就不打擾，使用者繼續用目前的
    else SSO_ERR = e.message;
  } finally { SSO_BUSY = false; render(); }
}
async function onHash() {
  const t = takeTicketFromHash();
  if (t === null) return render();
  if (t) return runTicket(t, false);
  SSO_ERR = '入場券格式不正確，請重新用管理系統帳號登入'; render();
}

// ---------- 嵌入管理系統（?embed=dzy）：postMessage 握手 ----------
// 載入後對 parent 送 ready；只收 origin 與 source 都對的訊息（照公告專區）。每次收到新券都會兌換，sub 不同就先登出舊 session。
const sendReady = () => { try { window.parent.postMessage({ type: 'dzy-store-ready', v: 1 }, EMBED_ORIGIN); } catch (e) { /* parent 不接受就算了 */ } };
function installEmbed() {
  document.body.classList.add('embed');
  if (ONLY) document.body.classList.add('embed-only', `embed-${ONLY}`);   // 考勤管理／排班管理：不顯示功能列
  window.addEventListener('message', e => {
    if (e.origin !== EMBED_ORIGIN || e.source !== window.parent) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || m.v !== 1) return;
    if (m.type === 'dzy-store-sso' && typeof m.ticket === 'string' && TICKET_RE.test(m.ticket)) runTicket(m.ticket, true);
    else if (m.type === 'dzy-store-logout') embedLogout();
    else if (m.type === 'dzy-store-tabs') document.body.classList.add('embed-tabs');
    else if (m.type === 'dzy-store-go') goNav(m.id);
  });
  window.addEventListener('dzystore-nav', postNav);   // 模組改了分頁數字（出勤核定 setReqBadge）
  sendReady();
}
async function embedLogout() {
  PENDING = null; SSO_ERR = '';
  if (getSession()) await logout();
  location.hash = '#/'; location.reload();
}

function viewEmbedWait() {
  const main = frame(null, `<div class="page"><div class="lcard"><h1>${esc(UI.systemName)}</h1>
    <p class="muted" id="embedStatus" role="status">${esc(SSO_ERR || '正在連線管理系統…')}</p>
    ${SSO_ERR ? '<button class="lbtn plain" id="embedRetry" type="button">重新連線</button>' : ''}</div></div>`);
  const b = main.querySelector('#embedRetry');
  if (b) b.onclick = () => { SSO_ERR = ''; sendReady(); render(); };
}

// 多店：登入後選一家
function viewSelect() {
  const main = frame(null, `<div class="page"><div class="lcard"><h1>選擇要進入的門市</h1><p class="muted">你的帳號可以進入下面這些門市，請選一家。</p>
    <div id="selErr" class="err" role="alert"></div>
    ${PENDING.stores.map(x => `<button class="lbtn plain" type="button" data-store="${esc(x.code)}">${esc(x.name)}</button>`).join('')}
    <div class="login-links"><button type="button" id="selCancel" class="linkbtn">取消</button></div></div></div>`);
  main.querySelectorAll('[data-store]').forEach(b => {
    b.onclick = () => busy(b, async () => {
      try {
        const old = getSession();
        const d = await ssoSelect(PENDING.select_token, b.dataset.store);
        await adoptResult(d, false);
        PENDING = null;
        if (old) { location.hash = ONLY ? `#/${ONLY}/` : '#/'; location.reload(); return; }
        location.hash = ONLY ? `#/${ONLY}/` : '#/'; render();
      } catch (er) { setMsg(main.querySelector('#selErr'), er.message); if (er.code === 'AUTH') PENDING = null; }
    });
  });
  main.querySelector('#selCancel').onclick = () => { PENDING = null; SSO_ERR = ''; render(); };
}
// 換店（已登入的個人帳號）：同分頁換新 token，舊 token 在伺服器立即刪除
function viewSwitch(s) {
  const list = s.stores || [];
  const main = frame(s, `${bannerHtml()}<div class="card"><h2>換店</h2><p class="hint">選一家要進入的門市；功能與權限會依你在那家店的設定重新計算。</p>
    <div id="swErr" class="err" role="alert"></div>
    <div class="sw-list">${list.map(x => `<button class="btn ghost sw-btn" type="button" data-store="${esc(x.code)}"${x.code === s.code ? ' disabled' : ''}>${esc(x.name)}${x.code === s.code ? '（目前）' : ''}</button>`).join('')}</div></div>`, '', { cur: '', title: '換店' });
  main.querySelectorAll('[data-store]').forEach(b => {
    b.onclick = () => busy(b, async () => {
      try {
        const d = await ssoSwitch(b.dataset.store);
        setSession(toSession(d));
        location.hash = ONLY ? `#/${ONLY}/` : '#/'; location.reload();
      } catch (er) { setMsg(main.querySelector('#swErr'), er.message); }
    });
  });
}
// 排班管理的頁頂分頁屬於哪種排班（docs/schedule-hq/spec.md §5）；跨入口分頁（go-*）不在表裡，由模組自己處理
const SCHED_TAB_MODE = { board: 'store', needs: 'store', staff: 'store', shifts: 'store', self: 'self', approve: 'self', fixed: 'fixed', fixedstaff: 'fixed' };
// 自動換店的保險：5 秒內不對同一家店重複換（權限或設定對不上時不要無限重載）
const AUTO_SW = 'dzystore_autosw';
function autoSwitchOk(code) { try { const x = JSON.parse(sessionStorage.getItem(AUTO_SW) || 'null'); return !(x && x.code === code && Date.now() - x.at < 5000); } catch (e) { return true; } }
async function autoSwitch(s, code, hash) {
  try { sessionStorage.setItem(AUTO_SW, JSON.stringify({ code, at: Date.now() })); } catch (e) { /* 無痕模式 */ }
  frame(s, '<div class="card"><p class="hint" id="autoSwitch" style="margin:0">切換中…</p></div>', '', { cur: 'schedule', title: '排班管理' });
  try { const d = await ssoSwitch(code); setSession(toSession(d)); location.hash = hash || '#/schedule/'; location.reload(); }
  catch (e) { frame(s, `<div class="card"><div class="err" id="autoSwitchErr" role="alert">${esc(e.message)}</div></div>`, '', { cur: 'schedule', title: '排班管理' }); }
}
// 排班管理：網址／頁頂點的分頁屬於別種排班的店，但這個人在那邊沒有排班權限
const SCHED_TAB_LABEL = { board: '門市班表', needs: '指定與需求', staff: '門市同仁', shifts: '班別與設定', self: '我的班表', approve: '部屬核准', fixed: '央廚班表', fixedstaff: '固定班別' };
function viewSchedNoAccess(s, tab) {
  frame(s, `<div class="card"><h2>排班管理</h2><p class="hint" id="schedNoAccess">你沒有「${esc(SCHED_TAB_LABEL[tab] || '這個頁面')}」的排班權限。</p>
    <a class="btn ghost" href="#/schedule/" id="schedNoAccessBack">回到這家店的排班</a></div>`, '', { cur: '', title: '排班管理' });
}
// ?only=… 但這家店沒有該功能的權限（出勤核定／排班）：說明＋多店可換店
function viewNoOnly(s, adminOnly) {
  const many = s.person && (s.stores || []).length > 1;
  const name = ONLY === 'duty' ? '出勤核定' : '自動排班', id = ONLY === 'duty' ? 'Duty' : 'Schedule';
  // adminOnly：有排班的查看權（出勤核定要對班表），但門市排班只給能排班的人（本店店長同等職、人資主管、管理員；2026-10-24 Eason）
  const msg = adminOnly ? '排班只有本店店長、人資主管或管理員可以使用。' : `你的帳號在這家店（${esc(s.name)}）沒有${ONLY_LABEL[ONLY]}的權限。`;
  frame(s, `<div class="card"><h2>${name}</h2><p class="hint" id="onlyNo${adminOnly ? 'ScheduleAdmin' : id}">${msg}${many ? '可以換到別家店試試。' : adminOnly ? '' : '如需使用請洽總部。'}</p>
    ${many ? `<a class="btn ghost" href="#/switch" id="no${id}Switch">換店</a>` : ''}</div>`, '', { cur: '', title: name });
}
// 舊網址 #/duty/…、#/schedule/…（非 ?only=）：不渲染，改提示已移到管理系統（duty：spec §17.3；schedule：hr-move-spec §3，共用同一個畫面）
function viewMoved(s, id) {
  const m = MOVED[id];
  frame(s, `<div class="card"><h2>${m.title}</h2><p id="${m.mid}">${m.title}已移到管理系統：${m.where}</p>
    <a class="btn" id="${m.mid}Go" href="${m.url}" ${attLinkAttr()}>${m.btn}</a></div>`, '', { cur: '', title: m.title });
}
async function viewStaffPerm(s, tok) {
  if (!canStaffPerm(s)) return go('#/');
  const main = frame(s, '<div id="spBody"></div>', '', { cur: 'staffperm', title: '本店同仁權限' });
  const view = (await import('./staffperm.js')).default;
  if (tok !== renderToken) return;
  view({ el: main.querySelector('#spBody'), api, session: s, ui: UI });
}

// 個人登入：開頁時向伺服器重讀自己的權限（店長改過本店同仁權限、總部改過作廢／考勤，重新開頁就立刻看到；伺服器每個請求本來就會重算，這裡只是讓畫面跟上）
async function refreshMe() {
  const s = getSession();
  if (!s || !s.person) return;
  try {
    const d = await api('GET', '/me');
    const cur = getSession();
    if (cur && cur.token === s.token) setSession({ ...cur, name: d.name || cur.name, brand: d.brand || cur.brand, features: d.features || [], canVoid: !!d.canVoid, isManager: !!d.isManager, scheduleAdmin: !!d.scheduleAdmin, dutyUnlocked: !!d.dutyUnlocked, dutyManager: d.dutyManager !== false, dutyHours: d.dutyHours !== false, stores: d.stores || cur.stores, attStores: d.attStores || [], dutyView: d.dutyView || null, ...schedPart(d) });
  } catch (e) { /* 登入失效 api 已處理；連不上就先沿用舊的 */ }
}

export async function render() {
  const tok = ++renderToken;
  let s = getSession();
  if (PENDING) return viewSelect();
  if (!s) return EMBED ? viewEmbedWait() : viewLogin();
  if (s.mustChangePassword) return viewPassword(s);
  const r = route();
  window.scrollTo(0, 0);
  if (r.page === 'switch') return s.person ? viewSwitch(s) : go('#/');
  if (ONLY) {                               // ?only=duty／schedule：只有該功能（含換店）；首頁與其他功能都不顯示
    if (!(s.features || []).includes(ONLY)) {
      // 區督導、總監這類：這家店沒有排班權、但在總部（或央廚、別家門市）有 → 直接切過去（優先總部），不要先顯示沒有權限
      if (ONLY === 'schedule' && s.person) { const t = pickSchedStore(s, 'self') || pickSchedStore(s, 'fixed') || pickSchedStore(s, 'store'); if (t && autoSwitchOk(t.code)) return autoSwitch(s, t.code, '#/schedule/'); }
      return viewNoOnly(s);
    }
    if (ONLY === 'schedule' && s.person) {
      const mode = s.schedMode || 'store';
      if (mode === 'store') rememberSchedStore(s.code);
      // 網址的分頁屬於別種排班的店（例如管理系統首頁提醒直接開 #/schedule/approve）→ 自動換到那種店（能進才換；沒有就留在這裡，由模組顯示第一個分頁）
      const want = r.page === 'schedule' ? SCHED_TAB_MODE[r.tab] : undefined;      // 只看排班的網址（#/duty/approve 這類別的功能網址會轉回排班，不算）
      if (want && want !== mode) {
        const t = pickSchedStore(s, want);
        if (t && autoSwitchOk(t.code)) return autoSwitch(s, t.code, location.hash);
        if (!t) return viewSchedNoAccess(s, r.tab);      // 沒有那邊的排班權限：說清楚，不要悄悄顯示別種排班的畫面
      }
      // 個人登入：門市排班只給能排班的人；只能看的主管（區督導、總監…）不看門市排班——有總部／央廚入口的轉過去，沒有就說明
      if (mode === 'store' && !s.scheduleAdmin) {
        const t = pickSchedStore(s, 'self') || pickSchedStore(s, 'fixed');
        if (t && autoSwitchOk(t.code)) return autoSwitch(s, t.code, '#/schedule/');
        return viewNoOnly(s, true);
      }
    }
    if (r.page !== ONLY) { history.replaceState(null, '', `#/${ONLY}/`); return render(); }
  }
  if (!ONLY && MOVED[r.page]) return viewMoved(s, r.page);   // 一般模式進 #/duty/…、#/schedule/…（ONLY 已在上面處理）
  if (r.page === 'password') return s.person ? go('#/') : viewPassword(s);
  if (r.page === 'staffperm') return viewStaffPerm(s, tok);
  if (r.page === 'features') return viewFeatures(s);
  if (r.page === 'admin') return viewAdmin(s, r.tab, tok);
  if (r.page) return viewModule(s, r.page, r.tab, tok);
  return viewHome(s, tok);
}

async function boot() {
  if (MOCK) { const db = document.getElementById('demoBar'); db.textContent = '示範模式：資料只存在這個瀏覽器，不會送到真的系統'; db.hidden = false; document.body.classList.add('has-demo'); }
  initAuth(() => { location.hash = '#/'; if (EMBED) sendReady(); render(); }, () => render());      // 嵌入時登入過期 → 再對 parent 要一張新券
  await loadUi();
  window.addEventListener('hashchange', onHash);
  if (EMBED) installEmbed();
  await refreshMe();
  const t = takeTicketFromHash();                                  // 從管理系統帶券回來：先兌換再畫第一個畫面
  if (t === null) return render();
  if (t) await runTicket(t, false); else { SSO_ERR = '入場券格式不正確，請重新用管理系統帳號登入'; render(); }
}
boot();
