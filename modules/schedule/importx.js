// 排班匯入 Excel（2026-11-10 Eason 開工單：門市排班、只吃 Excel、先預覽、確認後整期覆蓋、對不上的讓店長選）。
// 這支只放純函式（不碰畫面、不碰 XLSX 元件）：讀表格 → 認日期與姓名 → 每格寫法翻成班表格子 → 對照現有班表算出要寫哪些格。
// 寫入照舊走 saveDays（伺服器所有檢查都還在）；這裡先用同一套規則（rules.js comboError／orderTwo／employed）把會被擋的格子挑出來列給店長看，
// 不讓整批存檔因為一格失敗。Excel 空白格＝清空、檔案裡沒列到的同仁不動（開工單兩題照推薦）。
import { comboError, orderTwo, employed, LEAVES } from './rules.js';
import { shiftCode, segsOf, isExtId } from './hours.js';

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const pad = (n) => String(n).padStart(2, '0');
export const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

/** 全形轉半形、去空白、英文轉大寫（「Ａ班 」→「A班」） */
export function norm(v) {
  if (v === null || v === undefined) return '';
  return String(v).normalize('NFKC').replace(/\s+/g, '').toUpperCase();
}

/** 檔名 → 'xlsx'｜'csv'｜'xls'（舊格式，請另存）｜'other'（不收）。需求：匯入只收 .xlsx／.csv（2026-11-10 挑錯：原本只擋 .xls，其他靠內容猜） */
export function fileKind(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  const ext = m ? m[1].toLowerCase() : '';
  return ext === 'xlsx' ? 'xlsx' : ext === 'csv' ? 'csv' : ext === 'xls' ? 'xls' : 'other';
}
/** CSV 位元組 → 文字：先照 UTF-8 讀（去掉 BOM）；不是合法的 UTF-8 就照 Big5 讀（台灣 Windows 的 Excel「CSV（逗號分隔）」存的是 Big5，
 *  原本一律當 UTF-8，姓名整排變亂碼；2026-11-10 挑錯）。bytes：Uint8Array 或 ArrayBuffer */
export function decodeCsv(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(u8); }
  catch (e) { try { text = new TextDecoder('big5').decode(u8); } catch (e2) { text = new TextDecoder('utf-8').decode(u8); } }
  return text.replace(/^\uFEFF/, '');
}

// Excel 日期序號（1900 系統）→ YYYY-MM-DD；用 UTC 算，不受電腦時區影響
const serialYmd = (n) => { const t = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };

/**
 * 表頭一格 → 這一期的哪一天（認不得回 null）。
 * 認得：Excel 日期格（序號或 Date）、2026/11/29、2026-11-29、11/29、11月29日、29、29日；後面接（日）、星期也可以。
 * 只寫幾號時，依這一期的日期找那一天（一期 28 天，同一個「號」不會出現兩次）。
 */
export function dateOf(v, dates) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    const y = `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    return dates.includes(y) ? y : null;
  }
  if (typeof v === 'number') {
    if (v > 30000 && v < 80000) { const y = serialYmd(v); return dates.includes(y) ? y : null; }
    if (Number.isInteger(v) && v >= 1 && v <= 31) return dates.find((d) => +d.slice(8, 10) === v) || null;
    return null;
  }
  const s = norm(v).replace(/[(（].*$/, '').replace(/星期.*$|週.$|周.$/, '');
  let m = /^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?$/.exec(s);
  if (m) { const y = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`; return dates.includes(y) ? y : null; }
  m = /^(\d{1,2})[/.\-月](\d{1,2})日?$/.exec(s);
  if (m) return dates.find((d) => +d.slice(5, 7) === +m[1] && +d.slice(8, 10) === +m[2]) || null;
  m = /^(\d{1,2})日?$/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 31) return dates.find((d) => +d.slice(8, 10) === +m[1]) || null;
  return null;
}

