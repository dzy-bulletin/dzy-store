// 瀏覽器內假後端（?mode=mock）。實作 plan.md「共用契約」全部端點，資料存 localStorage（dzystore_mockdb），
// 方便重整後仍在；清掉該 key 即回到初始。
// ⚠ 以下密碼只是測試用，不是真密碼：
//   TEST1 / store-test-1234（門市 mala，值班核定密碼 1234；duty 為空字串＝預設 0000，第一次要改）   TEST2 / store-test-1234（門市 mzt，功能全開）   ADMIN / admin-test-1234（管理者 hq）
import { lossMock, lossAlias } from './mock-loss.js';
import { transferMock, transferHome, TRANSFER_NODES, DEFAULT_TRANSFER_ALIAS } from './mock-transfer.js';   // 門市調撥假後端（獨立檔）
import { LEAVE_TYPES as MOCK_LEAVES } from '../modules/duty/calc.js';   // 假別名稱沿用內建清單，假後端的「薪酬假別表」預設就是這些
import { inventory as invMock, homeItems as invHome } from './mock-inventory.js';   // 庫存盤點假後端（另一支檔案）
const KEY = 'dzystore_mockdb';
// e2e 注入的資料（window.__E2E_DATA，由測試每次隨機產生）；沒有就用下面內建預設，示範模式不受影響。
const E2E = () => (typeof window !== 'undefined' && window.__E2E_DATA) || {};
const clone = x => JSON.parse(JSON.stringify(x));
const DB_VERSION = 6;   // 資料結構／預設名稱改版就加 1：舊瀏覽器留的舊資料版本不符，整包重建
const MODS = ['purchase', 'cashbook', 'duty', 'transfer', 'loss', 'inventory'];
const LABELS = { purchase: '貨單辨識', cashbook: '收支登記', duty: '值班核定', transfer: '門市調撥', loss: '耗損登記', inventory: '庫存盤點' };
const hex = n => Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b => b.toString(16).padStart(2, '0')).join('');
const ok = data => ({ ok: true, data: data === undefined ? {} : data });
const fail = (error, message) => ({ ok: false, error, message });

