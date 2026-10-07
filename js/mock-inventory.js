// 庫存盤點的假後端（?mode=mock）。規則與 server/inventory.js 一致（初始化、overwrote、歷史節流、importLegacy、首頁偏低數）。
// 資料放在 mock.js 的 db.inv（跟著 localStorage 一起存，重整還在）。
// e2e 可在載入前設定 window.__E2E_DATA = { inventory: { 門市代號: <舊版匯出形狀的資料> } }，那家店第一次用時就以它初始化，取代預設的 154 項。
const DEFAULTS = await (await fetch(new URL('./mock-inventory-defaults.json', import.meta.url))).json();
const ok = data => ({ ok: true, data: data === undefined ? {} : data });
const fail = (error, message) => ({ ok: false, error, message });
const bad = m => fail('BAD_INPUT', m);
const clone = x => JSON.parse(JSON.stringify(x));
const GAP = 5 * 60 * 1000, AUTO_KEEP = 300;
const ZONES = ['cart', 'stock'];

function findProduct(S, pid) { for (const c in S.products) { const f = (S.products[c] || []).find(p => p.id === pid); if (f) return f; } return null; }
const pg = p => (p.spec > 0 ? p.price / p.spec : p.price);
const value = (S, i) => { const p = findProduct(S, i.pid); return p ? (parseFloat(i.qty) || 0) * (parseFloat(i.spec) || 1) * pg(p) : 0; };
const total = S => { let t = 0; S.cartCats.forEach(c => (S.cartItems[c] || []).forEach(i => { t += value(S, i); })); S.stockCats.forEach(c => (S.stockItems[c] || []).forEach(i => { t += value(S, i); })); return t; };
function counts(S, homeLow) {      // homeLow：首頁用，偏低只算有填數量（qty>0）的列
  let low = 0, high = 0;
  const scan = (cats, items) => cats.forEach(c => (items[c] || []).forEach(i => {
    const t = S.thresholds[i.pid]; if (!t) return; const v = value(S, i);
    if (t.low !== null && t.low !== undefined && v < t.low) { if (!homeLow || (parseFloat(i.qty) || 0) > 0) low++; } else if (t.high !== null && t.high !== undefined && v > t.high) high++;
  }));
  scan(S.cartCats, S.cartItems); scan(S.stockCats, S.stockItems);
  return { low, high };
}

function store(db, code) {
  db.inv = db.inv || {};
  if (!db.inv[code]) {
    const seed = window.__E2E_DATA && window.__E2E_DATA.inventory && window.__E2E_DATA.inventory[code];
    let S;
    if (seed) S = clone(seed);
    else S = { products: clone(DEFAULTS.products), thresholds: clone(DEFAULTS.thresholds), cartCats: [...DEFAULTS.cartCats], stockCats: [...DEFAULTS.stockCats], cartItems: {}, stockItems: {} };
    S.cartCats = S.cartCats || []; S.stockCats = S.stockCats || []; S.cartItems = S.cartItems || {}; S.stockItems = S.stockItems || {}; S.thresholds = S.thresholds || {};
    S.cartCats.forEach(c => { S.cartItems[c] = S.cartItems[c] || []; }); S.stockCats.forEach(c => { S.stockItems[c] = S.stockItems[c] || []; });
    db.inv[code] = { S, meta: {}, history: [], seq: 0, lastFinish: null };
  }
  return db.inv[code];
}
const snap = st => { const S = clone(st.S); delete S.dropped; return S; };
function hist(st, kind, force) {
  const nowMs = Date.now();
  if (!force) { const last = [...st.history].reverse().find(h => h.kind === 'auto'); if (last && nowMs - Date.parse(last.at) < GAP) return null; }
  const h = { id: ++st.seq, at: new Date(nowMs).toISOString(), kind, total: Math.round(total(st.S) * 100) / 100, snapshot: snap(st) };
  st.history.push(h);
  const autos = st.history.filter(x => x.kind === 'auto');
  if (autos.length > AUTO_KEEP) { const drop = new Set(autos.slice(0, autos.length - AUTO_KEEP).map(x => x.id)); st.history = st.history.filter(x => !drop.has(x.id)); }
  return h.id;
}
const nameOf = v => (typeof v === 'string' ? v.trim() : '');
const numOrNull = v => { if (v === null || v === undefined || v === '') return null; const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) && n >= 0 && n <= 1e9 ? n : undefined; };

