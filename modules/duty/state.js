// 出勤核定：四個分頁共用的狀態與呼叫。換了登入就整包重來（不留上一個人的資料）。
import { api } from '../../js/api.js';
import { getSession } from '../../js/auth.js';
import { reqDecidable } from './quick-calc.js';
import { viewCanWrite } from './calc.js';

const FLAG = 'dzystore_dutyok';
// 管理者（2026-10-11 Eason：看得到所有門市、也能代核）：asStore＝正在看的門市代號，每次呼叫自動帶上；stores＝各店總覽讀到的門市清單。
export const S = { key: null, admin: false, asStore: '', asName: '', stores: null, meta: { clockStore: '', label: '', breakStart: '', breakEnd: '' }, date: null, dayCache: {}, dayTok: 0,
  pend: null, pendAll: false, focusEmp: null, elsewhere: [], rerender: null, leave: null, leaveP: null,
  all: false, metaBy: {}, leaveBy: {}, recent: {}, reqPre: null, dqFull: false };   // all＝個人登入「全部門市」模式（2026-10-19）；metaBy／leaveBy＝各店的休息帶與假別額度（以營運系統門市代號為鍵）

export function reset(key) {
  S.key = key; S.asStore = ''; S.asName = ''; S.stores = null; S.meta = { clockStore: '', label: '', breakStart: '', breakEnd: '' }; S.date = null; S.dayCache = {}; S.dayTok++;
  S.pend = null; S.pendAll = false; S.focusEmp = null; S.elsewhere = []; S.leave = null; S.leaveP = null; S.reqCount = 0; S.reqAt = 0; S.metaBy = {}; S.leaveBy = {}; S.recent = {}; S.reqPre = null; S.dqFull = false;
  S.leaveMirrorStale = false; S.leaveErr = false; S.leaveStale = false;      // 換登入／換模式：上一個人的額度狀態不留（第三輪審查）
}

// ---- 全部門市（個人登入、可核的人分布在兩家以上打卡店；2026-10-19）----
// session.attStores＝伺服器算好的那幾家店（少於兩家是空陣列）。預設進「全部門市」；選了哪一家（或全部）記在這台裝置、綁這個人（person.sub）。
// 2026-11-15 Eason：原本綁登入 token，嵌在管理系統每次重新載入都換新 token → 一直跳回全部門市。改記「這個人選了哪家店的代號」；
// 下次打開若登入的不是那家，personStoreBar 會自動切過去（不重新載入頁面，免得管理系統又帶回預設的店）。
const PICK_KEY = 'dzystore_dutypick';
export const multiStores = s => (s && s.person && Array.isArray(s.attStores) && s.attStores.length >= 2 ? s.attStores : []);
function pickOf(s) {
  try { const v = JSON.parse(localStorage.getItem(PICK_KEY) || 'null'); return v && s && s.person && v.sub === s.person.sub && typeof v.code === 'string' ? v.code : null; } catch (e) { return null; }
}
export function allModeOf(s) {
  if (!multiStores(s).length) return false;
  const c = pickOf(s);
  return c === null || c === 'ALL';
}
// 選了單一門市（還沒切過去時，回那家店的代號；全部門市或沒選過回空字串）
export function pickedStore(s) { const c = pickOf(s); return c && c !== 'ALL' ? c : ''; }
// code＝選定的門市代號；空字串＝全部門市
export function rememberOne(code) { const s = getSession(); try { localStorage.setItem(PICK_KEY, JSON.stringify({ sub: (s && s.person && s.person.sub) || '', code: code || 'ALL' })); } catch (e) {} }
// 換模式就整包重來（不同模式的名單、快取、額度不混）
export function setAll(on) { on = !!on; if (S.all !== on) { reset(S.key); S.all = on; } }
// 合併各店的讀取：伺服器 /m/duty/all，op＝要讀的單店動作。回應的 failed＝讀不到的店、stores[].meta＝各店休息帶
export async function callAll(op, body) {
  const k = S.key;
  const r = await call('all', Object.assign({ op }, body || {}));
  if (r && Array.isArray(r.stores) && S.key === k && S.all) for (const st of r.stores) if (st.ok && st.meta) S.metaBy[st.store] = st.meta;
  return r;
}
// 每一列自己的店（全部門市時列上有 store）：休息帶與假別額度各用各的店
// 單一門市也可能有別家的列（總部那組直接列在央廚打卡的人，2026-11-02）：列上有 store 就用那家的
export const leaveFor = store => (S.all ? (S.leaveBy[store] || null) : store ? (S.leaveBy[store] || null) : S.leave);
// 上次資料的時間：今天 13:00、不是今天就 11/9 18:00（台北時間）
export function snapLabel(at) {
  const f = ms => new Date(ms + 8 * 3600e3).toISOString(), a = f(at), n = f(Date.now()), t = a.slice(11, 16);
  return a.slice(0, 10) === n.slice(0, 10) ? '今天 ' + t : Number(a.slice(5, 7)) + '/' + Number(a.slice(8, 10)) + ' ' + t;
}
export const rowKey = r => (r && r.store ? r.store + '|' : '') + String(r && r.emp_id);
// 某店讀不到的提示條（全部門市時，其他店照常顯示）
export function failedStores(el, failed, retry) {
  if (!failed || !failed.length) return;
  const bar = h('div', 'du-fail du-fail-stores');
  bar.append(h('span', 'du-fail-msg', failed.map(f => f.storeName + '暫時讀不到').join('、') + '（其他門市照常顯示）'));
  if (retry) { const b = h('button', 'btn sm ghost', '重新載入', { type: 'button' }); b.onclick = () => { b.disabled = true; b.textContent = '載入中…'; retry(); }; bar.append(b); }
  el.append(bar);
}

