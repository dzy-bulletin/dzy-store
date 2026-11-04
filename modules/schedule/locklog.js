// 鎖定紀錄（2026-11-05 Eason：要能查詢、紀錄永久保留）：這家店每一次鎖定／解除鎖定——誰、什麼時候、哪一期、有沒有送 LINE。
// 資料：/m/schedule/lockLog（伺服器 sch_log，本機從不刪、雲端備份全送）；每次進這個分頁重讀一次，篩選只在前端。只讀，看得到班表的人都看得到。
import { esc } from '../../js/ui.js';
import { call } from './state.js';
import { periodStart, periodEnd, parseLabel } from './period.js';

export const ACTION_LABEL = { lock: '鎖定', unlock: '解除鎖定' };
const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
// 期別不是今年的帶年份（T14＝2027/1/31–2/27），今年的只寫月/日
export const periodText = (p, thisYear) => {
  try {
    const a = periodStart(p), b = periodEnd(p), y = thisYear || String(new Date(Date.now() + 8 * 3600e3).getUTCFullYear());
    const f = (d) => (d.slice(0, 4) === y ? '' : d.slice(0, 4) + '/') + md(d);
    return `${p}（${f(a)}–${a.slice(0, 4) === b.slice(0, 4) && a.slice(0, 4) !== y ? md(b) : f(b)}）`;
  } catch (e) { return p || '—'; }
};
const periodNum = (p) => { try { return parseLabel(p); } catch (e) { return -1; } };
// 紀錄時間存 UTC，畫面一律台北時間「2026/11/5 14:20」
export function atText(iso) {
  const t = new Date(iso);
  if (isNaN(t)) return String(iso || '');
  const x = new Date(t.getTime() + 8 * 3600e3), p2 = (n) => String(n).padStart(2, '0');
  return `${x.getUTCFullYear()}/${x.getUTCMonth() + 1}/${x.getUTCDate()} ${p2(x.getUTCHours())}:${p2(x.getUTCMinutes())}`;
}
export function filterLog(log, f) {
  const who = String(f.who || '').trim().toLowerCase();
  return log.filter((e) => (!f.period || e.period === f.period) && (!f.action || e.action === f.action) && (!who || String(e.who || '').toLowerCase().indexOf(who) >= 0));
}

let LL = null;   // { key, log, err, f }
export function renderLockLog(ctx) {
  const key = ctx.session.token || ctx.session.code;
  if (!LL || LL.key !== key) LL = { key, log: null, err: '', f: { period: '', action: '', who: '' } };
  const st = LL, el = ctx.el;
  el.innerHTML = '<div class="card"><p class="hint" style="margin:0" id="llWait">讀取中…</p></div>';
  call('lockLog', {}).then((d) => { st.log = (d && d.log) || []; st.err = ''; }, (e) => { st.err = e.message; })
    .then(() => { if (el.isConnected) draw(el, st); });
}

function draw(el, st) {
  if (st.err) { el.innerHTML = `<div class="card"><div class="err" id="llErr" role="alert">讀不到鎖定紀錄：${esc(st.err)}</div></div>`; return; }
  const periods = Array.from(new Set(st.log.map((e) => e.period).filter(Boolean))).sort((a, b) => periodNum(b) - periodNum(a));   // 新的期在前（T100 也排對）
  if (st.f.period && periods.indexOf(st.f.period) < 0) st.f.period = '';
  const opt = (v, t, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(t)}</option>`;
  el.innerHTML = `<div class="card">
    <h2 style="margin-top:0">鎖定紀錄</h2>
    <p class="hint">每一次鎖定、解除鎖定都會記下來，永久保留、不能修改。</p>
    <div class="sc-ll-bar">
      <label>期別 <select id="llPeriod">${opt('', '全部期別', st.f.period)}${periods.map((p) => opt(p, periodText(p), st.f.period)).join('')}</select></label>
      <label>動作 <select id="llAction">${opt('', '全部', st.f.action)}${opt('lock', '鎖定', st.f.action)}${opt('unlock', '解除鎖定', st.f.action)}</select></label>
      <label>操作人 <input id="llWho" type="search" placeholder="姓名或代號" value="${esc(st.f.who)}" autocomplete="off"></label>
    </div>
    <div id="llOut"></div></div>`;
  const out = el.querySelector('#llOut');
  const paint = () => {
    const rows = filterLog(st.log, st.f);
    if (!st.log.length) { out.innerHTML = '<p class="hint" id="llEmpty">這家店還沒有鎖定紀錄。</p>'; return; }
    if (!rows.length) { out.innerHTML = '<p class="hint" id="llEmpty">沒有符合條件的紀錄。</p>'; return; }
    out.innerHTML = `<p class="hint" id="llCount">共 ${rows.length} 筆</p><div class="sc-ll-wrap"><table class="sc-ll"><thead><tr><th>時間</th><th>期別</th><th>動作</th><th>操作人</th><th>說明</th></tr></thead><tbody>${
      rows.map((e) => `<tr data-ll="${esc(String(e.id))}"><td>${esc(atText(e.at))}</td><td>${esc(periodText(e.period))}</td><td><span class="sc-ll-act ${e.action === 'lock' ? 'lock' : 'unlock'}">${esc(ACTION_LABEL[e.action] || e.action)}</span></td><td>${esc(e.who || '—')}</td><td>${esc(e.detail || '')}</td></tr>`).join('')
    }</tbody></table></div>`;
  };
  el.querySelector('#llPeriod').addEventListener('change', (ev) => { st.f.period = ev.target.value; paint(); });
  el.querySelector('#llAction').addEventListener('change', (ev) => { st.f.action = ev.target.value; paint(); });
  el.querySelector('#llWho').addEventListener('input', (ev) => { st.f.who = ev.target.value; paint(); });
  paint();
}
