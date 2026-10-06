// 「送出中 X.X 秒」：所有會打後端的按鈕都要包這一層（2026-09-08 Eason 指定，照抄原系統 js/busy.js 的做法）。
// 沒有回饋店長會以為沒按到而連按，一連按就記成兩筆；看得到秒數在跑，人就會等。失敗一律讓按鈕可以再按，但絕不自動重送。
import { S, msgOf } from './state.js';

const TICK_MS = 100, DONE_HOLD_MS = 1200;

export function runBusy(btn, task, opts) {
  opts = opts || {};
  if (!btn || btn.disabled) return Promise.resolve();
  const original = btn.textContent, label = btn.getAttribute('data-busy') || '送出中', started = Date.now();
  const paint = () => { btn.textContent = `${label} ${((Date.now() - started) / 1000).toFixed(1)} 秒` + (S.retrying ? '（重試中）' : ''); };
  btn.disabled = true; btn.classList.add('is-busy'); paint();
  const timer = setInterval(paint, TICK_MS);
  const restore = () => { btn.textContent = original; btn.disabled = false; };
  return Promise.resolve().then(task).then(result => {
    clearInterval(timer); btn.classList.remove('is-busy');
    btn.textContent = opts.doneText || '已完成 ✓';
    setTimeout(restore, DONE_HOLD_MS);
    return result;
  }, err => {
    clearInterval(timer); btn.classList.remove('is-busy'); restore();
    if (opts.onError) opts.onError(msgOf(err), err);
  });
}
