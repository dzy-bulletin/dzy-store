// 統計分頁：期間、總金額卡（含上期比較）、每日長條、三份排行（按品類→品名、按品名→原因、按原因→品名）、匯出 CSV、列印。
// 只讀取一次（上期起點到本期終點），之後全在前端加總每筆存下的「金額」，不回頭查成本表重算——照原系統（第 1173–1340 行）。
import { esc } from '../../js/ui.js';
import { S, call, msgOf } from './state.js';
import { summarize, dateRange, prevRange, ymd, money, csv, topN } from './calc.js';

const KINDS = [['today', '本日'], ['week', '本週'], ['month', '本月'], ['custom', '自訂']];
const md = d => d.slice(5).replace('-', '/');

// 展開後的下一層：只有名稱／金額／佔比／筆數；只列前 10 項，其餘收成一列（原系統 subRank）；「其他」有原因說明清單
function subHtml(list) {
  return '<ul class="ls-sub">' + topN(list, 10).map(x => {
    const rest = !!x.其餘;
    const nl = x.說明 && x.說明.length ? `<ul class="r-notes">${x.說明.map(n => `<li>${esc(n.說明)}${n.筆數 > 1 ? `<small>${n.筆數} 筆</small>` : ''}</li>`).join('')}</ul>` : '';
    return `<li class="ls-rk sub${rest ? ' r-rest' : ''}" data-name="${esc(rest ? '其餘' : x.名稱)}"><div class="r-head plain"><div class="r-top"><span class="r-name">${rest ? '其餘 ' + x.其餘 + ' 項' : esc(x.名稱)}</span><span class="r-amt">${money(x.金額)}</span></div>
      <div class="r-sub">${x.佔比}%　${x.筆數} 筆</div>${nl}</div></li>`;
  }).join('') + '</ul>';
}
// 頂層排行：金額由大到小＋佔比條；subLabel 給了就代表可點開看下一層
function rankHtml(id, list, limit, subLabel) {
  const top = list.length ? list[0].金額 : 0;
  const shown = limit && list.length > limit ? list.slice(0, limit) : list;
  let h = shown.map(r => {
    const kids = subLabel && r.明細 && r.明細.length, key = id + '｜' + r.名稱;
    const body = `<div class="r-top"><span class="r-name">${esc(r.名稱)}</span><span class="r-amt">${money(r.金額)}</span></div>
      <div class="r-sub"><span>${r.佔比}%　${r.筆數} 筆</span>${kids ? `<span class="r-hint">${r.明細.length} 個${subLabel}</span>` : ''}</div><div class="r-bar"><i style="width:${top ? Math.max(2, r.金額 / top * 100) : 0}%"></i></div>`;
    if (!kids) return `<li class="ls-rk" data-name="${esc(r.名稱)}"><div class="r-head plain">${body}</div></li>`;
    const open = !!S.rankOpen[key];
    return `<li class="ls-rk can-open${open ? ' is-open' : ''}" data-name="${esc(r.名稱)}" data-key="${esc(key)}"><button type="button" class="r-head" aria-expanded="${open}">${body}</button>${subHtml(r.明細)}</li>`;
  }).join('');
  if (limit && list.length > limit) h += `<li class="ls-more"><button type="button" class="more" data-more="${id}">顯示全部 ${list.length} 項</button></li>`;
  return h;
}

