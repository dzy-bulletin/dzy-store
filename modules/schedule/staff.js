// 自動排班「同仁」分頁：身分（正職／計時，依日期生效）、目標工時、只能上的班、報到日、離職日、生日、手機、特休；不同班配對；帶入實際出勤。
// 姓名與在職從打卡名冊來（有打卡的店）。新同仁一律在這裡「新增同仁」（2026-10-11 合併出勤核定的新進同仁報到）：
// 有打卡的店由伺服器代建打卡帳號（addHire），沒有打卡的店用 local- 編號。不放任何薪資。
import { esc, busy, confirmBox } from '../../js/ui.js';
import { clockLink } from '../duty/calc.js';
import { S, call, load } from './state.js';
import { termAt } from './rules.js';
import { leaveOf } from './calc.js';

export function renderStaff(ctx) {
  const el = ctx.el, D = S.data;
  const shifts = D.shifts.filter((s) => s.active);
  const asOf = D.dates[0];
  const noClock = D.meta.clockAlias === null;
  const card = (st) => {
    const t = termAt(D.terms, st.emp_id, asOf) || {};
    const lv = st.hire_date ? leaveOf(t, st.hire_date, D.today) : null;
    const lvTxt = !lv ? '填報到日期後顯示' : lv.days == null ? `${lv.hours} 小時（照工時比例）` : `${lv.days} 天`;
    const allowed = t.allowed_shifts || [];
    const hist = (D.terms[st.emp_id] || []).length > 1 ? `<div class="hint">身分紀錄：${(D.terms[st.emp_id] || []).map((x) => `${esc(x.from_date)} 起${x.kind === 'ft' ? '正職' : '計時'}`).join('、')}</div>` : '';
    return `<div class="card sc-staff" data-emp="${esc(st.emp_id)}"><div class="row"><h3>${esc(st.name)}</h3><span class="hint">${esc(st.emp_id)}</span>${st.leave_date ? `<span class="tag">${esc(st.leave_date)} 離職</span>` : ''}${!t.kind ? '<span class="tag bad">還沒設正職或計時</span>' : ''}${!st.hire_date && !st.leave_date ? '<span class="tag bad">還沒填報到日期</span>' : ''}</div>
      <div class="grid2">
        <div class="fld"><label>身分</label><select class="f-kind"><option value="">請選擇</option><option value="ft" ${t.kind === 'ft' ? 'selected' : ''}>正職（四週變形）</option><option value="pt" ${t.kind === 'pt' ? 'selected' : ''}>計時（每週一例一休）</option></select></div>
        <div class="fld"><label>身分從哪天開始</label><input type="date" class="f-from" value="${esc(t.from_date && t.from_date > '2026-10-04' ? t.from_date : '')}" placeholder="空白＝一直都是"></div>
        <div class="fld"><label>每期目標工時（小時）</label><input type="number" min="0" max="300" class="f-target" value="${t.target_min != null ? Math.round(t.target_min / 60) : ''}" placeholder="正職預設 160"></div>
        <div class="fld"><label>計時：契約每週工時（小時）</label><input type="number" min="0" max="60" class="f-week" value="${t.week_min != null ? Math.round(t.week_min / 60) : ''}"></div>
        <div class="fld"><label>報到日期</label><input type="date" class="f-hire" value="${esc(st.hire_date || '')}"></div>
        <div class="fld"><label>離職日期</label><input type="date" class="f-leave" value="${esc(st.leave_date || '')}"></div>
        <div class="fld"><label>生日</label><input type="date" class="f-bday" value="${esc(st.birthday || '')}"></div>
        <div class="fld"><label>手機</label><input type="tel" class="f-phone" value="${esc(st.phone || '')}" maxlength="20"></div>
      </div>
      <label class="sc-chk"><input type="checkbox" class="f-same" ${t.same_days ? 'checked' : ''}> 計時但每週上班天數跟正職一樣（特休給完整天數）</label>
      <div class="fld mt"><label>只能上的班（都不勾＝每班都能上）</label><div class="row">${shifts.map((s) => `<label class="sc-chk"><input type="checkbox" class="f-al" value="${esc(s.id)}" ${allowed.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div></div>
      <p class="hint">特休：${lvTxt}</p>${hist}
      <div class="row"><button type="button" class="btn sm f-save">儲存</button><span class="f-msg okmsg" role="status"></span></div></div>`;
  };
  const pairs = D.pairs;
  const nameOf = (e) => (D.staff.find((s) => s.emp_id === e) || {}).name || e;

  const staffMsg = S.staffMsg; S.staffMsg = '';
  const hired = S.hireResult; S.hireResult = null;
  const hiredHtml = !hired ? '' : `<div class="okmsg" id="hiDone" role="status">✓ 已新增 <b>${esc(hired.name)}</b>（編號 ${esc(hired.emp_id)}）${hired.clock ? '，打卡帳號也建好了。請他打開 LINE「鼎兆元打卡」，第一次打卡時<b>人在店裡</b>、輸入全名綁定。' : '。'}
      <br>接著：這一期還沒鎖定就到「班表」按自動排班；已經鎖定要先解除鎖定（要出勤核定密碼，LINE 上那一期會暫時撤下）→ 自動排班 → 沒有紅字再鎖定。</div>
    ${hired.link ? `<details class="mt" id="hiLinkBox"><summary>舊版專屬打卡連結（沒用 LINE 打卡的人才需要）</summary><p class="hint">用 Safari 開 → 加入主畫面，以後都從主畫面進。</p><span class="du-link" id="hiLink">${esc(hired.link)}</span> <button type="button" class="btn sm ghost" id="hiCopy">複製連結</button></details>` : ''}`;
  el.innerHTML = `
  <div class="card"><h2>同仁</h2>
    <p class="hint">${noClock ? '這家店沒有打卡系統，同仁只存在排班裡。' : '姓名與在職跟打卡系統的名冊同步（以打卡的員工編號對人）。'}每個人都要設定正職或計時、填報到日期才能排班。</p>
    ${noClock ? '' : `<div class="row"><button type="button" class="btn ghost" id="stActuals">帶入 10/19–10/31 實際出勤</button><span class="hint">11 月第一期要接著算連續上班天數與換班間隔，排之前按一次。</span></div>`}
    <div id="stMsg" class="okmsg" role="status">${esc(staffMsg || '')}</div></div>
  <div class="card" id="hiCard"><h2>新增同仁</h2>
    <p class="hint">${noClock ? '填好按「新增同仁」就會出現在下面的清單。' : '填好按「新增同仁」，系統會<b>同時在打卡系統建立他的帳號</b>，不用再到「出勤核定 › 員工名冊」做一次。'}報到日之前不會排到他。</p>
    <div class="grid2">
      <div class="fld"><label for="hiName">姓名（全名）</label><input type="text" id="hiName" maxlength="20" autocomplete="off"></div>
      <div class="fld"><label for="hiHire">報到日期（必填）</label><input type="date" id="hiHire"></div>
      <div class="fld"><label for="hiKind">身分</label><select id="hiKind"><option value="">請選擇</option><option value="ft">正職（四週變形）</option><option value="pt">計時（每週一例一休）</option></select></div>
      <div class="fld"><label for="hiTarget">每期目標工時（小時）</label><input type="number" min="0" max="300" id="hiTarget" placeholder="正職預設 160"></div>
      <div class="fld"><label for="hiWeek">計時：契約每週工時（小時）</label><input type="number" min="0" max="60" id="hiWeek"></div>
      <div class="fld"><label for="hiBday">生日</label><input type="date" id="hiBday"></div>
      <div class="fld"><label for="hiPhone">手機</label><input type="tel" id="hiPhone" maxlength="20"></div>
    </div>
    <label class="sc-chk"><input type="checkbox" id="hiSame"> 計時但每週上班天數跟正職一樣（特休給完整天數）</label>
    <div class="fld mt"><label>只能上的班（都不勾＝每班都能上）</label><div class="row">${shifts.map((s) => `<label class="sc-chk"><input type="checkbox" class="hi-al" value="${esc(s.id)}"> ${esc(s.name)}</label>`).join('')}</div></div>
    <div class="row mt"><button type="button" class="btn" id="hiAdd">新增同仁</button></div>
    <div id="hiMsg" class="okmsg" role="status"></div>${hiredHtml}</div>
  ${D.staff.map(card).join('')}
  <div class="card"><h2>不要排在同一班的兩個人</h2>
    <div class="row"><select id="prA" aria-label="第一個人">${D.staff.map((s) => `<option value="${esc(s.emp_id)}">${esc(s.name)}</option>`).join('')}</select>
    <select id="prB" aria-label="第二個人">${D.staff.map((s, i) => `<option value="${esc(s.emp_id)}" ${i === 1 ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
    <button type="button" class="btn" id="prAdd">加入</button></div>
    <div class="mt">${pairs.length ? pairs.map((p, i) => `<div class="du-item"><span class="du-item-body">${esc(nameOf(p[0]))} ／ ${esc(nameOf(p[1]))}</span><button type="button" class="btn sm ghost pr-del" data-i="${i}">移除</button></div>`).join('') : '<p class="hint">目前沒有設定。</p>'}</div>
    <div id="prMsg" class="okmsg" role="status"></div></div>`;

  const q = (s) => el.querySelector(s);
  const say = (box, t, bad) => { box.className = (box.classList.contains('f-msg') ? 'f-msg ' : '') + (bad ? 'err' : 'okmsg'); box.textContent = t; };
  const hrs = (v) => (v === '' ? null : Math.round(Number(v) * 60));

  el.querySelectorAll('.sc-staff').forEach((c) => {
    const f = (s) => c.querySelector(s);
    f('.f-save').onclick = () => busy(f('.f-save'), async () => {
      const emp = c.dataset.emp;
      try {
        await call('saveStaff', { staff: { emp_id: emp, hire_date: f('.f-hire').value || null, leave_date: f('.f-leave').value || null, birthday: f('.f-bday').value || null, phone: f('.f-phone').value || null } });
        if (f('.f-kind').value) await call('saveTerm', { term: { emp_id: emp, from_date: f('.f-from').value || null, kind: f('.f-kind').value, target_min: hrs(f('.f-target').value), week_min: hrs(f('.f-week').value), same_days: f('.f-same').checked, allowed_shifts: [...c.querySelectorAll('.f-al:checked')].map((x) => x.value) } });
        await load(); ctx.rerender();
      } catch (e) { say(f('.f-msg'), e.message, true); }
    });
  });
  q('#hiAdd').onclick = () => busy(q('#hiAdd'), async () => {
    const box = q('#hiMsg');
    const name = q('#hiName').value.trim();
    if (!name) { say(box, '請先輸入姓名', true); return q('#hiName').focus(); }
    if (!q('#hiHire').value) { say(box, '請填報到日期（報到日前不會排班）', true); return q('#hiHire').focus(); }
    if (!q('#hiKind').value) { say(box, '請選正職或計時', true); return q('#hiKind').focus(); }
    const dup = D.staff.find((x) => x.name === name && (!x.leave_date || x.leave_date >= D.today));
    if (dup) { say(box, `同仁清單已經有在職的「${name}」（編號 ${dup.emp_id}）。真的是不同人請改用可區分的名字（例如加姓氏或括號）。`, true); return q('#hiName').focus(); }
    if (!noClock && !(await confirmBox(`要新增「${name}」嗎？\n會同時在打卡系統建立他的帳號，他就能開始打卡。`, '新增'))) return;
    try {
      const r = await call('addHire', { hire: { name, hire_date: q('#hiHire').value, kind: q('#hiKind').value, target_min: hrs(q('#hiTarget').value), week_min: hrs(q('#hiWeek').value),
        same_days: q('#hiSame').checked, birthday: q('#hiBday').value || null, phone: q('#hiPhone').value || null, allowed_shifts: [...el.querySelectorAll('.hi-al:checked')].map((x) => x.value) } });
      S.hireResult = { name: r.name, emp_id: r.emp_id, clock: r.clock, link: r.clock && r.key ? clockLink(r.clockStore, r.key) : '' };
      await load(); ctx.rerender();
    } catch (e) { say(box, e.code === 'NOT_FOUND' ? '伺服器還沒更新到這個功能，請先到「出勤核定 › 員工名冊」建打卡帳號，再回來補報到日與身分。' : e.message, true); }
  });
  if (q('#hiCopy')) q('#hiCopy').onclick = () => {
    const cp = q('#hiCopy'), link = q('#hiLink').textContent;
    const done = () => { cp.textContent = '✓ 已複製'; setTimeout(() => { cp.textContent = '複製連結'; }, 2000); };
    const fallback = () => { const r = document.createRange(); r.selectNodeContents(q('#hiLink')); const sl = getSelection(); sl.removeAllRanges(); sl.addRange(r); cp.textContent = '已選取，請長按複製'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, fallback); else fallback();
  };
  if (q('#stActuals')) q('#stActuals').onclick = () => busy(q('#stActuals'), async () => {
    try { const r = await call('importActuals', {}); await load(); S.staffMsg = `已帶入 ${r.from}～${r.to} 的實際出勤，共 ${r.rows} 筆`; ctx.rerender(); }
    catch (e) { say(q('#stMsg'), e.message, true); }
  });
  const savePairs = async (list) => { await call('savePairs', { pairs: list }); await load(); ctx.rerender(); };
  q('#prAdd').onclick = () => busy(q('#prAdd'), async () => {
    const a = q('#prA').value, b = q('#prB').value;
    try { await savePairs(pairs.concat([[a, b]])); } catch (e) { say(q('#prMsg'), e.message, true); }
  });
  el.querySelectorAll('.pr-del').forEach((b) => {
    b.onclick = () => busy(b, async () => {
      if (!(await confirmBox('移除這一組設定？', '移除'))) return;
      try { await savePairs(pairs.filter((_, i) => i !== Number(b.dataset.i))); } catch (e) { say(q('#prMsg'), e.message, true); }
    });
  });
}
