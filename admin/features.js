import { esc, busy, setMsg } from '../js/ui.js';
import { MODULES } from '../js/registry.js';

export default async function view({ el, api }) {
  let list;
  try { list = await api('GET', '/admin/accounts'); } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  el.innerHTML = `<div class="card"><h2>功能開關</h2><p class="hint">勾選的功能才會出現在該店首頁。改完按該列的「儲存」。</p><div id="fMsg" role="alert" class="err"></div>
    <div class="scroll"><table id="featTable"><thead><tr><th>門市</th>${MODULES.map(m => `<th>${esc(m.label)}</th>`).join('')}<th></th></tr></thead><tbody>
    ${list.map(a => `<tr data-code="${esc(a.code)}"><td><b>${esc(a.code)}</b> ${esc(a.name)}</td>
      ${MODULES.map(m => `<td><input type="checkbox" data-mod="${m.id}" aria-label="${esc(a.code + ' ' + m.label)}" ${a.features.includes(m.id) ? 'checked' : ''}></td>`).join('')}
      <td><button class="btn sm" data-save>儲存</button></td></tr>`).join('')}</tbody></table></div></div>`;
  el.querySelectorAll('tr[data-code]').forEach(tr => {
    tr.querySelector('[data-save]').onclick = e => busy(e.currentTarget, async () => {
      const m = el.querySelector('#fMsg');
      try {
        const features = [...tr.querySelectorAll('input[data-mod]:checked')].map(i => i.dataset.mod);
        await api('POST', '/admin/features', { code: tr.dataset.code, features });
        setMsg(m, `${tr.dataset.code} 已儲存`, true);
      } catch (er) { setMsg(m, er.message); }
    });
  });
}