function parseLegacy(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return bad('這不是舊版庫存匯出的檔案（要是一個 JSON 物件）');
  if (!data.products || typeof data.products !== 'object' || Array.isArray(data.products)) return bad('這不是舊版庫存匯出的檔案（找不到商品資料 products）');
  const S = { products: {}, cartCats: [], stockCats: [], cartItems: {}, stockItems: {}, thresholds: {} };
  const ids = new Set();
  for (const cat of Object.keys(data.products)) {
    const arr = data.products[cat];
    if (!Array.isArray(arr)) return bad(`「${cat}」的商品清單格式不對`);
    S.products[cat] = [];
    for (const p of arr) {
      if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) return bad(`「${cat}」裡有商品的代號格式不對`);
      if (!nameOf(p.name)) return bad(`「${cat}」裡有商品的品名不正確（代號 ${p.id}）`);
      if (ids.has(p.id)) return bad(`商品代號重複：${p.id}`);
      ids.add(p.id);
      const price = typeof p.price === 'number' ? p.price : parseFloat(p.price) || 0, spec = typeof p.spec === 'number' ? p.spec : parseFloat(p.spec) || 0;
      if (!(price >= 0) || !(spec >= 0)) return bad(`商品「${p.name}」的價格或規格不是合理的數字`);
      S.products[cat].push({ id: p.id, name: p.name.trim(), price, spec: spec || 1, unit: nameOf(p.unit) || '克' });
    }
  }
  let dropped = 0;
  for (const [ck, ik] of [['cartCats', 'cartItems'], ['stockCats', 'stockItems']]) {
    const list = data[ck] === undefined ? [] : data[ck], items = data[ik] === undefined ? {} : data[ik];
    if (!Array.isArray(list)) return bad('分類清單格式不對');
    if (!items || typeof items !== 'object' || Array.isArray(items)) return bad('盤點資料格式不對');
    const seen = new Set();
    for (const c of list) {
      if (typeof c !== 'string' || !c.trim() || S[ck].includes(c)) return bad('分類名稱不正確');
      S[ck].push(c); S[ik][c] = [];
      const arr = items[c] === undefined ? [] : items[c];
      if (!Array.isArray(arr)) return bad(`「${c}」的盤點資料格式不對`);
      for (const it of arr) {
        if (!it || typeof it !== 'object' || typeof it.pid !== 'string') return bad(`「${c}」裡有盤點列格式不對`);
        if (!ids.has(it.pid)) { dropped++; continue; }
        let id = typeof it.id === 'string' && it.id ? it.id : 'i' + Math.random().toString(36).slice(2, 10);
        while (seen.has(id)) id += 'x';
        seen.add(id);
        const qty = typeof it.qty === 'number' ? it.qty : parseFloat(it.qty) || 0, spec = typeof it.spec === 'number' ? it.spec : parseFloat(it.spec) || 1;
        if (!(qty >= 0) || !(spec > 0)) return bad(`「${c}」裡有盤點列的數量或規格不是合理的數字`);
        S[ik][c].push({ id, pid: it.pid, name: nameOf(it.name) || findProduct(S, it.pid).name, spec, qty });
      }
    }
  }
  const th = data.thresholds && typeof data.thresholds === 'object' && !Array.isArray(data.thresholds) ? data.thresholds : {};
  for (const pid of Object.keys(th)) {
    if (!ids.has(pid) || !th[pid] || typeof th[pid] !== 'object') continue;
    const low = numOrNull(th[pid].low), high = numOrNull(th[pid].high);
    S.thresholds[pid] = { low: low === undefined ? null : low, high: high === undefined ? null : high };
  }
  // 同正本 applyDefaultThresholds：只補「從未出現過」的商品預設門檻，檔案裡已有的 key（含明確清除的 null）保留
  for (const pid of Object.keys(DEFAULTS.thresholds || {})) if (ids.has(pid) && !Object.prototype.hasOwnProperty.call(th, pid)) S.thresholds[pid] = { low: DEFAULTS.thresholds[pid].low, high: DEFAULTS.thresholds[pid].high };
  if (!ids.size && !Object.values(S.cartItems).flat().length && !Object.values(S.stockItems).flat().length) return bad('這個檔案裡沒有商品也沒有盤點資料');
  S.dropped = dropped;
  return S;
}
function summarize(S) {
  const lines = m => Object.values(m || {}).flat();
  return { categories: Object.keys(S.products).length, products: Object.values(S.products).flat().length, cartLines: lines(S.cartItems).length, stockLines: lines(S.stockItems).length,
    countedLines: [...lines(S.cartItems), ...lines(S.stockItems)].filter(i => (parseFloat(i.qty) || 0) > 0).length, thresholds: Object.keys(S.thresholds || {}).length, total: Math.round(total(S)) };
}

