import { esc, busy, setMsg, fmtTime } from '../js/ui.js';

// 門市對照：每個門市帳號對應哪一家打卡店別（值班核定要連到打卡系統的哪一店）
export default async function view({ el, api }) {
  let d;
  try { d = await api('GET', '/admin/alias'); } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  el.innerHTML = `<div class="card"><h2>門市對照（打卡店別）</h2>
    <p class="hint">每個門市帳號要連到打卡系統的哪一家店。沒設定的店，值班核定進不去。</p><div id="alMsg" role="alert" class="err"></div>
    <div class="scroll"><table id="aliasTable"><thead><tr><th>代號</th><th>店名</th><th>打卡店別</th></tr></thead><tbody>
    ${d.aliases.map(a => `<tr data-code="${esc(a.code)}"><td><b>${esc(a.code)}</b></td><td>${esc(a.name)}</td><td>
      <select class="aliasSel" aria-label="${esc(a.code)} 打卡店別"><option value="__none"${a.value === null ? ' selected' : ''}>無</option>
      ${d.stores.map(s => `<option value="${esc(s.value)}"${a.value === s.value ? ' selected' : ''}>${esc(s.label)}${s.value ? '（' + esc(s.value) + '）' : ''}</option>`).join('')}</select></td></tr>`).join('')}
    </tbody></table></div></div>
    <div class="card"><h2>打卡金鑰代管狀態</h2><p class="hint">只顯示「已設／未設」。金鑰由管理者在公司 Mac mini 終端機輸入，這裡看不到內容。</p>
    <div class="scroll"><table id="vaultTable"><thead><tr><th>打卡店別</th><th>名稱</th><th>狀態</th><th>更新時間</th></tr></thead><tbody>
    ${d.vault.map(v => `<tr data-vault="${esc(v.name)}"><td>${esc(v.label)}</td><td><code>${esc(v.name)}</code></td>
      <td><span class="tag ${v.set ? 'ok' : 'bad'}">${v.set ? '已設' : '未設'}</span></td><td>${v.updatedAt ? esc(fmtTime(v.updatedAt)) : '—'}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  el.querySelectorAll('.aliasSel').forEach(sel => {
    sel.onchange = async () => {
      const code = sel.closest('tr').dataset.code, m = el.querySelector('#alMsg');
      sel.disabled = true;
      try { await api('POST', '/admin/alias', { code, system: 'clock', value: sel.value === '__none' ? null : sel.value }); setMsg(m, `${code} 已存檔`, true); }
      catch (er) { setMsg(m, er.message); }
      finally { sel.disabled = false; }
    };
  });
}