// 管理者換門市：清掉上一家店的資料（日期、核定快取、假別額度、待審數），只保留門市清單
export function setStore(code, name) {
  const stores = S.stores;
  reset(S.key);
  S.stores = stores; S.asStore = code || ''; S.asName = name || '';
}

// 呼叫 /m/duty/<action>；回應裡的 meta（店別與休息帶）順手記下。核定通行碼失效（後台重設、換了登入）就退回輸入畫面。
// 讀取類動作（其他動作都算寫入）：寫入後把「上次看到的名單」丟掉，下次一定等新資料（剛核定完不能先秀核定前的樣子）
const READS = new Set(['all', 'hr_return_list', 'mgr_day', 'mgr_req_day', 'mgr_req_pending', 'mgr_pending_approvals', 'mgr_roster', 'mgr_pending_devices', 'mgr_notices',
  'mgr_line_binds', 'mgr_qr_token', 'payroll_leave_options', 'payroll_annual_left', 'line_hub_attach_get', 'admin_stores', 'mgr_req_month',
  'mirror_jobs', 'mirror_ack', 'mgr_approve_check']);      // mgr_approve_check：送出前只檢查，不寫入（2026-11-14）      // 背景送出的進度、按知道了：不動考勤資料，不清上次看到的名單
export async function call(action, body) {
  if (!READS.has(action)) { S.recent = {}; S.reqPre = null; checkMemo.clear(); }      // 寫入之後：記住的送出前檢查結果作廢
  try {
    const k = S.key, st = S.asStore;
    const b0 = Object.assign({ mf: 1 }, body || {});      // 寫入也帶（2026-11-19 審查 R2：伺服器看到新前端的核定一定要有 base_ver、calc_ver）      // mf：這個前端會處理「伺服器先給副本」（mirror_stale）並背景再問（2026-11-19；沒帶的舊前端伺服器照舊等新的）
    const r = await api('POST', '/m/duty/' + action, st ? Object.assign({}, b0, { asStore: st }) : b0, undefined, { read: READS.has(action) });
    if (r && r.meta && action !== 'mgr_approve_check' && S.key === k && S.asStore === st) S.meta = r.meta;      // 送出前檢查在背景跑、可能晚到：不拿它的休息帶蓋掉剛讀到的
    // 考勤副本（2026-11-14）：Mac mini 副本讀的資料標 __mirror；有 ver 的人核定時可以背景送（bg.js canBg）
    if (r && r.mirror_at) for (const f of ['employees', 'items']) if (Array.isArray(r[f])) for (const x of r[f]) if (x && typeof x === 'object') x.__mirror = true;
    if (r && Array.isArray(r.home_stores) && S.key === k) for (const x of r.home_stores) if (x.ok && x.meta) S.metaBy[x.store] = x.meta;   // 總部那組併進來的別家：休息帶各用各的   // 管理者已經換店／換登入：上一家店晚到的回應不寫進來（2026-10-12 Codex 審查）
    return r;
  } catch (e) {
    if (e.code === 'FORBIDDEN' && /核定通行碼/.test(e.message)) { try { sessionStorage.removeItem(FLAG); } catch (x) {} if (S.rerender) S.rerender(); }
    else if (e.code === 'DUTY_MUST_CHANGE') { try { sessionStorage.setItem(FLAG, 'm'); } catch (x) {} if (S.rerender) S.rerender(); }
    throw e;
  }
}