export function renderStat(ctx) {
  const el = ctx.el;
  const today = ymd(new Date());
  el.innerHTML = `<div class="ls-seg" id="lsSeg">${KINDS.map(([k, t]) => `<button type="button" data-k="${k}" aria-pressed="${S.statKind === k}">${t}</button>`).join('')}</div>
    <div class="ls-two" id="lsCustom" hidden><div class="fld"><label for="lsFrom">起</label><input id="lsFrom" type="date"></div><div class="fld"><label for="lsTo">迄</label><input id="lsTo" type="date"></div></div>
    <div id="lsStatErr" class="err" role="alert"></div>
    <div class="card ls-sum" id="lsSum"><div class="ls-sum-label">耗損總金額<span id="lsRange"></span></div><div class="ls-sum-big" id="lsTotal">$0</div>
      <div class="ls-sum-sub"><span id="lsCount">0 筆</span><span id="lsDelta"></span></div></div>
    <div class="card" id="lsChartBlock"><h2>每日走勢</h2><div class="ls-chart" id="lsChart"></div><div class="ls-axis"><span id="lsAxisA"></span><span id="lsAxisB"></span></div></div>
    <div id="lsRankBlock"><div class="card"><h2>按品類</h2><ul class="ls-rank" id="lsRankCat"></ul></div>
      <div class="card"><h2>按品名</h2><ul class="ls-rank" id="lsRankItem"></ul></div>
      <div class="card"><h2>按原因</h2><ul class="ls-rank" id="lsRankReason"></ul></div></div>
    <div class="row no-print" id="lsActs"><button class="btn ghost" type="button" id="lsCsv">匯出 CSV</button><button class="btn ghost" type="button" id="lsPrint">列印</button></div>
    <p class="hint" id="lsStatEmpty" hidden>這段期間還沒有紀錄。</p>`;
  const $ = id => el.querySelector('#' + id);
  const range = () => {
    if (S.statKind === 'custom') {
      const f = $('lsFrom').value, t = $('lsTo').value;
      if (!f || !t) return null;
      return f <= t ? { from: f, to: t } : { from: t, to: f };
    }
    return dateRange(S.statKind, today);
  };
  if (S.statKind === 'custom') { $('lsCustom').hidden = false; $('lsFrom').value = S.statFrom; $('lsTo').value = S.statTo; }
  let seq = 0, lastRows = [], lastCur = null;

  // 按品名可能上百項，先給前 10，按「顯示全部」展開（原系統 itemRankOpen）
  function drawRanks() {
    if (!lastCur) return;
    $('lsRankCat').innerHTML = rankHtml('cat', lastCur.按品類, 0, '品項');
    $('lsRankItem').innerHTML = rankHtml('item', lastCur.按品名, S.itemAll ? 0 : 10, '原因');
    $('lsRankReason').innerHTML = rankHtml('reason', lastCur.按原因, 0, '品項');
  }
  async function draw() {
    const rg = range(); if (!rg) return;
    const mine = ++seq, pv = prevRange(rg.from, rg.to);
    $('lsStatErr').textContent = '';
    let recs;
    try { recs = (await call('listLoss', { from: pv.from, to: rg.to })).records || []; }
    catch (e) { if (mine === seq && el.isConnected) $('lsStatErr').textContent = '讀不到紀錄：' + msgOf(e); return; }
    if (mine !== seq || !el.isConnected) return;
    const cur = summarize(recs, rg.from, rg.to), prev = summarize(recs, pv.from, pv.to);
    lastRows = cur.rows; lastCur = cur;
    $('lsRange').textContent = md(rg.from) + (rg.from === rg.to ? '' : '–' + md(rg.to));
    $('lsTotal').textContent = money(cur.總金額);
    $('lsCount').textContent = cur.筆數 + ' 筆';
    const d = Math.round((cur.總金額 - prev.總金額) * 100) / 100;
    $('lsDelta').textContent = prev.總金額 === 0 ? (cur.總金額 ? '上期沒有紀錄' : '') : `上期 ${money(prev.總金額)}（${d >= 0 ? '+' : ''}${money(d).replace('$', '')}）`;
    // 每日走勢（只有一天就不畫，否則會變成一整塊實心色塊）
    const days = cur.每日, max = days.reduce((m, x) => Math.max(m, x.金額), 0);
    $('lsChartBlock').hidden = days.length < 2 || !cur.筆數;
    $('lsChart').innerHTML = days.map(x => `<div class="${x.金額 > 0 ? 'has' : ''}" data-date="${x.日期}" data-amt="${x.金額}" title="${x.日期}　${money(x.金額)}" style="height:${max ? Math.max(2, x.金額 / max * 100) : 0}%"></div>`).join('');
    $('lsAxisA').textContent = md(rg.from); $('lsAxisB').textContent = md(rg.to);
    drawRanks();
    const none = !cur.筆數;
    $('lsStatEmpty').hidden = !none; $('lsRankBlock').hidden = none; $('lsActs').hidden = none;
  }

  el.querySelectorAll('#lsSeg button').forEach(b => b.onclick = () => {
    S.statKind = b.dataset.k;
    el.querySelectorAll('#lsSeg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    $('lsCustom').hidden = S.statKind !== 'custom';
    if (S.statKind === 'custom' && !$('lsFrom').value) { const m = dateRange('month', today); $('lsFrom').value = S.statFrom = m.from; $('lsTo').value = S.statTo = m.to; }
    draw();
  });
  $('lsFrom').onchange = () => { S.statFrom = $('lsFrom').value; draw(); };
  $('lsTo').onchange = () => { S.statTo = $('lsTo').value; draw(); };
  // 展開／收合只動這一列的 class，不重畫整頁——重畫會把捲動位置彈回頂端
  // 展開／收合只動這一列的 class，不重畫整頁——重畫會把捲動位置彈回頂端
  $('lsRankBlock').onclick = e => {
    const more = e.target.closest('[data-more]');
    if (more) { S.itemAll = true; drawRanks(); return; }
    const head = e.target.closest('.r-head'); if (!head || head.classList.contains('plain')) return;
    const li = head.parentElement, key = li.dataset.key, open = !S.rankOpen[key];
    S.rankOpen[key] = open; li.classList.toggle('is-open', open); head.setAttribute('aria-expanded', String(open));
  };
  $('lsPrint').onclick = () => window.print();
  $('lsCsv').onclick = () => {
    const rg = range(); if (!rg || !lastRows.length) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv(lastRows)], { type: 'text/csv;charset=utf-8' }));
    a.download = `耗損_${rg.from}_${rg.to}.csv`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  draw();
}
