// 自動排班「指定與需求」分頁：每天各班要幾個人（平日／週六／週日範本＋個別日期）、每站最少人數（同一套做法）、同仁指定休假／上班／某班。
import { esc, busy } from '../../js/ui.js';
import { S, mutate, call, load, WD, md } from './state.js';
import { weekday } from './period.js';
// 指定日期格：月份放在 span，窄螢幕（≤360）除了第一格與每月 1 號都只顯示日（12/27 → 27），不然 7 欄塞不下（2026-10-26 手機巡檢）
const pinDate = (d) => { const t = md(d), k = t.indexOf('/'); return k < 0 ? t : `<span class="m">${t.slice(0, k + 1)}</span>${t.slice(k + 1)}`; };

const KINDS = [['wd', '平日'], ['sat', '週六'], ['sun', '週日']];

export function renderNeeds(ctx) {
  const el = ctx.el, D = S.data, locked = D.meta.locked;
  const shifts = D.shifts.filter((s) => s.active);
  const stations = (D.stations || []).filter((x) => x.active);          // 店裡沒有使用中的站別就不畫「各站最少人數」（現有畫面零變化）
  const stTplV = (k, id) => { const v = (D.stationNeedTpl[k] || {})[id]; return v != null ? v : ''; };
  const tplV = (k, sid, f) => { const x = (D.demandTpl[k] || {})[sid]; return x && x[f] != null ? x[f] : ''; };
  if (!S.needDay || !D.dates.includes(S.needDay)) S.needDay = D.dates[0];
  if (!S.pinEmp || !D.staff.some((s) => s.emp_id === S.pinEmp)) S.pinEmp = (D.staff[0] || {}).emp_id || '';
  const ov = D.demandOverrides[S.needDay];
  if (!S.stDay || !D.dates.includes(S.stDay)) S.stDay = D.dates[0];
  const stOv = (D.stationNeedDay || {})[S.stDay];
  const stDayV = (id) => { const v = (stOv || (D.stationNeed || {})[S.stDay] || {})[id]; return v != null ? v : ''; };
  const dayV = (sid, f) => { const x = (ov || D.demand[S.needDay] || {})[sid]; return x && x[f] != null ? x[f] : ''; };
  const pins = (D.pins[S.pinEmp] || {});
  const pinLabel = (p) => (!p ? '' : p.kind === 'off' ? '休' : p.kind === 'work' ? '上' : ((D.shifts.find((s) => s.id === p.shift_id) || {}).name || p.shift_id));

  const snMsg = S.snMsg || ''; S.snMsg = '';
  const tplMsg = S.ndMsg || ''; S.ndMsg = '';            // 重畫之後才顯示的訊息（重畫是非同步的，直接寫進舊畫面會被蓋掉）
  el.innerHTML = `
  <div class="card"><h2>每天各班要幾個人</h2>
    <p class="hint">設定一次，每一期都會照這個排。最少人數排不滿會出現「缺人」警告；最多人數空白＝不限。</p>
    ${shifts.length ? `<div class="scroll"><table class="sc-tbl"><thead><tr><th>班別</th>${KINDS.map(([, l]) => `<th>${l}最少</th><th>${l}最多</th>`).join('')}</tr></thead><tbody>
    ${shifts.map((s) => `<tr><th scope="row">${esc(s.name)}</th>${KINDS.map(([k]) => `<td><input type="number" min="0" max="99" class="sc-n" data-k="${k}" data-s="${esc(s.id)}" data-f="min" value="${tplV(k, s.id, 'min')}" aria-label="${esc(s.name)} 最少"></td><td><input type="number" min="0" max="99" class="sc-n" data-k="${k}" data-s="${esc(s.id)}" data-f="max" value="${tplV(k, s.id, 'max')}" aria-label="${esc(s.name)} 最多"></td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
    <div class="row mt"><button type="button" class="btn" id="ndTplSave">儲存人數範本</button></div>` : '<p class="hint">請先到「班別與設定」新增班別。</p>'}
    <div id="ndTplMsg" class="okmsg" role="status">${esc(tplMsg)}</div></div>

  <div class="card"><h2>個別日期另外設人數</h2>
    <p class="hint">國定假日、活動日要多排或少排人時用。只影響 ${esc(D.period)} 這一期。</p>
    <div class="row"><select id="ndDay" aria-label="日期">${D.dates.map((d) => `<option value="${d}" ${d === S.needDay ? 'selected' : ''}>${md(d)}（${WD[weekday(d)]}）${D.demandOverrides[d] ? '・已另設' : ''}${D.holidays.days[d] ? '・' + esc(D.holidays.days[d]) : ''}</option>`).join('')}</select></div>
    ${shifts.map((s) => `<div class="row mt"><span class="sc-lbl">${esc(s.name)}</span><input type="number" min="0" max="99" class="sc-dn" data-s="${esc(s.id)}" data-f="min" value="${dayV(s.id, 'min')}" aria-label="${esc(s.name)} 最少"> 到 <input type="number" min="0" max="99" class="sc-dn" data-s="${esc(s.id)}" data-f="max" value="${dayV(s.id, 'max')}" aria-label="${esc(s.name)} 最多"> 人</div>`).join('')}
    <div class="row mt"><button type="button" class="btn" id="ndDaySave" ${locked ? 'disabled' : ''}>儲存這一天</button><button type="button" class="btn ghost" id="ndDayClear" ${locked || !ov ? 'disabled' : ''}>改回範本</button></div>
    <div id="ndDayMsg" class="okmsg" role="status"></div></div>

  ${stations.length ? `<div class="card"><h2>每站最少人數</h2>
    <p class="hint">每個工作站、每天至少要幾個人。班表底部會顯示各站人數，不足標紅、提醒清單列「缺人」（只提醒，不擋鎖定）。空白＝不設。</p>
    <div class="scroll"><table class="sc-tbl"><thead><tr><th>工作站</th>${KINDS.map(([, l]) => `<th>${l}最少</th>`).join('')}</tr></thead><tbody>
    ${stations.map((x) => `<tr><th scope="row">${esc(x.name)}</th>${KINDS.map(([k]) => `<td><input type="number" min="0" max="99" class="sn-n" data-k="${k}" data-st="${esc(x.id)}" value="${stTplV(k, x.id)}" aria-label="${esc(x.name)} ${KINDS.find((y) => y[0] === k)[1]}最少"></td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
    <div class="row mt"><button type="button" class="btn" id="snTplSave">儲存各站人數</button></div>
    <div id="snTplMsg" class="okmsg" role="status">${esc(snMsg)}</div></div>

  <div class="card"><h2>個別日期另外設各站人數</h2>
    <p class="hint">國定假日、活動日要多排或少排人時用；這一天有另外設就整天取代上面的範本。只影響 ${esc(D.period)} 這一期；班表已鎖定也能改。</p>
    <div class="row"><select id="snDay" aria-label="日期">${D.dates.map((d) => `<option value="${d}" ${d === S.stDay ? 'selected' : ''}>${md(d)}（${WD[weekday(d)]}）${(D.stationNeedDay || {})[d] ? '・已另設' : ''}${D.holidays.days[d] ? '・' + esc(D.holidays.days[d]) : ''}</option>`).join('')}</select></div>
    ${stations.map((x) => `<div class="row mt"><span class="sc-lbl">${esc(x.name)}</span><input type="number" min="0" max="99" class="sn-dn" data-st="${esc(x.id)}" value="${stDayV(x.id)}" aria-label="${esc(x.name)} 最少"> 人</div>`).join('')}
    <div class="row mt"><button type="button" class="btn" id="snDaySave">儲存這一天</button><button type="button" class="btn ghost" id="snDayClear" ${stOv ? '' : 'disabled'}>改回範本</button></div>
    <div id="snDayMsg" class="okmsg" role="status"></div></div>` : ''}

  <div class="card"><h2>指定休假、指定上班</h2>
    <p class="hint">同仁要休的日子先在這裡點好，自動排班不會改動。點一下日期會依序切換：沒指定 → 休 → 上 →（各班別）→ 沒指定。</p>
    ${D.staff.length ? `<div class="row"><select id="pnEmp" aria-label="同仁">${D.staff.map((s) => `<option value="${esc(s.emp_id)}" ${s.emp_id === S.pinEmp ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
    <div class="sc-pins mt">${D.dates.map((d, i) => `<button type="button" class="sc-pin${pins[d] ? ' on k-' + pins[d].kind : ''}${i && d.slice(8) !== '01' ? ' no-m' : ''}" data-date="${d}" ${locked ? 'disabled' : ''}>${pinDate(d)}<small>${WD[weekday(d)]}</small><b>${esc(pinLabel(pins[d]))}</b></button>`).join('')}</div>` : '<p class="hint">還沒有同仁。</p>'}
    <div id="pnMsg" class="okmsg" role="status"></div></div>`;

  const q = (s) => el.querySelector(s);
  const msg = (id, t, bad) => { const m = q(id); m.className = bad ? 'err' : 'okmsg'; m.textContent = t; };
  const num = (v) => (v === '' ? null : Number(v));

  if (q('#ndTplSave')) q('#ndTplSave').onclick = () => busy(q('#ndTplSave'), async () => {
    const rows = [];
    for (const [k] of KINDS) for (const s of shifts) {
      const mn = el.querySelector(`.sc-n[data-k="${k}"][data-s="${s.id}"][data-f="min"]`).value, mx = el.querySelector(`.sc-n[data-k="${k}"][data-s="${s.id}"][data-f="max"]`).value;
      if (mn === '' && mx === '') continue;
      rows.push({ kind: k, shift_id: s.id, min: num(mn) || 0, max: num(mx) });
    }
    try { await call('saveDemandTpl', { rows }); await load(); S.ndMsg = '已儲存'; ctx.rerender(); } catch (e) { msg('#ndTplMsg', e.message, true); }
  });
  q('#ndDay').onchange = () => { S.needDay = q('#ndDay').value; ctx.rerender(); };
  q('#ndDaySave').onclick = () => busy(q('#ndDaySave'), async () => {
    const rows = shifts.map((s) => ({ shift_id: s.id, min: num(el.querySelector(`.sc-dn[data-s="${s.id}"][data-f="min"]`).value) || 0, max: num(el.querySelector(`.sc-dn[data-s="${s.id}"][data-f="max"]`).value) }));
    try { await mutate('saveDemandDay', { date: S.needDay, rows }); ctx.rerender(); } catch (e) { msg('#ndDayMsg', e.message, true); }
  });
  q('#ndDayClear').onclick = () => busy(q('#ndDayClear'), async () => {
    try { await mutate('saveDemandDay', { date: S.needDay, rows: null }); ctx.rerender(); } catch (e) { msg('#ndDayMsg', e.message, true); }
  });
  if (q('#snTplSave')) q('#snTplSave').onclick = () => busy(q('#snTplSave'), async () => {
    const rows = [];
    for (const [k] of KINDS) for (const x of stations) {
      const v = el.querySelector(`.sn-n[data-k="${k}"][data-st="${x.id}"]`).value;
      if (v !== '') rows.push({ kind: k, station_id: x.id, min: num(v) || 0 });
    }
    try { await call('saveStationNeedTpl', { rows }); await load(); S.snMsg = '已儲存'; ctx.rerender(); } catch (e) { msg('#snTplMsg', e.message, true); }
  });
  if (q('#snDay')) q('#snDay').onchange = () => { S.stDay = q('#snDay').value; ctx.rerender(); };
  if (q('#snDaySave')) q('#snDaySave').onclick = () => busy(q('#snDaySave'), async () => {
    const rows = stations.map((x) => ({ station_id: x.id, min: num(el.querySelector(`.sn-dn[data-st="${x.id}"]`).value) || 0 }));
    try { await mutate('saveStationNeedDay', { date: S.stDay, rows }); ctx.rerender(); } catch (e) { msg('#snDayMsg', e.message, true); }
  });
  if (q('#snDayClear')) q('#snDayClear').onclick = () => busy(q('#snDayClear'), async () => {
    try { await mutate('saveStationNeedDay', { date: S.stDay, rows: [] }); ctx.rerender(); } catch (e) { msg('#snDayMsg', e.message, true); }
  });
  if (q('#pnEmp')) q('#pnEmp').onchange = () => { S.pinEmp = q('#pnEmp').value; ctx.rerender(); };
  el.querySelectorAll('.sc-pin').forEach((b) => {
    b.onclick = () => busy(b, async () => {
      const cur = pins[b.dataset.date];
      const cycle = [null, { kind: 'off' }, { kind: 'work' }, ...shifts.map((s) => ({ kind: 'shift', shift_id: s.id }))];
      const i = cycle.findIndex((c) => (c === null ? !cur : cur && c.kind === cur.kind && (c.shift_id || null) === (cur.shift_id || null)));
      const next = cycle[(i + 1) % cycle.length];
      try { await mutate('savePins', { pins: [Object.assign({ emp_id: S.pinEmp, date: b.dataset.date }, next || { kind: null })] }); ctx.rerender(); }
      catch (e) { msg('#pnMsg', e.message, true); }
    });
  });
}