// 「申請審核」分頁名稱旁的待審筆數（2026-10-09）。在申請審核分頁讀到清單、或核准／退回後直接更新；在其他分頁則背景問一次（60 秒內不重問）。
export function setReqBadge(n) {
  S.reqCount = n; S.reqAt = Date.now();
  const a = document.querySelector('nav.tabs a[data-tab="request"]');
  if (!a) return;
  a.querySelectorAll('.badge').forEach(b => b.remove());
  if (n > 0) { const i = document.createElement('i'); i.className = 'badge'; i.textContent = String(n); i.setAttribute('aria-label', n + ' 筆待審'); a.append(i); }
  window.dispatchEvent(new Event('dzystore-nav'));   // 嵌入管理系統時：頁頂分頁的數字跟著更新（shell.js postNav）
}
// 申請審核清單要列的：本人自己送的（伺服器標 self，送上層審核）另外放最下面、只給最小列的（hours_only）不列（2026-10-29 Eason 4A）
export const reqShown = items => (Array.isArray(items) ? items : []).filter(it => !(it && (it.self === true || it.hours_only === true)));
// 這張單這個人現在按不按得下去（＝那一列有沒有核准鈕；規則同手機一頁核定 quick-calc.js reqDecidable）
export const reqCanDecide = it => reqDecidable(it, canWriteRow);
// 要我處理的待審申請（分頁數字、標題；首頁 server/att-alerts.js 同一個算法）：只算按得下去的（2026-11-10）。
// 只看名單的人的單、支援同仁的忘刷單、主管代開送總監層級審核中的單照樣列在清單（唯讀），但不算數字
export const reqTodo = items => reqShown(items).filter(reqCanDecide);
export function refreshReqBadge() {
  if (S.admin && !S.asStore) return;
  if (S.reqAt && Date.now() - S.reqAt < 60000) return setReqBadge(S.reqCount || 0);
  const k = S.key;
  (S.all ? callAll('mgr_req_pending') : call('mgr_req_pending')).then(r => { if (S.key === k) setReqBadge(reqTodo(r && r.items).length); }, () => {});
}

export const brk = store => { const m = (store && S.metaBy[store]) || S.meta; return { start: m.breakStart, end: m.breakEnd }; };
// 某一列（mgr_day 的同仁）的休息帶：伺服器在列上標了就用列上的（2026-11-16，那一列實際打卡那家店的），舊回應沒有才照店別查
export const brkOf = emp => (emp && emp.brk && typeof emp.brk.start === 'string' && typeof emp.brk.end === 'string' ? { start: emp.brk.start, end: emp.brk.end } : brk(emp && emp.store));

// 小工具：建元素（文字一律用 textContent，不拼 innerHTML）
export function h(tag, cls, text, attrs) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
  return e;
}

// 送出前只檢查（2026-11-14 考勤管理好上手第 1 項）：打卡系統 mgr_approve_check，用送出核定同一套檢查跑到寫入前就停。
// 回每人 {emp_id, ok, error, message, approved_hours}；讀不到（舊版打卡、連不上）回 null＝不標、照舊送出才知道。
// 同一個人、同一份內容 20 秒內只問一次（2026-11-15 新頁：整天先檢查一次，詳細模式的細調卡打開時拿同一份結果，不重複打）
const CHECK_TTL = 20000, checkMemo = new Map();
const checkKey = (date, store, it) => [date, store || '', String(it.emp_id), JSON.stringify((it.periods || []).map(p => [p.start, p.end])),
  JSON.stringify((it.leaves || []).map(l => [l.type || l.leave_type || '', String(l.hours ?? '')]).sort()), String(it.late_min ?? ''), String(it.diff_reason || ''), JSON.stringify(it.dup_ignore || null)].join('|');
