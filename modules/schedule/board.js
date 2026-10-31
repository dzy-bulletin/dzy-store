// 自動排班「班表」分頁：整期格子（桌機）／單日清單（手機）、營業額與工時比、每班人數、檢查結果、自動排班、鎖定與發布。
import { esc, busy, confirmBox } from '../../js/ui.js';
import { timeText, segsOf, shiftMinutes, shiftCode } from './hours.js';
import { api } from '../../js/api.js';
import { S, canEdit, loadAnnual, load, mutate, movePeriod, WD, md, hm, DAY_LABEL, LEAVE_LABEL, call } from './state.js';
import { weekday, periodEnd, todayTaipei } from './period.js';
import { termAt, LEAVES, NOTE_COLORS } from './rules.js';
import { stHidden, setStHidden, stToggleHtml } from './stview.js';
import { setupChecklist } from './checklist.js';
import { getSession } from '../../js/auth.js';

const PUB_TEXT = { pending: '等待送到 LINE', sent: '已發布到 LINE', failed: '送 LINE 失敗', stale: '已被較新版本取代' };

function cellText(c, shifts) {
  if (!c) return { t: '', cls: 'empty' };
  if (c.shift_id) { const s = shifts[c.shift_id]; return { t: s ? shiftCode(s.name) : c.shift_id, cls: 'work' + (c.day_type === 'H' ? ' ot' : ''), ot: c.day_type === 'H' }; }
  if (c.day_type === 'L') return { t: LEAVE_LABEL[c.leave] || '假', cls: 'leave' };
  if (c.day_type === 'W') return { t: '?', cls: 'empty' };
  return { t: DAY_LABEL[c.day_type] || '', cls: c.day_type === 'R' ? 'rest' : 'off' };
}
const LV_RANK = { block: 0, warn: 1, info: 2 };
// 休息日加班特別標示（Eason 2026-10-27：正職連上 12 天裡含的休息日加班、計時第 6 天都要一眼看得出來）
const otTag = (x) => (x.ot ? '<i class="sc-ot">休加</i>' : '');

