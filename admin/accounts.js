import { esc, busy, setMsg, confirmBox } from '../js/ui.js';
const BRANDS = { mala: '麻的小辛辣', mzt: '墨竹亭', yiwu: '一悟燒肉', cf: '中央廚房', hq: '總部' };

export default async function view({ el, api }) {
  let temp = null;       // { code, pw }：只顯示一次
  let editing = null;
  async function draw() {
    let list;
    try { list = await api('GET', '/admin/accounts'); } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    el.innerHTML = `
      ${temp ? `<div class="note warn" id="tempBox"><b>${esc(temp.code)} 已設為預設密碼 000000，請門市登入後自行更改</b>
        <div class="mt"><button class="btn ghost sm" id="tempDone" type="button">知道了</button></div></div>` : ''}
      <div class="card"><h2>新增帳號</h2><p class="hint">新帳號的密碼是 000000，門市第一次登入時系統會要求自己改。</p>
        <form id="addForm"><div class="grid2">
          <div class="fld"><label for="nCode">門市代號（大寫英數 2-10 碼）</label><input id="nCode" type="text" autocapitalize="characters"></div>
          <div class="fld"><label for="nName">店名</label><input id="nName" type="text"></div>
          <div class="fld"><label for="nBrand">品牌</label><select id="nBrand">${Object.entries(BRANDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div class="fld"><label for="nRole">角色</label><select id="nRole"><option value="store">門市</option><option value="admin">管理者</option></select></div>
        </div><div class="row mt"><button class="btn" id="addBtn" type="submit">新增</button></div><div id="addMsg" class="err" role="alert"></div></form></div>
      <div class="card"><h2>帳號列表</h2><div id="listMsg" class="err" role="alert"></div><div class="scroll"><table id="accTable"><thead><tr><th>代號</th><th>店名</th><th>品牌</th><th>角色</th><th>狀態</th><th>操作</th></tr></thead><tbody>
      ${list.map(a => `<tr data-code="${esc(a.code)}"><td><b>${esc(a.code)}</b></td>
        <td>${editing === a.code ? `<input type="text" class="nameIn" value="${esc(a.name)}" style="min-width:120px">` : esc(a.name)}</td>
        <td>${esc(BRANDS[a.brand] || a.brand)}</td><td>${a.role === 'admin' ? '管理者' : '門市'}</td>
        <td><span class="tag ${a.active ? 'ok' : 'bad'}">${a.active ? '啟用' : '停用'}</span>${a.locked ? ' <span class="tag bad">已鎖定</span>' : ''}${a.mustChangePassword ? ' <span class="tag">待改密碼</span>' : ''}</td>
        <td><div class="row">
          ${editing === a.code ? '<button class="btn sm" data-act="saveName">儲存</button><button class="btn ghost sm" data-act="cancel">取消</button>' : '<button class="btn ghost sm" data-act="rename">改名</button>'}
          <button class="btn ghost sm" data-act="toggle">${a.active ? '停用' : '啟用'}</button>
          ${a.locked ? '<button class="btn ghost sm" data-act="unlock">解鎖</button>' : ''}
          <button class="btn ghost sm" data-act="reset">重設密碼</button></div></td></tr>`).join('')}
      </tbody></table></div></div>`;

    const done = el.querySelector('#tempDone'); if (done) done.onclick = () => { temp = null; draw(); };
    const f = el.querySelector('#addForm');
    f.onsubmit = e => { e.preventDefault(); busy(f.querySelector('#addBtn'), async () => {
      try {
        const code = f.nCode.value.trim().toUpperCase();
        const d = await api('POST', '/admin/accounts', { code, name: f.nName.value.trim(), brand: f.nBrand.value, role: f.nRole.value });
        temp = { code, pw: d.tempPassword }; await draw();
      } catch (er) { setMsg(el.querySelector('#addMsg'), er.message); }
    }); };
    el.querySelectorAll('#accTable button[data-act]').forEach(btn => {
      const tr = btn.closest('tr'), code = tr.dataset.code, a = list.find(x => x.code === code);
      btn.onclick = async () => {
        const act = btn.dataset.act, msg = el.querySelector('#listMsg');
        if (act === 'rename') { editing = code; return draw(); }
        if (act === 'cancel') { editing = null; return draw(); }
        if (act === 'reset' && !(await confirmBox(`確定要重設 ${code} 的密碼？重設後密碼回到 000000，對方目前的登入會被登出。`, '重設'))) return;
        if (act === 'toggle' && a.active && !(await confirmBox(`確定要停用 ${code}？`, '停用'))) return;
        busy(btn, async () => {
          try {
            if (act === 'saveName') { await api('POST', '/admin/accounts/update', { code, name: tr.querySelector('.nameIn').value }); editing = null; }
            if (act === 'toggle') await api('POST', '/admin/accounts/update', { code, active: !a.active });
            if (act === 'unlock') await api('POST', '/admin/accounts/update', { code, unlock: true });
            if (act === 'reset') { const d = await api('POST', '/admin/accounts/reset', { code }); temp = { code, pw: d.tempPassword }; }
            await draw();
          } catch (er) { setMsg(msg, er.message); }
        });
      };
    });
  }
  await draw();
}
