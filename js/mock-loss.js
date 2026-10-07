// 耗損登記的瀏覽器內假後端（?mode=mock）。行為對照 server/proxy/loss.js：兩種模式（有 mzt_loss 對照＝墨竹亭共用表、沒有＝營運系統自有）、
// 店別由「伺服器」決定、listLoss 只回該店、voidLoss 先確認屬於該店、addLoss 重複 id 回 duplicated。
// 初始資料可由 window.__E2E_DATA.loss 注入（e2e 用）：{ mztItems, mztRecords, ownItems: { mala: [...] }, ownRecords }。
const CATS = ['肉類', '海鮮', '蔬菜', '豆製品・加工品', '乾貨・南北貨', '調味料', '飲品・酒水', '包材・耗材', '其他'];
const REASONS = ['報廢', '過期', '備料失誤', '客訴重做', '試菜', '盤點差異', '其他'];
const MZT = [['墨竹亭光復', '墨竹亭光復'], ['墨竹亭金山', '墨竹亭金山'], ['墨竹亭六張犁', '墨竹亭六張犁'], ['墨竹亭美村', '墨竹亭台中美村']];
const ok = data => ({ ok: true, data });
const fail = (error, message) => ({ ok: false, error, message });
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = v => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const clone = x => JSON.parse(JSON.stringify(x));

function L(db) {
  if (!db.loss) {
    const seed = (typeof window !== 'undefined' && window.__E2E_DATA && window.__E2E_DATA.loss) || {};
    db.loss = { alias: { TEST2: '墨竹亭光復' }, mztItems: clone(seed.mztItems || []), mztRecords: clone(seed.mztRecords || []),
      ownItems: clone(seed.ownItems || {}), ownRecords: clone(seed.ownRecords || []) };
  }
  return db.loss;
}

export const lossAlias = {
  info(db) { return { lossAliases: { ...L(db).alias }, lossStores: MZT.map(([value, label]) => ({ value, label })) }; },
  set(db, a, b) {
    const l = L(db);
    if (b.value === null) { delete l.alias[a.code]; return ok({}); }
    if (!MZT.some(([v]) => v === b.value)) return fail('BAD_INPUT', '耗損系統店別不正確');
    l.alias[a.code] = b.value; return ok({});
  },
};

const itemOut = i => ({ 品名: i.品名, 品類: i.品類, 單位: i.單位, 單位成本: i.單位成本, 停用: !!i.停用, 更新時間: i.更新時間 || '' });
function cleanRec(r, store) {
  if (!r || !/^[A-Za-z0-9_-]{6,64}$/.test(r.id || '')) return '登記編號不正確，請重新整理後再試';
  if (!isDate(r.日期)) return '日期不正確';
  if (!String(r.品名 || '').trim()) return '請填品名';
  if (!CATS.includes(r.品類)) return '請選品類';
  if (!REASONS.includes(r.原因)) return '請選原因';
  const q = num(r.耗損量), c = num(r.單位成本), a = num(r.金額);
  if (!(q > 0)) return '耗損量要大於 0';
  if (!(c >= 0)) return '單位成本不正確';
  if (!Number.isFinite(a) || Math.abs(a - Math.round(q * c * 100) / 100) > 0.005) return '金額與耗損量、單位成本對不上，請重新整理後再試';
  return { id: r.id, 日期: r.日期, 店別: store, 品類: r.品類, 品名: String(r.品名).trim(), 耗損量: q, 單位: String(r.單位 || ''), 單位成本: c, 金額: a, 原因: r.原因,
    原因說明: r.原因 === '其他' ? String(r.原因說明 || '').slice(0, 100) : '', 備註: String(r.備註 || '').slice(0, 200), 建立時間: new Date().toISOString(), 作廢: false };
}

export function lossMock(action, me, b, db) {
  const l = L(db), alias = l.alias[me.code];
  const mzt = !!alias, store = mzt ? alias : me.code;
  const items = mzt ? l.mztItems : (l.ownItems[me.brand] || (l.ownItems[me.brand] = []));
  const records = mzt ? l.mztRecords : l.ownRecords;
  if (action === 'bootstrap') return ok({ items: items.map(itemOut), meta: { rev: 1 }, serverTime: new Date().toISOString(), mode: mzt ? 'mzt' : 'own',
    storeLabel: mzt ? (MZT.find(([v]) => v === alias) || [0, alias])[1] : me.name, categories: CATS, reasons: REASONS });
  if (action === 'listLoss') {
    const from = isDate(b.from) ? b.from : '', to = isDate(b.to) ? b.to : '';
    return ok({ records: records.filter(r => r.店別 === store && (!from || r.日期 >= from) && (!to || r.日期 <= to)).map(clone) });
  }
  if (action === 'addLoss') {
    if (!Array.isArray(b.records) || !b.records.length) return fail('BAD_INPUT', '登記資料格式不正確');
    const clean = [];
    for (const r of b.records) { const c = cleanRec(r, store); if (typeof c === 'string') return fail('BAD_INPUT', c); clean.push(c); }
    if (window.__E2E_LOSS_CLASH) { window.__E2E_LOSS_CLASH = false; return ok({ accepted: [], duplicated: clean.map(c => c.id) }); }   // e2e 用：模擬 id 撞到別店的紀錄（回 duplicated 但本店沒有這筆）
    const accepted = [], duplicated = [];
    for (const c of clean) { if (records.some(r => r.id === c.id)) duplicated.push(c.id); else { records.push(c); accepted.push(c.id); } }
    return ok({ accepted, duplicated });
  }
  if (action === 'voidLoss') {
    const r = records.find(x => x.id === b.id && x.店別 === store);
    if (!r) return fail('FORBIDDEN', '找不到這筆登記，或不是你們店的紀錄');
    r.作廢 = true; return ok({ ok: true, id: r.id });
  }
  if (action === 'saveItem') {
    const it = b.item || {}, name = String(it.品名 || '').trim(), cost = num(it.單位成本);
    if (!name) return fail('BAD_INPUT', '缺少品名');
    if (!CATS.includes(it.品類)) return fail('BAD_INPUT', '請選品類');
    if (!(cost >= 0)) return fail('BAD_INPUT', '單位成本不正確');
    const rec = { 品名: name, 品類: it.品類, 單位: String(it.單位 || ''), 單位成本: cost, 停用: it.停用 === true, 更新時間: new Date().toISOString() };
    const old = it.舊品名 && it.舊品名 !== name ? items.find(x => x.品名 === it.舊品名) : null;
    if (old) { if (items.some(x => x.品名 === name)) return fail('BAD_INPUT', `「${name}」已經在成本表裡了`); Object.assign(old, rec); }
    else { const ex = items.find(x => x.品名 === name); if (ex) Object.assign(ex, rec); else items.push(rec); }
    return ok({ items: items.map(itemOut) });
  }
  return fail('NOT_FOUND', '找不到這個功能');
}
