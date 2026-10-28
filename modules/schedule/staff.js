// 自動排班「同仁」分頁：身分（正職／計時，依日期生效）、目標工時、只能上的班、報到日、離職日、生日、手機、特休；不同班配對；帶入實際出勤。
// 姓名與在職從打卡名冊來（有打卡的店）。新同仁一律在這裡「新增同仁」（2026-10-11 合併出勤核定的新進同仁報到）：
// 有打卡的店由伺服器代建打卡帳號（addHire），沒有打卡的店用 local- 編號。不放任何薪資。
import { esc, busy, confirmBox } from '../../js/ui.js';
import { DZY_ORIGIN } from '../../js/config.js';
import { clockLink } from '../duty/calc.js';
import { S, call, load } from './state.js';
import { termAt } from './rules.js';
import { leaveOf } from './calc.js';

export function renderStaff(ctx) {
  const el = ctx.el, D = S.data;
  const shifts = D.shifts.filter((s) => s.active);
  const stations = D.stations || [];                            // 預設站別（工作站別）：店裡沒有任何站別就不顯示這一欄
  const asOf = D.dates[0];
  const noClock = D.meta.clockAlias === null;
  const noDuty = !noClock && D.meta.dutyOn === false;          // 有打卡但沒開出勤核定：不同步名冊、不能帶入實際出勤、不能新增（要先開出勤核定）
  const card = (st) => {
    // 期中才報到的人，身分通常從報到日起算：要用報到日去找，不然期首那天找不到、卡片誤標「還沒設正職或計時」（2026-10-27 林秀縈：10/12 報到、身分 10/12 起，看 T00＝10/4 起時被誤標）
    const eff = termAt(D.terms, st.emp_id, st.hire_date && st.hire_date > asOf ? st.hire_date : asOf) || {};
    // 同一人可以有好幾筆身分設定（依日期生效）：選單選哪一筆就編哪一筆；預設是這期生效的那筆（2026-10-28 Eason）
    const list = D.terms[st.emp_id] || [];
    const sel = (S.termSel || {})[st.emp_id] || eff.from_date || '';
    const isNew = sel === '__new';
    // 卡片標題的標籤（還沒設身分、備援）一律看「這期生效」那筆，不跟著選單選到的那筆跑（2026-10-28 Eason）
    const t = isNew ? Object.assign({}, eff, { from_date: null }) : (list.find((x) => x.from_date === sel) || eff);
    const lv = st.hire_date ? leaveOf(t, st.hire_date, D.today) : null;
    const lvTxt = !lv ? '填報到日期後顯示' : lv.days == null ? `${lv.hours} 小時（照工時比例）` : `${lv.days} 天`;
    const allowed = t.allowed_shifts || [], allowedHol = t.allowed_shifts_hol || [];
    const termLabel = (x) => `${x.from_date <= '2026-10-04' ? '一開始' : x.from_date + ' 起'}：${x.kind === 'ft' ? '正職' : '計時'}${x.kind === 'pt' && x.backup ? '・備援' : ''}${(x.allowed_shifts || []).length ? '・平日限班' : ''}${(x.allowed_shifts_hol || []).length ? '・假日限班' : ''}`;
    const hist = list.length ? `<div class="fld"><label>身分設定（依日期生效，選一筆來看或修改）</label><div class="row"><select class="f-term">${list.map((x) => `<option value="${esc(x.from_date)}" ${x.from_date === sel ? 'selected' : ''}>${esc(termLabel(x))}${x === eff ? '（這期生效）' : ''}</option>`).join('')}<option value="__new" ${isNew ? 'selected' : ''}>＋ 從某天起改設定（新增一筆）</option></select>${list.length > 1 && !isNew && sel !== list[0].from_date ? '<button type="button" class="btn sm ghost f-tdel">刪除這筆</button>' : ''}</div>${isNew ? '<p class="hint">新增一筆：請在「身分從哪天開始」填日期，那天起改用下面的設定，之前照舊。</p>' : ''}</div>` : '';
    return `<div class="card sc-staff" data-emp="${esc(st.emp_id)}"><div class="row"><h3>${esc(st.name)}</h3><span class="hint">${esc(st.emp_id)}</span>${st.leave_date ? `<span class="tag">${esc(st.leave_date)} 離職</span>` : ''}${!eff.kind ? '<span class="tag bad">還沒設正職或計時</span>' : ''}${!st.hire_date && !st.leave_date ? '<span class="tag bad">還沒填報到日期</span>' : ''}${eff.kind === 'pt' && eff.backup ? '<span class="tag">備援</span>' : ''}</div>
      ${hist}
      <div class="grid2">
        <div class="fld"><label>身分</label><select class="f-kind"><option value="">請選擇</option><option value="ft" ${t.kind === 'ft' ? 'selected' : ''}>正職（四週變形）</option><option value="pt" ${t.kind === 'pt' ? 'selected' : ''}>計時（每週一例一休）</option></select></div>
        <div class="fld"><label>身分從哪天開始</label><input type="date" class="f-from" value="${esc(t.from_date && t.from_date > '2026-10-04' ? t.from_date : '')}"${list.length && !isNew ? ' readonly title="要換日期：選「＋ 從某天起改設定」新增一筆，再刪掉這筆"' : ''} placeholder="空白＝一直都是"></div>
        <div class="fld"><label>每期目標工時（小時）</label><input type="number" min="0" max="300" class="f-target" value="${t.target_min != null ? Math.round(t.target_min / 60) : ''}" placeholder="正職預設 160"></div>
        <div class="fld"><label>計時：契約每週工時（小時）</label><input type="number" min="0" max="60" class="f-week" value="${t.week_min != null ? Math.round(t.week_min / 60) : ''}"></div>
        <div class="fld"><label>報到日期</label><input type="date" class="f-hire" value="${esc(st.hire_date || '')}"></div>
        <div class="fld"><label>離職日期</label><input type="date" class="f-leave" value="${esc(st.leave_date || '')}"></div>
        <div class="fld"><label>生日</label><input type="date" class="f-bday" value="${esc(st.birthday || '')}"></div>
        <div class="fld"><label>手機</label><input type="tel" class="f-phone" value="${esc(st.phone || '')}" maxlength="20"></div>
      </div>
      <label class="sc-chk"><input type="checkbox" class="f-same" ${t.same_days ? 'checked' : ''}> 計時但每週上班天數跟正職一樣（特休給完整天數）</label>
      <label class="sc-chk f-bkbox"${t.kind === 'pt' ? '' : ' hidden'}><input type="checkbox" class="f-bk" ${t.kind === 'pt' && t.backup ? 'checked' : ''}> 備援：其他同仁都排不開才排他（只限計時；自動排班先不排他，哪天缺人才叫他補）</label>
      <div class="fld mt"><label>平日只能上的班（都不勾＝每班都能上）</label><div class="row">${shifts.map((s) => `<label class="sc-chk"><input type="checkbox" class="f-al" value="${esc(s.id)}" ${allowed.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div></div>
      <div class="fld mt"><label>假日只能上的班（六日、國定假日、補假；都不勾＝跟平日一樣）</label><div class="row">${shifts.map((s) => `<label class="sc-chk"><input type="checkbox" class="f-alh" value="${esc(s.id)}" ${allowedHol.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div></div>
      ${stations.length ? `<div class="fld mt"><label>預設站別（新排的上班日自動帶入，班表上可以再改）</label><select class="f-dst"><option value="">不設</option>${
        stations.filter((x) => x.active || x.id === st.default_station).map((x) => `<option value="${esc(x.id)}" ${x.id === st.default_station ? 'selected' : ''}>${esc(x.name)}${x.active ? '' : '（已停用）'}</option>`).join('')}</select></div>` : ''}
      <div class="grid2 mt">
        <div class="fld"><label>排班順位（1 最優先，空白＝不設）</label><input type="number" min="1" max="99" step="1" class="f-prio" value="${st.prio != null ? esc(st.prio) : ''}"></div>
        <div class="fld"><label>優先班別（順位前面的人先拿到）</label><select class="f-pref"><option value="">不設</option>${D.shifts.filter((x) => x.active || x.id === st.pref_shift).map((x) => `<option value="${esc(x.id)}" ${x.id === st.pref_shift ? 'selected' : ''}>${esc(x.name)}${x.active ? '' : '（已停用）'}</option>`).join('')}</select></div>
      </div>
      <p class="hint">特休：${lvTxt}</p>
      <div class="row"><button type="button" class="btn sm f-save">儲存</button><span class="f-msg okmsg" role="status"></span></div></div>`;
  };
  const pairs = D.pairs;
  // 離職同仁（離職日＝最後上班日已過；名冊 active=false 同步時也是寫成昨天）收到最下方、預設收合；離職日還沒到的仍算在職留在上面
  const isLeft = (st) => !!st.leave_date && st.leave_date < D.today;
  const onJob = D.staff.filter((st) => !isLeft(st)), gone = D.staff.filter(isLeft);
  const nameOf = (e) => (D.staff.find((s) => s.emp_id === e) || {}).name || e;

  const staffMsg = S.staffMsg; S.staffMsg = '';
  const hired = S.hireResult; S.hireResult = null;
  const hiredHtml = !hired ? '' : `<div class="okmsg" id="hiDone" role="status">✓ 已新增 <b>${esc(hired.name)}</b>（編號 ${esc(hired.emp_id)}）${hired.clock ? '，打卡帳號也建好了。請他打開 LINE「鼎兆元打卡」，第一次打卡時<b>人在店裡</b>、輸入全名綁定。' : '。'}
      <br>這是備案新增：請通知總部到管理系統把他建檔，他才能認領管理系統帳號。
      <br>接著：這一期還沒鎖定就到「班表」按自動排班；已經鎖定要先解除鎖定（LINE 上那一期會暫時撤下）→ 自動排班 → 沒有紅字再鎖定。</div>
    ${hired.link ? `<details class="mt" id="hiLinkBox"><summary>舊版專屬打卡連結（沒用 LINE 打卡的人才需要）</summary><p class="hint">用 Safari 開 → 加入主畫面，以後都從主畫面進。</p><span class="du-link" id="hiLink">${esc(hired.link)}</span> <button type="button" class="btn sm ghost" id="hiCopy">複製連結</button></details>` : ''}`;
  el.innerHTML = `
  <div class="card"><h2>同仁</h2>
    <p class="hint">${noClock ? '這家店沒有打卡系統，同仁只存在排班裡。' : noDuty ? '這家店還沒開通「出勤核定」，同仁名單不會跟打卡系統同步，也不能新增同仁；需要的話請管理者開通。' : '姓名與在職跟打卡系統的名冊同步（以打卡的員工編號對人）。'}每個人都要設定正職或計時、填報到日期才能排班。</p>
    ${noClock || noDuty ? '' : `<div class="row"><button type="button" class="btn ghost" id="stActuals">帶入 10/19–10/31 實際出勤</button><span class="hint">11 月第一期要接著算連續上班天數與換班間隔，排之前按一次。</span></div>`}
    <div id="stMsg" class="okmsg" role="status">${esc(staffMsg || '')}</div></div>
  <div class="card" id="hiCard"><h2>新增同仁</h2>
    <div class="row"><a class="btn" id="hiDzy" href="${DZY_ORIGIN}/#/staff" target="_blank" rel="noopener">到管理系統新增（建議）</a></div>
    <p class="hint">新同仁請在管理系統新增，會同時建好打卡帳號與管理系統帳號，本人當天就能認領。</p>
    ${hiredHtml}
    <details class="fb-box" id="hiFallback"><summary>管理系統連不上時才用（備案）</summary>
    <div class="note warn mt" id="hiWarn">這裡新增只會建打卡帳號；新人要等總部在管理系統建檔後才能認領帳號，請事後通知總部。</div>
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
    <label class="sc-chk" id="hiBkBox" hidden><input type="checkbox" id="hiBk"> 備援：其他同仁都排不開才排他（只限計時）</label>
    <div class="fld mt"><label>平日只能上的班（都不勾＝每班都能上）</label><div class="row">${shifts.map((s) => `<label class="sc-chk"><input type="checkbox" class="hi-al" value="${esc(s.id)}"> ${esc(s.name)}</label>`).join('')}</div></div>
    <div class="fld mt"><label>假日只能上的班（六日、國定假日、補假；都不勾＝跟平日一樣）</label><div class="row">${shifts.map((s) => `<label class="sc-chk"><input type="checkbox" class="hi-alh" value="${esc(s.id)}"> ${esc(s.name)}</label>`).join('')}</div></div>
    <div class="row mt"><button type="button" class="btn" id="hiAdd">新增同仁</button></div>
    <div id="hiMsg" class="okmsg" role="status"></div></details></div>
  ${onJob.map(card).join('')}
  ${gone.length ? `<details class="sc-left" id="stLeft"${S.leftOpen ? ' open' : ''}><summary>離職同仁（${gone.length} 人）</summary>${gone.map(card).join('')}</details>` : ''}
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
    f('.f-kind').onchange = () => { f('.f-bkbox').hidden = f('.f-kind').value !== 'pt'; };   // 備援只限計時
    if (f('.f-term')) f('.f-term').onchange = () => { S.termSel = S.termSel || {}; S.termSel[c.dataset.emp] = f('.f-term').value; ctx.rerender(); };
    if (f('.f-tdel')) f('.f-tdel').onclick = () => busy(f('.f-tdel'), async () => {
      const from = f('.f-term').value;
      if (!(await confirmBox(`刪除「${f('.f-term').selectedOptions[0].textContent}」這筆身分設定？\n刪掉後那段日子改用前一筆的設定。`, '刪除'))) return;
      try { await call('deleteTerm', { emp_id: c.dataset.emp, from_date: from }); S.termSel = S.termSel || {}; delete S.termSel[c.dataset.emp]; await load(); ctx.rerender(); }
      catch (e) { say(f('.f-msg'), e.message, true); }
    });
    f('.f-save').onclick = () => busy(f('.f-save'), async () => {
      const emp = c.dataset.emp;
      try {
        const newTerm = f('.f-term') && f('.f-term').value === '__new';
        if (newTerm && !f('.f-from').value) { say(f('.f-msg'), '新增一筆身分設定：請填「身分從哪天開始」', true); f('.f-from').focus(); return; }
        await call('saveStaff', { staff: { emp_id: emp, hire_date: f('.f-hire').value || null, leave_date: f('.f-leave').value || null, birthday: f('.f-bday').value || null, phone: f('.f-phone').value || null, ...(f('.f-dst') ? { default_station: f('.f-dst').value || null } : {}),
          prio: f('.f-prio').value === '' ? null : Number(f('.f-prio').value), pref_shift: f('.f-pref').value || null } });
        const kind = f('.f-kind').value;
        // 既有那筆：開始日不能在這裡改（改了等於新增一筆、舊的還在，Codex 審查），一律存回選到的那筆
        const fromDate = f('.f-term') && !newTerm ? f('.f-term').value : (f('.f-from').value || null);
        try {
          if (kind) await call('saveTerm', { term: { emp_id: emp, from_date: fromDate, kind, target_min: hrs(f('.f-target').value), week_min: hrs(f('.f-week').value), same_days: f('.f-same').checked, allowed_shifts: [...c.querySelectorAll('.f-al:checked')].map((x) => x.value),
          allowed_shifts_hol: [...c.querySelectorAll('.f-alh:checked')].map((x) => x.value), backup: kind === 'pt' && f('.f-bk').checked } });
        } catch (e) { throw new Error(`排班順位、報到日等已存；身分設定沒存：${e.message}`); }   // 兩段存檔不是一次完成，講清楚哪些已存（Codex 審查）
        // 沒選身分：其他欄位照存，但要講清楚身分還沒存（2026-10-27 林秀縈：紅標還在、又沒提示，看起來像存失敗）
        if (kind) { S.termSel = S.termSel || {}; S.termSel[emp] = fromDate || undefined; }
        S.staffSaved = { emp, bad: !kind, text: kind ? '✓ 已儲存' : '報到日、生日等資料已存。身分還沒設定：請在「身分」選正職或計時再按一次儲存，才排得進班表（開始日期可空白＝一直都是）。' };
        await load(); ctx.rerender();
      } catch (e) { say(f('.f-msg'), e.message, true); }
    });
  });
  const saved = S.staffSaved; S.staffSaved = null;
  const sc = saved && [...el.querySelectorAll('.sc-staff')].find((c) => c.dataset.emp === saved.emp);
  if (sc) {
    say(sc.querySelector('.f-msg'), saved.text, saved.bad);
    if (saved.bad) { sc.querySelector('.f-kind').focus(); sc.scrollIntoView({ block: 'center' }); }
  }
  q('#hiKind').onchange = () => { q('#hiBkBox').hidden = q('#hiKind').value !== 'pt'; };   // 備援只限計時
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
        same_days: q('#hiSame').checked, birthday: q('#hiBday').value || null, phone: q('#hiPhone').value || null, allowed_shifts: [...el.querySelectorAll('.hi-al:checked')].map((x) => x.value),
        allowed_shifts_hol: [...el.querySelectorAll('.hi-alh:checked')].map((x) => x.value), backup: q('#hiKind').value === 'pt' && q('#hiBk').checked } });
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
  if (q('#stLeft')) q('#stLeft').ontoggle = () => { S.leftOpen = q('#stLeft').open; };   // 在收合區裡按儲存重畫後維持展開
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
