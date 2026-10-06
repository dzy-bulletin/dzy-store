import { esc, fmtTime } from '../js/ui.js';

export default async function view({ el, api }) {
  let rows;
  try { rows = await api('GET', '/admin/audit?limit=500'); } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  el.innerHTML = `<div class="card"><h2>操作紀錄</h2><p class="hint">最近 ${rows.length} 筆（最多 500 筆）。不記內容、不記密碼。</p>
    <div class="scroll"><table id="auditTable"><thead><tr><th>時間</th><th>門市</th><th>功能</th><th>動作</th><th>結果</th><th>耗時</th><th>錯誤</th></tr></thead><tbody>
    ${rows.length ? rows.map(r => `<tr><td>${fmtTime(r.at)}</td><td>${esc(r.code)}</td><td>${esc(r.module)}</td><td>${esc(r.action)}</td>
      <td><span class="tag ${r.ok ? 'ok' : 'bad'}">${r.ok ? '成功' : '失敗'}</span></td><td>${esc(r.ms)} ms</td><td>${esc(r.error)}</td></tr>`).join('') : '<tr><td colspan="7">還沒有紀錄</td></tr>'}
    </tbody></table></div></div>`;
}
