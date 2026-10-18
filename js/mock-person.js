// 示範模式的「個人帳號登入」假後端（?mode=mock）：假的管理系統入場券、假身分（欄位照契約 test/fixtures/dzy-store-contract-v2.json 的 ident）、
// 假的同仁名單（roster）、本店同仁權限、支援同仁、單位對照、關閉門市帳號登入。用到才由 mock.js 動態 import（不拖慢每一頁的載入）。
// 資料都放在 mock.js 的 db（localStorage dzystore_mockdb）：db.personas、db.unitMap、db.storePerm、db.storeDefault、db.storeLoginOff、db.tickets、db.selects。
// 簡化處（真伺服器才有）：5 分鐘重查／30 分鐘沿用、出勤核定依人過濾。
const hex = n => Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b => b.toString(16).padStart(2, '0')).join('');
const ok = data => ({ ok: true, data: data === undefined ? {} : data });
const fail = (error, message) => ({ ok: false, error, message });
const clone = x => JSON.parse(JSON.stringify(x));
const taipeiToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
export const SUB_RE = /^(DZY\d{3,}|U:[A-Za-z0-9_-]{1,64})$/;
export const MAX_SUPPORT_DAYS = 90;

// 假人物（欄位照契約 ident；attStores 是示範用：這個人考勤名單裡有人的門市代號）
export const PERSONAS = {
  DZY023: { name: '陳小明', unit: 'mzt-test', title: 'sm', epoch: '2026-03-01', units_managed: ['mzt-test'], void_units: [] },
  DZY031: { name: '李計時', unit: 'mzt-test', title: 'pt', epoch: '2026-05-01', units_managed: [], void_units: [] },
  DZY032: { name: '王正職', unit: 'mzt-test', title: 'ft', epoch: '2026-04-01', units_managed: [], void_units: ['mzt-test'] },
  DZY033: { name: '周副店', unit: 'mzt-test', title: 'ft', epoch: '2026-02-01', units_managed: [], void_units: [], attStores: ['TEST2'] },
  DZY040: { name: '吳支援', unit: 'mala-test', title: 'pt', epoch: '2026-06-01', units_managed: [], void_units: [] },
  DZY051: { name: '林督導', unit: 'mala-office', title: 'sv', epoch: '2025-09-01', units_managed: [], void_units: [], attStores: ['TEST1'] },
  DZY060: { name: '張區經理', unit: 'mala-office', title: 'am', epoch: '2025-01-01', units_managed: ['mala-test', 'mzt-test'], void_units: [] },
  DZY070: { name: '黃人資', unit: 'hq-hr', title: 'hm', epoch: '2025-01-01', hr_head: true, units_managed: [], void_units: [], attStores: ['TEST1', 'TEST2'] },
  DZY080: { name: '何新人', unit: 'ck-test', title: 'pt', epoch: '2026-10-01', units_managed: [], void_units: [] },
  DZY090: { name: '劉離職', unit: 'mzt-test', title: 'pt', epoch: '2025-01-01', units_managed: [], void_units: [], active: false },
  'U:u_admin01': { name: '系統管理員', unit: '', title: '', epoch: '', admin: true, units_managed: ['mala-test', 'mzt-test'], void_units: ['mala-test', 'mzt-test'] },
};
export const UNIT_MAP = { 'mala-test': 'TEST1', 'mzt-test': 'TEST2' };
export const STORE_DEFAULT = { TEST1: ['purchase', 'cashbook'], TEST2: ['purchase', 'cashbook', 'loss', 'inventory'] };

export const seed = () => ({ personas: clone(PERSONAS), unitMap: clone(UNIT_MAP), storePerm: {}, storeDefault: clone(STORE_DEFAULT), storeLoginOff: [], tickets: {}, selects: {} });
export const personaOf = (db, sub) => (db.personas || {})[sub] ? Object.assign({ sub }, db.personas[sub]) : null;
const unitOf = (db, code) => Object.keys(db.unitMap).find(u => db.unitMap[u] === code) || null;
const parseUntil = (u, today) => typeof u === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(u) && today <= u;