export function inventory(action, me, b, db) {
  if (window.__E2E_INV_FAIL && action === 'saveCounts') return fail('UPSTREAM', '庫存伺服器沒有回應，請稍後再試');   // e2e 用：模擬存檔失敗
  const st = store(db, me.code), S = st.S;
  const at = () => new Date().toISOString();
  if (action === 'bootstrap') { const d = snap(st); return ok({ at: at(), lastFinish: st.lastFinish, data: d }); }
  if (action === 'lowCount') return ok({ ...counts(S, true), missing: 0 });
  if (action === 'saveCounts') {
    if (!ZONES.includes(b.zone)) return bad('區域不正確');
    const zone = b.zone, cats = zone === 'cart' ? S.cartCats : S.stockCats, items = zone === 'cart' ? S.cartItems : S.stockItems;
    const base = typeof b.base === 'string' && b.base ? b.base : null, device = String(b.device || '').slice(0, 40), t = at();
    let overwrote = false; const dropped = [];
    const findRow = id => { for (const c of Object.keys(items)) { const i = items[c].findIndex(x => x.id === id); if (i >= 0) return { c, i }; } return null; };
    const stale = id => { const m = st.meta[zone + '|' + id]; return !!(m && base && m.at > base && m.device !== device); };
    for (const l of b.lines || []) {
      if (!l || typeof l.id !== 'string' || !l.id) return bad('盤點資料格式不對');
      if (!findProduct(S, l.pid) || !cats.includes(l.cat)) { dropped.push(l.id); continue; }
      const qty = typeof l.qty === 'number' ? l.qty : parseFloat(l.qty), spec = typeof l.spec === 'number' ? l.spec : parseFloat(l.spec);
      if (!Number.isFinite(qty) || qty < 0 || qty > 1e9) return bad('數量要是 0 以上的數字');
      if (!Number.isFinite(spec) || spec <= 0) return bad('規格要是大於 0 的數字');
      if (stale(l.id)) overwrote = true;
      const row = { id: l.id, pid: l.pid, name: nameOf(l.name) || '（未命名）', spec, qty }, f = findRow(l.id);
      if (f) { if (f.c === l.cat) items[f.c][f.i] = row; else { items[f.c].splice(f.i, 1); items[l.cat].push(row); } } else items[l.cat].push(row);
      st.meta[zone + '|' + l.id] = { at: t, device };
    }
    for (const id of b.deleted || []) { const f = findRow(id); if (!f) continue; if (stale(id)) overwrote = true; items[f.c].splice(f.i, 1); delete st.meta[zone + '|' + id]; }
    if ((b.lines || []).length || (b.deleted || []).length) hist(st, 'auto', false);
    return ok({ at: t, overwrote, dropped });
  }
  if (action === 'saveCats') {
    const zone = b.zone;
    if (![...ZONES, 'prod'].includes(zone)) return bad('區域不正確');
    const list = (b.cats || []).map(nameOf);
    if (list.some(x => !x)) return bad('分類名稱不能空白');
    if (new Set(list).size !== list.length) return bad('分類名稱重複了');
    const renames = b.renames || [];
    if (zone === 'prod') {
      if (renames.length) return bad('商品類別不能改名');
      for (const c of Object.keys(S.products)) if (!list.includes(c)) { if ((S.products[c] || []).length) return bad(`「${c}」類別裡還有商品，不能刪除`); }
      const next = {}; list.forEach(c => { next[c] = S.products[c] || []; }); S.products = next;
    } else {
      const ck = zone === 'cart' ? 'cartCats' : 'stockCats', ik = zone === 'cart' ? 'cartItems' : 'stockItems', items = S[ik], next = {};
      for (const r of renames) if (!S[ck].includes(r.from) || !list.includes(r.to)) return bad('分類改名資料不正確');
      list.forEach(c => { const old = (renames.find(r => r.to === c) || {}).from || c; next[c] = items[old] || []; });
      S[ck] = list; S[ik] = next;
    }
    hist(st, 'auto', false);
    return ok({ at: at() });
  }
  if (action === 'saveProduct') {
    const name = nameOf(b.name);
    if (!name) return bad('品名不能空白');
    const price = typeof b.price === 'number' ? b.price : parseFloat(b.price) || 0, spec = typeof b.spec === 'number' ? b.spec : parseFloat(b.spec) || 1;
    if (!(price >= 0)) return bad('價格要是 0 以上的數字');
    if (!(spec > 0)) return bad('規格要是大於 0 的數字');
    const unit = nameOf(b.unit).slice(0, 8) || '克';
    if (b.id) {
      const p = findProduct(S, String(b.id));
      if (!p) return fail('NOT_FOUND', '找不到這個商品，請重新整理');
      if (p.name !== name) [S.cartItems, S.stockItems].forEach(m => Object.values(m).forEach(arr => arr.forEach(i => { if (i.pid === p.id) i.name = name; })));
      Object.assign(p, { name, price, spec, unit }); hist(st, 'auto', false);
      return ok({ product: { ...p }, threshold: S.thresholds[p.id] || null, at: at() });
    }
    if (!S.products[b.cat]) return bad('找不到這個商品類別');
    const p = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, price, spec, unit };
    S.products[b.cat].push(p); S.thresholds[p.id] = { low: null, high: 2000 }; hist(st, 'auto', false);
    return ok({ product: { ...p }, threshold: { low: null, high: 2000 }, at: at() });
  }
  if (action === 'deleteProduct') {
    const p = findProduct(S, String(b.id || ''));
    if (!p) return fail('NOT_FOUND', '找不到這個商品，請重新整理');
    for (const c of Object.keys(S.products)) S.products[c] = S.products[c].filter(x => x.id !== p.id);
    delete S.thresholds[p.id];
    let n = 0;
    [S.cartItems, S.stockItems].forEach(m => Object.keys(m).forEach(c => { const before = m[c].length; m[c] = m[c].filter(i => i.pid !== p.id); n += before - m[c].length; }));
    hist(st, 'auto', false);
    return ok({ removedLines: n, at: at() });
  }
  if (action === 'saveThreshold') {
    const low = numOrNull(b.low), high = numOrNull(b.high);
    if (low === undefined || high === undefined) return bad('門檻要是 0 以上的數字，或留空代表不設定');
    if (!findProduct(S, String(b.pid || ''))) return fail('NOT_FOUND', '找不到這個商品，請重新整理');
    S.thresholds[b.pid] = { low, high };
    return ok({ at: at() });
  }
  if (action === 'finish') { const id = hist(st, 'finish', true); st.lastFinish = at(); return ok({ id, at: st.lastFinish }); }
  if (action === 'listHistory') return ok({ items: [...st.history].reverse().slice(0, Math.min(+b.limit || 50, 200)).map(({ id, at: a, kind, total: t }) => ({ id, at: a, kind, total: t })) });
  if (action === 'getHistory') {
    const h = st.history.find(x => x.id === +b.id);
    if (!h) return fail('NOT_FOUND', '找不到這筆歷史');
    return ok({ id: h.id, at: h.at, kind: h.kind, total: h.total, data: clone(h.snapshot) });
  }
  if (action === 'importLegacy') {
    const N = parseLegacy(b.data);
    if (N.ok === false) return N;
    const out = { applied: false, preview: summarize(N), current: summarize(S), dropped: N.dropped };
    if (b.confirm !== true) return ok(out);
    out.backupId = hist(st, 'import-backup', true);
    delete N.dropped; st.S = N; st.meta = {}; out.applied = true; out.at = at();
    return ok(out);
  }
  return fail('NOT_FOUND', '找不到這個功能');
}

// 首頁：庫存偏低 N 項（對照 server/home.js 的 inventory 規則）
export function homeItems(me, db) {
  const n = counts(store(db, me.code).S, true).low;
  return n ? [{ module: 'inventory', level: 'warn', text: `庫存偏低 ${n} 項`, count: n, link: '#/inventory/stock' }] : [];
}
