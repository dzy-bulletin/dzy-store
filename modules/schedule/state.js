// 自動排班：前端狀態與呼叫。每次修改後整包重讀（伺服器回來的就是最新的檢查結果與版本），不在前端自己拼。
import { api } from '../../js/api.js';
import { periodOf, todayTaipei, shiftPeriod, parseLabel } from './period.js';

export const S = { key: null, period: null, data: null, loading: null, sel: null, view: null, day: null, msg: '', err: '', annual: undefined, annualP: null };

/** 能不能排班（hr-move-spec §3、§10.1-2）：只有個人登入且是本店店長同等職、人資主管、管理員（scheduleAdmin）；門市帳號與其他看得到的主管都只能看。伺服器另外擋（schedule.js mod()），這裡只決定畫面 */
export const canEdit = (ses) => !!(ses && ses.person && ses.scheduleAdmin);

export function reset(key) {
  S.key = key; S.period = null; S.data = null; S.loading = null; S.sel = null; S.view = null; S.day = null; S.msg = ''; S.err = '';
  S.annual = undefined; S.annualP = null; S.ckOpen = false;      // 排班前檢查清單的展開狀態不跨店
}
/** 剩餘特休（薪資系統，{emp_id: 天}）：班表畫好後另外抓、抓到再重畫；整個登入期間抓一次，抓不到就不顯示（2026-10-12 Eason） */
export function loadAnnual(rerender) {
  if (S.annual !== undefined || S.annualP) return;
  const k = S.key;
  S.annualP = call('annual').then((r) => { if (S.key !== k) return; S.annual = (r && r.annual) || null; S.annualP = null; if (S.annual) rerender(); },
    () => { if (S.key === k) { S.annual = null; S.annualP = null; } });
}
export const call = (action, body) => api('POST', '/m/schedule/' + action, body || {});

export function defaultPeriod() {
  const p = periodOf(todayTaipei());
  return p || 'T00';
}
export function movePeriod(k) {
  const n = parseLabel(S.period) + k;
  if (n < 0) return;
  S.period = shiftPeriod(S.period, k);
  S.data = null; S.sel = null; S.day = null;
}
export async function load() {
  if (!S.period) S.period = defaultPeriod();
  S.data = await call('load', { period: S.period });
  return S.data;
}
/** 帶版本的修改：成功後重讀；別人剛改過（CONFLICT）時也重讀並提示 */
export async function mutate(action, body) {
  try {
    const r = await call(action, Object.assign({ period: S.period, version: S.data && S.data.meta.version }, body || {}));
    await load();
    return r;
  } catch (e) {
    if (e.code === 'CONFLICT' || e.code === 'LOCKED') { try { await load(); } catch (e2) { /* 留原畫面 */ } }
    throw e;
  }
}

const DUTY_KEY = 'dzystore_dutyok';
export const dutyFlag = () => { try { return sessionStorage.getItem(DUTY_KEY) || ''; } catch (e) { return ''; } };
export const setDutyFlag = (v) => { try { if (v) sessionStorage.setItem(DUTY_KEY, v); else sessionStorage.removeItem(DUTY_KEY); } catch (e) { /* 無痕模式 */ } };

export const WD = ['日', '一', '二', '三', '四', '五', '六'];
export const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
export const hm = (min) => { const h = Math.floor(min / 60), r = min % 60; return r ? `${h}:${String(r).padStart(2, '0')}` : String(h); };
export const DAY_LABEL = { R: '例', H: '休' };
export const LEAVE_LABEL = { '特': '特休', '補': '補休', '國': '國定' };