// 某人在某店的權限（對照 server/person.js personAccess：預設／自訂／全部關／支援到期／上限；出勤核定與作廢不進 store_perm）
export function access(db, p, code, eff) {
  const acc = db.accounts[code];
  if (!acc || !acc.active || acc.role !== 'store') return { features: [], canVoid: false, isManager: false, scheduleAdmin: false, dutyManager: false };
  const upper = eff(acc), unit = unitOf(db, code), today = taipeiToday();
  const isAdmin = !!p.admin, isManager = isAdmin || (!!unit && p.units_managed.includes(unit));
  const hr = !!p.hr_head, dutyEntry = (p.attStores || []).includes(code) || isManager || isAdmin || hr;
  let feats = [];
  if (isManager) feats = upper.slice();
  else if (unit) {
    const row = db.storePerm[code + '|' + p.sub];
    if (p.unit === unit) {
      if (row && row.kind === 'home') feats = row.mode === 'deny' ? [] : row.features.slice();
      else feats = (db.storeDefault[code] || []).slice();
    } else if (row && row.kind === 'support' && parseUntil(row.until, today)) feats = row.mode === 'deny' ? [] : row.features.slice();
    feats = feats.filter(f => f !== 'duty' && upper.includes(f));
  }
  if (dutyEntry && upper.includes('duty') && !feats.includes('duty')) feats.push('duty');
  feats = Array.from(new Set(feats)).sort();
  return { features: feats, canVoid: isManager || (!!unit && p.void_units.includes(unit)), isManager, scheduleAdmin: isManager || hr || isAdmin, dutyManager: isManager || hr || isAdmin };
}
// 這個人可以進哪些店
export function storesOf(db, p, eff) {
  const cand = new Set();
  const add = u => { if (u && db.unitMap[u]) cand.add(db.unitMap[u]); };
  add(p.unit); p.units_managed.forEach(add); p.void_units.forEach(add);
  Object.keys(db.storePerm).forEach(k => { const [c, s] = k.split('|'); if (s === p.sub && db.storePerm[k].kind === 'support') cand.add(c); });
  (p.attStores || []).forEach(c => cand.add(c));
  const order = { mala: 1, mzt: 2, yiwu: 3, cf: 4 };
  return [...cand].filter(c => db.accounts[c] && access(db, p, c, eff).features.length)
    .sort((a, b) => (order[db.accounts[a].brand] || 5) - (order[db.accounts[b].brand] || 5) || (a < b ? -1 : 1)).map(c => ({ code: c, name: db.accounts[c].name }));
}
export function sessionBody(db, p, code, eff, token) {
  const a = db.accounts[code], x = access(db, p, code, eff);
  return Object.assign(token ? { token: token.token, expiresAt: token.expiresAt } : {}, { code, name: a.name, role: 'store', brand: a.brand, mustChangePassword: false, features: x.features,
    person: { sub: p.sub, name: p.name }, canVoid: x.canVoid, isManager: x.isManager, scheduleAdmin: x.scheduleAdmin, dutyUnlocked: x.features.includes('duty'), dutyManager: x.dutyManager, stores: storesOf(db, p, eff) });
}
const newSession = (db, p, code) => {
  const t = { token: hex(32), expiresAt: new Date(Date.now() + 12 * 3600e3).toISOString(), code, duty: false, sub: p.sub };
  db.sessions[t.token] = t; return t;
};
// 假的管理系統發券（示範模式的「用管理系統帳號登入」鍵與 e2e 都走這裡）
export function mint(db, sub) { const t = hex(32); db.tickets[t] = { sub, exp: Date.now() + 60e3 }; return t; }

