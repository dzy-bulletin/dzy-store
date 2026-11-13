// 排班匯入 Excel 的畫面（2026-11-10 開工單）：班表上方「匯入 Excel」「下載範本」兩顆按鈕＋匯入預覽視窗。
// 讀檔、比對都在瀏覽器裡做（importx.js 純函式）；按「確認匯入」才用 saveDays 一次寫入（伺服器檢查照舊）。
import { esc, busy } from '../../js/ui.js';
import { S, mutate, md, WD } from './state.js';
import { weekday, addDays } from './period.js';
import { LEAVES } from './rules.js';
import { shiftCode, timeText, isExtId } from './hours.js';
import { norm, parseSheet, pickSheet, buildPlan, templateAoa, legendAoa, fileKind, decodeCsv } from './importx.js';

let xlsxP = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (xlsxP) return xlsxP;
  xlsxP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL('../../vendor/xlsx.mini.min.js', import.meta.url).href;
    s.onload = () => (window.XLSX ? res(window.XLSX) : rej(new Error('Excel 元件載入失敗')));
    s.onerror = () => rej(new Error('Excel 元件載入失敗，請檢查網路後再試'));
    document.head.append(s);
  }).catch((e) => { xlsxP = null; throw e; });
  return xlsxP;
}

// 店長選過的寫法與姓名對照：存在這台裝置（開工單：不用改資料庫）；換店、班別或同仁不在了就不採用
const MEM = 'dzystore_schimport_';
const memKey = (ses) => MEM + ((ses && (ses.code || ses.store)) || '');
function memLoad(ses) { try { const v = JSON.parse(localStorage.getItem(memKey(ses)) || '{}'); return { tokens: v.tokens || {}, names: v.names || {} }; } catch (e) { return { tokens: {}, names: {} }; } }
function memSave(ses, m) { try { localStorage.setItem(memKey(ses), JSON.stringify(m)); } catch (e) { /* 無痕模式：下次重選 */ } }

/** 按鈕（放在班表上方那排）：能排班的人才有；鎖定的期「匯入」灰掉（要先解鎖），範本照樣能下載 */
export function importButtons(locked, canLock) {
  if (!canLock) return '';
  return (locked ? '<button type="button" class="btn ghost" id="scImport" disabled title="這一期已鎖定，要先解除鎖定才能匯入">匯入 Excel（先解除鎖定）</button>'
    : '<button type="button" class="btn ghost" id="scImport">匯入 Excel</button>')
    + '<input type="file" id="scImportFile" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden>'
    + '<button type="button" class="btn ghost" id="scTemplate">下載範本</button>';
}

const IMP = { open: false };

