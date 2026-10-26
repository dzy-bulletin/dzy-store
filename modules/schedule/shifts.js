// 自動排班「班別與設定」分頁：每店自己的班別（名稱、上下班、休息）、工作站別（名稱、顏色、排序、停用）、目標每工時營業額。
import { esc, busy } from '../../js/ui.js';
import { S, call, load, hm } from './state.js';
import { shiftMinutes, breakOk, breakWarn } from './hours.js';
import { staleFixed } from './fixed.js';

let stNote = null;                                                   // 存站別後（畫面會重畫）要留給那一列的訊息：{ id, text }

export function renderShifts(ctx) {
  const el = ctx.el, D = S.data;
  const note = stNote; stNote = null;
  const fixed = !!(ctx.session && ctx.session.schedMode === 'fixed');      // 央廚固定排班：只管班別時段（新增後到「固定班別」選用）；沒有營業額目標
  const row = (s) => `<div class="card sc-shift" data-id="${esc(s ? s.id : '')}"><div class="grid2">
      <div class="fld"><label>班別名稱</label><input type="text" class="s-name" maxlength="12" value="${esc(s ? s.name : '')}" placeholder="例：早班"></div>
      <div class="fld"><label>上班</label><input type="time" class="s-start" value="${esc(s ? s.start : '10:00')}"></div>
      <div class="fld"><label>下班（早於上班＝隔天下班）</label><input type="time" class="s-end" value="${esc(s ? s.end : '19:00')}"></div>
      <div class="fld"><label>休息（分鐘）</label><input type="number" min="0" max="600" class="s-break" value="${s ? s.break_min : 60}"></div>
      <div class="fld"><label>顏色</label><input type="color" class="s-color" value="${esc((s && s.color) || '#FFF4CC')}"></div>
      <div class="fld"><label>排序</label><input type="number" min="0" max="999" class="s-sort" value="${s ? s.sort : 0}"></div></div>
    <div class="row"><span class="hint s-hours">${s ? `工時 ${hm(shiftMinutes(s))} 小時` : ''}</span>
      ${s ? `<label class="sc-chk"><input type="checkbox" class="s-active" ${s.active ? 'checked' : ''}> 使用中</label>` : ''}
      <button type="button" class="btn sm s-save">${s ? '儲存' : '新增班別'}</button><span class="s-msg okmsg" role="status"></span></div></div>`;

  // 工作站別（station-spec §7）：只停用不刪除；停用的灰字標「已停用」，選單不出現、已排的格子照樣顯示
  const stations = D.stations || [];
  const stRow = (x, i) => `<div class="card sc-station${x && !x.active ? ' off' : ''}" data-id="${esc(x ? x.id : '')}"><div class="row">
      <input type="text" class="st-name" maxlength="10" value="${esc(x ? x.name : '')}" placeholder="例：炒鍋" aria-label="站別名稱">
      <input type="color" class="st-color" value="${esc((x && x.color) || '#5B6B7A')}" aria-label="顏色">
      ${x ? `<label class="sc-chk"><input type="checkbox" class="st-active" ${x.active ? 'checked' : ''}> 使用中</label>${x.active ? '' : '<span class="tag">已停用</span>'}
        <button type="button" class="btn sm ghost st-up" ${i === 0 ? 'disabled' : ''} aria-label="上移">↑</button><button type="button" class="btn sm ghost st-down" ${i === stations.length - 1 ? 'disabled' : ''} aria-label="下移">↓</button>` : ''}
      <button type="button" class="btn sm st-save">${x ? '儲存' : '新增站別'}</button><span class="st-msg okmsg" role="status">${x && note && note.id === x.id ? esc(note.text) : ''}</span></div></div>`;

  const rule = '一個班沒排休息最多 6 小時，超過要有至少 30 分鐘休息；4～6 小時沒排休息會提醒（勞基法 §35：連續工作 4 小時要休息 30 分鐘，餐飲可依但書在工作時間內讓同仁輪流休息）。';
  const tail = fixed ? '新增的班別會出現在「固定班別」與「央廚班表」的選單裡。已經有人在用的班要換時間，建議新增一個新班別，再到「固定班別」改選——改選後系統會自動重產他從明天起的平日班並送到 LINE；直接改舊班別的時間，已送到 LINE 的班表不會自動重送。' : '改班別時間只影響還沒鎖定的期；已發布的班表照鎖定當時的內容。';
  el.innerHTML = `<div class="card"><h2>班別</h2><p class="hint" id="scShiftHint">${rule}${tail}</p></div>
    ${D.shifts.map(row).join('')}${row(null)}
    <div class="card"><h2>工作站別</h2><p class="hint">每位同仁每個上班日站哪個工作站（例：炒鍋、外場、收銀、備料）。站別不能刪除，不用的請取消「使用中」：停用後選單不會出現、不再自動帶入，已排的班表照樣顯示。改站名或停用後，已鎖定的班表會自動重送 LINE。</p></div>
    ${stations.map(stRow).join('')}${stRow(null)}
    ${fixed ? '' : `<div class="card"><h2>每工時營業額目標</h2><p class="hint">班表上低於這個數字會標橘色。空白＝不比較。</p>
      <div class="row"><input type="number" min="0" id="cfgRatio" value="${D.cfg && D.cfg.ratio_target != null ? D.cfg.ratio_target : ''}" aria-label="每工時營業額目標"> 元
      <button type="button" class="btn" id="cfgSave">儲存</button><span id="cfgMsg" class="okmsg" role="status"></span></div></div>`}`;

  el.querySelectorAll('.sc-shift').forEach((c) => {
    const f = (s) => c.querySelector(s);
    const paint = () => {
      const sh = { start: f('.s-start').value, end: f('.s-end').value, break_min: Number(f('.s-break').value) || 0 };
      try { f('.s-hours').textContent = `工時 ${hm(shiftMinutes(sh))} 小時` + (!breakOk(sh) ? '（超過 6 小時要休息 30 分鐘）' : breakWarn(sh) ? '（超過 4 小時沒排休息：請在上班時間內讓同仁輪流休息 30 分鐘）' : ''); } catch (e) { f('.s-hours').textContent = ''; }
    };
    ['.s-start', '.s-end', '.s-break'].forEach((s) => { f(s).oninput = paint; });
    if (c.dataset.id) paint();                                       // 已存的班別一打開就顯示提醒
    f('.s-save').onclick = () => busy(f('.s-save'), async () => {
      const shift = { id: c.dataset.id || null, name: f('.s-name').value, start: f('.s-start').value, end: f('.s-end').value, break_min: Number(f('.s-break').value) || 0,
        color: f('.s-color').value, sort: Number(f('.s-sort').value) || 0, active: f('.s-active') ? f('.s-active').checked : true };
      try { await call('saveShift', { shift }); staleFixed(); await load(); ctx.rerender(); }
      catch (e) { const m = f('.s-msg'); m.className = 's-msg err'; m.textContent = e.message; }
    });
  });
  const saveSt = async (x) => call('saveStation', { station: x });
  el.querySelectorAll('.sc-station').forEach((c) => {
    const f = (s) => c.querySelector(s);
    const cur = stations.find((x) => x.id === c.dataset.id);
    const fail = (e) => { const m = f('.st-msg'); m.className = 'st-msg err'; m.textContent = e.message; };
    f('.st-save').onclick = () => busy(f('.st-save'), async () => {
      try {
        const r = await saveSt({ id: c.dataset.id || null, name: f('.st-name').value, color: f('.st-color').value, sort: cur ? cur.sort : stations.length + 1, active: f('.st-active') ? f('.st-active').checked : true });
        if (r && r.republished && r.republished.length) stNote = { id: r.id, text: `已重送 ${r.republished.join('、')} 到 LINE` };
        staleFixed(); await load(); ctx.rerender();
      }
      catch (e) { fail(e); }
    });
    // 上下移：把整張清單重新編號（1、2、3…）再交換這兩個，存有變的
    const move = (dir) => busy(f(dir > 0 ? '.st-down' : '.st-up'), async () => {
      const i = stations.indexOf(cur), j = i + dir;
      if (j < 0 || j >= stations.length) return;
      const order = stations.slice(); [order[i], order[j]] = [order[j], order[i]];
      try { for (const [k, x] of order.entries()) if (x.sort !== k + 1) await saveSt({ id: x.id, name: x.name, color: x.color, sort: k + 1, active: !!x.active }); staleFixed(); await load(); ctx.rerender(); }
      catch (e) { fail(e); }
    });
    if (f('.st-up')) { f('.st-up').onclick = () => move(-1); f('.st-down').onclick = () => move(1); }
  });
  if (fixed) return;
  el.querySelector('#cfgSave').onclick = () => busy(el.querySelector('#cfgSave'), async () => {
    const m = el.querySelector('#cfgMsg');
    try { const v = el.querySelector('#cfgRatio').value; await call('saveCfg', { ratio_target: v === '' ? null : Number(v) }); await load(); m.className = 'okmsg'; m.textContent = '已儲存'; }
    catch (e) { m.className = 'err'; m.textContent = e.message; }
  });
}