// 公開路由（還沒登入）：/sso、/sso/select。回 null＝不是這裡的路由
export function publicRoute(db, method, p, b, eff, log) {
  if (method === 'POST' && p === '/sso') {
    if (typeof b.ticket !== 'string' || !b.ticket) return fail('BAD_INPUT', '缺少入場券');
    const t = db.tickets[b.ticket];
    delete db.tickets[b.ticket];        // 一次性
    if (!t || t.exp < Date.now()) return fail('AUTH', '入場券無效或已過期，請回管理系統重新進入');
    const per = personaOf(db, t.sub);
    if (!per) return fail('AUTH', '這個管理系統帳號不是同仁，不能使用門市營運系統');
    if (per.active === false) return fail('AUTH', '帳號已停用或沒有這家店的權限');
    const stores = storesOf(db, per, eff);
    if (!stores.length) return fail('FORBIDDEN', '你的帳號目前沒有可以進入的門市，請洽店長或總部');
    if (stores.length === 1) { log(stores[0].code, 'login', 'sso', true, '', per.name); return ok(sessionBody(db, per, stores[0].code, eff, newSession(db, per, stores[0].code))); }
    const st = hex(32); db.selects[st] = { sub: per.sub, exp: Date.now() + 5 * 60e3 };
    return ok({ select_token: st, stores });
  }
  if (method === 'POST' && p === '/sso/select') {
    const s = db.selects[b.select_token];
    if (!s || s.exp < Date.now()) return fail('AUTH', '選店憑證已失效，請回管理系統重新進入');
    const per = personaOf(db, s.sub), want = String(b.store || '').toUpperCase();
    if (!per || !storesOf(db, per, eff).some(x => x.code === want)) return fail('BAD_INPUT', '不能進入這家店');
    delete db.selects[b.select_token];
    log(want, 'login', 'sso-select', true, '', per.name);
    return ok(sessionBody(db, per, want, eff, newSession(db, per, want)));
  }
  return null;
}

// 已登入的個人帳號：/sso/switch；回 null＝不是這裡的路由
export function personRoute(db, method, p, b, s, per, eff, log) {
  if (method === 'POST' && p === '/sso/switch') {
    const want = String(b.store || '').toUpperCase();
    if (!storesOf(db, per, eff).some(x => x.code === want)) return fail('FORBIDDEN', '你沒有這家店的權限');
    delete db.sessions[s.token];          // 舊 token 立即失效
    log(want, 'login', 'sso-switch', true, '', per.name);
    return ok(sessionBody(db, per, want, eff, newSession(db, per, want)));
  }
  return null;
}