// 值的下拉選項（對不上的寫法用）：使用中的本店班別、休息日加班、例、休、國定、各假別、清空、不匯入
function valueOptions(D, cur) {
  const sh = D.shifts.filter((s) => s.active && !isExtId(s.id));
  const o = (v, t) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(t)}</option>`;
  return o('', '請選擇…') + sh.map((s) => o('S:' + s.id, `${shiftCode(s.name)} ${timeText(s)}`)).join('')
    + sh.map((s) => o('O:' + s.id, `休息日加班 ${shiftCode(s.name)}`)).join('')
    + o('R', '例假') + o('H', '休息日') + o('L:國', '國定假日假') + LEAVES.map(([c, l]) => o('L:' + c, l)).join('')
    + o('CLEAR', '清空') + o('SKIP', '不匯入');
}

function draw(D) {
  const bg = document.getElementById('scImpBg');
  if (!bg) return;
  const box = bg.querySelector('.sc-imp');
  const sheetSel = IMP.sheets.length > 1 ? `<label class="sc-impsheet">工作表 <select id="impSheet">${IMP.sheets.map((s, i) => `<option value="${i}"${i === IMP.sheetI ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : '';
  const head = `<div class="sc-imphead"><b>匯入 Excel 到 ${esc(D.period)}（${md(D.dates[0])}–${md(D.dates[D.dates.length - 1])}）</b><span class="sc-impfile">${esc(IMP.fileName)}</span>${sheetSel}</div>`;
  if (!IMP.parsed.ok) {
    box.innerHTML = `${head}<div class="note warn" id="impErr">${esc(IMP.parsed.err)}</div>
      <p class="hint">可以先按「下載範本」，照範本的格式填好再匯入。</p><div class="row sc-impacts"><button type="button" class="btn ghost" id="impCancel">關閉</button></div>`;
    return bind(D);
  }
  const pl = IMP.plan = buildPlan(D, IMP.parsed, IMP.picks);
  const c = pl.counts;
  const chips = `<div class="sc-impsum" id="impSum"><span class="sc-impchip ok">會寫入 ${c.write} 格</span>${c.change ? `<span class="sc-impchip chg">其中改掉現有 ${c.change} 格</span>` : ''}${c.skip ? `<span class="sc-impchip bad">不會匯入 ${c.skip} 格</span>` : ''}<span class="sc-impchip">不變 ${c.same} 格</span></div>`;
  const th = D.dates.map((d) => `<th>${md(d)}<small>${WD[weekday(d)]}</small></th>`).join('');
  const cellTd = (x) => {
    if (!x) return '<td></td>';
    const cls = { change: 'chg', new: 'new', reject: 'bad', unknown: 'bad', skip: 'skip', keep: 'keep' }[x.status] || '';
    const sub = x.status === 'change' ? `<small>原 ${esc(x.oldText || '空白')}</small>` : x.status === 'unknown' ? '<small>？</small>' : x.status === 'reject' ? '<small>不匯入</small>' : x.status === 'keep' ? '<small>支援</small>' : '';
    return `<td class="${cls}" title="${esc(x.reason || '')}">${esc(x.text || '')}${sub}</td>`;
  };
  const table = pl.rows.length ? `<div class="sc-imptbl"><table id="impTable"><thead><tr><th class="nm">同仁</th>${th}</tr></thead><tbody>${pl.rows.map((r) => `<tr data-emp="${esc(r.emp_id)}"><th class="nm">${esc(r.name)}</th>${D.dates.map((d) => cellTd(r.cells[d])).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="note warn">檔案裡沒有對得到的同仁，請在下面選他們是誰。</div>';
  const staffOpts = (cur) => {
    const used = new Set(pl.rows.map((r) => r.emp_id));
    return `<option value="">請選擇…</option><option value="SKIP"${cur === 'SKIP' ? ' selected' : ''}>不匯入</option>`
      + D.staff.filter((s) => !s.ext && D.dates.some((d) => (!s.hire_date || s.hire_date <= d) && (!s.leave_date || d <= s.leave_date)) && !used.has(s.emp_id))
        .map((s) => `<option value="${esc(s.emp_id)}">${esc(s.name)}</option>`).join('');
  };
  const fixes = [];
  for (const t of pl.unknownTokens) fixes.push(`<div class="sc-impfix"><span>Excel 寫「<b>${esc(t.tok)}</b>」（${t.n} 格）是什麼？</span><select class="imp-tok" data-tok="${esc(norm(t.tok))}">${valueOptions(D, '')}</select></div>`);
  for (const n of pl.unknownNames) if (n.chosen !== 'SKIP') fixes.push(`<div class="sc-impfix"><span>Excel 的「<b>${esc(n.name)}</b>」是誰？班表裡沒有對得到的名字</span><select class="imp-name" data-name="${esc(n.name)}">${staffOpts(n.chosen)}</select></div>`);
  const notes = [];
  const skipNames = pl.unknownNames.filter((n) => n.chosen === 'SKIP').map((n) => n.name);
  if (skipNames.length) notes.push(`<li>不匯入：${skipNames.map(esc).join('、')}（<button type="button" class="btn ghost sm" id="impUnskip">重新選</button>）</li>`);
  if (pl.missing.length) notes.push(`<li class="warn">檔案裡沒有：${pl.missing.map(esc).join('、')} → 這幾位的班維持原樣</li>`);
  // 檔案沒列到的日期不動（2026-11-10 挑錯 #9）：連續的日子併成一段「12/13–12/26」
  const spans = (ds) => { const out = []; let a0 = null, b0 = null; const push = () => { if (a0) out.push(a0 === b0 ? md(a0) : `${md(a0)}–${md(b0)}`); }; for (const d of ds) { if (b0 && addDays(b0, 1) === d) { b0 = d; continue; } push(); a0 = b0 = d; } push(); return out.join('、'); };
  if (pl.missingDates && pl.missingDates.length) notes.push(`<li class="warn" id="impNoDates">檔案裡沒有這 ${pl.missingDates.length} 天（${spans(pl.missingDates)}）→ 這幾天的班維持原樣</li>`);
  // Excel 寫的名字跟班表上不一樣、但自動對到的：列出來讓店長看一眼（2026-11-10 挑錯 #10）
  const renamed = pl.rows.filter((r) => r.xlsName !== undefined && norm(r.xlsName) !== norm(r.name));
  if (renamed.length) notes.push(`<li id="impNameMap">名字寫法不同，已對到：${renamed.map((r) => `「${esc(r.xlsName)}」→ ${esc(r.name)}`).join('、')}</li>`);
  if (pl.ambNames && pl.ambNames.length) notes.push(`<li class="bad" id="impAmb">班表上有同名的同仁（${pl.ambNames.map(esc).join('、')}），只寫名字分不出是誰，這幾列不匯入；請在 Excel 寫工號＋姓名（例：E11 ${esc(pl.ambNames[0])}）</li>`);
  if (pl.dupNames.length) notes.push(`<li class="bad">同一位同仁出現兩列（${pl.dupNames.map(esc).join('、')}），兩列都不匯入，請在檔案刪掉一列再匯入</li>`);
  if (pl.keeps.length) notes.push(`<li>支援別家門市的班不會被匯入改掉（${pl.keeps.length} 格）</li>`);
  if (pl.dayOnly) notes.push(`<li class="warn" id="impDayOnly">檔案的日期只寫幾號、沒寫月份，已照這一期（${md(D.dates[0])}–${md(D.dates[D.dates.length - 1])}）對日期，請確認是這一期的班表</li>`);
  if (pl.outside) notes.push(`<li>檔案裡有 ${pl.outside} 天不在這一期，已略過</li>`);
  for (const r of pl.rejects) notes.push(`<li class="bad">${esc(r.name)} ${md(r.date)}：${esc(r.reason)} → 這格不會匯入</li>`);
  box.innerHTML = `${head}${chips}${table}
    ${fixes.length ? `<div class="sc-impfixes" id="impFixes"><b class="hint">要你選一下（選過的這台裝置會記住）</b>${fixes.join('')}</div>` : ''}
    ${notes.length ? `<ul class="sc-impnotes" id="impNotes">${notes.join('')}</ul>` : ''}
    <p class="hint">Excel 的空白格會清空；匯入後照平常檢查提醒清單、再鎖定送 LINE。</p>
    <div id="impMsg" class="err" role="status"></div>
    <div class="row sc-impacts"><button type="button" class="btn" id="impOk"${pl.writes.length ? '' : ' disabled'}>${pl.writes.length ? `確認匯入 ${pl.writes.length} 格` : '沒有要匯入的格子'}</button><button type="button" class="btn ghost" id="impCancel">取消</button></div>`;
  bind(D);
}

function bind(D) {
  const bg = document.getElementById('scImpBg');
  const q = (s) => bg.querySelector(s);
  const close = () => { IMP.open = false; bg.remove(); };
  q('#impCancel').onclick = close;
  if (q('#impSheet')) q('#impSheet').onchange = () => { IMP.sheetI = +q('#impSheet').value; parse(D); draw(D); };
  bg.querySelectorAll('.imp-tok').forEach((s) => { s.onchange = () => { if (!s.value) return; IMP.picks.tokens[s.dataset.tok] = s.value; remember(); draw(D); }; });
  bg.querySelectorAll('.imp-name').forEach((s) => { s.onchange = () => { if (!s.value) return; IMP.picks.names[s.dataset.name] = s.value; remember(); draw(D); }; });
  if (q('#impUnskip')) q('#impUnskip').onclick = () => { for (const n of IMP.plan.unknownNames) if (n.chosen === 'SKIP') delete IMP.picks.names[n.name]; remember(); draw(D); };
  if (q('#impOk')) q('#impOk').onclick = () => busy(q('#impOk'), async () => {
    const pl = IMP.plan;
    try {
      // 一次最多 2000 格（伺服器上限）；一般一期 28 天 × 幾十人用不到第二批
      for (let i = 0; i < pl.writes.length; i += 2000) await mutate('saveDays', { cells: pl.writes.slice(i, i + 2000), reason: 'import' });
      close();
      IMP.done(`已匯入 ${pl.writes.length} 格` + (pl.counts.skip ? `，${pl.counts.skip} 格沒匯入（看預覽裡的紅字）` : ''), false);
    } catch (e) { const m = q('#impMsg'); if (m) m.textContent = '匯入沒有成功：' + e.message + '（班表沒有改）'; }
  });
}

// 記住店長選的對照（只記有意義的：寫法 → 值、Excel 姓名 → 同仁）
function remember() {
  const m = memLoad(IMP.ses);
  Object.assign(m.tokens, IMP.picks.tokens); Object.assign(m.names, IMP.picks.names);
  memSave(IMP.ses, m);
}

function parse(D) {
  const names = D.staff.filter((s) => !s.ext).map((s) => s.name);
  IMP.parsed = parseSheet(IMP.sheets[IMP.sheetI].aoa, D.dates, names);
}

function validPicks(D, m) {
  const act = new Set(D.shifts.filter((s) => s.active && !isExtId(s.id)).map((s) => s.id));
  const ok = (v) => { const ids = /^[SO]:/.test(v) ? v.slice(2).split('+') : []; return ids.every((id) => act.has(id)); };
  const emp = new Set(D.staff.map((s) => s.emp_id));
  return { tokens: Object.fromEntries(Object.entries(m.tokens).filter(([, v]) => typeof v === 'string' && ok(v))), names: Object.fromEntries(Object.entries(m.names).filter(([, v]) => v === 'SKIP' || emp.has(v))) };
}

/** 綁定按鈕；say(訊息, 是否錯誤)、rerender() 是班表看板給的 */
export function bindImport(root, ses, say, rerender) {
  const q = (s) => root.querySelector(s);
  const file = q('#scImportFile');
  if (q('#scImport') && file) {
    q('#scImport').onclick = () => { file.value = ''; file.click(); };
    file.onchange = async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const D = S.data;
      try {
        const kind = fileKind(f.name);
        if (kind === 'xls') throw new Error('這是舊版 .xls 檔，請在 Excel 用「另存新檔」存成 .xlsx 再匯入');
        if (kind === 'other') throw new Error('只能匯入 .xlsx 或 .csv 檔，其他格式請在 Excel 用「另存新檔」存成 .xlsx 再匯入');
        const X = await loadXlsx();
        // CSV 用文字讀（這個 Excel 元件沒有內建編碼表，用位元組讀中文會變亂碼）：先照 UTF-8，讀不出來照 Big5（Windows 的 Excel 另存 CSV）；其餘照位元組讀
        const wb = kind === 'csv' ? X.read(decodeCsv(await f.arrayBuffer()), { type: 'string', raw: true, cellDates: false }) : X.read(await f.arrayBuffer(), { type: 'array', cellDates: false });
        const sheets = wb.SheetNames.map((n) => ({ name: n, aoa: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }) }));
        if (!sheets.length) throw new Error('檔案裡沒有工作表');
        Object.assign(IMP, { open: true, ses, sheets, fileName: f.name, picks: validPicks(D, memLoad(ses)), done: (m, bad) => { say(m, bad); rerender(); } });
        IMP.sheetI = pickSheet(sheets, D.dates, D.staff.filter((s) => !s.ext).map((s) => s.name));
        parse(D);
      } catch (e) { say('讀不到這個檔案：' + ((e && e.message) || '格式不對'), true); return rerender(); }
      const old = document.getElementById('scImpBg'); if (old) old.remove();
      const bg = document.createElement('div');
      bg.className = 'modal-bg'; bg.id = 'scImpBg';
      bg.innerHTML = '<div class="modal sc-imp" role="dialog" aria-label="匯入 Excel 預覽"></div>';
      document.body.appendChild(bg);
      draw(D);
    };
  }
  if (q('#scTemplate')) q('#scTemplate').onclick = () => busy(q('#scTemplate'), async () => {
    const D = S.data;
    try {
      const X = await loadXlsx();
      const wb = X.utils.book_new();
      const ws = X.utils.aoa_to_sheet(templateAoa(D));
      ws['!cols'] = [{ wch: 10 }].concat(D.dates.map(() => ({ wch: 6 })));
      X.utils.book_append_sheet(wb, ws, '班表');
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(legendAoa(D)), '寫法說明');
      const buf = X.write(wb, { bookType: 'xlsx', type: 'array' });
      const name = `班表範本_${D.period}_${md(D.dates[0]).replace('/', '')}-${md(D.dates[D.dates.length - 1]).replace('/', '')}.xlsx`;
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a'); a.href = url; a.download = name; a.style.display = 'none';
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      say('已下載：' + name);
    } catch (e) { say((e && e.message) || '下載沒有成功，請再試一次', true); }
    rerender();
  });
}