export function renderBoard(ctx) {
  const el = ctx.el, D = S.data;
  const shifts = Object.fromEntries(D.shifts.map((s) => [s.id, s]));
  const activeShifts = D.shifts.filter((s) => s.active);
  const staff = D.staff.filter((st) => D.dates.some((d) => (!st.hire_date || st.hire_date <= d) && (!st.leave_date || d <= st.leave_date)));
  const locked = D.meta.locked;
  const ses = ctx.session || getSession();
  const canLock = canEdit(ses);       // 個人登入：排班、鎖定、解鎖、重送都只有店長同等職、人資主管、管理員（伺服器另外擋，這裡只是不顯示）
  const byCell = {}, byDay = {};
  for (const r of D.results) {
    if (r.emp_id && r.date) (byCell[r.emp_id + '|' + r.date] = byCell[r.emp_id + '|' + r.date] || []).push(r);
    else if (r.date && !r.emp_id) (byDay[r.date] = byDay[r.date] || []).push(r);
  }
  const counts = { block: 0, warn: 0, info: 0 };
  D.results.forEach((r) => { counts[r.level]++; });
  const target = D.cfg && D.cfg.ratio_target;
  // 工作站別（station-spec §7）：店裡沒有任何站別就完全不畫站別相關的東西（現有畫面零變化）。stMap 含停用的站（舊格子照樣顯示）。
  const stList = D.stations || [], stMap = Object.fromEntries(stList.map((x) => [x.id, x]));
  const stActive = stList.filter((x) => x.active);
  // 「隱藏工作站」（Eason 2026-10-27）：只藏格子小標與各站人數（stShow），鎖定判斷、改站別面板照用 stActive
  const hideSt = stHidden(), stShow = hideSt ? [] : stActive;
  const stTag = (c) => {
    if (hideSt || !c || !c.shift_id) return '';
    const x = c.station_id && stMap[c.station_id];
    if (x) return `<small class="sc-sn${x.active ? '' : ' off'}" data-station="${esc(x.id)}"${x.color ? ` style="color:${esc(x.color)}"` : ''}>${esc(x.name)}</small>`;
    return '';   // 沒選站＝空白（2026-10-31 Eason：只顯示有指定的工作站；2026-11-01 起也不列入提醒）
  };
  const narrow = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
  const view = S.view || (narrow ? 'day' : 'grid');
  if (!S.day || !D.dates.includes(S.day)) S.day = D.dates.includes(D.today) ? D.today : D.dates[0];
  const pub = D.meta.publication;
  const bday = (st, d) => st.birthday && st.birthday.slice(5) === d.slice(5);
  // 六日、同仁生日各有底色（Eason 2026-10-12）
  // 假日淡紅底（Eason 2026-10-12）：照人事行政總處辦公日曆——六日（補行上班的週六除外）、國定假日、補假
  const gov = D.holidays.gov || { off: {}, work: [] };
  const govOff = (d) => (gov.off || {})[d] || '';
  const isWe = (d) => { const w = weekday(d); return ((w === 0 || w === 6) && !(gov.work || []).includes(d)) || !!D.holidays.days[d] || !!govOff(d); };
  // 本期休假天數＝例假＋休息日（沒出勤）＋請假；請假另外分列（Eason 2026-10-12）
  const offOf = (st) => {
    let n = 0; const lv = {};
    for (const d of D.dates) {
      if ((st.hire_date && st.hire_date > d) || (st.leave_date && d > st.leave_date)) continue;
      const c = (D.days[st.emp_id] || {})[d];
      if (!c || c.shift_id) continue;
      if (c.day_type === 'R' || c.day_type === 'H') n++;
      else if (c.day_type === 'L') { n++; const k = LEAVE_LABEL[c.leave] || '假'; lv[k] = (lv[k] || 0) + 1; }
    }
    return { n, lv };
  };
  // 本期排班時數（2026-10-31 Eason：休假天數右邊加一欄；小時用小數，149:30 → 149.5）：在職日有排班的格子，照班別扣掉休息後的工時加總（含休息日加班）
  const hoursOf = (st) => D.dates.reduce((a, d) => { const c = (D.days[st.emp_id] || {})[d], s = c && c.shift_id && shifts[c.shift_id]; return a + (s && inJobOn(st, d) ? shiftMinutes(s) : 0); }, 0);
  // 名字下方的剩餘特休：薪資系統的餘額（S.annual，另外抓；計時或拿不到就不顯示）
  loadAnnual(ctx.rerender);
  // 剩餘特休是薪資系統的數字，要等那天過了、考勤核定才扣；班表上今天起已排的特休另外標出來（2026-10-31 Eason：排了 1 天怎麼還是 7 天）
  const annualPlanned = (st) => D.dates.filter((d) => d >= todayTaipei() && inJobOn(st, d) && ((D.days[st.emp_id] || {})[d] || {}).day_type === 'L' && D.days[st.emp_id][d].leave === '特').length;
  const annualTxt = (st) => { const a = S.annual && S.annual[st.emp_id]; if (a == null) return ''; const n = annualPlanned(st); return `<small class="sc-al">特休剩 ${a} 天${n ? `（本期排 ${n} 天）` : ''}</small>`; };

  const ratioCls = (r) => (r == null || !target ? '' : r < target ? ' low' : ' good');
  // 當天總人數（Eason 2026-10-11：不分班別，只看當天幾個人上班）；需要人數＝各班最少人數加總
  const dayTotal = (d) => staff.filter((st) => (!st.hire_date || st.hire_date <= d) && (!st.leave_date || d <= st.leave_date) && ((D.days[st.emp_id] || {})[d] || {}).shift_id).length;
  const inJobOn = (st, d) => (!st.hire_date || st.hire_date <= d) && (!st.leave_date || d <= st.leave_date);
  // 當天排定總工時（2026-11-01 Eason：當天人數下方一列）：在職、有排班的人照班別扣掉休息後的工時加總，跟右邊「排班時數」同一套算法
  const dayMin = (d) => staff.reduce((a, st) => { const c = (D.days[st.emp_id] || {})[d], s = c && c.shift_id && shifts[c.shift_id]; return a + (s && inJobOn(st, d) ? shiftMinutes(s) : 0); }, 0);
  const hrTxt = (min) => +(min / 60).toFixed(2);
  const stCount = (d, id) => staff.filter((st) => inJobOn(st, d) && ((D.days[st.emp_id] || {})[d] || {}).station_id === id && ((D.days[st.emp_id] || {})[d] || {}).shift_id).length;
  const stNeed = (d, id) => ((D.stationNeed || {})[d] || {})[id] || 0;
  // 統計列只列有設最少人數的站（這期任一天有設）；沒設的站（例：收班）只在格子上顯示站名，不另列一排人數（2026-10-31 Eason）
  const stCntShow = stShow.filter((x) => D.dates.some((d) => stNeed(d, x.id) > 0));
  const dayNeed = (d) => Object.values(D.demand[d] || {}).reduce((a, x) => a + (x.min || 0), 0);
  // 當天人數只顯示早／晚（2026-10-31 Eason）：照上班時間分、不看班名——早＝15:00 以前開始，晚＝18:00 以後才結束（含跨夜）；二段班、整天班兩邊都算
  const isEarly = (s) => segsOf(s)[0].start < '15:00';
  const isLate = (s) => { const g = segsOf(s), last = g[g.length - 1]; return last.end > '18:00' || last.end <= g[0].start; };
  const dayEL = (d) => { let e = 0, l = 0; for (const st of staff) { const c = (D.days[st.emp_id] || {})[d] || {}, s = c.shift_id && shifts[c.shift_id]; if (!s || !inJobOn(st, d)) continue; if (isEarly(s)) e++; if (isLate(s)) l++; } return { e, l }; };
  // 每天的午餐／晚餐備註（全店共用，Eason 2026-10-26）：放在日期下方、同仁上方；鎖定後也能改，存了自動重送 LINE
  const NOTE_KINDS = [['lunch', '午餐備註'], ['dinner', '晚餐備註']];
  const noteOf = (d, k) => ((D.notes || {})[d] || {})[k] || '';
  const noteColor = (d, k) => { const c = noteOf(d, k + '_color'); return NOTE_COLORS[c] ? c : ''; };
  const noteStyle = (c) => (c ? ` style="color:${NOTE_COLORS[c][1]}"` : '');
  // 字體顏色選擇：預設＋固定色票（Eason 2026-11-01）
  const colorPick = (k, cur) => `<div class="sc-ncol" role="group" aria-label="字體顏色" data-k="${k}" data-c="${cur}">${[['', ['預設', '']]].concat(Object.entries(NOTE_COLORS)).map(([c, [name, hex]]) =>
    `<button type="button" class="sc-ncsw${c === cur ? ' on' : ''}" data-c="${c}" aria-pressed="${c === cur}" title="${name}"${hex ? ` style="color:${hex}"` : ''}>${name}</button>`).join('')}</div>`;
  // 預估營業額以月為單位：本期碰到的每個月一格
  const monthsHtml = (D.months || []).map((m) => `<div class="sc-month"><label for="scRev-${m.ym}">${+m.ym.slice(5)} 月預估營業額</label>
      <input type="number" inputmode="numeric" min="0" id="scRev-${m.ym}" class="sc-mrev" data-ym="${m.ym}" value="${m.revenue == null ? '' : m.revenue}"> 元
      <span class="hint">每工時營業額 <b class="${ratioCls(m.ratio)}">${m.ratio == null ? '—' : m.ratio.toLocaleString() + ' 元'}</b>（整月排班 ${hm(m.minutes)} 小時${target ? `，目標 ${target.toLocaleString()} 元` : ''}）</span></div>`).join('');
  // 匯出 PDF 時印在標題下方（2026-11-01 Eason：畫面上的營業額區塊列印時藏起來，數字改印在這一行；整月工時是日曆月，不是這一期）
  const printRev = (D.months || []).length ? `<div class="sc-printrev">${D.months.map((m) => `<span>${+m.ym.slice(5)} 月預估營業額 ${m.revenue == null ? '未填' : m.revenue.toLocaleString() + ' 元'}｜每工時營業額 ${m.ratio == null ? '—' : m.ratio.toLocaleString() + ' 元'}｜整月排班 ${hm(m.minutes)} 小時${target ? `｜目標 ${target.toLocaleString()} 元` : ''}</span>`).join('')}</div>` : '';

  // 排班前檢查清單（Eason 2026-10-27）：只給能排班的人、未鎖定的期；班別、同仁身分沒設好擋自動排班；全部設好收成一行
  const ck = setupChecklist(D);
  const ckMark = (i) => (!i.ok ? { must: '✕', rec: '!', opt: '○' }[i.level] : i.key === 'pins' ? '○' : '✓');
  const ckCls = (i) => (i.key === 'pins' || (i.level === 'opt' && !i.ok) ? 'opt' : i.ok ? 'ok' : i.level === 'must' ? 'bad' : 'warn');
  const guideA = '<a id="scGuide" class="sc-ckguide" href="schedule-guide.html" target="_blank" rel="noopener">📖 看完整圖解</a>';
  let checkHtml = '';
  if (!locked && canLock) {
    if (ck.allDone && !S.ckOpen) checkHtml = `<div id="scCheck" class="sc-check done"><span class="sc-ckdone">✓ 排班前設定都完成了</span><button type="button" class="btn ghost sm" id="scCkMore">展開</button>${guideA}</div>`;
    else checkHtml = `<div id="scCheck" class="sc-check"><b class="sc-cktitle">開始排班前，先把這幾項設好</b>
      ${ck.items.map((i) => `<div class="sc-ck ${ckCls(i)}" data-key="${i.key}"><span class="sc-ckmark" aria-hidden="true">${ckMark(i)}</span><span class="sc-cktext">${esc(i.text)}</span>${!i.ok && i.tab ? `<a class="sc-ckgo" href="#/schedule/${i.tab}">去設定 ›</a>` : !i.ok && i.field ? `<button type="button" class="sc-ckgo sc-ckfield" data-field="${i.field}">去填寫 ›</button>` : ''}</div>`).join('')}
      <div class="sc-ckfoot">${guideA}${ck.allDone ? '<button type="button" class="btn ghost sm" id="scCkMore">收起</button>' : ''}</div></div>`;
  }

  const head = `<div class="card sc-head">
    <div class="sc-printtitle">${esc((ctx.session && ctx.session.name) || '')} 班表　${esc(D.period)}　${md(D.dates[0])}–${md(periodEnd(D.period))}</div>${printRev}
    <div class="sc-period"><button type="button" class="btn ghost sm" id="scPrev" aria-label="上一期">‹</button>
      <div><b>${esc(D.period)}</b><span class="sc-range">${md(D.dates[0])}（日）– ${md(periodEnd(D.period))}（六）</span></div>
      <button type="button" class="btn ghost sm" id="scNext" aria-label="下一期">›</button></div>
    <div class="sc-state">
      <span class="tag ${locked ? 'on' : ''}" id="scLockTag">${locked ? '已鎖定' : '排班中'}</span>
      ${D.period === 'T00' ? '<span class="tag">試排期，不送 LINE</span>' : ''}
      ${pub ? `<span class="tag ${pub.status === 'sent' ? 'on' : pub.status === 'failed' ? 'bad' : ''}" id="scPubTag" title="${esc(pub.last_error || '')}">${PUB_TEXT[pub.status] || ''}${pub.kind === 'unpublish' && pub.status === 'sent' ? '（已撤下）' : ''}</span>` : ''}
      ${D.meta.clockAlias === null && D.period !== 'T00' ? '<span class="tag">這家店沒有 LINE 打卡，鎖定不送 LINE</span>' : ''}
    </div>
    ${checkHtml}
    <div class="row sc-acts">
      ${locked || !canLock ? '' : `<button type="button" class="btn" id="scAuto"${ck.blockers.length ? ' disabled' : ''}>${ck.blockers.length ? `自動排班（先完成：${esc(ck.blockers.join('、'))}）` : '自動排班'}</button><label class="sc-chk"><input type="checkbox" id="scAll"> 連手動改過的也重排</label>`}
      ${canLock ? `<button type="button" class="btn ${locked ? 'ghost' : ''}" id="scLock">${locked ? '解除鎖定' : '鎖定並發布'}</button>` : ''}
      ${canLock && pub && (pub.status === 'failed' || pub.status === 'pending') ? '<button type="button" class="btn ghost" id="scResend">立即重送</button>' : ''}
      <button type="button" class="btn ghost" id="scPdf">匯出 PDF</button>
      ${stList.length ? stToggleHtml('scStToggle') : ''}
      <span class="grow"></span>
      <div class="sc-seg" role="group" aria-label="檢視方式"><button type="button" id="scViewGrid" class="${view === 'grid' ? 'on' : ''}">整期</button><button type="button" id="scViewDay" class="${view === 'day' ? 'on' : ''}">單日</button></div>
    </div>
    ${D.meta.needs_recheck ? '<div class="note warn mt" role="alert">這一期已發布，但上一期改過之後，跨期的換班間隔或連續上班天數不合規定了。請解除鎖定、修正後再鎖定。</div>' : ''}
    <div class="sc-months mt">${monthsHtml}</div>
    <div id="scMsg" class="${S.err ? 'err' : 'okmsg'}" role="status">${esc(S.err || S.msg || '')}</div>
  </div>`;

  const sum = D.results.length ? `<details class="card sc-sum"><summary class="sc-sumtoggle"><span class="sc-sumlabel">提醒</span>
      ${counts.block ? `<span class="lv block">${counts.block} 個要修正</span>` : '<span class="lv ok">沒有違反規定</span>'}
      ${counts.warn ? `<span class="lv warn">${counts.warn} 個警告</span>` : ''}${counts.info ? `<span class="lv info">${counts.info} 個提醒</span>` : ''}</summary>
      <ul class="sc-list">${D.results.slice().sort((a, b) => LV_RANK[a.level] - LV_RANK[b.level]).slice(0, 80).map((r) => `<li class="lv-${r.level}">${esc(r.msg)}</li>`).join('')}${D.results.length > 80 ? `<li class="lv-info" id="scSumMore">另有 ${D.results.length - 80} 筆未列</li>` : ''}</ul></details>` : '';

  let body;
  if (view === 'grid') {
    const th = D.dates.map((d) => { const w = weekday(d), hol = D.holidays.days[d], g = !hol && govOff(d); return `<th class="${isWe(d) ? 'we' : ''}${hol ? ' hol' : ''}" title="${esc(hol || (g ? g + '（行政院人事行政總處辦公日曆，非勞基法國定假日）' : ''))}">${md(d)}<small>${WD[w]}${hol ? '・國' : g ? '・補' : ''}</small></th>`; }).join('');
    const rows = staff.map((st) => {
      const tds = D.dates.map((d) => {
        const c = (D.days[st.emp_id] || {})[d];
        const inJob = (!st.hire_date || st.hire_date <= d) && (!st.leave_date || d <= st.leave_date);
        if (!inJob) return '<td class="sc-c na"></td>';
        const x = cellText(c, shifts), iss = byCell[st.emp_id + '|' + d] || [];
        const lv = iss.length ? iss.sort((a, b) => LV_RANK[a.level] - LV_RANK[b.level])[0].level : '';
        const pin = (D.pins[st.emp_id] || {})[d];
        const sel = S.sel && S.sel.emp === st.emp_id && S.sel.date === d;
        const pinCls = !pin ? '' : pin.kind === 'off' ? ' pin-off' : ' pin';   // 指定休假：黃底；指定上班／班別：右上小黑點
        return `<td class="sc-c ${x.cls}${isWe(d) ? ' we' : ''}${bday(st, d) ? ' bd' : ''}${lv ? ' i-' + lv : ''}${sel ? ' sel' : ''}${pinCls}" data-emp="${esc(st.emp_id)}" data-date="${d}" title="${esc(iss.map((r) => r.msg).concat(pin && pin.kind === 'off' ? ['指定休假'] : [], x.ot ? ['休息日加班'] : []).join('\n'))}">${esc(x.t)}${otTag(x)}${stTag(c)}${bday(st, d) ? '<i class="sc-bd" title="生日">生日</i>' : ''}</td>`;
      }).join('');
      const o = offOf(st), lvs = Object.entries(o.lv).map(([k, v]) => k + ' ' + v).join('・');
      return `<tr><th class="sc-name" scope="row">${esc(st.name)}${annualTxt(st)}</th>${tds}<td class="sc-off"><b>${o.n}</b>${lvs ? `<small>${esc(lvs)}</small>` : ''}</td><td class="sc-hr"><b>${+(hoursOf(st) / 60).toFixed(2)}</b></td></tr>`;
    }).join('');
    const cnt = `<tr class="sc-cnt"><th scope="row">當天人數</th>${D.dates.map((d) => {
      const n = dayTotal(d), need = dayNeed(d), el = dayEL(d);
      return `<td class="${need && n < need ? 'short' : ''}${isWe(d) ? ' we' : ''}" title="共 ${n} 人上班${need ? `，至少要 ${need} 人` : ''}">早 ${el.e}<br>晚 ${el.l}</td>`;
    }).join('')}<td class="sc-off"></td><td class="sc-hr"></td></tr>`
      + `<tr class="sc-dhr"><th scope="row">當天工時</th>${D.dates.map((d) => `<td class="${isWe(d) ? 'we' : ''}" title="當天排定總工時（扣掉休息）">${hrTxt(dayMin(d))}</td>`).join('')}`
      + `<td class="sc-off"></td><td class="sc-hr" title="這期全店排定總工時"><b>${hrTxt(D.dates.reduce((a, d) => a + dayMin(d), 0))}</b></td></tr>`;
    const noteRows = NOTE_KINDS.map(([k, label]) => `<tr class="sc-noterow"><th scope="row">${label}</th>${D.dates.map((d) => {
      const t = noteOf(d, k);
      return `<td class="sc-nt${isWe(d) ? ' we' : ''}${t ? ' has' : ''}${S.noteSel === d ? ' sel' : ''}" data-note="${d}" data-kind="${k}" title="${esc(t || (canLock ? '點一下寫' + label : ''))}">${t ? `<div class="sc-ntx"${noteStyle(noteColor(d, k))}>${esc(t)}</div>` : canLock ? '<span class="sc-ntadd" aria-hidden="true">＋</span>' : ''}</td>`;
    }).join('')}<td class="sc-off"></td><td class="sc-hr"></td></tr>`).join('');
    // 各站人數：每個使用中的站一列，不足最少人數的紅字「1/2」
    const stRows = stCntShow.map((x) => `<tr class="sc-stcnt" data-station="${esc(x.id)}"><th scope="row">${esc(x.name)}</th>${D.dates.map((d) => {
      const n = stCount(d, x.id), need = stNeed(d, x.id);
      return `<td class="${need && n < need ? 'short' : ''}${isWe(d) ? ' we' : ''}" title="${esc(x.name)}${need ? `至少要 ${need} 人` : '沒有設人數'}">${n}${need ? '/' + need : ''}</td>`;
    }).join('')}<td class="sc-off"></td><td class="sc-hr"></td></tr>`).join('');
    // 班表最下方列班別與時間（2026-10-31 Eason）：使用中的班＋這期有排到的停用班
    const usedSh = new Set(); for (const st of staff) for (const d of D.dates) { const c = (D.days[st.emp_id] || {})[d]; if (c && c.shift_id) usedSh.add(c.shift_id); }
    const legendSh = D.shifts.filter((s) => s.active || usedSh.has(s.id));
    const legend = legendSh.length ? `<div class="sc-legend" id="scLegend">${legendSh.map((s) => `<span><b>${esc(shiftCode(s.name))}</b>：${esc(timeText(s))}</span>`).join('')}</div>` : '';
    body = `<div class="card sc-gridcard"><div class="scroll"><table class="sc-grid">
      <thead><tr><th class="sc-name">同仁</th>${th}<th class="sc-offh">休假<small>天數</small></th><th class="sc-hrh">排班<small>時數</small></th></tr></thead>
      <tbody>${noteRows}${rows}${cnt}${stRows}</tbody></table></div>${legend}</div>`;
  } else {
    const d = S.day, hol = D.holidays.days[d];
    const chips = D.dates.map((x) => `<button type="button" class="sc-daychip${x === d ? ' on' : ''}${isWe(x) ? ' we' : ''}${(byDay[x] || []).length ? ' warn' : ''}" data-day="${x}">${md(x)}<small>${WD[weekday(x)]}</small></button>`).join('');
    const list = staff.filter((st) => (!st.hire_date || st.hire_date <= d) && (!st.leave_date || d <= st.leave_date)).map((st) => {
      const c = (D.days[st.emp_id] || {})[d], x = cellText(c, shifts), iss = byCell[st.emp_id + '|' + d] || [];
      const s = c && c.shift_id ? shifts[c.shift_id] : null;
      const pin = (D.pins[st.emp_id] || {})[d];
      return `<button type="button" class="sc-drow ${x.cls}${bday(st, d) ? ' bd' : ''}${pin && pin.kind === 'off' ? ' pin-off' : ''}${iss.length ? ' i-' + iss.sort((a, b) => LV_RANK[a.level] - LV_RANK[b.level])[0].level : ''}" data-emp="${esc(st.emp_id)}" data-date="${d}">
        <span class="sc-dn">${esc(st.name)}${bday(st, d) ? ' <i class="sc-bd">生日</i>' : ''}${annualTxt(st)}</span><span class="sc-dv">${esc(x.t)}${otTag(x)}${s ? `<small>${esc(timeText(s))}</small>` : ''}${stTag(c)}</span>
        ${iss.length ? `<span class="sc-dmsg">${esc(iss.map((i) => i.msg).join('；'))}</span>` : ''}</button>`;
    }).join('');
    const n = dayTotal(d), nd = dayNeed(d), el = dayEL(d);
    const cnt = `<span class="tag ${nd && n < nd ? 'bad' : ''}" id="scDayCount">早 ${el.e} 人｜晚 ${el.l} 人</span><span class="tag" id="scDayHours">總工時 ${hrTxt(dayMin(d))} 小時</span>`
      + stCntShow.map((x) => { const k = stCount(d, x.id), nn = stNeed(d, x.id); return `<span class="tag sc-dst ${nn && k < nn ? 'bad' : ''}" data-station="${esc(x.id)}">${esc(x.name)} ${k}${nn ? '/' + nn : ''}</span>`; }).join('');
    body = `<div class="card"><div class="sc-days">${chips}</div>
      <h2 class="mt">${md(d)}（${WD[weekday(d)]}）${hol ? `<span class="tag">${esc(hol)}</span>` : ''}</h2>
      <div class="row">${cnt}</div>
      <div class="sc-dnotes mt" id="scDayNotes">${NOTE_KINDS.map(([k, label]) => `<div class="sc-dnote${noteOf(d, k) ? ' has' : ''}"><b>${label}</b><span id="scDayNote-${k}"${noteStyle(noteColor(d, k))}>${noteOf(d, k) ? esc(noteOf(d, k)) : '（沒有）'}</span></div>`).join('')}
        ${canLock ? `<button type="button" class="btn ghost sm" id="scDayNoteEdit" data-note="${d}">寫備註</button>` : ''}</div>
      ${(byDay[d] || []).map((x) => `<div class="note warn mt">${esc(x.msg)}</div>`).join('')}
      <div class="sc-dlist mt">${list}</div></div>`;
  }

  // 編輯列：選了一格才出現。
  // 工作站別（station-spec §7）：站別與班別分開存——「套用」只存班別（saveDays，不收站別）、「儲存站別」只存站別（setStation）；
  // 站別下拉只在這一格目前（已存）就是上班格時出現，兩邊不會打架。期別鎖定中：其他欄位維持唯讀，只剩站別可改（不問核定密碼、不解鎖）。
  let editor = '';
  if (S.sel) {
    const st = D.staff.find((x) => x.emp_id === S.sel.emp);
    const c = (D.days[S.sel.emp] || {})[S.sel.date] || {};
    const iss = byCell[S.sel.emp + '|' + S.sel.date] || [];
    const head2 = `<b>${esc(st ? st.name : '')}　${md(S.sel.date)}（${WD[weekday(S.sel.date)]}）</b>`;
    const stRow = c.shift_id && (stActive.length || c.station_id) ? `<div class="row mt"><label for="scStationSel">工作站</label><select id="scStationSel" aria-label="這一格的工作站"><option value="">不選</option>${
      stList.filter((x) => x.active || x.id === c.station_id).map((x) => `<option value="${esc(x.id)}"${x.id === c.station_id ? ' selected' : ''}>${esc(x.name)}${x.active ? '' : '（已停用）'}</option>`).join('')}</select>
      <button type="button" class="btn" id="scStationOk">儲存站別</button>${locked ? '<button type="button" class="btn ghost" id="scCellX">取消</button>' : ''}</div>` : '';
    if (locked) {
      const sh = c.shift_id ? shifts[c.shift_id] : null;
      editor = `<div class="card sc-editor" id="scEditor">${head2}<span class="hint">　${esc(sh ? `${shiftCode(sh.name)} ${timeText(sh)}` : '')}　已鎖定，只能改工作站（改完會自動重送 LINE）</span>${stRow || '<div class="row mt"><button type="button" class="btn ghost" id="scCellX">取消</button></div>'}</div>`;
    } else {
      const cur = c.shift_id ? 'S:' + c.shift_id + (c.day_type === 'H' ? ':H' : '') : c.day_type === 'L' ? 'L:' + c.leave : c.day_type || '';
      // 國定假日假：國定假日當天都可選；正職在有國定假日的期別可移到別天（Eason 2026-10-12）
      const isFt = (termAt(D.terms, S.sel.emp, S.sel.date) || {}).kind === 'ft';
      const guoOk = !!D.holidays.days[S.sel.date] || (isFt && D.dates.some((d) => D.holidays.days[d]));
      const otOpts = activeShifts.map((s) => `<option value="S:${esc(s.id)}:H">${esc(shiftCode(s.name))}（休息日出勤）</option>`).join('');
      // 休息日加班只能改回休息日或換一個休息日出勤的班（伺服器同樣擋，Eason 2026-10-11）
      const opts = c.day_type === 'H' && c.shift_id ? otOpts + '<option value="H">休息日</option>'
        : activeShifts.map((s) => `<option value="S:${esc(s.id)}">${esc(shiftCode(s.name))} ${esc(timeText(s))}</option>`).join('') + otOpts
        + '<option value="R">例假</option><option value="H">休息日</option>' + LEAVES.map(([k, l]) => `<option value="L:${k}">${l}</option>`).join('')
        + (guoOk ? '<option value="L:國">國定假日假</option>' : '') + '<option value="CLEAR">清空</option>';
      editor = `<div class="card sc-editor" id="scEditor">${head2}
      <div class="row mt"><select id="scCellSel" aria-label="這一格要排什麼">${opts.replace(`value="${cur}"`, `value="${cur}" selected`)}</select>
      <button type="button" class="btn" id="scCellOk">套用</button><button type="button" class="btn ghost" id="scCellX">取消</button></div>${stRow}
      ${iss.length ? `<ul class="sc-list">${iss.map((r) => `<li class="lv-${r.level}">${esc(r.msg)}</li>`).join('')}</ul>` : ''}</div>`;
    }
  }

  // 備註編輯：點了某天的備註格才出現（鎖定中也可以改）
  let noteEditor = '';
  if (S.noteSel && D.dates.includes(S.noteSel) && canLock) {
    const d = S.noteSel;
    noteEditor = `<div class="card sc-editor" id="scNoteEditor"><b>${md(d)}（${WD[weekday(d)]}）備註</b>
      ${NOTE_KINDS.map(([k, label]) => `<label class="sc-nlabel" for="scNote-${k}">${label}</label><input type="text" id="scNote-${k}" maxlength="60" placeholder="例：${k === 'lunch' ? '12:00 有 30 人團體訂位' : '提早 30 分鐘盤點'}" value="${esc(noteOf(d, k))}"${noteStyle(noteColor(d, k))}>${colorPick(k, noteColor(d, k))}`).join('')}
      ${locked && D.meta.clockAlias !== null && D.period !== 'T00' ? '<div class="hint mt">這一期已鎖定，存了會自動重送到 LINE，同仁看得到新的備註。</div>' : ''}
      <div class="row mt"><button type="button" class="btn" id="scNoteOk">儲存</button><button type="button" class="btn ghost" id="scNoteX">取消</button></div></div>`;
  }

  el.innerHTML = head + sum + body + editor + noteEditor;
  const q = (s) => el.querySelector(s);
  const rerender = () => ctx.rerender();
  const say = (m, isErr) => { S.msg = isErr ? '' : m; S.err = isErr ? m : ''; };

  const onChip = el.querySelector('.sc-daychip.on'); if (onChip && onChip.scrollIntoView) onChip.scrollIntoView({ block: 'nearest', inline: 'center' });
  q('#scPrev').onclick = () => { movePeriod(-1); say(''); rerender(); };
  q('#scNext').onclick = () => { movePeriod(1); say(''); rerender(); };
  if (q('#scStToggle')) q('#scStToggle').onclick = () => { setStHidden(!stHidden()); rerender(); };
  q('#scViewGrid').onclick = () => { S.view = 'grid'; rerender(); };
  if (q('#scCkMore')) q('#scCkMore').onclick = () => { S.ckOpen = !S.ckOpen; rerender(); };
  el.querySelectorAll('.sc-ckfield').forEach((b) => { b.onclick = () => { const f = document.getElementById(b.dataset.field); if (f) { f.scrollIntoView({ block: 'center' }); f.focus(); } }; });
  q('#scViewDay').onclick = () => { S.view = 'day'; rerender(); };
  el.querySelectorAll('.sc-daychip').forEach((b) => { b.onclick = () => { S.day = b.dataset.day; rerender(); }; });
  el.querySelectorAll('.sc-c[data-emp], .sc-drow').forEach((td) => {
    td.onclick = () => {
      if (!canLock) { say('你只能查看班表，排班請找本店店長', true); return rerender(); }
      const c = (D.days[td.dataset.emp] || {})[td.dataset.date];
      // 已鎖定：只有「上班格而且店裡有站別」能點開（只改站別）；其他照舊提示要先解鎖
      if (locked && !(c && c.shift_id && (stActive.length || c.station_id))) { say('這一期已鎖定，要先解除鎖定才能修改', true); return rerender(); }
      S.sel = { emp: td.dataset.emp, date: td.dataset.date }; S.noteSel = null; rerender();
    };
  });
  el.querySelectorAll('.sc-mrev').forEach((inp) => {
    inp.onchange = async () => {
      try { await call('saveRevenue', { values: { [inp.dataset.ym]: inp.value === '' ? null : Number(inp.value) } }); await load(); say('已存營業額'); }
      catch (e) { say(e.message, true); }
      rerender();
    };
  });
  // 匯出 PDF：切到整期格子、用瀏覽器列印（選「儲存為 PDF」）；列印樣式只留班表本身（schedule.css 的 @media print）
  q('#scPdf').onclick = () => {
    const go = () => { try { window.print(); } catch (e) { say('這個瀏覽器不能列印，請改用電腦的 Chrome 或 Safari', true); rerender(); } };
    if (view !== 'grid') { S.view = 'grid'; rerender(); setTimeout(go, 400); } else go();
  };
  const openNote = (d) => { if (!canLock) { say('你只能查看班表，備註請找本店店長', true); return rerender(); } S.noteSel = d; S.sel = null; rerender(); const f = q('#scNote-lunch'); if (f) f.focus(); };
  el.querySelectorAll('.sc-nt[data-note], #scDayNoteEdit').forEach((b) => { b.onclick = () => openNote(b.dataset.note); });
  if (q('#scNoteX')) q('#scNoteX').onclick = () => { S.noteSel = null; rerender(); };
  el.querySelectorAll('.sc-ncol .sc-ncsw').forEach((b) => { b.onclick = () => {   // 選色只改畫面，按儲存才存
    const g = b.closest('.sc-ncol'), c = b.dataset.c;
    g.dataset.c = c;
    g.querySelectorAll('.sc-ncsw').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
    const inp = q('#scNote-' + g.dataset.k); if (inp) inp.style.color = c ? NOTE_COLORS[c][1] : '';
  }; });
  if (q('#scNoteOk')) q('#scNoteOk').onclick = () => busy(q('#scNoteOk'), async () => {
    const d = S.noteSel;
    try {
      const col = (k) => q(`.sc-ncol[data-k="${k}"]`).dataset.c;
      const r = await call('saveNotes', { period: S.period, notes: { [d]: { lunch: q('#scNote-lunch').value, dinner: q('#scNote-dinner').value, lunch_color: col('lunch'), dinner_color: col('dinner') } } });
      await load(); S.noteSel = null; say(r.resend ? '已存備註，正在重送到 LINE' : '已存備註');
    } catch (e) { say(e.message, true); }
    rerender();
  });
  if (q('#scCellX')) q('#scCellX').onclick = () => { S.sel = null; rerender(); };
  if (q('#scStationOk')) q('#scStationOk').onclick = () => busy(q('#scStationOk'), async () => {
    try {
      const r = await mutate('setStation', { cells: [{ emp_id: S.sel.emp, date: S.sel.date, station_id: q('#scStationSel').value || null }] });
      S.sel = null; say(r.publication ? '已存站別，LINE 班表正在重新送出' : '已存站別');
    } catch (e) { say(e.message, true); }
    rerender();
  });
  if (q('#scCellOk')) q('#scCellOk').onclick = () => busy(q('#scCellOk'), async () => {
    const v = q('#scCellSel').value, cell = { emp_id: S.sel.emp, date: S.sel.date };
    if (v === 'CLEAR') cell.clear = true;
    else if (v.startsWith('S:')) { const [, id, h] = v.split(':'); Object.assign(cell, { day_type: h ? 'H' : 'W', shift_id: id }); }
    else if (v.startsWith('L:')) Object.assign(cell, { day_type: 'L', leave: v.slice(2) });
    else Object.assign(cell, { day_type: v });
    try { await mutate('saveDays', { cells: [cell] }); S.sel = null; say('已存'); } catch (e) { say(e.message, true); }
    rerender();
  });
  if (q('#scAuto')) q('#scAuto').onclick = () => busy(q('#scAuto'), async () => {
    const all = q('#scAll').checked;
    if (all && !(await confirmBox('手動改過的格子也會被重新排，確定嗎？', '全部重排'))) return;
    try {
      const r = await mutate('auto', { keepManual: !all });
      if (r.ok) say(r.problems && r.problems.length ? '排好了，有幾個地方要注意：' + r.problems.join('；') : '排好了');
      else say('排不出來：' + r.problems.slice(0, 5).join('；'), true);
    } catch (e) { say(e.message, true); }
    rerender();
  });

  // 鎖定／解鎖：只有管理系統個人帳號（scheduleAdmin）能做，不需要出勤核定密碼；門市帳號（共用店號）不能排班（hr-move-spec §10.1-2），畫面走不到這裡
  const doLock = async () => {
    try {
      if (locked) { await mutate('unlock'); say(pub && pub.kind === 'publish' ? '已解除鎖定，LINE 上的這一期班表會撤下' : '已解除鎖定'); }
      else { const r = await mutate('lock'); say(r.publish ? '已鎖定，正在送到 LINE' : '已鎖定'); }
    } catch (e) { say(e.message, true); }
    rerender();
  };
  if (q('#scLock')) q('#scLock').onclick = () => busy(q('#scLock'), async () => {
    if (!locked && counts.block) { say(`還有 ${counts.block} 個地方不合規定，修正後才能鎖定`, true); return rerender(); }
    if (locked && !(await confirmBox('解除鎖定後，同仁在 LINE 上會暫時看不到這一期的班表，改好要再鎖定。確定嗎？', '解除鎖定'))) return;
    await doLock();
  });
  if (q('#scResend')) q('#scResend').onclick = () => busy(q('#scResend'), async () => {
    try { const r = await call('resend', { period: S.period }); await load(); say(r.publication && r.publication.status === 'sent' ? '已送到 LINE' : '還是送不出去，系統會每 5 分鐘自動再試'); }
    catch (e) { say(e.message, true); }
    rerender();
  });
}