// 字的種類：中文、英文、數字、其他文字；空白、標點、括號＝''（可以當分隔）
const charKind = (ch) => (!ch ? '' : /\p{Script=Han}/u.test(ch) ? 'han' : /[A-Z]/.test(ch) ? 'latin' : /[0-9]/.test(ch) ? 'digit' : /\p{L}/u.test(ch) ? 'other' : '');
/** raw（Excel 那格的原字）裡有沒有「獨立一段」的 key（已經 norm 過的同仁姓名）：字與字之間可以夾空白；前後緊貼的字不能跟姓名頭尾同一類 */
export function standsAlone(raw, key) {
  const soft = String(raw === null || raw === undefined ? '' : raw).normalize('NFKC').toUpperCase();
  const chars = Array.from(key);
  if (!chars.length) return false;
  const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(chars.map(esc).join('\\s*'), 'gu');
  let m;
  while ((m = re.exec(soft))) {
    const before = Array.from(soft.slice(0, m.index)).pop(), after = Array.from(soft.slice(m.index + m[0].length))[0];
    if ((!charKind(before) || charKind(before) !== charKind(chars[0])) && (!charKind(after) || charKind(after) !== charKind(chars[chars.length - 1]))) return true;
    re.lastIndex = m.index + 1;
  }
  return false;
}

// 不是同仁的列（表格下方常見的統計列）：名字欄是這些字就整列略過，不列進「對不上的姓名」
const NOT_NAME = /^(姓名|名字|同仁|員工|星期|週|人數|當天人數|合計|總計|小計|總工時|工時|備註|午餐|晚餐|日期|班別|早|晚|說明)$/;

/**
 * 從一張工作表（二維陣列）找出表頭列、日期欄、姓名欄，回傳每一列同仁的原始格子。
 * staffNames：班表上的同仁姓名（用來挑哪一欄是姓名）。
 * 回傳 { ok, err?, header, dateCols:[[欄,日期]], nameCol, rows:[{r, name, cells:{日期: 原始值}}], outside }
 */