function seedSlips() {   // 測試注入的貨單：hours_ago＝幾小時前上傳；編號依當天流水號
  const seed = ((E2E().purchase || {}).slips) || [], byDay = {};
  return seed.map(x => {
    const at = new Date(Date.now() - x.hours_ago * 3600e3), day = at.toISOString().slice(0, 10).replace(/-/g, '');
    byDay[day] = (byDay[day] || 0) + 1;
    return { id: `S${day}-${String(byDay[day]).padStart(4, '0')}`, client_id: 'seed-' + hex(8), store: x.store, status: x.status, vendor_name: x.vendor_name,
      uploaded_at: at.toISOString(), photo_count: x.photo_count, return_reason: x.return_reason };
  });
}
function fresh() {
  const A = E2E().accounts || {}, o = (c, k, d) => (A[c] && A[c][k] !== undefined ? A[c][k] : d);
  const db = {
    v: DB_VERSION,
    accounts: {
      TEST1: { code: 'TEST1', name: o('TEST1', 'name', '測試門市'), brand: 'mala', role: 'store', active: true, pw: o('TEST1', 'pw', 'store-test-1234'), must: false, fails: 0, lockUntil: 0, features: [...MODS], duty: o('TEST1', 'duty', '1234') },
      TEST2: { code: 'TEST2', name: o('TEST2', 'name', '墨竹亭測試店'), brand: 'mzt', role: 'store', active: true, pw: o('TEST2', 'pw', 'store-test-1234'), must: false, fails: 0, lockUntil: 0, features: [...MODS], duty: o('TEST2', 'duty', '1234') },
      ADMIN: { code: 'ADMIN', name: '系統管理者', brand: 'hq', role: 'admin', active: true, pw: o('ADMIN', 'pw', 'admin-test-1234'), must: false, fails: 0, lockUntil: 0, features: [...MODS], duty: '' },
    },
    sessions: {}, audit: [], slips: seedSlips(), alias: {}, vault: {},
    ui: { systemName: '鼎兆元｜門市營運系統', logoUrl: '', colors: { red: '#E8380D', black: '#231815' },
      cards: MODS.map((id, i) => ({ id, label: LABELS[id], visible: true, order: i + 1 })), banner: '' },
  };
  (E2E().extraAccounts || []).forEach(x => { db.accounts[x.code] = { code: x.code, name: x.name, brand: x.brand, role: 'store', active: true, pw: '000000', must: true, fails: 0, lockUntil: 0, features: [...x.features], duty: '' }; });
  return db;
}
let db;
function load() {
  if (db) return db;
  try { db = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
  if (!db || db.v !== DB_VERSION) db = fresh();   // 版本不符（舊瀏覽器留著舊卡片名稱與順序）→ 整包重建
  return db;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }
const rid = () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.split('').sort(() => Math.random() - .5).slice(0, 10).join('');
const pub = (a, token) => ({ code: a.code, name: a.name, role: a.role, brand: a.brand, mustChangePassword: a.must, features: a.features, ...(token ? { token: token.token, expiresAt: token.expiresAt } : {}) });
function log(code, module, action, okk, error) { db.audit.unshift({ at: new Date().toISOString(), code, module, action, ok: okk, ms: 5, error: error || '' }); db.audit.length = Math.min(db.audit.length, 500); }

export async function handle(method, path, body, token) {
  await new Promise(r => setTimeout(r, 60));
  db = null; load(); body = body || {};
  const r = route(method, path.split('?')[0], path.includes('?') ? new URLSearchParams(path.split('?')[1]) : new URLSearchParams(), body, token);
  save();
  return r;
}

function route(method, p, q, b, token) {
  if (method === 'GET' && p === '/ui') return ok(db.ui);
  if (method === 'POST' && p === '/login') {
    const a = db.accounts[String(b.code || '').toUpperCase()];
    if (!a) return fail('AUTH', '代號或密碼不對');
    if (a.lockUntil > Date.now()) { return fail('LOCKED', '連續輸入錯誤，帳號已鎖定，請 15 分鐘後再試或請管理者解鎖'); }
    if (!a.active || a.pw !== b.password) {
      if (a.active) a.fails++;
      if (a.fails >= 5) { a.lockUntil = Date.now() + 15 * 60000; a.fails = 0; }
      log(a.code, 'auth', 'login', false, '密碼錯誤'); return fail('AUTH', '代號或密碼不對');
    }
    a.fails = 0;
    if (b.password === '000000') a.must = true;   // 與伺服器一致：用預設密碼登入一律強制改
    const t = { token: hex(32), expiresAt: new Date(Date.now() + 12 * 3600e3).toISOString(), code: a.code, duty: false };
    db.sessions[t.token] = t; log(a.code, 'auth', 'login', true);
    return ok(pub(a, t));
  }
  const s = token && db.sessions[token];
  if (!s || Date.parse(s.expiresAt) <= Date.now()) return fail('AUTH', '登入已過期，請重新登入');
  const me = db.accounts[s.code];
  if (!me || !me.active) return fail('AUTH', '登入已過期，請重新登入');
  if (method === 'POST' && p === '/logout') { delete db.sessions[token]; return ok(); }
  if (method === 'GET' && p === '/me') return ok(pub(me));
  if (method === 'POST' && p === '/password') {
    if (me.pw !== b.oldPassword) return fail('AUTH', '目前的密碼不對');
    if (b.newPassword === '000000') return fail('BAD_INPUT', '新密碼不可以是預設密碼 000000');
    if (String(b.newPassword || '').length < 8) return fail('BAD_INPUT', '新密碼至少要 8 碼');
    me.pw = b.newPassword; me.must = false; return ok();
  }
  if (me.must) return fail('MUST_CHANGE_PASSWORD', '請先改密碼');
  if (method === 'POST' && p === '/duty/unlock') {
    if (b.password !== (me.duty || '0000')) { log(me.code, 'duty', 'unlock', false, '密碼錯誤'); return fail('FORBIDDEN', '核定密碼不對'); }
    s.duty = true; s.dutyMust = !me.duty; log(me.code, 'duty', 'unlock', true); return ok(s.dutyMust ? { unlocked: true, mustChange: true } : { unlocked: true });
  }
  if (method === 'POST' && p === '/duty/password') {
    if (!s.duty) return fail('FORBIDDEN', '請先輸入目前的核定密碼');
    if (String(b.newPassword || '').length < 4) return fail('BAD_INPUT', '新的核定密碼至少 4 碼');
    if (b.newPassword === '0000') return fail('BAD_INPUT', '新的核定密碼不可以是預設的 0000');
    me.duty = b.newPassword; s.dutyMust = false;
    for (const t of Object.values(db.sessions)) if (t.code === me.code && t !== s) { t.duty = false; t.dutyMust = false; }
    log(me.code, 'duty', 'password', true); return ok();
  }
  if (method === 'GET' && p === '/home') return ok(homeFor(me));
  let m = p.match(/^\/m\/(\w+)\/(\w+)$/);
  if (method === 'POST' && m) {
    if (!MODS.includes(m[1]) || !me.features.includes(m[1])) return fail('FORBIDDEN', '這家店沒有開通這個功能');
    if ((db.fail || []).includes(m[1] + '/' + m[2])) return fail('UPSTREAM', '伺服器暫時沒有回應，請稍後再試');   // e2e 用：db.fail = ['模組/動作'] 讓那個動作失敗
    if (m[1] === 'duty' && s.dutyMust) return fail('DUTY_MUST_CHANGE', '請先把值班核定通行碼改成自己的');
    if (m[1] === 'duty' && !s.duty) return fail('FORBIDDEN', '請先輸入值班核定通行碼');
    if (m[1] === 'purchase') return purchase(m[2], me, b);
    if (m[1] === 'cashbook') return cashbook(m[2], me, b);
    if (m[1] === 'duty') return duty(m[2], me, s, b);
    if (m[1] === 'transfer') return transferMock(m[2], me, b, db);
    if (m[1] === 'inventory') return invMock(m[2], me, b, db);
    if (m[1] === 'loss') return lossMock(m[2], me, b, db);
    return fail('NOT_FOUND', '還在搬移中，暫時請用原本的系統');
  }
  if (p.startsWith('/admin/')) {
    if (me.role !== 'admin') return fail('FORBIDDEN', '只有管理者可以使用');
    return admin(method, p, q, b, me);
  }
  return fail('NOT_FOUND', '找不到這個功能');
}

// ---------- 首頁待辦與異常（對照 server/home.js 的規則；用假資料算）----------
// db.homeFaults（測試用，e2e 直接寫進 localStorage）：['cashbook', …]＝該模組讀不到；不動各模組的呼叫計數
function homeFor(me) {
  const has = id => me.features.includes(id);
  const bad = id => (db.homeFaults || []).includes(id);
  const items = [], errors = [];
  const ERR = { duty: '值班核定暫時讀不到', purchase: '貨單辨識暫時讀不到', cashbook: '收支登記暫時讀不到' };
  const add = (module, level, text, count, link) => items.push({ module, level, text, count, link });
  if (has('duty')) {
    if (bad('duty')) errors.push({ module: 'duty', message: ERR.duty });
    else {
      const d = dutyDb();
      const n = new Set(dutyDo(d, 'mgr_pending_approvals', {}).data.items.map(x => x.date)).size;
      if (n) add('duty', 'todo', `本月還有 ${n} 天沒核定`, n, '#/duty/approve');
      const nq = dutyDo(d, 'mgr_req_pending', {}).data.items.length;
      if (nq) add('duty', 'todo', `${nq} 筆加班請假申請待審`, nq, '#/duty/request');
      if (d.devices.length) add('duty', 'todo', `${d.devices.length} 支新手機等核准`, d.devices.length, '#/duty/device');
    }
  }
  if (has('purchase')) {
    if (bad('purchase')) errors.push({ module: 'purchase', message: ERR.purchase });
    else {
      if (!db.slips) db.slips = seedSlips();
      const mine = db.slips.filter(x => x.store === me.code && Date.parse(x.uploaded_at) >= Date.now() - STORE_SLIPS_DAYS * 86400e3);
      const nBad = mine.filter(x => x.status === 'failed' || x.status === 'returned').length;
      const nSlow = mine.filter(x => ['uploaded', 'queued', 'recognizing'].includes(x.status) && Date.now() - Date.parse(x.uploaded_at) > 2 * 3600e3).length;
      if (nBad) add('purchase', 'error', `${nBad} 張貨單要重拍或處理`, nBad, '#/purchase/mine');
      if (nSlow) add('purchase', 'warn', `${nSlow} 張貨單辨識超過 2 小時`, nSlow, '#/purchase/mine');
    }
  }
  if (has('cashbook')) {
    if (bad('cashbook')) errors.push({ module: 'cashbook', message: ERR.cashbook });
    else {
      const t = taipeiDay(), y = +t.slice(0, 4), mo = +t.slice(5, 7);
      const prev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
      if (!db.cb) db.cb = cbSeed();
      const locked = ((db.cb.locks && db.cb.locks[me.code]) || []).includes(prev);
      if (+t.slice(8, 10) > 5 && !locked) add('cashbook', 'todo', `上個月（${prev}）還沒月結`, 1, '#/cashbook/close');
    }
  }
  if (has('transfer')) items.push(...transferHome(db, me));
  if (has('inventory')) items.push(...invHome(me, db));
  const rank = { error: 0, warn: 1, todo: 2 };
  items.sort((a, c) => rank[a.level] - rank[c.level]);
  return { items, errors, at: new Date().toISOString() };
}

function admin(method, p, q, b, me) {
  const acc = () => db.accounts[String(b.code || '').toUpperCase()];
  if (method === 'GET' && p === '/admin/accounts')
    return ok(Object.values(db.accounts).map(a => ({ code: a.code, name: a.name, brand: a.brand, role: a.role, active: a.active, locked: a.lockUntil > Date.now(), mustChangePassword: a.must, features: a.features })));
  if (method === 'POST' && p === '/admin/accounts') {
    const code = String(b.code || '').toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(code)) return fail('BAD_INPUT', '門市代號要是 2-10 碼的大寫英數字');
    if (db.accounts[code]) return fail('BAD_INPUT', '這個代號已經有人用了');
    if (!String(b.name || '').trim()) return fail('BAD_INPUT', '請填店名');
    if (!['mala', 'mzt', 'yiwu', 'cf', 'hq'].includes(b.brand)) return fail('BAD_INPUT', '品牌不正確');
    if (!['store', 'admin'].includes(b.role)) return fail('BAD_INPUT', '角色不正確');
    const pw = '000000';
    db.accounts[code] = { code, name: b.name.trim(), brand: b.brand, role: b.role, active: true, pw, must: true, fails: 0, lockUntil: 0, features: [], duty: '' };
    log(me.code, 'admin', 'account.create', true); return ok({ tempPassword: pw });
  }
  if (method === 'POST' && p === '/admin/accounts/update') {
    const a = acc(); if (!a) return fail('NOT_FOUND', '找不到這個帳號');
    if (b.name !== undefined) { if (!String(b.name).trim()) return fail('BAD_INPUT', '店名不能空白'); a.name = String(b.name).trim(); }
    if (b.active !== undefined) { if (a.code === me.code && !b.active) return fail('BAD_INPUT', '不能停用自己'); a.active = !!b.active; }
    if (b.unlock) { a.lockUntil = 0; a.fails = 0; }
    log(me.code, 'admin', 'account.update', true); return ok();
  }
  if (method === 'POST' && p === '/admin/accounts/reset') {
    const a = acc(); if (!a) return fail('NOT_FOUND', '找不到這個帳號');
    a.pw = '000000'; a.must = true;
    for (const t of Object.keys(db.sessions)) if (db.sessions[t].code === a.code) delete db.sessions[t];
    log(me.code, 'admin', 'account.reset', true); return ok({ tempPassword: a.pw });
  }
  if (method === 'POST' && p === '/admin/features') {
    const a = acc(); if (!a) return fail('NOT_FOUND', '找不到這個帳號');
    a.features = MODS.filter(x => (b.features || []).includes(x)); log(me.code, 'admin', 'features', true); return ok();
  }
  if (method === 'POST' && p === '/admin/duty-pass') {
    const a = acc(); if (!a) return fail('NOT_FOUND', '找不到這個帳號');
    if (String(b.password || '').length < 4) return fail('BAD_INPUT', '核定密碼至少要 4 碼');
    a.duty = b.password; log(me.code, 'admin', 'duty-pass', true); return ok();
  }
  if (method === 'POST' && p === '/admin/duty-pass/reset') {
    const a = acc(); if (!a) return fail('NOT_FOUND', '找不到這個帳號');
    a.duty = '';
    for (const t of Object.values(db.sessions)) if (t.code === a.code) { t.duty = false; t.dutyMust = false; }
    log(me.code, 'admin', 'duty-pass-reset', true); return ok();
  }
  if (method === 'GET' && p === '/admin/alias') {
    const stores = [['', '光復小辛辣', 'duty:_'], ['cf', '央廚', 'duty:cf'], ['hq', '總部', 'duty:hq'], ['mztjs', '墨竹亭金山', 'duty:mztjs'], ['mztgf', '墨竹亭光復', 'duty:mztgf']];
    return ok({ aliases: Object.values(db.accounts).filter(a => a.role === 'store').sort((x, y) => x.code.localeCompare(y.code))
        .map(a => ({ code: a.code, name: a.name, system: 'clock', value: Object.prototype.hasOwnProperty.call(db.alias, a.code) ? db.alias[a.code] : null, transfer: (db.aliasTr || DEFAULT_TRANSFER_ALIAS)[a.code] || null })),
      stores: stores.map(([value, label]) => ({ value, label })),
      ...lossAlias.info(db),
      vault: stores.map(([, label, name]) => ({ name, label, set: !!db.vault[name], updatedAt: db.vault[name] || null })),
      transferNodes: TRANSFER_NODES.map(n => ({ code: n.code, name: n.name, short: n.short })),
      transferVault: TRANSFER_NODES.map(n => ({ name: 'transfer:' + n.code, label: n.name, set: !!db.vault['transfer:' + n.code], updatedAt: db.vault['transfer:' + n.code] || null })) });
  }
  if (method === 'POST' && p === '/admin/alias') {
    const a = acc(); if (!a) return fail('NOT_FOUND', '找不到這個帳號');
    if (b.system === 'transfer') {
      if (b.value !== null && !TRANSFER_NODES.some(n => n.code === b.value)) return fail('BAD_INPUT', '調撥節點不正確');
      db.aliasTr = { ...(db.aliasTr || DEFAULT_TRANSFER_ALIAS) }; if (b.value === null) delete db.aliasTr[a.code]; else db.aliasTr[a.code] = b.value;
      log(me.code, 'admin', 'alias-set', true); return ok();
    }
    if (b.system === 'mzt_loss') return lossAlias.set(db, a, b);
    if (b.system !== 'clock') return fail('BAD_INPUT', '對照類型不正確');
    if (b.value === null) delete db.alias[a.code];
    else if (!['', 'cf', 'hq', 'mztjs', 'mztgf'].includes(b.value)) return fail('BAD_INPUT', '打卡店別不正確');
    else db.alias[a.code] = b.value;
    log(me.code, 'admin', 'alias-set', true); return ok();
  }
  if (method === 'POST' && p === '/admin/ui') {
    const hexc = /^#[0-9a-fA-F]{6}$/;
    if (!b.colors || !hexc.test(b.colors.red) || !hexc.test(b.colors.black)) return fail('BAD_INPUT', '顏色格式不正確');
    const ids = (b.cards || []).map(c => c.id);
    if (ids.length !== 6 || new Set(ids).size !== 6 || !MODS.every(m => ids.includes(m))) return fail('BAD_INPUT', '首頁卡片要六張齊全、不能重複');
    if (b.logoUrl && !/^(https:\/\/[^/]|\/[^/]|data:image\/(png|jpeg|webp);base64,)/.test(b.logoUrl)) return fail('BAD_INPUT', 'Logo 網址要以 https:// 開頭、或是 / 開頭的站內路徑（不能是 //），或 png／jpeg／webp 的內嵌圖片');
    if ((b.banner || '').length > 300) return fail('BAD_INPUT', '公告橫幅最多 300 字');
    db.ui = { systemName: String(b.systemName || '').trim() || '鼎兆元｜門市營運系統', logoUrl: b.logoUrl || '', colors: b.colors,
      cards: (b.cards || []).map(c => ({ id: c.id, label: c.label, visible: !!c.visible, order: c.order })), banner: b.banner || '' };
    log(me.code, 'admin', 'ui', true); return ok();
  }
  if (method === 'GET' && p === '/admin/audit') return ok(db.audit.slice(0, Math.min(+q.get('limit') || 500, 500)));
  return fail('NOT_FOUND', '找不到這個功能');
}

