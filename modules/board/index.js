// 叫貨看板（2026-10-11 Eason：第七格）：墨竹亭總部叫貨看板（IT 部門的 Cloudflare Worker，原系統不改）。
// 看板帳密由伺服器代管（vault board:<門市代號>），門市點進來直接看到自己店的看板，不用再登入。
// 看板回的是一整頁 HTML，放進 sandbox iframe（只給 allow-scripts，不給 same-origin：看板的程式碰不到營運系統的登入資料）。
import { esc } from '../../js/ui.js';

if (!document.getElementById('bdCss')) {
  const l = document.createElement('link');
  l.id = 'bdCss'; l.rel = 'stylesheet'; l.href = new URL('../../css/board.css', import.meta.url).href;
  document.head.appendChild(l);
}

let cache = null;          // { key, html, at }：同一個登入切頁回來不重抓（伺服器另有 60 秒快取）

const timeOf = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }); };

function fit(frame) {      // iframe 撐滿畫面剩下的高度（看板自己在框內捲動）
  if (!frame.isConnected) return removeEventListener('resize', frame._fit);
  const top = frame.getBoundingClientRect().top + window.scrollY;
  frame.style.height = Math.max(420, window.innerHeight - top - 16) + 'px';
}

function draw(ctx, d) {
  ctx.el.innerHTML = `<div class="bd-bar"><span class="hint" id="bdAt">更新時間 ${esc(timeOf(d.at))}</span><button class="btn ghost sm" id="bdRefresh" type="button">重新整理</button></div>
    <iframe class="bd-frame" id="bdFrame" title="叫貨看板" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>`;
  const frame = ctx.el.querySelector('#bdFrame');
  frame.srcdoc = d.html;
  frame._fit = () => fit(frame);
  addEventListener('resize', frame._fit);
  fit(frame);
  const btn = ctx.el.querySelector('#bdRefresh');
  btn.onclick = () => { btn.disabled = true; btn.textContent = '讀取中…'; load(ctx, true); };
}

function load(ctx, refresh) {
  const key = ctx.session.token || ctx.session.code;
  return ctx.api('POST', '/m/board/view', refresh ? { refresh: true } : {}).then(d => {
    cache = { key, html: d.html, at: d.at };
    if (ctx.el.isConnected) draw(ctx, cache);
  }, e => {
    cache = null;          // 讀失敗就不留舊內容：「重新讀取」一定重抓
    if (!ctx.el.isConnected) return;
    ctx.el.innerHTML = `<div class="card"><div class="err" id="bdLoadErr" role="alert">${esc(e.message || '叫貨看板讀取失敗，請稍後再試')}</div><button class="btn mt" id="bdRetry" type="button">重新讀取</button></div>`;
    ctx.el.querySelector('#bdRetry').onclick = () => ctx.rerender();
  });
}

export default {
  id: 'board',
  tabs: [{ id: 'view', label: '看板' }],
  render(ctx) {
    const key = ctx.session.token || ctx.session.code;
    if (cache && cache.key === key) return draw(ctx, cache);
    cache = null;
    ctx.el.innerHTML = '<div class="card"><p class="hint" style="margin:0">讀取中…</p></div>';
    return load(ctx, false);
  },
};
