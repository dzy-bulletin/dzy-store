import { esc, busy, setMsg, confirmBox } from '../js/ui.js';
import { MODULES } from '../js/registry.js';

export default async function view({ el, api, ui }) {
  let list, offCodes = [];
  try { list = await api('GET', '/admin/accounts'); } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const sso = !!(ui && ui.sso);      // 伺服器沒有設管理系統連線就不出現「關閉門市帳號登入」（關了會沒人進得去）
  if (sso) { try { offCodes = (await api('GET', '/admin/store-login-off')).codes || []; } catch (e) { offCodes = []; } }
  el.innerHTML = `<div class="card"><h2>功能開關</h2><p class="hint">勾選的功能才會出現在該店首頁。改完按該列的「儲存」。門市可以在自己的「功能開關」關掉已開通的功能，這裡會標示「門市已自行關閉」；你取消或重新開通某個功能，門市的關閉紀錄就會清掉。</p><div id="fMsg" role="alert" class="err"></div>
    <div class="scroll"><table id="featTable"><thead><tr><th>門市</th>${MODULES.map(m => `<th>${esc(m.label)}</th>`).join('')}${sso ? '<th>門市帳號登入</th>' : ''}<th></th></tr></thead><tbody>
    ${list.map(a => `<tr data-code="${esc(a.code)}"><td><b>${esc(a.code)}</b> ${esc(a.name)}</td>
      ${MODULES.map(m => `<td><input type="checkbox" data-mod="${m.id}" aria-label="${esc(a.code + ' ' + m.label)}" ${a.features.includes(m.id) ? 'checked' : ''}>${(a.storeOff || []).includes(m.id) ? '<div class="store-off">門市已自行關閉</div>' : ''}</td>`).join('')}
      ${sso ? `<td>${a.role === 'store' ? `<label class="row" style="gap:4px;flex-wrap:nowrap"><input type="checkbox" data-logoff aria-label="${esc(a.code)} 關閉門市帳號登入"${offCodes.includes(a.code) ? ' checked' : ''}> 關閉</label>` : '—'}</td>` : ''}
      <td><button class="btn sm" data-save>儲存</button></td></tr>`).join('')}</tbody></table></div></div>`;
  el.querySelectorAll('input[data-logoff]').forEach(box => {
    box.onchange = async () => {
      const tr = box.closest('tr'), code = tr.dataset.code, m = el.querySelector('#fMsg'), off = box.checked;
      // 關閉前在頁面內確認（不用瀏覽器的 confirm()）；取消就復原勾選
      if (off && !(await confirmBox(`確定要關閉 ${code} 的門市帳號登入？\n\n關閉後這家店只能用管理系統帳號登入，門市代號＋密碼會被擋下，目前已登入的門市帳號也會立刻登出。`, '關閉登入'))) { box.checked = false; return; }
      box.disabled = true;
      try { await api('POST', '/admin/store-login-off', { code, off }); setMsg(m, off ? `${code} 已關閉門市帳號登入` : `${code} 已恢復門市帳號登入`, true); }
      catch (er) { box.checked = !off; setMsg(m, er.message); }
      box.disabled = false;
    };
  });
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
