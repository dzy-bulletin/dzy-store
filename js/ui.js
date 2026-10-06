export const DEFAULT_COLORS = { red: '#E8380D', black: '#231815' };

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 送出中停用按鈕，避免連按
export async function busy(btn, fn) {
  if (btn.disabled) return;
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '送出中';
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}
export function setMsg(el, text, ok) {
  el.textContent = text || '';
  el.className = ok ? 'okmsg' : 'err';
}
export function confirmBox(text, okLabel = '確定') {
  return new Promise(resolve => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" role="dialog"><p>${esc(text)}</p><div class="row"><button class="btn" data-ok>${esc(okLabel)}</button><button class="btn ghost" data-no>取消</button></div></div>`;
    document.body.appendChild(bg);
    const done = v => { bg.remove(); resolve(v); };
    bg.querySelector('[data-ok]').onclick = () => done(true);
    bg.querySelector('[data-no]').onclick = () => done(false);
  });
}
// 套用 GET /ui：系統名稱、logo、主色、公告
export function applyUi(ui) {
  const root = document.documentElement.style;
  const c = (ui && ui.colors) || {};
  root.setProperty('--red', c.red || DEFAULT_COLORS.red);
  root.setProperty('--black', c.black || DEFAULT_COLORS.black);
  if (ui && ui.systemName) document.title = ui.systemName;
}
export function fmtTime(iso) {
  const d = new Date(iso); if (isNaN(d)) return esc(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
