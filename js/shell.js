import { MOCK } from './config.js';
import { api } from './api.js';
import { initAuth, getSession, setSession, clearSession, rememberedCode, login, logout, changePassword } from './auth.js';
import { MODULES, ADMIN_TABS } from './registry.js';
import { esc, busy, setMsg, applyUi } from './ui.js';
import { applyTheme } from './theme.js';

const app = document.getElementById('app');
let UI = { systemName: '門市營運系統', logoUrl: '', colors: {}, cards: [], banner: '' };
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

const NAV_ICONS = { home: '🏠', purchase: '🧾', cashbook: '💰', duty: '🕒', transfer: '🔄', loss: '🗑️', inventory: '📦', admin: '⚙️' };
// 左側深色側邊欄（外觀正本 ~/mala-clock-in/payroll.html .sidebar）：品牌→首頁→有開的系統→（管理者）後台管理→使用者區
function sidebarHtml(s, cur) {
  const feats = new Set(s.features || []);
  const mods = [...(UI.cards || [])].sort((a, b) => a.order - b.order)
    .filter(c => c.visible && feats.has(c.id) && MODULES.some(m => m.id === c.id));
  const item = (key, href, label) => `<a href="${href}" data-nav="${key}" class="${cur === key ? 'on' : ''}"${cur === key ? ' aria-current="page"' : ''}><span class="ic">${NAV_ICONS[key] || '•'}</span>${esc(label)}</a>`;
  return `<aside class="sidebar" id="sidebar">
    <a class="brand" href="#/" id="brand"><div class="logos"></div><div><div class="bt js-bt" id="brandName"></div><div class="bs js-bs"></div></div></a>
    <nav id="nav" aria-label="系統選單">
      ${item('home', '#/', '首頁')}
      ${mods.length ? '<div class="nav-label">系統</div>' : ''}
      ${mods.map(c => item(c.id, `#/${c.id}/`, c.label)).join('')}
      ${s.role === 'admin' ? `<div class="nav-label">管理</div>${item('admin', '#/admin/accounts', '後台管理').replace('<a ', '<a id="adminLink" ')}` : ''}
    </nav>
    <div class="side-user"><div class="av">🙂</div>
      <div class="su-main"><div class="nm" id="whoName">${esc(s.name)}</div><div class="rl">${esc(s.code || '')}${s.role === 'admin' ? '・管理者' : ''}</div></div>
      <div class="su-act">${!s.mustChangePassword ? '<a href="#/password" id="pwLink">改密碼</a>' : ''}<button id="logoutBtn" type="button">登出</button></div></div>
  </aside>`;
}
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
    app.innerHTML = `<div class="app">${sidebarHtml(s, opts.cur)}<div class="main-wrap"><div class="topbar"><h1 class="page-title" id="pageTitle">${esc(opts.title || '')}</h1>${opts.sub ? `<div class="sub">${esc(opts.sub)}</div>` : ''}</div>${nav || ''}<main>${inner}</main></div></div>`;
  }
  applyTheme(s ? s.brand : null, UI.logoUrl);
  const lb = document.getElementById('logoutBtn');
  if (lb) lb.onclick = async () => { await logout(); location.hash = '#/'; render(); };
  return app.querySelector('main') || app.querySelector('.login-view');
}

// ---------- 登入 ----------
function viewLogin() {
  const main = frame(null, `<div class="page">${bannerHtml()}<div class="lcard"><h1>${esc(UI.systemName)}</h1>
    <p class="muted">請用門市代號登入（例如 MDGF）</p>
    <form id="loginForm" autocomplete="off"><label class="f" for="code">門市代號<input id="code" type="text" autocapitalize="characters" autocomplete="username" value="${esc(rememberedCode())}"></label>
    <label class="f" for="password">密碼<input id="password" type="password" autocomplete="current-password"></label>
    <p class="pwhint" id="pwHint">第一次使用的預設密碼是 000000，登入後系統會請你設定自己的新密碼。</p>
    <div id="loginErr" class="err" role="alert"></div><button class="lbtn" id="loginBtn" type="submit">登入</button></form>
    <div class="login-links"><button type="button" id="forgotBtn" class="linkbtn" aria-expanded="false" aria-controls="forgotBox">忘記密碼</button>
      <a id="guideLink" href="guide.html" target="_blank" rel="noopener">操作手冊</a></div>
    <div class="note" id="forgotBox" hidden>忘記密碼請找管理者，在後台重設。重設後密碼會回到 000000，登入後再自己設定新密碼。</div></div></div></div>`);
  const codeEl = main.querySelector('#code');
  codeEl.oninput = () => { const p = codeEl.selectionStart; codeEl.value = codeEl.value.toUpperCase(); try { codeEl.setSelectionRange(p, p); } catch (e) {} };
  const fb = main.querySelector('#forgotBtn'), fbox = main.querySelector('#forgotBox');
  fb.onclick = () => { fbox.hidden = !fbox.hidden; fb.setAttribute('aria-expanded', String(!fbox.hidden)); };
  const f = main.querySelector('#loginForm');
  if (rememberedCode()) main.querySelector('#password').focus();
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
}
async function loadTodos(tok) {
  let d = null;
  try { d = await api('GET', '/home'); } catch (e) { /* 讀不到：每組顯示「暫時讀不到」 */ }
  if (tok !== renderToken || !document.getElementById('todoBody')) return;
  fillGroups(d);
  applyBadges(d ? d.items : []);
}
function viewHome(s, tok) {
  const feats = new Set(s.features || []);
  const cards = [...(UI.cards || [])].sort((a, b) => a.order - b.order)
    .filter(c => c.visible && feats.has(c.id) && MODULES.some(m => m.id === c.id));
  const html = cards.length
    ? `<div id="todoBody" aria-live="polite">${cards.map(c => `<section class="card todo-group" data-module="${c.id}"><h2>${esc(c.label)}</h2><div class="todo-body"><div class="hint">讀取中…</div></div></section>`).join('')}</div>`
    : `<div class="card"><p>目前還沒有開通任何功能，請洽管理者。</p></div>`;
  frame(s, bannerHtml() + html, '', { cur: 'home', title: '待辦與異常', sub: s.name });
  if (cards.length) loadTodos(tok);
}

// ---------- 模組 ----------
async function viewModule(s, id, tab, tok) {
  const reg = MODULES.find(m => m.id === id);
  if (!reg || !(s.features || []).includes(id) || (cardOf(id) && !cardOf(id).visible)) return go('#/');
  const mod = (await reg.load()).default;
  if (tok !== renderToken) return;
  const cur = mod.tabs.some(t => t.id === tab) ? tab : mod.tabs[0].id;
  if (cur !== tab) return history.replaceState(null, '', `#/${id}/${cur}`), render();
  const locked = mod.locked && mod.locked();
  const main = frame(s, `${bannerHtml()}<div id="modBody"></div>`, locked ? '' : tabsHtml(id, mod.tabs, cur), { cur: id, title: labelOf(reg) });
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
  view({ el: main.querySelector('#admBody'), api, session: s, refreshUi: async () => { await loadUi(); } });
}

export async function render() {
  const tok = ++renderToken;
  let s = getSession();
  if (!s) return viewLogin();
  if (s.mustChangePassword) return viewPassword(s);
  const r = route();
  window.scrollTo(0, 0);
  if (r.page === 'password') return viewPassword(s);
  if (r.page === 'admin') return viewAdmin(s, r.tab, tok);
  if (r.page) return viewModule(s, r.page, r.tab, tok);
  return viewHome(s, tok);
}

async function boot() {
  if (MOCK) { const db = document.getElementById('demoBar'); db.textContent = '示範模式：資料只存在這個瀏覽器，不會送到真的系統'; db.hidden = false; document.body.classList.add('has-demo'); }
  initAuth(() => { location.hash = '#/'; render(); }, () => render());
  await loadUi();
  window.addEventListener('hashchange', render);
  render();
}
boot();
