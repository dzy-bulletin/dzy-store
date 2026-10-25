// 自動排班「班別與設定」分頁：每店自己的班別（名稱、上下班、休息）、目標每工時營業額。
import { esc, busy } from '../../js/ui.js';
import { S, call, load, hm } from './state.js';
import { shiftMinutes, breakOk, breakWarn } from './hours.js';

export function renderShifts(ctx) {
  const el = ctx.el, D = S.data;
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

  const rule = '一個班沒排休息最多 6 小時，超過要有至少 30 分鐘休息；4～6 小時沒排休息會提醒（勞基法 §35：連續工作 4 小時要休息 30 分鐘，餐飲可依但書在工作時間內讓同仁輪流休息）。';
  const tail = fixed ? '新增的班別會出現在「固定班別」與「央廚班表」的選單裡。已經有人在用的班要換時間，建議新增一個新班別，再到「固定班別」改選——改選後系統會自動重產他從明天起的平日班並送到 LINE；直接改舊班別的時間，已送到 LINE 的班表不會自動重送。' : '改班別時間只影響還沒鎖定的期；已發布的班表照鎖定當時的內容。';
  el.innerHTML = `<div class="card"><h2>班別</h2><p class="hint" id="scShiftHint">${rule}${tail}</p></div>
    ${D.shifts.map(row).join('')}${row(null)}
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
      try { await call('saveShift', { shift }); await load(); ctx.rerender(); }
      catch (e) { const m = f('.s-msg'); m.className = 's-msg err'; m.textContent = e.message; }
    });
  });
  if (fixed) return;
  el.querySelector('#cfgSave').onclick = () => busy(el.querySelector('#cfgSave'), async () => {
    const m = el.querySelector('#cfgMsg');
    try { const v = el.querySelector('#cfgRatio').value; await call('saveCfg', { ratio_target: v === '' ? null : Number(v) }); await load(); m.className = 'okmsg'; m.textContent = '已儲存'; }
    catch (e) { m.className = 'err'; m.textContent = e.message; }
  });
}
