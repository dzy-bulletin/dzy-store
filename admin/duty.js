import { esc, busy, setMsg, confirmBox } from '../js/ui.js';

export default async function view({ el, api }) {
  let list;
  try { list = await api('GET', '/admin/accounts'); } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const opts = list.map(a => `<option value="${esc(a.code)}">${esc(a.code)} ${esc(a.name)}</option>`).join('');
  el.innerHTML = `<div class="card" style="max-width:520px"><h2>值班核定密碼</h2>
    <p class="hint">每店第一次的核定密碼是 0000，門市第一次進「值班核定」時系統會要求改成自己的。門市忘記時，在這裡「重設為 0000」。</p>
    <div class="fld"><label for="drCode">門市</label><select id="drCode">${opts}</select></div>
    <div class="row mt"><button class="btn" id="drBtn" type="button">重設為 0000</button></div><div id="drMsg" role="alert" class="err"></div></div>
    <details id="dpAdv" class="card" style="max-width:520px"><summary><b>進階：直接指定新的核定密碼</b></summary>
    <p class="hint mt">一般不需要。設定後門市直接用這組進入，不會被要求再改。至少 4 碼。</p>
    <form id="dpForm"><div class="fld"><label for="dpCode">門市</label><select id="dpCode">${opts}</select></div>
    <div class="fld mt"><label for="dpPw">新的核定密碼</label><input id="dpPw" type="text" autocomplete="off"></div>
    <div class="row mt"><button class="btn ghost" id="dpBtn" type="submit">設定</button></div><div id="dpMsg" role="alert" class="err"></div></form></details>`;
  const drBtn = el.querySelector('#drBtn');
  drBtn.onclick = async () => {
    const code = el.querySelector('#drCode').value, m = el.querySelector('#drMsg');
    if (!(await confirmBox(`確定要把 ${code} 的值班核定密碼重設為 0000？目前已進入核定的人會被要求重新輸入。`, '重設'))) return;
    busy(drBtn, async () => {
      try { await api('POST', '/admin/duty-pass/reset', { code }); setMsg(m, `${code} 的核定密碼已重設為 0000，門市下次進入時要自己改`, true); }
      catch (er) { setMsg(m, er.message); }
    });
  };
  const f = el.querySelector('#dpForm');
  f.onsubmit = e => { e.preventDefault(); busy(f.querySelector('#dpBtn'), async () => {
    const m = el.querySelector('#dpMsg');
    try { await api('POST', '/admin/duty-pass', { code: f.dpCode.value, password: f.dpPw.value }); f.dpPw.value = ''; setMsg(m, `${f.dpCode.value} 的核定密碼已更新`, true); }
    catch (er) { setMsg(m, er.message); }
  }); };
}
