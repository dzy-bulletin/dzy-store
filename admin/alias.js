import { esc, busy, setMsg, fmtTime } from '../js/ui.js';

// 門市對照：每個門市帳號對應哪一家打卡店別（出勤核定要連到打卡系統的哪一店）
export default async function view({ el, api, ui }) {
  let d;
  let um = null;
  try { d = await api('GET', '/admin/alias'); } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  if (ui && ui.sso) { try { um = await api('GET', '/admin/unit-map'); } catch (e) { um = null; } }      // 沒開個人帳號登入（或舊版伺服器）就不顯示這欄
  const unitOf = code => ((um && um.items) || []).find(x => x.code === code);
  const unitCell = code => {      // 管理系統單位下拉：HQ（不是啟用中的門市帳號）不設單位；別家用掉的選項停用並標「已被 XXX 使用」
    if (!((um.stores || []).some(x => x.code === code))) return '<td class="muted">—</td>';
    const cur = (unitOf(code) || {}).unit || '', choices = (um.units || []).slice();
    if (cur && !choices.some(c => c.unit === cur)) choices.push({ unit: cur, label: '（清單以外）' });      // 線上已存但不在清單的值照樣顯示為已選
    return `<td><select class="unitSel" data-old="${esc(cur)}" aria-label="${esc(code)} 管理系統單位"><option value=""${cur ? '' : ' selected'}>（無）</option>
      ${choices.map(c => { const by = ((um.items) || []).find(x => x.unit === c.unit && x.code !== code);
        return `<option value="${esc(c.unit)}"${c.unit === cur ? ' selected' : ''}${by ? ' disabled' : ''}>${esc(c.unit)} ${esc(c.label)}${by ? '（已被 ' + esc(by.code) + ' 使用）' : ''}</option>`; }).join('')}</select></td>`;
  };
  el.innerHTML = `<div class="card"><h2>門市對照</h2>
    <p class="hint">打卡店別：每個門市帳號要連到打卡系統的哪一家店，沒設定的店出勤核定進不去。調撥節點：門市調撥要連到哪個節點。耗損系統店別：墨竹亭四家店選對應店別（共用 mzt-loss 的品項表）；小辛辣等沒對應的選「無」，資料存在營運系統自己的資料庫。</p><div id="alMsg" role="alert" class="err"></div>
    <div class="scroll"><table id="aliasTable"><thead><tr><th>代號</th><th>店名</th><th>打卡店別</th><th>調撥節點</th><th>耗損系統店別</th>${um ? '<th>管理系統單位</th>' : ''}</tr></thead><tbody>
    ${d.aliases.map(a => `<tr data-code="${esc(a.code)}"><td><b>${esc(a.code)}</b></td><td>${esc(a.name)}</td><td>
      <select class="aliasSel" aria-label="${esc(a.code)} 打卡店別"><option value="__none"${a.value === null ? ' selected' : ''}>無</option>
      ${d.stores.map(s => `<option value="${esc(s.value)}"${a.value === s.value ? ' selected' : ''}>${esc(s.label)}${s.value ? '（' + esc(s.value) + '）' : ''}</option>`).join('')}</select></td>
      <td><select class="aliasTrSel" aria-label="${esc(a.code)} 調撥節點"><option value="__none"${!a.transfer ? ' selected' : ''}>無</option>
      ${(d.transferNodes || []).map(n => `<option value="${esc(n.code)}"${a.transfer === n.code ? ' selected' : ''}>${esc(n.code)} ${esc(n.name)}</option>`).join('')}</select></td>
      <td><select class="lossSel" aria-label="${esc(a.code)} 耗損系統店別"><option value="__none"${!(d.lossAliases || {})[a.code] ? ' selected' : ''}>無（用營運系統自有）</option>
      ${(d.lossStores || []).map(s => `<option value="${esc(s.value)}"${(d.lossAliases || {})[a.code] === s.value ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}</select></td>
      ${um ? unitCell(a.code) : ''}</tr>`).join('')}
    </tbody></table></div></div>
    <div class="card"><h2>打卡金鑰代管狀態</h2><p class="hint">只顯示「已設／未設」。金鑰由管理者在公司 Mac mini 終端機輸入，這裡看不到內容。</p>
    <div class="scroll"><table id="vaultTable"><thead><tr><th>打卡店別</th><th>名稱</th><th>狀態</th><th>更新時間</th></tr></thead><tbody>
    ${d.vault.map(v => `<tr data-vault="${esc(v.name)}"><td>${esc(v.label)}</td><td><code>${esc(v.name)}</code></td>
      <td><span class="tag ${v.set ? 'ok' : 'bad'}">${v.set ? '已設' : '未設'}</span></td><td>${v.updatedAt ? esc(fmtTime(v.updatedAt)) : '—'}</td></tr>`).join('')}
    </tbody></table></div></div>
    <div class="card"><h2>調撥門市 pin 代管狀態</h2><p class="hint">門市調撥的各節點 pin 也由管理者在公司 Mac mini 終端機輸入（名稱 transfer:節點代號），這裡只顯示「已設／未設」。</p>
    <div class="scroll"><table id="vaultTrTable"><thead><tr><th>節點</th><th>名稱</th><th>狀態</th><th>更新時間</th></tr></thead><tbody>
    ${(d.transferVault || []).map(v => `<tr data-vault="${esc(v.name)}"><td>${esc(v.label)}</td><td><code>${esc(v.name)}</code></td>
      <td><span class="tag ${v.set ? 'ok' : 'bad'}">${v.set ? '已設' : '未設'}</span></td><td>${v.updatedAt ? esc(fmtTime(v.updatedAt)) : '—'}</td></tr>`).join('')}
    </tbody></table></div></div>
    <div class="card"><h2>叫貨看板帳密代管狀態</h2><p class="hint">登入叫貨看板用的帳號密碼，由管理者在公司 Mac mini 終端機輸入，這裡只顯示「已設／未設」。board:_ 是全部門市共用的一組（總部帳號）：用它的店只看得到看板上自己那一區（「看板店別」）；看板店別空白的店看不到。某家店另存 board:門市代號 就改用它自己的帳號、看到的就是那個帳號的畫面。</p>
    <div class="scroll"><table id="vaultBdTable"><thead><tr><th>門市</th><th>名稱</th><th>看板店別</th><th>狀態</th><th>更新時間</th></tr></thead><tbody>
    ${(d.boardVault || []).map(v => `<tr data-vault="${esc(v.name)}"><td>${esc(v.label)}</td><td><code>${esc(v.name)}</code></td><td>${v.name === 'board:_' ? '—' : esc(v.store || '（無）')}</td>
      <td><span class="tag ${v.set || v.shared ? 'ok' : 'bad'}">${v.set ? '已設' : v.shared ? '用共用' : '未設'}</span></td><td>${v.updatedAt ? esc(fmtTime(v.updatedAt)) : '—'}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  el.querySelectorAll('.unitSel').forEach(sel => {      // 管理系統單位：一家門市對一個單位；選（無）＝取消對照
    sel.onchange = async () => {
      const code = sel.closest('tr').dataset.code, m = el.querySelector('#alMsg'), old = sel.dataset.old, now = sel.value;
      sel.disabled = true;
      try {
        if (old && old !== now) await api('POST', '/admin/unit-map', { unit: old, code: null });
        if (now) {
          try { await api('POST', '/admin/unit-map', { unit: now, code }); }
          catch (er) { if (old && old !== now) { try { await api('POST', '/admin/unit-map', { unit: old, code }); } catch (x) { /* 還原失敗：重新整理會看到真實狀態 */ } } throw er; }
        }
        sel.dataset.old = now; setMsg(m, now ? `${code} 對照管理系統單位 ${now}，已存檔` : `${code} 已取消管理系統單位對照`, true);
      } catch (er) { sel.value = old; setMsg(m, er.message); }
      finally { sel.disabled = false; }
    };
  });
  el.querySelectorAll('.lossSel').forEach(sel => {
    sel.onchange = async () => {
      const code = sel.closest('tr').dataset.code, m = el.querySelector('#alMsg');
      sel.disabled = true;
      try { await api('POST', '/admin/alias', { code, system: 'mzt_loss', value: sel.value === '__none' ? null : sel.value }); setMsg(m, `${code} 耗損系統店別已存檔`, true); }
      catch (er) { setMsg(m, er.message); }
      finally { sel.disabled = false; }
    };
  });
  el.querySelectorAll('.aliasTrSel').forEach(sel => {
    sel.onchange = async () => {
      const code = sel.closest('tr').dataset.code, m = el.querySelector('#alMsg');
      sel.disabled = true;
      try { await api('POST', '/admin/alias', { code, system: 'transfer', value: sel.value === '__none' ? null : sel.value }); setMsg(m, `${code} 調撥節點已存檔`, true); }
      catch (er) { setMsg(m, er.message); }
      finally { sel.disabled = false; }
    };
  });
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