// 本店同仁權限（店長／個人管理員 用自己的店；後台管理者帳號用 store 參數）
export function storePermRoute(db, method, p, q, b, s, per, me, eff, log) {
  if (!/^\/store-perm(\/default|\/support)?$/.test(p)) return null;
  let code, selfSub = null, setBy;
  if (per) {
    if (!access(db, per, s.code, eff).isManager) return fail('FORBIDDEN', '只有這家店的店長可以設定同仁權限');
    code = s.code; selfSub = per.sub; setBy = per.sub;
  } else if (me.role === 'admin') {
    code = String((method === 'GET' ? q.get('store') : b.store) || '').trim().toUpperCase();
    if (!code) return fail('BAD_INPUT', '請先選一家門市');
    if (!db.accounts[code] || db.accounts[code].role !== 'store') return fail('NOT_FOUND', '找不到這家門市');
    setBy = 'admin:' + me.code;
  } else return fail('FORBIDDEN', '只有這家店的店長可以設定同仁權限');
  const unit = unitOf(db, code);
  const assignable = eff(db.accounts[code]).filter(f => f !== 'duty');
  const roster = () => Object.keys(db.personas).map(sub => personaOf(db, sub)).filter(x => x.unit === unit && x.active !== false && x.title)
    .map(x => ({ sub: x.sub, emp_no: x.sub, name: x.name, title: x.title })).sort((a, c) => (a.sub < c.sub ? -1 : 1));
  const checkFeatures = list => {
    if (!Array.isArray(list) || list.some(f => typeof f !== 'string')) return fail('BAD_INPUT', '功能清單格式不正確');
    if (list.some(f => f === 'duty' || f === 'cashbook.void')) return fail('FORBIDDEN', '出勤核定與收支作廢由總部設定，店長不能分配');
    const bad = list.find(f => !assignable.includes(f));
    if (bad) return fail(['purchase', 'cashbook', 'transfer', 'loss', 'inventory', 'board', 'schedule'].includes(bad) ? 'FORBIDDEN' : 'BAD_INPUT', '這家店沒有開通這個功能，不能分配（' + bad + '）');
    return null;
  };
  const sortedSet = list => Array.from(new Set(list)).sort();

  if (method === 'GET' && p === '/store-perm') {
    const def = (db.storeDefault[code] || []).slice();
    const rows = Object.keys(db.storePerm).filter(k => k.startsWith(code + '|')).map(k => Object.assign({ sub: k.split('|')[1] }, db.storePerm[k]));
    const today = taipeiToday();
    return ok({ store: { code, name: db.accounts[code].name, unit },
      assignable, default: { features: def },
      people: roster().map(r => { const row = rows.find(x => x.sub === r.sub && x.kind === 'home'); const stale = !!(row && row.stale); const mode = row && !stale ? row.mode : 'inherit';      // stale＝轉調／復職後失效（示範資料用 row.stale 模擬）
        return { sub: r.sub, emp_no: r.emp_no, name: r.name, title: r.title, self: r.sub === selfSub, mode, stale, features: mode === 'inherit' ? def : mode === 'deny' ? [] : row.features.slice() }; }),
      support: rows.filter(x => x.kind === 'support').map(x => ({ sub: x.sub, name: x.name, mode: x.mode, features: x.features.slice(), until: x.until, expired: !(x.until >= today) })) });
  }
  if (method !== 'POST') return null;
  if (p === '/store-perm/default') {
    const e = checkFeatures(b.features); if (e) return e;
    db.storeDefault[code] = sortedSet(b.features); log(me.code, 'store-perm', 'default', true, '', per && per.name); return ok();
  }
  const subOk = typeof b.sub === 'string' && SUB_RE.test(b.sub);
  if (!subOk) return fail('BAD_INPUT', '同仁編號格式不正確（例如 DZY023）');
  if (selfSub && b.sub === selfSub) return fail('FORBIDDEN', '不能改自己的權限');
  if (!unit) return fail('BAD_INPUT', '這家店還沒有對照管理系統的單位，請洽總部設定');
  const key = code + '|' + b.sub, existing = db.storePerm[key];
  if (p === '/store-perm') {
    if (!['custom', 'deny', 'inherit'].includes(b.mode)) return fail('BAD_INPUT', '模式不正確');
    if (b.mode === 'inherit') { delete db.storePerm[key]; log(me.code, 'store-perm', 'reset', true, '', per && per.name); return ok(); }
    if (existing && existing.kind === 'support' && !(existing.until >= taipeiToday())) return fail('BAD_INPUT', '支援已到期，請先續期');
    const feats = b.mode === 'deny' ? [] : sortedSet(b.features || []);
    if (b.mode !== 'deny') { const e = checkFeatures(b.features); if (e) return e; }
    const who = personaOf(db, b.sub);
    if (!who) return fail('NOT_FOUND', '管理系統查不到這位同仁');
    if (who.active === false) return fail('BAD_INPUT', '這位同仁已停用，不能設定權限');
    let kind;
    if (who.unit === unit) kind = 'home'; else if (existing && existing.kind === 'support') kind = 'support';
    else return fail('BAD_INPUT', '這位不是本店同仁；要請別店同仁支援，請用「加入支援同仁」');
    db.storePerm[key] = { kind, name: who.name, mode: b.mode, features: feats, until: kind === 'support' ? existing.until : null, setBy };
    log(me.code, 'store-perm', 'set', true, '', per && per.name); return ok();
  }
  if (p === '/store-perm/support') {
    const today = taipeiToday(), u = b.until;
    if (typeof u !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(u) || isNaN(Date.parse(u + 'T00:00:00Z'))) return fail('BAD_INPUT', '請填支援到期日（例如 2026-11-30）');
    if (u < today) return fail('BAD_INPUT', '到期日不能是過去的日期');
    if (u > addDays(today, MAX_SUPPORT_DAYS)) return fail('BAD_INPUT', `支援最長 ${MAX_SUPPORT_DAYS} 天，到期後可以再續`);
    const e = checkFeatures(b.features); if (e) return e;
    if (!b.features.length) return fail('BAD_INPUT', '請至少勾選一個功能');
    const who = personaOf(db, b.sub);
    if (!who) return fail('NOT_FOUND', '管理系統查不到這位同仁');
    if (who.active === false) return fail('BAD_INPUT', '這位同仁已停用，不能設定權限');
    if (who.unit === unit) return fail('BAD_INPUT', '這位是本店同仁，不用加入支援，直接在名單裡設定權限');
    db.storePerm[key] = { kind: 'support', name: who.name, mode: 'custom', features: sortedSet(b.features), until: u, setBy };
    log(me.code, 'store-perm', 'support', true, '', per && per.name); return ok();
  }
  return null;
}