// ---------- 貨單辨識（模擬貨單伺服器：廠商、上傳、我的貨單、照片）----------
const VENDORS_DEFAULT = [{ id: 1, name: '大成肉品' }, { id: 2, name: '新鮮蔬果行' }, { id: 3, name: '冷凍食品批發' }];
const vendorList = () => { const v = (E2E().purchase || {}).vendors; return v || VENDORS_DEFAULT; };
const STORE_SLIPS_DAYS = 30;

function purchase(action, me, b) {
  if (!db.slips) db.slips = seedSlips();
  if (action === 'vendors') return ok(vendorList());
  if (action === 'mine') {
    const since = Date.now() - STORE_SLIPS_DAYS * 86400e3;
    return ok(db.slips.filter(x => x.store === me.code && Date.parse(x.uploaded_at) >= since).sort((a, c) => c.uploaded_at.localeCompare(a.uploaded_at) || c.id.localeCompare(a.id))
      .map(({ store, client_id, ...rest }) => rest));
  }
  if (action === 'slips') {
    const cid = String(b.get ? b.get('client_id') || '' : '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(cid)) return fail('BAD_INPUT', '送出的資料不完整，請重新整理再試');
    const dup = db.slips.find(x => x.client_id === cid);
    if (dup) return ok({ id: dup.id, status: dup.status, duplicate: true });
    const photos = (b.getAll ? b.getAll('photos[]') : []).filter(f => f && f.size > 0);
    if (!photos.length) return fail('BAD_INPUT', '至少要一張照片');
    if (photos.length > 6) return fail('BAD_INPUT', '一次最多 6 張照片');
    let vendor = null;
    const vid = b.get('vendor_id'), vname = String(b.get('vendor_name') || '').trim();
    if (vid) { vendor = vendorList().find(v => String(v.id) === String(vid)); if (!vendor) return fail('BAD_INPUT', '廠商不存在'); }
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const n = db.slips.filter(x => x.id.startsWith('S' + day)).length + 1;
    const slip = { id: `S${day}-${String(n).padStart(4, '0')}`, client_id: cid, store: me.code, status: 'queued', vendor_name: vendor ? vendor.name : (vname || null),
      uploaded_at: new Date().toISOString(), photo_count: photos.length, return_reason: null };
    db.slips.push(slip); log(me.code, 'purchase', 'slips', true);
    return ok({ id: slip.id, status: slip.status, duplicate: false });
  }
  return fail('NOT_FOUND', '找不到這個功能');
}

// GET 取圖：回 Blob（畫一張帶貨單編號的假照片），錯誤回 {ok:false}
export async function handleBlob(path, token) {
  await new Promise(r => setTimeout(r, 40));
  db = null; load();
  const s = token && db.sessions[token];
  if (!s || Date.parse(s.expiresAt) <= Date.now()) return fail('AUTH', '登入已過期，請重新登入');
  const m = path.match(/^\/m\/purchase\/photo\/([^/]+)\/(\d+)$/);
  const slip = m && (db.slips || []).find(x => x.id === m[1] && x.store === s.code);
  if (!slip || +m[2] < 1 || +m[2] > slip.photo_count) return fail('NOT_FOUND', '找不到這張照片');
  const c = document.createElement('canvas'); c.width = 240; c.height = 320;
  const g = c.getContext('2d'); g.fillStyle = '#f3ece4'; g.fillRect(0, 0, 240, 320); g.fillStyle = '#231815'; g.font = '20px sans-serif';
  g.fillText(slip.id, 14, 40); g.fillText('第 ' + m[2] + ' 張', 14, 70);
  return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', 0.8));
}

// ---------- 收支登記（模擬現金帳伺服器：多店、冪等、鎖月、作廢留痕、收據編號每店遞增）----------
// 資料在 db.cb：{ rows, frequent:{店:[...]}, locks:{店:[月]}, tokens:{店|token:id}, calls:{動作:次數}, faults:[...] }
// faults（測試用，由 e2e 直接寫進 localStorage）：{ action, mode, once }
//   mode='timeout'：不執行、回 TIMEOUT；'timeout-saved'：先寫進去再回 TIMEOUT（逾時但其實有記到）；'down'：回 UPSTREAM（連不上）
const CB_EXPENSE_D = ['食材', '包材', '瓦斯水電', '雜支', '交通'];
const CB_INCOME_D = ['雜項收入', '廢料回收'];
const cbSubj = () => { const c = E2E().cashbook || {}; return { exp: c.expense || CB_EXPENSE_D, inc: c.income || CB_INCOME_D }; };
function cbSeed() {
  const c = E2E().cashbook;
  if (!c) return { rows: [], frequent: {}, locks: {}, tokens: {}, calls: {}, faults: [] };
  return { rows: clone(c.rows || []), frequent: clone(c.frequent || {}), locks: clone(c.locks || {}), tokens: {}, calls: {}, faults: [] };
}
const cbTax = (amount, inv) => { const a = Math.round(Number(amount) || 0); if (!inv) return { net: a, tax: 0 }; const net = Math.round(a / 1.05); return { net, tax: a - net }; };   // 同原系統 splitTax

function cashbook(action, me, b) {
  if (!db.cb) db.cb = cbSeed();
  const cb = db.cb, store = me.code;
  cb.calls[action] = (cb.calls[action] || 0) + 1;
  const fi = cb.faults.findIndex(f => f.action === action);
  const fault = fi >= 0 ? cb.faults[fi] : null;
  if (fault && fault.once) cb.faults.splice(fi, 1);
  if (fault && fault.mode === 'timeout') return fail('TIMEOUT', '現金帳回應太久，這次不一定沒記進去，請先看明細確認');
  if (fault && fault.mode === 'down') return fail('UPSTREAM', '現金帳沒有回應，請稍後再試');
  const out = cbDo(cb, action, store, b);
  if (fault && fault.mode === 'timeout-saved') return fail('TIMEOUT', '現金帳回應太久，這次不一定沒記進去，請先看明細確認');
  if (out.ok) log(store, 'cashbook', action, true);
  return out;
}

function cbDo(cb, action, store, b) {
  const stamp = () => new Date().toISOString();
  const mine = () => cb.rows.filter(r => r.store === store);
  const locks = () => (cb.locks[store] = cb.locks[store] || []);
  const freq = () => (cb.frequent[store] = cb.frequent[store] || []);
  const view = r => ({ ...r });
  const monthRows = m => mine().filter(r => r.date.slice(0, 7) === m);
  const open = m => !locks().includes(m);
  if (action === 'bootstrap' || action === 'list') {
    const rows = b.month ? monthRows(String(b.month)).map(view) : undefined;
    if (action === 'list') return ok({ rows: rows || [] });
    return ok({ settings: { store: me_name(store), expenseSubjects: cbSubj().exp, incomeSubjects: cbSubj().inc }, frequent: freq().slice(), lockedMonths: locks().slice(), ...(rows ? { rows, month: b.month } : {}) });
  }
  if (action === 'create') {
    const tk = b.clientToken ? store + '|' + String(b.clientToken) : '';
    if (tk && cb.tokens[tk]) { const hit = cb.rows.find(r => r.id === cb.tokens[tk]); if (hit) return ok({ row: view(hit), frequent: freq().slice(), duplicate: true }); }
    const month = String(b.date || '').slice(0, 7);
    if (!open(month)) return fail('LOCKED', '這個月已經結帳鎖定，不能再新增或修改');
    const amount = Math.round(Number(b.amount));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) || !['支出', '收入'].includes(b.kind) || !String(b.subject || '').trim() || !String(b.name || '').trim() || !(amount >= 1 && amount <= 10000000)) return fail('BAD_INPUT', '有欄位沒填或金額不對');
    const mr = monthRows(month); let seq = 0; mr.forEach(r => { if (r.kind === b.kind && r.seq > seq) seq = r.seq; });   // 作廢的仍占編號
    let n = mr.length + 1; while (cb.rows.some(r => r.id === month + '-' + ('00' + n).slice(-3))) n++;
    const t = cbTax(amount, b.hasInvoice);
    const row = { id: month + '-' + ('00' + n).slice(-3), store, date: b.date, kind: b.kind, subject: String(b.subject).trim(), name: String(b.name).trim(), amount, hasInvoice: !!b.hasInvoice,
      net: t.net, tax: t.tax, seq: seq + 1, photo: b.photoBase64 ? 'https://example.invalid/cashbook/photo/' + cb.rows.length + '.jpg' : '', author: '店長', createdAt: stamp(), status: '正常' };
    cb.rows.push(row); if (tk) cb.tokens[tk] = row.id;
    const f = freq().find(x => x.subject === row.subject && x.name === row.name);
    if (f) { f.count++; f.lastUsed = stamp(); } else freq().push({ subject: row.subject, name: row.name, count: 1, lastUsed: stamp() });
    return ok({ row: view(row), frequent: freq().slice() });
  }
  const target = () => cb.rows.find(r => r.id === b.id && r.store === store);
  if (action === 'update') {
    const r = target(); if (!r) return fail('NOT_FOUND', '找不到這筆資料，請重新整理');
    if (!open(r.date.slice(0, 7))) return fail('LOCKED', '這個月已經結帳鎖定，不能再新增或修改');
    const date = b.date || r.date, amount = b.amount !== undefined ? Math.round(Number(b.amount)) : r.amount, inv = b.hasInvoice !== undefined ? !!b.hasInvoice : r.hasInvoice;
    if (!open(date.slice(0, 7))) return fail('LOCKED', '這個月已經結帳鎖定，不能再新增或修改');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(amount >= 1)) return fail('BAD_INPUT', '有欄位沒填或金額不對');
    const t = cbTax(amount, inv);
    Object.assign(r, { date, amount, hasInvoice: inv, net: t.net, tax: t.tax, subject: b.subject ? String(b.subject).trim() : r.subject, name: b.name ? String(b.name).trim() : r.name });
    return ok({ row: view(r) });
  }
  if (action === 'void') {   // 作廢留痕：資料列永遠留著，只是不計入合計
    const r = target(); if (!r) return fail('NOT_FOUND', '找不到這筆資料，請重新整理');
    if (!open(r.date.slice(0, 7))) return fail('LOCKED', '這個月已經結帳鎖定，不能再新增或修改');
    Object.assign(r, { status: '作廢', voidedAt: stamp(), voidReason: String(b.reason || '') });
    return ok({ row: view(r) });
  }
  if (action === 'lock' || action === 'unlock') {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(b.month || ''))) return fail('BAD_INPUT', '有欄位沒填或金額不對');
    const l = locks();
    if (action === 'lock' && !l.includes(b.month)) l.push(b.month);
    if (action === 'unlock') cb.locks[store] = l.filter(m => m !== b.month);
    return ok({ lockedMonths: cb.locks[store].slice() });
  }
  return fail('NOT_FOUND', '找不到這個功能');
}
function me_name(store) { return (db.accounts[store] && db.accounts[store].name) || store; }

