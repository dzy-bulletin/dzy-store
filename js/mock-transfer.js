// 門市調撥的瀏覽器內假後端（?mode=mock）。行為照原系統 ~/mala-transfer/gas/Code.gs 的狀態機：草稿→已出貨→已簽收；任何狀態→已刪除（軟刪除）。
// 誰能做什麼：開單／編輯草稿／出貨／刪除＝調出方；簽收＝調入方；修改（amend）＝雙方、只限已出貨。錯誤訊息逐字取自 Code.gs，方便前端直接顯示。
// 資料存在 mock 資料庫的 db.xfer（由 mock.js 傳進來、跟著 localStorage 一起存）。
// 初始資料讀 window.__E2E_DATA?.transfer（測試注入：{ mem, reasons, docs, items }），沒有就用少量預設；不寫死大量資料。
const NODES = [
  { code: 'M01', name: '墨竹亭新竹金山店', short: '墨·金山', brand: '墨竹亭' }, { code: 'M02', name: '墨竹亭新竹光復店', short: '墨·光復', brand: '墨竹亭' },
  { code: 'M03', name: '墨竹亭台北六張犁店', short: '墨·六張犁', brand: '墨竹亭' }, { code: 'M04', name: '墨竹亭台北行天宮店', short: '墨·行天宮', brand: '墨竹亭' },
  { code: 'M05', name: '墨竹亭台中文心店', short: '墨·文心', brand: '墨竹亭' }, { code: 'M06', name: '墨竹亭內湖瑞光店', short: '墨·瑞光', brand: '墨竹亭' },
  { code: 'M07', name: '墨竹亭台中美村店', short: '墨·美村', brand: '墨竹亭' }, { code: 'Y01', name: '一悟燒肉金山店', short: '悟·金山', brand: '一悟燒肉' },
  { code: 'Y02', name: '一悟燒肉竹北店', short: '悟·竹北', brand: '一悟燒肉' }, { code: 'S01', name: '小辛辣光復店', short: '辣·光復', brand: '小辛辣' },
  { code: 'CK', name: '中央廚房', short: '中央廚房', brand: '鼎兆元總部' },
];
export const TRANSFER_NODES = NODES;
export const DEFAULT_TRANSFER_ALIAS = { TEST1: 'S01', TEST2: 'M02' };
const CATS = ['食材', '包材', '雜貨'];
const ok = data => ({ ok: true, data });
const fail = (error, message) => ({ ok: false, error, message });
const bad = message => fail('BAD_INPUT', message);                       // 上游的白話錯誤（BAD_STATE／REQUIRED…）轉成 BAD_INPUT，跟伺服器轉送器一致
const trim = v => String(v == null ? '' : v).replace(/^\s+|\s+$/g, '');
const round2 = n => Math.round(n * 100) / 100;                           // Code.gs 第 148 行
const num = v => { const n = Number(v); return isNaN(n) ? null : n; };
const pad = (n, w) => String(n).padStart(w, '0');
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
const nodeByCode = c => NODES.find(n => n.code === c) || null;
const nodeByName = n => NODES.find(x => x.name === n) || null;

export function mockToday() {
  let o = ''; try { o = localStorage.getItem('dzystore_mock_today') || ''; } catch (e) {}
  if (o) return o;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}
const nowTs = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00';

function inj() { try { return (window.__E2E_DATA && window.__E2E_DATA.transfer) || null; } catch (e) { return null; } }
const DEFAULT_REASONS = [['R1', '短少'], ['R2', '損壞'], ['R3', '退回'], ['R4', '規格不符'], ['R5', '多送'], ['R6', '單價錯誤']];
function X(db) {
  if (db.xfer) return db.xfer;
  const i = inj() || {};
  db.xfer = {
    docs: (i.docs || []).map(d => ({ ...d })), items: (i.items || []).map(d => ({ ...d })), logs: [],
    mem: (i.mem || [{ name: '示範高湯', spec: '1kg', unit: '包', price: 45, uses: 3, cat: '食材' }, { name: '示範外帶袋', spec: '大', unit: '包', price: 30, uses: 1, cat: '包材' }]).map(m => ({ ...m })),
    reasons: (i.reasons || DEFAULT_REASONS.map(([code, name]) => ({ code, name }))).map(r => ({ code: r.code, name: r.name, type: r.type || '固定', on: r.on !== false, uses: r.uses || 0 })),
  };
  return db.xfer;
}
export function nodeOfAccount(db, code) { return nodeByCode((db.aliasTr || DEFAULT_TRANSFER_ALIAS)[code]); }