export function parseSheet(aoa, dates, staffNames) {
  const rows = Array.isArray(aoa) ? aoa : [];
  let header = -1, best = [];
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const cols = [], seen = new Set();
    (rows[r] || []).forEach((v, c) => { const d = dateOf(v, dates); if (d && !seen.has(d)) { seen.add(d); cols.push([c, d]); } });
    if (cols.length > best.length) { best = cols; header = r; }
  }
  if (best.length < 7) return { ok: false, err: `找不到這一期（${md(dates[0])}–${md(dates[dates.length - 1])}）的日期：表頭要有一列寫日期（例 11/29、2026/11/29 或 29）` };
  // 表頭那列有寫日期、但不在這一期的格子（例：整個月的班表）→ 略過，畫面告訴店長略過幾天
  const dateColSet = new Set(best.map((x) => x[0]));
  let outside = 0;
  (rows[header] || []).forEach((v, c) => { if (!dateColSet.has(c) && /^\d{1,4}([/.\-月年]\d{1,2})*日?$/.test(norm(v).replace(/[(（].*$/, '')) && norm(v)) outside++; });
  const firstDateCol = Math.min(...best.map((x) => x[0]));
  // 姓名欄：表頭以下、日期欄以外，最多格「含有班表同仁姓名」的那一欄；一格都對不到就用第一個日期欄左邊最近、有字最多的欄
  const names = staffNames.map(norm).filter(Boolean);
  const score = {}, filled = {};
  for (let r = header + 1; r < rows.length; r++) (rows[r] || []).forEach((v, c) => {
    if (dateColSet.has(c)) return;
    const t = norm(v); if (!t) return;
    filled[c] = (filled[c] || 0) + 1;
    if (names.some((n) => t === n || t.includes(n))) score[c] = (score[c] || 0) + 1;
  });
  let nameCol = -1;
  const byScore = Object.keys(score).map(Number).sort((a, b) => score[b] - score[a] || a - b);
  if (byScore.length) nameCol = byScore[0];
  else {
    const left = Object.keys(filled).map(Number).filter((c) => c < firstDateCol).sort((a, b) => b - a);
    nameCol = left.length ? left.sort((a, b) => filled[b] - filled[a] || b - a)[0] : -1;
  }
  if (nameCol < 0) return { ok: false, err: '找不到姓名欄：日期左邊要有一欄寫同仁姓名' };
  const out = [];
  for (let r = header + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const name = String(row[nameCol] === undefined || row[nameCol] === null ? '' : row[nameCol]).trim();
    if (!name || NOT_NAME.test(norm(name))) continue;
    const cells = {};
    let any = false;
    for (const [c, d] of best) { const v = row[c]; cells[d] = v === undefined || v === null ? '' : v; if (norm(v)) any = true; }
    // 一整列日期格都是星期幾（日、一、二…）的列＝星期列，不是同仁
    if (best.every(([c]) => WD.includes(norm(row[c])) || !norm(row[c])) && any) continue;
    out.push({ r, name, cells });
  }
  // 表頭只寫幾號（29、30、1…）沒寫月份：認不出是哪個月的班表，照這一期的日期對，預覽提醒店長確認（2026-11-13 排班挑錯低）
  const dayOnly = best.every(([c]) => { const v = (rows[header] || [])[c]; return typeof v === 'number' ? v >= 1 && v <= 31 : /^\d{1,2}日?$/.test(norm(v).replace(/[(（].*$/, '').replace(/星期.*$|週.$|周.$/, '')); });
  return { ok: true, header, dateCols: best, nameCol, rows: out, outside, dayOnly };
}

/** 從整本活頁簿挑最像班表的工作表（讀得到最多同仁的那張）；sheets＝[{name, aoa}] */
export function pickSheet(sheets, dates, staffNames) {
  let bestI = 0, bestN = -1;
  sheets.forEach((s, i) => {
    const p = parseSheet(s.aoa, dates, staffNames);
    const n = p.ok ? p.rows.length * 100 + p.dateCols.length : -1;
    if (n > bestN) { bestN = n; bestI = i; }
  });
  return bestI;
}

// ── 每一格的寫法 → 值 ──
// 值的寫法（跟格子編輯框的下拉一致）：'S:班別id' 上班、'S:a+b' 一天兩班、'O:班別id' 休息日加班、'R' 例假、'H' 休息日、'L:假別' 請假、'CLEAR' 清空、'SKIP' 不匯入、'KEEP' 不動
const REST_R = new Set(['例', '例假', '例休', '例假日', 'R']);
const REST_H = new Set(['休', '休息', '休息日', '休假', 'OFF', 'H']);
const GUO = new Set(['國', '國定', '國定假', '國定假日', '國假']);
const TIME = /^(\d{1,2})(?::?(\d{2}))?[-~〜～至到](\d{1,2})(?::?(\d{2}))?$/;
const hhmm = (h, m) => `${pad(+h)}:${m || '00'}`;

/** 一個寫法對得到哪些使用中的班別（代號 A、名稱 A班／早班、或時間 10-19） */
export function shiftsMatching(tok, shifts) {
  const t = norm(tok); if (!t) return [];
  const act = shifts.filter((s) => s.active && !isExtId(s.id));
  const byName = act.filter((s) => { const n = norm(s.name); return t === n || t === n.replace(/班$/, '') || t === norm(shiftCode(s.name)) || t === norm(s.id); });
  if (byName.length) return byName;
  const m = TIME.exec(t);
  if (!m) return [];
  const a = hhmm(m[1], m[2]), b = hhmm(m[3], m[4]);
  return act.filter((s) => { const g = segsOf(s); return g.length && g[0].start === a && g[g.length - 1].end === b; });
}

/** 寫法 → 值；認不得或對到兩個以上班別回 null（交給店長選） */
export function readToken(tok, shifts) {
  const t = norm(tok);
  if (!t) return 'CLEAR';
  if (/^支援/.test(t)) return 'KEEP';                       // 下載範本裡「支援 光復C」：支援別家門市的班，匯入不動
  if (REST_R.has(t)) return 'R';
  if (REST_H.has(t)) return 'H';
  if (GUO.has(t)) return 'L:國';
  for (const [c, l] of LEAVES) if (t === c || t === l || t === l.replace(/假$/, '') || t === c + '假') return 'L:' + c;
  const one = (x) => { const m = shiftsMatching(x, shifts); return m.length === 1 ? m[0].id : null; };
  const ot = /^(?:休加|休息日加班|加班)(.+)$/.exec(t) || /^(.+?)[(（]?(?:休加|休息日加班)[)）]?$/.exec(t);
  if (ot) {
    const id = one(ot[1]); if (id) return 'O:' + id;
    // 休息日加班兩班（範本寫「休加A+C」，2026-11-13 排班挑錯低：原本讀不懂）
    const ps = ot[1].split(/[+＋&、,，/]/).filter(Boolean);
    if (ps.length === 2) { const a = one(ps[0]), b = one(ps[1]); if (a && b && a !== b) return 'O:' + a + '+' + b; }
    return null;
  }
  const single = one(t);
  if (single) return 'S:' + single;
  const parts = t.split(/[+＋&、,，/]/).filter(Boolean);
  if (parts.length === 2) { const a = one(parts[0]), b = one(parts[1]); if (a && b && a !== b) return 'S:' + a + '+' + b; }
  return null;
}

/** 「10-19」這種時間寫法被 Excel 自動轉成日期，讀進來是日期序號：轉回「月-日」（10/19 → 10-19）。其他值原樣回傳 */
export function excelDateBack(v) {
  if (typeof v !== 'number' || !(v > 30000 && v < 80000) || !Number.isInteger(v)) return v;
  const y = serialYmd(v);
  return `${+y.slice(5, 7)}-${+y.slice(8, 10)}`;
}

/** 值 → 送給 saveDays 的格子內容（不含 emp_id、date）；CLEAR 回 { clear:true }，SKIP／KEEP 回 null */
export function cellOfValue(v) {
  if (!v || v === 'SKIP' || v === 'KEEP') return null;
  if (v === 'CLEAR') return { clear: true };
  if (v === 'R' || v === 'H') return { day_type: v };
  if (v.startsWith('L:')) return { day_type: 'L', leave: v.slice(2) };
  if (v.startsWith('O:')) { const [a, b] = v.slice(2).split('+'); return Object.assign({ day_type: 'H', shift_id: a }, b ? { shift2_id: b } : {}); }
  if (v.startsWith('S:')) { const [a, b] = v.slice(2).split('+'); return Object.assign({ day_type: 'W', shift_id: a }, b ? { shift2_id: b } : {}); }
  return null;
}

/** 格子 → 範本裡的寫法（下載範本用；跟 readToken 互轉） */
export function tokenOfCell(c, shiftMap) {
  if (!c) return '';
  if (c.shift_id && (isExtId(c.shift_id) || isExtId(c.shift2_id))) return '支援 ' + [c.shift_id, c.shift2_id].filter(Boolean).map((id) => (shiftMap[id] ? shiftMap[id].name : id)).join('＋');
  const code = (id) => (shiftMap[id] ? shiftCode(shiftMap[id].name) : id);
  if (c.shift_id) return (c.day_type === 'H' ? '休加' : '') + code(c.shift_id) + (c.shift2_id ? '+' + code(c.shift2_id) : '');
  if (c.day_type === 'R') return '例';
  if (c.day_type === 'H') return '休';
  if (c.day_type === 'L') return c.leave === '國' ? '國定' : ((LEAVES.find((x) => x[0] === c.leave) || [])[1] || c.leave || '');
  return '';
}

/** 值 → 預覽格子上的字（A、A＋C、休加A、例、休、特休…） */
export function valueText(v, shiftMap) {
  const c = cellOfValue(v);
  if (!c) return v === 'KEEP' ? '不動' : '';
  if (c.clear) return '';
  return tokenOfCell(c, shiftMap).replace('+', '＋');
}

const sameCell = (a, b) => {
  const e = (x) => (x ? [x.day_type || '', x.shift_id || '', x.shift2_id || '', x.leave || ''].join('|') : '');
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (e(a) === e(b)) return true;
  return !!(a.shift2_id && b.shift2_id && a.day_type === b.day_type && a.shift_id === b.shift2_id && a.shift2_id === b.shift_id);
};

/**
 * 算出匯入計畫。
 * D：排班 load 回來的整包（staff、shifts、days、dates、holidays、support）；parsed：parseSheet 的結果；
 * picks：{ tokens:{寫法: 值}, names:{Excel 姓名: emp_id 或 'SKIP'} }（店長在預覽選的，含這台裝置記住的）。
 * 回傳 { rows, writes, counts, unknownTokens, unknownNames, missing, rejects, keeps, dupNames, outside }
 */
export function buildPlan(D, parsed, picks) {
  const P = picks || { tokens: {}, names: {} };
  const dates = D.dates;
  const shiftMap = Object.fromEntries((D.shifts || []).concat(D.extShifts || []).map((s) => [s.id, s]));
  const staff = (D.staff || []).filter((st) => !st.ext && dates.some((d) => employed(st, d)));
  const byNorm = {};
  for (const st of staff) (byNorm[norm(st.name)] = byNorm[norm(st.name)] || []).push(st);
  // 名字比對：完全相同 → 唯一；不然看 Excel 那格有沒有「含」某位同仁的名字（「E11 林秀縈」「林秀縈(正職)」）；兩個以上算對不上。
  // 「含」要是獨立的一段：名字前後緊貼著同一類的字（中文貼中文、數字貼數字、英文貼英文）就不算——
  // 名冊有「王明」、Excel 寫「王明華」是另一個人，原本會直接當成王明寫進去（2026-11-10 挑錯 #10）
  // 班表上有兩位同名同仁（Eason 2026-11-13 紅燈 s2 選 A）：Excel 要寫「工號＋姓名」（E11 林秀縈）才對得到；只寫名字回 AMB（不匯入、說明原因）
  const AMB = { amb: true };
  const autoEmp = (name) => {
    const t = norm(name);
    const cands = byNorm[t] || staff.filter((st) => norm(st.name) && standsAlone(name, norm(st.name)));
    if (cands.length === 1) return cands[0].emp_id;
    if (cands.length > 1) {
      const byId = cands.filter((st) => standsAlone(name, norm(st.emp_id)));
      if (byId.length === 1) return byId[0].emp_id;
      if (cands.every((st) => norm(st.name) === norm(cands[0].name))) return AMB;
    }
    return null;
  };
  const supported = new Set();
  for (const x of D.support || []) if (x.kind === 'store' && x.emp) for (const d of Object.keys(x.days || {})) supported.add(x.emp + '|' + d);
  const unknownTokens = {}, unknownNames = [], rejects = [], keeps = [], dupNames = [], ambNames = [], rows = [], writes = [];
  // 檔案裡有哪幾天：沒列到的日期不動（同「檔案沒列到的同仁不動」）。原本缺的日期被當成空白格＝清空，只給兩週的檔案會把另外兩週清掉（2026-11-10 挑錯 #9）
  const haveDates = new Set(parsed.dateCols ? parsed.dateCols.map((x) => x[1]) : parsed.rows.flatMap((r) => Object.keys(r.cells || {})));
  const missingDates = dates.filter((d) => !haveDates.has(d));
  const used = new Set();
  // 同一位同仁出現兩列：兩列都不匯入（原本只收第一列，第一列空白會把整期清掉；Eason 2026-11-13 紅燈 s1 選 A）
  const empOfRow = (pr) => { const a = autoEmp(pr.name); return a === AMB ? null : (Object.prototype.hasOwnProperty.call(P.names, pr.name) ? P.names[pr.name] : a); };
  const rowsPer = {};
  for (const pr of parsed.rows) { const e = empOfRow(pr); if (e && e !== 'SKIP') rowsPer[e] = (rowsPer[e] || 0) + 1; }
  const counts = { write: 0, change: 0, same: 0, skip: 0 };
  for (const pr of parsed.rows) {
    if (autoEmp(pr.name) === AMB) { if (!ambNames.includes(pr.name)) ambNames.push(pr.name); counts.skip += dates.filter((d) => norm(pr.cells[d])).length; continue; }
    let emp = Object.prototype.hasOwnProperty.call(P.names, pr.name) ? P.names[pr.name] : autoEmp(pr.name);
    const known = emp && emp !== 'SKIP' ? staff.find((s) => s.emp_id === emp) : null;
    if (!known) {
      const filled = dates.filter((d) => norm(pr.cells[d])).length;
      if (!unknownNames.some((x) => x.name === pr.name)) unknownNames.push({ name: pr.name, filled, chosen: emp === 'SKIP' ? 'SKIP' : '' });
      counts.skip += filled;
      continue;
    }
    if (rowsPer[known.emp_id] > 1) { if (!used.has(known.emp_id)) dupNames.push(known.name); used.add(known.emp_id); counts.skip += dates.filter((d) => norm(pr.cells[d])).length; continue; }
    used.add(known.emp_id);
    const row = { emp_id: known.emp_id, name: known.name, xlsName: pr.name, cells: {} };
    for (const d of dates) {
      const raw = pr.cells[d], tok = norm(excelDateBack(raw));
      const old = (D.days[known.emp_id] || {})[d] || null;
      const oldText = tokenOfCell(old, shiftMap).replace('+', '＋');
      let v = Object.prototype.hasOwnProperty.call(P.tokens, tok) && tok ? P.tokens[tok] : readToken(tok, D.shifts || []);
      // 範本原樣傳回：寫法跟現在的格子一樣（例：已停用的班別代號）就不動（2026-11-13 排班挑錯低）
      if (v === null && old && tok && tok === norm(tokenOfCell(old, shiftMap))) v = 'KEEP';
      const put = (status, extra) => { row.cells[d] = Object.assign({ status, tok: String(raw === undefined ? '' : raw), oldText }, extra); };
      if (!haveDates.has(d)) { counts.same++; put('same', { text: oldText }); continue; }
      if (v === null) {
        (unknownTokens[tok] = unknownTokens[tok] || { tok: String(raw).trim(), n: 0, chosen: '' }).n++;
        counts.skip++; put('unknown', { text: String(raw).trim() }); continue;
      }
      if (v === 'SKIP') { if (tok) counts.skip++; put('skip', { text: String(raw).trim() }); continue; }
      // 支援別家門市的班（門市互相支援排班）：匯入一律不動，Excel 寫什麼都一樣
      if (old && old.shift_id && (isExtId(old.shift_id) || isExtId(old.shift2_id))) {
        if (v !== 'KEEP') keeps.push({ name: known.name, date: d });
        counts.same++; put('keep', { text: oldText }); continue;
      }
      if (v === 'KEEP') { counts.same++; put('same', { text: oldText }); continue; }
      let cell = cellOfValue(v);
      const reject = (reason) => { rejects.push({ name: known.name, date: d, reason }); counts.skip++; put('reject', { text: valueText(v, shiftMap) || '空白', reason }); };
      if (cell.clear) {
        if (!old) { counts.same++; put('same', { text: '' }); continue; }
      } else if (sameCell(old, cell)) { counts.same++; put('same', { text: oldText }); continue; }
      if (supported.has(known.emp_id + '|' + d) && !cell.clear) { reject('別家門市排了他這天來支援，這裡不能改'); continue; }
      const wasOt = old && old.day_type === 'H' && old.shift_id;
      if (wasOt && (cell.clear || cell.day_type !== 'H')) { reject('原本是休息日加班（要付加班費），只能改回休息日'); continue; }
      if (!cell.clear) {
        const err = comboError(cell, D.holidays, d);
        if (err) { reject(err); continue; }
        if (cell.shift2_id) { const o = orderTwo(shiftMap, cell); if (o.err) { reject(o.err); continue; } cell = Object.assign({ day_type: o.cell.day_type, shift_id: o.cell.shift_id, shift2_id: o.cell.shift2_id }); }
        if (cell.shift_id && !employed(known, d)) { reject('這天不在職（還沒報到或已離職），不能排班'); continue; }
      }
      const change = !!old;
      counts.write++; if (change) counts.change++;
      writes.push(Object.assign({ emp_id: known.emp_id, date: d }, cell));
      put(change ? 'change' : 'new', { text: cell.clear ? '' : valueText(v, shiftMap) });
    }
    rows.push(row);
  }
  const missing = staff.filter((st) => !used.has(st.emp_id)).map((st) => st.name);
  return { rows, writes, counts, unknownTokens: Object.values(unknownTokens), unknownNames, missing, missingDates, rejects, keeps, dupNames, ambNames, outside: parsed.outside || 0, dayOnly: !!parsed.dayOnly };
}

/** 下載範本的表格（二維陣列）：姓名＋這一期每天；第二列星期；照班表順序列出每位在職同仁現在的班 */
export function templateAoa(D) {
  const shiftMap = Object.fromEntries((D.shifts || []).concat(D.extShifts || []).map((s) => [s.id, s]));
  const staff = (D.staff || []).filter((st) => !st.ext && D.dates.some((d) => employed(st, d)));
  const out = [['姓名'].concat(D.dates.map(md)), ['星期'].concat(D.dates.map((d) => WD[new Date(d + 'T00:00:00Z').getUTCDay()]))];
  for (const st of staff) out.push([st.name].concat(D.dates.map((d) => tokenOfCell((D.days[st.emp_id] || {})[d], shiftMap))));
  return out;
}

/** 範本第二張「寫法說明」 */
export function legendAoa(D) {
  const act = (D.shifts || []).filter((s) => s.active && !isExtId(s.id));
  const out = [['寫法', '意思']];
  for (const s of act) out.push([shiftCode(s.name), `${s.name}（${segsOf(s).map((x) => x.start + '–' + x.end).join('、')}）`]);
  out.push(['A+C', '一天兩個班（兩個班別代號中間加 +）'], ['休加A', '休息日加班，上 A 班（要付加班費）'], ['例', '例假'], ['休', '休息日'],
    ['國定', '國定假日假'], ...LEAVES.map(([, l]) => [l, '請假']), ['（空白）', '清空這一格'], ['10-19', '也可以寫時間，對得到上面的班別就算']);
  return out;
}