export function checkOnce(date, store, items) {
  const now = Date.now();
  for (const [k, v] of checkMemo) if (now - v.at > CHECK_TTL) checkMemo.delete(k);
  const keys = items.map(it => checkKey(date, store, it));
  const need = items.filter((it, i) => !checkMemo.has(keys[i]));
  if (need.length) {
    const p = call('mgr_approve_check', Object.assign({ date, items: need }, store ? { store } : {})).then(r => (r && Array.isArray(r.results) ? r.results : null), () => null);
    need.forEach(it => { const k = checkKey(date, store, it); checkMemo.set(k, { at: now, p: p.then(rs => (rs ? rs.find(r => r.emp_id === String(it.emp_id)) || null : undefined)) }); });
  }
  return Promise.all(keys.map(k => checkMemo.get(k).p)).then(list => {
    if (list.some(x => x === undefined)) { keys.forEach(k => { const v = checkMemo.get(k); if (v) v.p.then(x => { if (x === undefined) checkMemo.delete(k); }); }); return null; }      // 讀不到：不記住，下次再問
    return list.filter(Boolean);
  });
}
export const dropChecks = () => checkMemo.clear();      // 送出核定、核准單之後：內容可能變了，重新問

// 情境提示（2026-11-14 考勤管理好上手第 5 項）：平常只顯示一句短的，旁邊「?」點了才展開完整說明（再點收起）
export function tipText(short, long, cls) {
  const w = h('span', 'du-tip' + (cls ? ' ' + cls : ''));
  const more = h('span', 'du-tip-long', long); more.hidden = true;
  const q = h('button', 'du-help', '?', { type: 'button', 'aria-label': '說明', 'aria-expanded': 'false' });
  q.onclick = (e) => { e.stopPropagation(); more.hidden = !more.hidden; q.setAttribute('aria-expanded', more.hidden ? 'false' : 'true'); };
  w.append(h('span', 'du-tip-short', short), q, more);
  return w;
}

// 支援標示（2026-10-26）：伺服器在支援帳號那筆加 support_from（原單位名稱，可能是空字串）；舊版沒有＝不標
// 個人例外（2026-11-01）：伺服器加 home_tag（歸屬，例「總部」），同一個標籤位置顯示（例：財務部同仁固定在央廚打卡，標「總部」）
export const supportText = it => (it && typeof it.support_from === 'string' ? '支援' + (it.support_from ? '（' + it.support_from + '）' : '')
  : (it && typeof it.home_tag === 'string' && it.home_tag ? it.home_tag : ''));
export function supportTag(it) {
  const t = supportText(it);
  if (!t) return null;
  return typeof it.support_from === 'string' ? h('span', 'du-support', t, { 'data-support': it.support_from }) : h('span', 'du-support du-home', t, { 'data-home': it.home_tag });
}

// 載入失敗提示條 + 重新載入（伺服器已自動重試過一次，這裡交給人按）
export function failBar(el, label, e, retry) {
  el.innerHTML = '';
  const bar = h('div', 'du-fail');
  bar.append(h('span', 'du-fail-msg', label + '沒載入成功：' + ((e && e.message) || '網路或伺服器忙碌')));
  const b = h('button', 'btn sm ghost', '重新載入', { type: 'button' });
  b.onclick = () => { b.disabled = true; b.textContent = '載入中…'; retry(); };
  bar.append(b);
  el.append(bar);
}