// ---------- 值班核定（對照 ~/mala-gas/mala-clock-in/程式碼.js 的 mgr_* 與伺服器 server/proxy/duty.js 的錯誤白話）----------
// 假資料：E01 王小明（班 08:00–17:00、天天有打卡）E02 李小華（班 09:00–12:00、天天有打卡但遲到）E03 陳大文（休假沒打卡）
// E04 林小美（只有未入帳嘗試）。TEST1 這家店的休息帶 12:00–13:00（像央廚）；把 db.duty.brk 設成 ['',''] 就是沒有休息帶（像光復）。
// e2e 可用 localStorage 的 dzystore_mock_today（yyyy-mm-dd）把「今天」固定住，日期相關的測試才不會隨執行日漂移
const taipeiDay = (n = 0) => {
  let o = ''; try { o = localStorage.getItem('dzystore_mock_today') || ''; } catch (e) {}
  const base = o ? new Date(o + 'T12:00:00Z') : new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(base.getTime() + n * 86400000));
};
const DUTY_FAKE_D = {
  E01: { shift: ['08:00', '17:00'], segs: [{ in: '08:00', out: '17:02', cross: false }], ref: 9.03 },
  E02: { shift: ['09:00', '12:00'], segs: [{ in: '09:12', out: '12:00', cross: false }], ref: 2.8 },
  E03: { shift: ['', ''], segs: [], ref: null },
  E04: { shift: ['', ''], segs: [], ref: null, attempts: 2 },
};
const fakeOf = emp => ((E2E().duty || {}).fake || DUTY_FAKE_D)[emp];
function dutyDb() {
  const E = E2E().duty;
  if (!db.duty && E) db.duty = { brk: [...E.brk], faults: [], calls: {}, approved: {}, leave: {}, roster: clone(E.roster), devices: clone(E.devices), notices: clone(E.notices), binds: clone(E.binds || []), reqs: clone(E.reqs || []) };
  if (!db.duty) db.duty = {
    brk: ['12:00', '13:00'], faults: [], calls: {}, approved: {}, leave: {},
    roster: [{ emp_id: 'E01', name: '王小明', active: true, created_by: '', removed_at: '', removed_by: '' }, { emp_id: 'E02', name: '李小華', active: true, created_by: '', removed_at: '', removed_by: '' },
      { emp_id: 'E03', name: '陳大文', active: true, created_by: '', removed_at: '', removed_by: '' }, { emp_id: 'E04', name: '林小美', active: true, created_by: '', removed_at: '', removed_by: '' },
      { emp_id: 'E00', name: '張前輩', active: false, created_by: '', removed_at: '2026-09-30T18:00:00+08:00', removed_by: '門市營運系統' }],
    devices: [{ emp_id: 'E02', name: '李小華', device_id: 'dev-aaaa-bbbbcc112233', count: 2, first_ts: '2026-10-06T08:55:00+08:00', last_ts: '2026-10-06T17:01:00+08:00', max_distance_m: 35, all_within_range: true },
      { emp_id: 'E04', name: '林小美', device_id: 'dev-dddd-eeee99887766', count: 1, first_ts: '2026-10-06T09:10:00+08:00', last_ts: '2026-10-06T09:10:00+08:00', max_distance_m: 420, all_within_range: false }],
    notices: [{ id: 'N1', text: '舊公告：10/1 起請準時打卡。', active: false, ends_on: '', expired: false, created_at: '2026-09-30T10:00:00+08:00', created_by: '門市營運系統' }],
    binds: [{ ts: '2026-10-08T09:02:00+08:00', emp_id: 'E01', name: '王小明', uid: 'U-mock-1', type: 'bind_name' }],
  };
  if (!db.duty.reqs) db.duty.reqs = defaultReqs();     // 舊瀏覽器留的假資料沒有申請：補上示範申請（不必整包重建）
  return db.duty;
}
// 加班請假／忘打卡申請的示範資料（對照 ~/mala-clock-in apps-script/Requests.gs）：請假附圖片、加班附 PDF、忘打卡的打卡被擋且定位誤差很大
function defaultReqs() {
  const at = (n, hm) => taipeiDay(n) + 'T' + hm + ':00+08:00';
  return [
    { id: 'R1', created_at: at(-1, '07:12'), emp_id: 'E03', name: '陳大文', kind: 'leave', date: taipeiDay(-1), leave_type: '病假', start: '', end: '', hours: 8, miss_type: '', reason: '發燒去看醫生，附診斷證明', attach_id: 'att-img-R1', status: 'pending' },
    { id: 'R2', created_at: at(-1, '19:20'), emp_id: 'E01', name: '王小明', kind: 'ot', date: taipeiDay(-1), leave_type: '', start: '17:00', end: '19:00', hours: 2, miss_type: '', reason: '晚上客人多，店長請我留下來幫忙', attach_id: 'att-pdf-R2', status: 'pending' },
    { id: 'R3', created_at: at(-1, '09:40'), emp_id: 'E04', name: '林小美', kind: 'miss', date: taipeiDay(-2), leave_type: '', start: '10:00', end: '18:00', hours: null, miss_type: 'both', reason: '在店門口按打卡一直說不在範圍內', attach_id: '', status: 'pending',
      punches: [{ type: 'in', hm: '09:58', status: 'rejected_out_of_range', distance_m: 860, accuracy_m: 1414 }, { type: 'out', hm: '18:03', status: 'rejected_out_of_range', distance_m: 640, accuracy_m: 900 }] },
    // 出差單（2026-10-09）：leave_type＝出差、reason＝'地點：…；事由：…'
    { id: 'R4', created_at: at(-1, '21:05'), emp_id: 'E02', name: '李小華', kind: 'trip', date: taipeiDay(-1), leave_type: '出差', start: '', end: '', hours: 8, miss_type: '', reason: '地點：台中央廚；事由：支援月初盤點', attach_id: '', status: 'pending' },
  ];
}
function reqSummary(r) {     // Requests.gs reqSummary_
  const md = parseInt(r.date.slice(5, 7), 10) + '/' + parseInt(r.date.slice(8, 10), 10);
  if (r.kind === 'leave') return md + ' ' + r.leave_type + (r.start ? ' ' + r.start + '–' + r.end : ' 整天') + ' ' + Number(r.hours) + ' 小時';
  if (r.kind === 'ot') return md + ' 加班 ' + r.start + '–' + r.end + '（' + Number(r.hours) + ' 小時）';
  if (r.kind === 'trip') {
    const m = /^地點：(.*?)；事由：/.exec(r.reason || ''), place = m ? m[1] : '';
    return md + ' 出差' + (r.start ? ' ' + r.start + '–' + r.end : ' 整天') + ' ' + Number(r.hours) + ' 小時' + (place ? '（地點：' + place + '）' : '');
  }
  const parts = [];
  if (r.miss_type === 'in' || r.miss_type === 'both') parts.push('上班 ' + r.start);
  if (r.miss_type === 'out' || r.miss_type === 'both') parts.push('下班 ' + r.end);
  return md + ' 忘打卡補登（' + parts.join('、') + '）';
}
const reqPublic = r => ({ id: r.id, created_at: r.created_at, emp_id: r.emp_id, name: r.name, kind: r.kind, date: r.date, leave_type: r.leave_type || '', start: r.start || '', end: r.end || '',
  hours: r.hours ?? null, miss_type: r.miss_type || '', reason: r.reason || '', has_attach: !!r.attach_id, status: r.status, decided_at: r.decided_at || '', decided_by: r.decided_by || '',
  reject_reason: r.reject_reason || '', summary: reqSummary(r) });