const nodeShort = name => (nodeByName(name) || {}).short || name;
const logWho = (store, name) => { const n = trim(name), s = nodeShort(store); return s && n ? s + '｜' + n : s || n; };   // Code.gs 第 1282 行
const log = (x, no, action, field, oldV, newV, who) => x.logs.push({ '流水號': x.logs.length + 1, '時間': nowTs(), '單號': no, '動作': action, '欄位': field || '', '原值': oldV === undefined ? '' : oldV, '新值': newV === undefined ? '' : newV, '操作人': trim(who) });

// ---- 驗證與計算（Code.gs 第 431–497 行）----
function validateDoc(d) {
  if (!trim(d['調出方'])) return '調出方必填';
  if (!trim(d['調入方'])) return '調入方必填';
  if (!nodeByName(d['調入方'])) return '調入方不是有效節點';
  if (d['調出方'] === d['調入方']) return '調出方與調入方不可相同';
  if (!trim(d['調撥日期'])) return '調撥日期必填';
  if (!isDate(d['調撥日期'])) return '調撥日期格式必須是 YYYY-MM-DD';
  if (!trim(d['預計到貨日'])) return '預計到貨日必填';
  if (!isDate(d['預計到貨日'])) return '預計到貨日格式必須是 YYYY-MM-DD';
  if (d['預計到貨日'] < d['調撥日期']) return '預計到貨日不可早於調撥日期';
  if (!trim(d['打包人'])) return '打包人必填';
  return '';
}
function validateItems(items) {
  if (!items || !items.length) return '至少要有一個品項';
  for (let i = 0; i < items.length; i++) {
    const it = items[i], at = '第 ' + (i + 1) + ' 個品項：';
    if (!trim(it['品項名稱'])) return at + '品項名稱必填';
    const price = num(it['調撥單價']), qty = num(it['應撥數量']);
    if (trim(it['調撥單價']) === '' || price === null || price <= 0) return at + '調撥單價必填，且必須大於 0';
    if (trim(it['應撥數量']) === '' || qty === null || qty <= 0) return at + '應撥數量必填，且必須大於 0';
    const cat = trim(it['類別']);
    if (!cat) return at + '類別必填，請選食材或包材';
    if (!CATS.includes(cat)) return at + '類別只能是 ' + CATS.join('／');
  }
  return '';
}
function buildRows(no, items) {                                           // 小計＝單價×應撥數量，Code.gs 第 480 行
  let total = 0;
  const rows = items.map((it, i) => {
    const price = num(it['調撥單價']), qty = num(it['應撥數量']), sub = round2(price * qty);
    total = round2(total + sub);
    return { '單號': no, '列序': pad(i + 1, 2), '品項名稱': trim(it['品項名稱']), '規格': trim(it['規格']), '單位': trim(it['單位']), '調撥單價': price, '應撥數量': qty,
      '實收數量': '', '差異數量': '', '差異原因代碼': '', '小計': sub, '類別': trim(it['類別']) };
  });
  return { rows, total };
}
function upsertMemory(x, items) {
  for (const it of items) {
    const name = trim(it['品項名稱']), hit = x.mem.find(m => m.name === name);
    const rec = { name, spec: trim(it['規格']), unit: trim(it['單位']), price: num(it['調撥單價']), cat: trim(it['類別']) };
    if (hit) Object.assign(hit, rec, { uses: (hit.uses || 0) + 1 }); else x.mem.push({ ...rec, uses: 1 });
  }
}
function nextDocNo(x, node, date) {
  const prefix = 'TR-' + date.replace(/-/g, '') + '-' + node.code + '-';
  let max = 0;
  for (const d of x.docs) if (d['單號'].startsWith(prefix)) max = Math.max(max, parseInt(d['單號'].slice(prefix.length), 10) || 0);
  return prefix + pad(max + 1, 3);
}
// 依明細重算三個金額欄（Code.gs 第 987 行）
function recalc(doc, items) {
  let plan = 0, recv = 0, any = false;
  for (const it of items) {
    plan = round2(plan + (num(it['小計']) || 0));
    const q = it['實收數量'];
    if (q !== '' && q !== null && q !== undefined) { any = true; recv = round2(recv + (num(q) || 0) * (num(it['調撥單價']) || 0)); }
  }
  doc['應撥總額'] = plan; doc['實收總額'] = any ? recv : ''; doc['差異總額'] = any ? round2(recv - plan) : '';
}
function ensureReason(x, text) {
  const name = trim(text);
  if (!name) return { code: '' };
  if (name.length > 20) return { err: '自訂差異原因限 20 字以內' };
  let max = 0;
  for (const r of x.reasons) { if (trim(r.name) === name) return { code: r.code }; const m = /^C(\d+)$/.exec(r.code); if (m) max = Math.max(max, Number(m[1])); }
  const code = 'C' + (max + 1); x.reasons.push({ code, name, type: '自訂', on: true, uses: 0 }); return { code };
}
const bump = (x, codes) => codes.forEach(c => { const r = x.reasons.find(y => y.code === c); if (r) r.uses++; });
const itemsOf = (x, no) => x.items.filter(r => r['單號'] === no).sort((a, b) => (a['列序'] < b['列序'] ? -1 : 1));
const mismatch = (store, what) => fail('FORBIDDEN', '這張單不是' + store + '的，不能' + what);