// 假別清單與額度（payroll_leave_options）：整個登入期間抓一次；抓不到靜默退回內建清單、只是沒有額度提示與硬擋（原頁同樣不擋人，manager.html:644–652）。
// 抓失敗不快取，下次進核定頁再試。核定了有假別的人之後，額度就舊了，同樣清掉讓下次重抓。
export function loadLeave() {
  if (S.leave) return Promise.resolve(S.leave);
  if (!S.leaveP && S.all) {                                               // 全部門市：各店各一份（by_store），讀不到的店安靜略過、只是沒有額度提示
    const k = S.key;
    const p = callAll('payroll_leave_options').then(r => {
      if (S.key !== k || S.leaveP !== p) return null;
      const by = {}; for (const [c, v] of Object.entries((r && r.by_store) || {})) if (v && Array.isArray(v.types)) by[c] = v;
      S.leaveBy = by; S.leave = Object.keys(by).length ? by : null; if (!S.leave) S.leaveP = null; S.leaveMirrorStale = !!(r && r.mirror_stale); if (S.leave) S.leaveErr = false; return S.leave;
    }, () => { if (S.key === k && S.leaveP === p) S.leaveP = null; return null; });
    S.leaveP = p;
  }
  if (!S.leaveP) {
    const k = S.key, st = S.asStore;
    const same = () => S.key === k && S.asStore === st;                   // 管理者換店後，上一家店的假別不能套到新店
    const p = call('payroll_leave_options').then(r => {
      if (same() && S.leaveP === p) {
        S.leave = r && Array.isArray(r.types) ? r : null; if (!S.leave) S.leaveP = null;
        S.leaveMirrorStale = !!(r && r.mirror_stale);                    // 上游慢、伺服器先給副本的額度（2026-11-18）：一頁核定背景再問一次（quick.js revalidate）
        S.leaveErr = false;
        const by = {}; for (const [c, v] of Object.entries((r && r.by_store) || {})) if (v && Array.isArray(v.types)) by[c] = v;
        S.leaveBy = by;                                                   // 總部那組併進來的別家（by_store）
      }
      return same() ? S.leave : null; },
      () => { if (same() && S.leaveP === p) { S.leaveP = null; S.leaveErr = true; } return null; });      // leaveErr：讀不到額度（一頁核定讓有請假的人先等、可以重試，2026-11-19）
    S.leaveP = p;
  }
  return S.leaveP;
}
export function staleLeave() { S.leave = null; S.leaveP = null; S.leaveBy = {}; S.leaveStale = true; }   // leaveStale：下次換日期先重抓額度再畫名單

// 個人登入且不是店長／人資主管／管理員：伺服器會擋打卡 QR、公告、新增同仁、設離職（proxy/duty.js manager_only），畫面就不顯示；門市帳號維持原樣
export const dutyManager = s => !(s && s.person && s.dutyManager === false);
// 有沒有核定工時的對象（2026-10-21 工時與申請分開核）：個人登入且伺服器明說 false＝只有申請審核權（區督導、區經理、研發總監）；門市登入、管理者、舊伺服器沒這欄＝有
// ---- 只看（2026-10-25，督導只看考勤）----
// 伺服器只在「這家店有 viewKeys」時才給 session.dutyView（目前這家店）與 attStores[].view（全部門市各店）：{ only, all, hours:[emp_id], req:[emp_id] }。
//   沒有這份資料＝維持原行為（所有人都可寫，伺服器照舊擋）。有的話：all（店長／人資主管／管理員）不逐列限制；否則只有 hours／req 名單裡的人可寫，其餘列唯讀。
//   這裡只決定要不要畫按鈕；真正的放行在伺服器（proxy/duty.js：寫入永遠不看 viewKeys）。
export function viewOf(s, store) {
  if (!s || !s.person) return null;
  if (store && store !== s.code) { const e = Array.isArray(s.attStores) ? s.attStores.find(x => x.code === store) : null; return (e && e.view) || null; }
  if (store && Array.isArray(s.attStores)) { const e = s.attStores.find(x => x.code === store); if (e) return e.view || null; }
  return s.dutyView || null;
}
// kind：'hours'＝核定工時、'req'＝申請審核
export function canWriteRow(kind, empId, store) {
  return viewCanWrite(viewOf(getSession(), store), kind, empId);      // 規則在 calc.js（純函式，假後端 mock.js 共用）
}
// 考勤作廢 att.void（2026-11-13，docs/att-void-hr）：這個人在這家店能作廢他已核准的申請（dutyView.void）；每張單能不能作廢仍看伺服器的 void_ok
export function canVoidRow(empId, store) {
  const v = viewOf(getSession(), store);
  return !!(v && Array.isArray(v.void) && v.void.indexOf(String(empId)) >= 0);
}
// 這家店有 dutyView、不是店長等（all）、且沒有任何可核定工時的人（hours 空；可能純只看，也可能混合店：對店長有申請權、其他人只看）：
// 沒有裝置核准、公告分頁，名冊不放 LINE 綁定紀錄（伺服器依 attKeys 過濾，本來就是空的）。這家店沒有 dutyView 的人完全不受影響
export const viewNoHoursStore = s => { const v = s && s.person && s.dutyView; return !!(v && !v.all && Array.isArray(v.hours) && v.hours.length === 0); };
export const dutyHours = s => !(s && s.person && s.dutyHours === false);