// 與 server/admin.js UNIT_CHOICES 同一份（外加兩個測試用單位，e2e 的 TEST1／TEST2 對到它們）
const UNIT_CHOICES = [
  { unit: 'mala-gf', label: '小辛辣 新竹光復' }, { unit: 'mzt-gf', label: '墨竹亭 新竹光復' }, { unit: 'mzt-js', label: '墨竹亭 新竹金山' },
  { unit: 'mzt-lzl', label: '墨竹亭 台北六張犁' }, { unit: 'mzt-wx', label: '墨竹亭 台中文心' }, { unit: 'mzt-rg', label: '墨竹亭 內湖瑞光' },
  { unit: 'mzt-mc', label: '墨竹亭 台中美村' }, { unit: 'yiwu-js', label: '一悟燒肉 新竹金山' }, { unit: 'yiwu-wx', label: '一悟燒肉 竹北文興' },
  { unit: 'ck', label: '中央工廠（央廚）' }, { unit: 'mala-test', label: '（測試）小辛辣' }, { unit: 'mzt-test', label: '（測試）墨竹亭' }
];

// 後台：管理系統單位對照、逐店關閉門市帳號登入
export function adminRoute(db, method, p, b, me, log) {
  if (p === '/admin/unit-map') {
    const stores = Object.values(db.accounts).filter(a => a.role === 'store' && a.active).sort((x, y) => (x.code < y.code ? -1 : 1)).map(a => ({ code: a.code, name: a.name }));
    if (method === 'GET') return ok({ items: Object.keys(db.unitMap).sort().map(u => ({ unit: u, code: db.unitMap[u], name: (db.accounts[db.unitMap[u]] || {}).name })), stores, units: UNIT_CHOICES });
    const unit = typeof b.unit === 'string' ? b.unit.trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(unit)) return fail('BAD_INPUT', '管理系統單位代碼格式不正確（小寫英數字與連字號，例如 mala-gf）');
    if (b.code === null) { delete db.unitMap[unit]; log(me.code, 'admin', 'unit-map-set', true); return ok(); }
    const code = String(b.code || '').trim().toUpperCase();
    if (!stores.some(x => x.code === code)) return fail('BAD_INPUT', '門市代號必須是啟用中的門市帳號');
    const used = Object.keys(db.unitMap).find(u => u !== unit && db.unitMap[u] === code);
    if (used) return fail('BAD_INPUT', `這家門市已經對給單位 ${used} 了，一家門市只能對一個管理系統單位`);
    db.unitMap[unit] = code; log(me.code, 'admin', 'unit-map-set', true); return ok();
  }
  if (p === '/admin/store-login-off') {
    if (method === 'GET') return ok({ codes: db.storeLoginOff.slice().sort() });
    const a = db.accounts[String(b.code || '').toUpperCase()];
    if (!a) return fail('NOT_FOUND', '找不到這個帳號');
    if (a.role !== 'store') return fail('BAD_INPUT', '只能對門市帳號設定');
    if (typeof b.off !== 'boolean') return fail('BAD_INPUT', '開關狀態必須是 true 或 false');
    db.storeLoginOff = db.storeLoginOff.filter(c => c !== a.code);
    if (b.off) { db.storeLoginOff.push(a.code); for (const t of Object.keys(db.sessions)) if (db.sessions[t].code === a.code && !db.sessions[t].sub) delete db.sessions[t]; }
    log(me.code, 'admin', 'store-login-off-set', true); return ok();
  }
  return null;
}
