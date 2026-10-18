import { esc, fmtTime } from '../js/ui.js';

export default async function view({ el, api, ui }) {
  let rows;
  try { rows = await api('GET', '/admin/audit?limit=500'); } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const who = !!(ui && ui.sso) || rows.some(r => r.actor);       // 沒開個人帳號登入、也沒有個人操作的紀錄：維持原本的欄位
  el.innerHTML = `<div class="card"><h2>操作紀錄</h2><p class="hint">最近 ${rows.length} 筆（最多 500 筆）。不記內容、不記密碼。</p>
    <div class="scroll"><table id="auditTable"><thead><tr><th>時間</th><th>門市</th>${who ? '<th>操作人</th>' : ''}<th>功能</th><th>動作</th><th>結果</th><th>耗時</th><th>錯誤</th></tr></thead><tbody>
    ${rows.length ? rows.map(r => `<tr><td>${fmtTime(r.at)}</td><td>${esc(r.code)}</td>${who ? `<td class="au-who">${esc(r.actor || '門市帳號')}</td>` : ''}<td>${esc(r.module)}</td><td>${esc(r.action)}</td>
      <td><span class="tag ${r.ok ? 'ok' : 'bad'}">${r.ok ? '成功' : '失敗'}</span></td><td>${esc(r.ms)} ms</td><td>${esc(r.error)}</td></tr>`).join('') : '<tr><td colspan="${who ? 8 : 7}">還沒有紀錄</td></tr>'}
    </tbody></table></div></div>`;
}