// ---- 動作 ----
export function transferMock(action, me, b, db) {
  const x = X(db), node = nodeOfAccount(db, me.code);
  if (!node) return fail('FORBIDDEN', '這家店還沒有設定調撥節點');
  const store = node.name;
  const find = no => x.docs.find(d => d['單號'] === no);
  const mine = d => d['調出方'] === store || d['調入方'] === store;

  if (action === 'bootstrap') {
    return ok({ nodes: NODES.map(n => ({ ...n, store: n.name })), statuses: ['草稿', '已出貨', '已簽收', '已刪除'],
      reasons: x.reasons.filter(r => r.on).map(r => ({ code: r.code, name: r.name, type: r.type })),
      items: x.mem.slice().sort((a, c) => (c.uses || 0) - (a.uses || 0)).map(m => ({ name: m.name, spec: m.spec, unit: m.unit, price: m.price, uses: m.uses || 0, cat: m.cat || '' })),
      itemCats: CATS, today: mockToday(), me: { code: node.code, name: node.name, short: node.short, brand: node.brand } });
  }
  if (action === 'createDraft') {
    const d = { ...(b.doc || {}), '調出方': store }, items = b.items || [], who = trim(b['操作人']) || trim(d['打包人']);
    const e = validateDoc(d) || validateItems(items); if (e) return bad(e);
    const no = nextDocNo(x, node, d['調撥日期']), built = buildRows(no, items);
    x.docs.push({ '單號': no, '狀態': '草稿', '調出方': store, '調入方': d['調入方'], '調撥日期': d['調撥日期'], '預計到貨日': d['預計到貨日'], '打包人': trim(d['打包人']), '簽收人': '', '備註': trim(d['備註']),
      '應撥總額': built.total, '實收總額': '', '差異總額': '', '建立時間': nowTs(), '出貨時間': '', '簽收時間': '', '最後異動時間': nowTs() });
    x.items.push(...built.rows); upsertMemory(x, items); log(x, no, '建立', '', '', '', logWho(store, who));
    return ok({ '單號': no });
  }
  if (action === 'updateDraft') {
    const no = trim(b['單號']), doc = find(no);
    if (!doc) return fail('NOT_FOUND', '找不到單號 ' + no);
    if (doc['調出方'] !== store) return mismatch(store, '修改');
    if (doc['狀態'] !== '草稿') return bad('只有草稿可以編輯，這張單目前是「' + doc['狀態'] + '」');
    const d = { ...(b.doc || {}), '調出方': store }, items = b.items || [];
    const e = validateDoc(d) || validateItems(items); if (e) return bad(e);
    if (d['調撥日期'] !== doc['調撥日期']) return bad('草稿不可更改調出方或調撥日期（單號已依此產生）');
    const built = buildRows(no, items);
    x.items = x.items.filter(r => r['單號'] !== no).concat(built.rows);
    Object.assign(doc, { '調入方': d['調入方'], '預計到貨日': d['預計到貨日'], '打包人': trim(d['打包人']), '備註': trim(d['備註']), '應撥總額': built.total, '最後異動時間': nowTs() });
    upsertMemory(x, items);
    return ok({ '單號': no, '應撥總額': built.total });
  }
  if (action === 'getDoc') {
    const no = trim(b['單號']), doc = find(no);
    if (!doc) return fail('NOT_FOUND', '找不到單號 ' + no);
    if (!mine(doc)) return fail('FORBIDDEN', '這張單不是你們店的');
    return ok({ doc: { ...doc }, items: itemsOf(x, no).map(r => ({ ...r })), logs: x.logs.filter(l => l['單號'] === no).sort((a, c) => c['流水號'] - a['流水號']).map(l => ({ ...l })) });
  }
  if (action === 'listDocs') {
    let want = b['狀態']; if (want && typeof want === 'string') want = [want];
    const kw = trim(b['關鍵字']).toUpperCase(), from = trim(b['起日']), to = trim(b['迄日']);
    const offset = Math.max(0, num(b.offset) || 0); let limit = num(b.limit); limit = (limit === null || limit <= 0) ? 20 : Math.min(limit, 200);
    const text = no => itemsOf(x, no).map(i => i['品項名稱'] + ' ' + i['規格'] + ' ' + i['單位']).join(' ');
    const hay = d => [d['單號'], d['狀態'], d['打包人'], d['簽收人'], d['備註'], d['調撥日期'], d['預計到貨日'], d['調出方'], nodeShort(d['調出方']), d['調入方'], nodeShort(d['調入方']), text(d['單號'])].join(' ').toUpperCase();
    const rows = x.docs.filter(d => mine(d) && (!want || want.includes(d['狀態'])) && (b.side !== 'out' || d['調出方'] === store) && (b.side !== 'in' || d['調入方'] === store)
      && (!from || d['調撥日期'] >= from) && (!to || d['調撥日期'] <= to) && (!kw || hay(d).includes(kw)))
      .sort((a, c) => (a['調撥日期'] !== c['調撥日期'] ? (a['調撥日期'] < c['調撥日期'] ? 1 : -1) : (a['單號'] < c['單號'] ? 1 : -1)));
    const sum = { '張數': 0, '應撥總額': 0, '調出': 0, '調入': 0, '已刪除張數': 0, '基準門市': store };   // sumRows_（Code.gs 第 778 行）：已刪除不計入、不用實收
    for (const d of rows) {
      if (d['狀態'] === '已刪除') { sum['已刪除張數']++; continue; }
      const amt = num(d['應撥總額']) || 0; sum['張數']++; sum['應撥總額'] = round2(sum['應撥總額'] + amt);
      if (d['調出方'] === store) sum['調出'] = round2(sum['調出'] + amt); else if (d['調入方'] === store) sum['調入'] = round2(sum['調入'] + amt);
    }
    const page = rows.slice(offset, offset + limit).map(d => ({ ...d, '品項數': itemsOf(x, d['單號']).length }));
    return ok({ rows: page, total: rows.length, hasMore: offset + page.length < rows.length, sum });
  }
  if (action === 'ship') {
    const no = trim(b['單號']), who = trim(b['操作人']);
    if (!who) return bad('請填操作人姓名');
    const doc = find(no); if (!doc) return fail('NOT_FOUND', '找不到單號 ' + no);
    if (doc['調出方'] !== store) return mismatch(store, '確認出貨');
    if (doc['狀態'] !== '草稿') return bad('這張單目前是「' + doc['狀態'] + '」，不能變成「已出貨」');
    Object.assign(doc, { '狀態': '已出貨', '出貨時間': nowTs(), '最後異動時間': nowTs() }); log(x, no, '出貨', '', '', '', logWho(store, who));
    return ok({ '單號': no, '狀態': '已出貨' });
  }
  if (action === 'receive') {
    const no = trim(b['單號']), who = trim(b['簽收人']);
    if (!who) return bad('請填簽收人姓名');
    const doc = find(no); if (!doc) return fail('NOT_FOUND', '找不到單號 ' + no);
    if (doc['調入方'] !== store) return mismatch(store, '簽收');
    if (doc['狀態'] !== '已出貨') return bad('這張單目前是「' + doc['狀態'] + '」，不能變成「已簽收」');
    const byIdx = {}; for (const l of (b.lines || [])) byIdx[pad(parseInt(l['列序'], 10), 2)] = l;
    const resolved = [];
    for (const it of itemsOf(x, no)) {                                    // 第一輪：全部驗完才寫，中途錯誤不留半套（Code.gs 第 1025 行起）
      const at = '第 ' + it['列序'] + ' 列（' + it['品項名稱'] + '）：', line = byIdx[it['列序']];
      if (!line) return bad(at + '沒有填實際簽收數量');
      const qty = num(line['實收數量']);
      if (qty === null || qty < 0) return bad(at + '實收數量必須是 0 以上的數字');
      const diff = round2(qty - (num(it['應撥數量']) || 0));
      let code = '', custom = '';
      if (diff !== 0) {
        code = trim(line['差異原因代碼']);
        if (code === 'OTHER') { custom = trim(line['自訂原因']); if (!custom) return bad(at + '選了「其他」就要填原因'); if (custom.length > 20) return bad('自訂差異原因限 20 字以內'); }
        else if (!code) return bad(at + '數量和應撥不一樣，必須選一個差異原因');
      }
      resolved.push({ it, qty, diff, code, custom });
    }
    const used = [];
    for (const r of resolved) {
      if (r.custom) r.code = ensureReason(x, r.custom).code;
      if (r.code) used.push(r.code);
      Object.assign(r.it, { '實收數量': r.qty, '差異數量': r.diff, '差異原因代碼': r.code });
    }
    bump(x, used);
    Object.assign(doc, { '狀態': '已簽收', '簽收人': who, '簽收時間': nowTs(), '最後異動時間': nowTs() });
    recalc(doc, itemsOf(x, no)); log(x, no, '簽收', '', '', '', logWho(store, who));
    return ok({ '單號': no, '狀態': '已簽收', '實收總額': doc['實收總額'], '差異總額': doc['差異總額'] });
  }
  if (action === 'amend') {
    const no = trim(b['單號']), who = trim(b['操作人']);
    if (!who) return bad('請填操作人姓名');
    const doc = find(no); if (!doc) return fail('NOT_FOUND', '找不到單號 ' + no);
    if (store !== doc['調出方'] && store !== doc['調入方']) return mismatch(store, '修改');
    if (doc['狀態'] === '草稿') return bad('草稿請直接編輯，不用走修改');
    if (doc['狀態'] === '已簽收') return bad('已簽收的單不可修改');
    if (doc['狀態'] === '已刪除') return bad('這張單已刪除，不可修改');
    const changes = b.changes || []; if (!changes.length) return bad('沒有要修改的內容');
    const items = itemsOf(x, no), pending = [];
    for (const c of changes) {
      const path = trim(c.path), m = /^明細#(\d{2})\.(.+)$/.exec(path);
      let target, field;
      if (m) {
        field = m[2]; if (!['實收數量', '差異原因代碼'].includes(field)) return fail('FORBIDDEN', '不可修改的欄位：' + path);
        target = items.find(i => i['列序'] === m[1]); if (!target) return fail('NOT_FOUND', '找不到明細 ' + path);
      } else {
        field = path.replace(/^單據\./, ''); if (!['預計到貨日', '備註', '打包人', '簽收人'].includes(field)) return fail('FORBIDDEN', '不可修改的欄位：' + path);
        target = doc;
      }
      let newV = c.value, custom = '';
      if (field === '實收數量') { newV = num(newV); if (newV === null || newV < 0) return bad(path + ' 必須是 0 以上的數字'); }
      if (field === '差異原因代碼' && trim(newV) === 'OTHER') { custom = trim(c.custom); if (!custom) return bad(path + ' 選了「其他」就要填原因'); }
      const oldV = target[field];
      if (!custom && String(oldV) === String(newV)) continue;
      target[field] = newV; if (m) target._dirty = true;
      pending.push({ target, field, path, oldV, newV, custom });
    }
    if (!pending.length) return ok({ '單號': no, '已修改筆數': 0 });
    for (const it of items) if (it._dirty) { const q = it['實收數量']; if (q !== '' && q !== null) it['差異數量'] = round2(num(q) - (num(it['應撥數量']) || 0)); }
    for (const it of items) {
      const hasCustom = pending.some(p => p.target === it && p.field === '差異原因代碼' && p.custom);
      if (num(it['差異數量']) && !trim(it['差異原因代碼']) && !hasCustom) return bad('第 ' + it['列序'] + ' 列改完有差異，必須選差異原因');
    }
    const used = [];
    for (const p of pending) {
      if (p.custom) { p.newV = ensureReason(x, p.custom).code; p.target[p.field] = p.newV; }
      if (p.field === '差異原因代碼' && p.newV) used.push(String(p.newV));
      log(x, no, '修改', p.path, p.oldV === '' ? '（空白）' : p.oldV, p.newV === '' ? '（空白）' : p.newV, logWho(store, who));
    }
    items.forEach(i => { delete i._dirty; }); bump(x, used);
    doc['最後異動時間'] = nowTs(); recalc(doc, items);
    return ok({ '單號': no, '已修改筆數': pending.length, '實收總額': doc['實收總額'], '差異總額': doc['差異總額'] });
  }
  if (action === 'deleteDoc') {
    const no = trim(b['單號']), who = trim(b['操作人']);
    if (!who) return bad('請填操作人姓名，刪除要記是誰刪的');
    const doc = find(no); if (!doc) return fail('NOT_FOUND', '找不到單號 ' + no);
    if (doc['調出方'] !== store) return mismatch(store, '刪除');
    if (doc['狀態'] === '已刪除') return bad('這張單已經刪除了');
    if (doc['狀態'] === '已簽收') return fail('FORBIDDEN', '已簽收的單要刪除，需要會計處理，請洽會計');
    const old = doc['狀態']; Object.assign(doc, { '狀態': '已刪除', '最後異動時間': nowTs() }); log(x, no, '刪除', '狀態', old, '已刪除', logWho(store, who));
    return ok({ '單號': no, '狀態': '已刪除' });
  }
  return fail('NOT_FOUND', '找不到這個功能');
}

// 首頁待辦（對照 server/home.js）：待出貨＝我方草稿；待簽收＝對方已出貨給我。店沒設節點＝不適用
export function transferHome(db, me) {
  const node = nodeOfAccount(db, me.code); if (!node) return [];
  const x = X(db), out = [];
  const n1 = x.docs.filter(d => d['調出方'] === node.name && d['狀態'] === '草稿').length, n2 = x.docs.filter(d => d['調入方'] === node.name && d['狀態'] === '已出貨').length;
  if (n1) out.push({ module: 'transfer', level: 'todo', text: `${n1} 張調撥單等你出貨`, count: n1, link: '#/transfer/todo' });
  if (n2) out.push({ module: 'transfer', level: 'todo', text: `${n2} 張貨等你簽收`, count: n2, link: '#/transfer/todo' });
  return out;
}