// 示範附件：圖片用 canvas 畫一張「示範附件」；PDF 給一小段 PDF 檔頭（只是讓下載連結出得來）
function mockAttach(id) {
  if (/pdf/.test(id)) return { mime: 'application/pdf', data: btoa('%PDF-1.4\n% mock attachment ' + id + '\n%%EOF\n') };
  let data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  try {
    const c = document.createElement('canvas'); c.width = 480; c.height = 300; const g = c.getContext('2d');
    g.fillStyle = '#fffdf6'; g.fillRect(0, 0, 480, 300); g.strokeStyle = '#c9b9a8'; g.lineWidth = 6; g.strokeRect(8, 8, 464, 284);
    g.fillStyle = '#231815'; g.font = 'bold 34px sans-serif'; g.fillText('診斷證明書（示範）', 60, 110);
    g.font = '22px sans-serif'; g.fillStyle = '#6b524a'; g.fillText('附件編號 ' + id, 60, 170); g.fillText('示範模式的假附件', 60, 210);
    const u = c.toDataURL('image/png'); if (u.indexOf('data:image/png;base64,') === 0) data = u.slice(22);
  } catch (e) {}
  return { mime: 'image/png', data };
}
function dutyHas(emp, date) { const f = fakeOf(emp); return !!f && (f.segs.length > 0 || !!f.attempts); }
function duty(action, me, s, b) {
  const d = dutyDb();
  d.calls[action] = (d.calls[action] || 0) + 1;
  const fi = d.faults.findIndex(f => f.action === action);
  const fault = fi >= 0 ? d.faults[fi] : null;
  if (fault && fault.once) d.faults.splice(fi, 1);
  if (fault && fault.mode === 'timeout') return fail('TIMEOUT', '打卡系統回應太久，請稍後再試');
  if (fault && fault.mode === 'down') return fail('UPSTREAM', '打卡系統暫時沒有回應，請稍後再試');
  const r = dutyDo(d, action, b);
  if (r.ok) r.data.meta = { clockStore: '', label: '麻的小辛辣 新竹光復店', breakStart: d.brk[0], breakEnd: d.brk[1] };
  return r;
}
function dutyDo(d, action, b) {
  const MGR = '門市營運系統';
  const today = taipeiDay();
  if (action === 'mgr_day') {
    const date = b.date || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('BAD_INPUT', '日期格式不對。');
    const employees = d.roster.filter(r => r.active).map(r => {
      const f = fakeOf(r.emp_id) || { shift: ['', ''], segs: [], ref: null };
      const out = { emp_id: r.emp_id, name: r.name, segments: f.segs.map(x => ({ ...x })), reference: f.ref, attempts: f.attempts || 0,
        leave_type: (d.leave[date + r.emp_id] || {}).type || '', leave_hours: (d.leave[date + r.emp_id] || {}).hours ?? '', shift_in: f.shift[0], shift_out: f.shift[1] };
      const a = d.approved[date + r.emp_id]; if (a) out.approved = { ...a };
      return out;
    }).sort((x, y) => (dutyHas(y.emp_id) ? 1 : 0) - (dutyHas(x.emp_id) ? 1 : 0));
    return ok({ date, employees });
  }
  if (action === 'mgr_pending_approvals') {
    const items = [], ym = today.slice(0, 7);
    for (let n = 8; n >= 1; n--) {
      const date = taipeiDay(-n); if (date.slice(0, 7) !== ym) continue;
      d.roster.filter(r => r.active && dutyHas(r.emp_id) && !d.approved[date + r.emp_id]).forEach(r => items.push({ date, emp_id: r.emp_id, name: r.name }));
    }
    return ok({ ym, today, items });
  }
  if (action === 'mgr_approve') {
    const date = String(b.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('BAD_INPUT', '日期格式不對。');
    const emp = d.roster.find(r => r.emp_id === b.emp_id); if (!emp) return fail('NOT_FOUND', '名冊裡找不到這位同仁，請重新整理。');
    const leave = String(b.leave_type || '').trim();
    let lh = ''; if (leave && b.leave_hours !== '' && b.leave_hours != null) { const h = Number(b.leave_hours); if (!isFinite(h) || h < 0) return fail('BAD_INPUT', '請假時數不能是負數，請修正後再送出。'); lh = Math.round(h * 100) / 100; }
    const periods = b.periods || [], trip = leave === '出差' && lh !== '' ? lh : 0;
    let hours, status;
    if (!periods.length) {
      if (!leave) return fail('BAD_INPUT', '上班時段格式不對，或沒有填任何時段也沒選假別。');
      if (leave === '出差') { if (!(trip > 0)) return fail('BAD_INPUT', '整天出差請填出差時數（填幾小時就核定幾小時）。'); hours = trip; status = '出差'; }
      else { hours = 0; status = '全天請假'; }
    } else {
      hours = trip; periods.forEach(p => { const [a, c] = [p.start, p.end].map(t => +t.slice(0, 2) * 60 + +t.slice(3)); hours += ((c <= a ? c + 1440 : c) - a) / 60; });
      hours = Math.round(hours * 100) / 100;
      const late = String(b.late_min ?? '').trim();
      status = late === '0' ? '主管認定不計遲到' : late !== '' && Number(late) > 0 ? '遲到' + Number(late) + '分(認定)' : '正常';
    }
    const rec = { periods: periods.map(p => ({ ...p })), approved_hours: hours, status_text: status, manager_name: MGR };
    d.approved[date + emp.emp_id] = rec; d.leave[date + emp.emp_id] = { type: leave, hours: lh };
    return ok({ date, emp_id: emp.emp_id, name: emp.name, periods, approved_hours: hours, leave_type: leave, leave_hours: lh, status_text: status, manager_name: MGR });
  }
  if (action === 'payroll_leave_options') {      // 薪酬假別表＋額度＋期限事件日；e2e 可把 d.leaveOpts 換成自己的（含 blocked、window_days、events）
    return ok(clone(d.leaveOpts || { ok: true, store: 'SSLGF', ym: taipeiDay().slice(0, 7), day_hours: 8, types: MOCK_LEAVES.map((n, i) => ({ code: 'lt' + i, name: n })), quotas: {}, events: {} }));
  }
  if (action === 'mgr_req_pending') {
    const items = d.reqs.filter(r => r.status === 'pending').sort((x, y) => (x.created_at < y.created_at ? -1 : 1)).map(r => {
      const o = reqPublic(r); o.attach_id = r.attach_id || '';
      if (r.date <= today) o.punches = clone(r.punches || []);   // 還沒到的日期沒有打卡可看
      return o;
    });
    return ok({ items });
  }
  if (action === 'mgr_req_decide') {
    const decision = String(b.decision || '');
    if (decision !== 'approve' && decision !== 'reject') return fail('BAD_INPUT', '核准或退回的選項不對，請重新整理。');
    const reason = String(b.reason ?? '').trim().slice(0, 100);
    if (decision === 'reject' && !reason) return fail('BAD_INPUT', '退回要寫理由');
    const r = d.reqs.find(x => String(x.id) === String(b.id || ''));
    if (!r) return fail('NOT_FOUND', '找不到這筆申請');
    if (r.status !== 'pending') return fail('BAD_INPUT', r.status === 'cancelled' ? '同仁已經取消這筆申請' : '這筆已經處理過了');
    r.status = decision === 'approve' ? 'approved' : 'rejected'; r.decided_at = new Date().toISOString(); r.decided_by = MGR; r.reject_reason = decision === 'reject' ? reason : '';
    return ok({ id: r.id, status: r.status });
  }
  if (action === 'mgr_req_decide_batch') {      // Requests.gs handleMgrReqDecideBatch_：只能核准、最多 30 筆，不是審核中的略過並說原因
    if (String(b.decision || '') !== 'approve') return fail('BAD_INPUT', '批次只能核准；退回請一筆一筆處理');
    const ids = (Array.isArray(b.ids) ? b.ids.map(String) : []).filter((x, i, a) => x && a.indexOf(x) === i);
    if (!ids.length) return fail('BAD_INPUT', '請先勾選要核准的申請');
    if (ids.length > 30) return fail('BAD_INPUT', '一次最多核准 30 筆');
    const done = [], skipped = [], now = new Date().toISOString();
    ids.forEach(id => {
      const r = d.reqs.find(x => String(x.id) === id);
      if (!r) return skipped.push({ id, reason: '找不到這筆申請' });
      if (r.status !== 'pending') return skipped.push({ id, reason: r.status === 'cancelled' ? '同仁已經取消這筆申請' : '這筆已經處理過了' });
      r.status = 'approved'; r.decided_at = now; r.decided_by = MGR; r.reject_reason = ''; done.push(id);
    });
    return ok({ done, skipped });
  }
  if (action === 'mgr_req_day') {
    const date = String(b.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('BAD_INPUT', '日期格式不對。');
    const by_emp = {};
    d.reqs.filter(r => r.date === date && r.status === 'approved').forEach(r => { (by_emp[r.emp_id] = by_emp[r.emp_id] || []).push(reqPublic(r)); });
    return ok({ date, by_emp });
  }
  if (action === 'mgr_qr_token') {               // 店別代碼由伺服器依打卡對照填：示範店＝光復（'' → gk）
    const now = Date.now(), win = Math.floor(now / 30000);
    return ok({ token: 'gk~' + win + '~2~' + hex(8), expires_in: 30000 - (now % 30000), manager: MGR });
  }
  if (action === 'line_hub_attach_get') {
    const id = String(b.attach_id || '');
    if (!id || !d.reqs.some(r => r.attach_id === id)) return fail('NOT_FOUND', '找不到這筆資料，請重新整理。');
    return ok(mockAttach(id));
  }
  if (action === 'mgr_pending_devices') return ok({ pending: d.devices.map(x => ({ ...x })) });
  if (action === 'mgr_device_decision') {
    const i = d.devices.findIndex(x => x.emp_id === b.emp_id && x.device_id === b.device_id);
    if (i < 0) return fail('BAD_INPUT', '這批待核准已被處理過了，請重新整理頁面。');
    const [g] = d.devices.splice(i, 1); return ok({ emp_id: g.emp_id, approve: !!b.approve, changed: g.count });
  }
  if (action === 'mgr_roster') return ok({ roster: d.roster.map(r => ({ ...r })), manager_name: MGR });
  if (action === 'mgr_line_binds') {   // 與打卡後端 Liff.js handleMgrLineBinds_ 同形狀：新的在前、still_bound
    const bound = {}; (d.binds || []).forEach(x => { if (String(x.type).indexOf('bind') === 0) bound[x.emp_id] = x.uid; else delete bound[x.emp_id]; });
    return ok({ days: 30, items: (d.binds || []).map(x => ({ ts: x.ts, emp_id: x.emp_id, name: x.name, type: x.type,
      still_bound: String(x.type).indexOf('bind') === 0 && bound[x.emp_id] === x.uid })).reverse() });
  }
  if (action === 'mgr_line_unbind') {
    const last = [...(d.binds || [])].reverse().find(x => x.emp_id === String(b.emp_id || ''));
    if (!last || String(last.type).indexOf('bind') !== 0) return ok({ already: true });
    if (!d.binds) d.binds = [];
    d.binds.push({ ts: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00', emp_id: last.emp_id, name: last.name, uid: last.uid, type: 'unbind_by:' + MGR });
    return ok({});
  }
  if (action === 'mgr_add_employee') {
    const name = String(b.name || '').trim();
    if (!name) return fail('BAD_INPUT', '請輸入同仁姓名');
    if (name.length > 20) return fail('BAD_INPUT', '姓名過長');
    if (name === MGR) return fail('BAD_INPUT', '不能新增與自己同名的同仁');
    const dup = d.roster.find(r => r.active && r.name === name);
    if (dup) return fail('BAD_INPUT', '名冊已經有在職的「' + name + '」（編號 ' + dup.emp_id + '）。薪資是用姓名對應請假與工時，同名會算錯——如果真的是不同人，請改用可區分的名字。');
    const n = d.roster.reduce((m, r) => Math.max(m, +r.emp_id.slice(1)), 0) + 1, emp_id = 'E' + String(n).padStart(2, '0');
    d.roster.push({ emp_id, name, active: true, created_by: MGR, removed_at: '', removed_by: '' });
    return ok({ emp_id, name, key: 'MOCKKEY' + hex(4), created_by: MGR, created_at: new Date().toISOString() });
  }
  if (action === 'mgr_set_active') {
    const r = d.roster.find(x => x.emp_id === String(b.emp_id || '').trim());
    if (!b.emp_id) return fail('BAD_INPUT', '請先選擇同仁');
    if (!r) return fail('NOT_FOUND', '名冊裡找不到這位同仁');
    const active = b.active === true || String(b.active).toLowerCase() === 'true';
    if (!active && r.name === MGR) return fail('BAD_INPUT', '不能把自己設為離職');
    if (active && d.roster.some(x => x !== r && x.active && x.name === r.name)) return fail('BAD_INPUT', '名冊已經有在職的「' + r.name + '」，不能同時有兩位同名在職。');
    r.active = active; r.removed_at = active ? '' : new Date().toISOString(); r.removed_by = active ? '' : MGR;
    return ok({ emp_id: r.emp_id, name: r.name, active });
  }
  if (action === 'mgr_notices') {
    const rows = d.notices.map(n => ({ ...n, expired: !!n.ends_on && n.ends_on < today })).sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
    return ok({ notices: rows, max_len: 120, max_show: 5 });
  }
  if (action === 'mgr_add_notice') {
    const text = String(b.text ?? '').trim();
    if (!text) return fail('BAD_INPUT', '請先輸入公告內容');
    if (text.length > 120) return fail('BAD_INPUT', '公告最多 120 個字（目前 ' + text.length + ' 個字）');
    const ends = String(b.ends_on ?? '').trim();
    if (ends && !/^\d{4}-\d{2}-\d{2}$/.test(ends)) return fail('BAD_INPUT', '下架日期格式不對');
    if (ends && ends < today) return fail('BAD_INPUT', '下架日期已經過了，這則公告發出來不會顯示');
    const n = { id: 'N' + Date.now(), text, active: true, ends_on: ends, expired: false, created_at: new Date().toISOString(), created_by: MGR };
    d.notices.push(n); return ok({ id: n.id, text, ends_on: ends, created_at: n.created_at, created_by: MGR });
  }
  if (action === 'mgr_set_notice_active') {
    const n = d.notices.find(x => x.id === String(b.id || '')); if (!n) return fail('NOT_FOUND', '找不到這則公告');
    n.active = b.active === true || String(b.active).toLowerCase() === 'true'; return ok({ id: n.id, active: n.active });
  }
  return fail('NOT_FOUND', '找不到這個功能');
}
