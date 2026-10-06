// 查單：單號／關鍵字、日期區間、狀態；合計＝整個查詢結果的應撥總額（後端算，排除已刪除，不是畫面上卡片相加）。
import { esc } from '../../js/ui.js';
import { S, call, msgOf, shortOf, todayISO } from './state.js';
import { money } from './calc.js';
import { paintCards, openDoc } from './list.js';

function sumBox(s) {
  if (!s) return '';
  const sub = [];
  if (s['基準門市']) sub.push(`以 ${shortOf(s['基準門市'])} 計：調出 ${money(s['調出'] || 0)}　調入 ${money(s['調入'] || 0)}`);
  if (s['已刪除張數']) sub.push(`不含 ${s['已刪除張數']} 張已刪除`);
  return `<div class="xf-sum" id="xfQsum">合計 <span class="big" id="xfQsumAmt">${money(s['應撥總額'] || 0)}</span> 元　·　<span id="xfQsumCnt">${s['張數']}</span> 張${sub.length ? `<span class="sub">${esc(sub.join('　·　'))}</span>` : ''}</div>`;
}

export function renderQuery(ctx) {
  const el = ctx.el, Q = S.q;
  el.innerHTML = `<div class="card"><h2>查單</h2>
    <div class="grid2 xf-qgrid">
      <div class="fld"><label for="xfQno">單號或關鍵字</label><input id="xfQno" placeholder="例：TR-20261007" autocomplete="off"></div>
      <div class="fld"><label for="xfQst">狀態</label><select id="xfQst"><option value="">全部</option><option>草稿</option><option>已出貨</option><option>已簽收</option><option>已刪除</option></select></div>
      <div class="fld"><label for="xfQfrom">調撥日期　起</label><input id="xfQfrom" type="date"></div>
      <div class="fld"><label for="xfQto">調撥日期　迄</label><input id="xfQto" type="date"></div>
    </div>
    <div class="row mt"><button class="btn" id="xfQbtn" type="button">查詢</button><button class="btn ghost" id="xfQmonth" type="button">本月</button><button class="btn ghost" id="xfQclear" type="button">清除</button></div>
    <div id="xfQmsg" class="err" role="alert"></div></div><div id="xfQlist"></div>`;
  const $ = id => el.querySelector('#' + id);
  $('xfQno').value = Q.f.kw; $('xfQst').value = Q.f.st; $('xfQfrom').value = Q.f.from; $('xfQto').value = Q.f.to;
  const read = () => { Q.f = { kw: $('xfQno').value.trim(), st: $('xfQst').value, from: $('xfQfrom').value, to: $('xfQto').value }; };
  ['xfQno', 'xfQst', 'xfQfrom', 'xfQto'].forEach(id => $(id).addEventListener('change', read));
  $('xfQno').addEventListener('input', read);

  function paint() {
    if (!el.isConnected) return;
    const box = $('xfQlist');
    if (!Q.searched) { box.innerHTML = ''; return; }
    box.innerHTML = Q.rows.length ? `<div class="card"><h2>找到 <span id="xfQtotal">${Q.total}</span> 張</h2>${sumBox(Q.sum)}<div id="xfQcards"></div>${Q.rows.length < Q.total ? '<button class="btn ghost mt" id="xfQmore" type="button">載入更多</button>' : ''}</div>`
      : '<div class="card xf-none" id="xfQempty"><b>沒有符合的單據</b><br>換個條件試試。</div>';
    if (Q.rows.length) paintCards(box.querySelector('#xfQcards'), Q.rows, '', false, no => openDoc(ctx, no, 'query').catch(e => { $('xfQmsg').textContent = msgOf(e); }));
    const more = box.querySelector('#xfQmore'); if (more) more.onclick = () => run(true);
  }
  async function run(more) {
    read(); const msg = $('xfQmsg'); msg.textContent = '';
    if (!more) { Q.offset = 0; Q.rows = []; }
    const btn = more ? $('xfQmore') : $('xfQbtn'), old = btn.textContent;
    btn.disabled = true; btn.textContent = '查詢中…';
    try {
      const d = await call('listDocs', { '關鍵字': Q.f.kw, '狀態': Q.f.st, '起日': Q.f.from, '迄日': Q.f.to, limit: 20, offset: Q.offset });
      Q.rows = Q.rows.concat(d.rows || []); Q.offset = Q.rows.length; Q.total = d.total; Q.sum = d.sum; Q.searched = true;
      paint();
    } catch (e) { if (el.isConnected) msg.textContent = msgOf(e); }
    finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = old; } }
  }
  $('xfQbtn').onclick = () => run(false);
  $('xfQmonth').onclick = () => {
    const t = todayISO(), ym = t.slice(0, 7), last = new Date(+t.slice(0, 4), +t.slice(5, 7), 0).getDate();
    $('xfQfrom').value = ym + '-01'; $('xfQto').value = ym + '-' + String(last).padStart(2, '0'); $('xfQno').value = ''; $('xfQst').value = ''; run(false);
  };
  $('xfQclear').onclick = () => { Q.f = { kw: '', from: '', to: '', st: '' }; Q.rows = []; Q.total = 0; Q.sum = null; Q.searched = false; ['xfQno', 'xfQfrom', 'xfQto'].forEach(id => { $(id).value = ''; }); $('xfQst').value = ''; $('xfQmsg').textContent = ''; paint(); };
  paint();
}
