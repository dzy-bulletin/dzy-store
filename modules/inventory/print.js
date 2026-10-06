// 列印與匯出（照正本 1212–1391 行）：異常摘要列、食材／包材／全店三張小計、庫存彙整（攤車＋現場合併）、未盤點品項；
// 「列印 PDF」用瀏覽器列印（另存成 PDF）、「匯出 Excel」是帶 BOM 的 CSV、「匯出資料」是舊版相容的 JSON。另有「完成盤點」把這一輪存進歷史。
import { esc } from '../../js/ui.js';
import { api } from '../../js/api.js';
import { S, flushNow, track } from './state.js';
import { buildSummary, fmt, excelRows, toCsv, exportBaseName } from './calc.js';
import { snack } from './count.js';

const tsOf = now => `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;

// 正本匯出的 JSON 就是整個 S；這裡的形狀完全一樣，所以舊版也讀得進去
export function legacyJson(storeName) {
  const d = S.data;
  return { storeName: storeName || '', products: d.products, cartCats: d.cartCats, stockCats: d.stockCats, cartItems: d.cartItems, stockItems: d.stockItems, thresholds: d.thresholds };
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderPrint(ctx) {
  const el = ctx.el, storeName = ctx.session.name || ctx.session.code || '';
  const sm = buildSummary(S.data);
  const bar = (sm.low + sm.high + sm.missingCount) === 0
    ? '<div class="inv-alertbar clean" id="invAlertBar"><span>✅</span><span>所有品項庫存正常，盤點完整</span></div>'
    : `<div class="inv-alertbar has" id="invAlertBar"><span>⚠️</span><span>${[sm.missingCount ? `${sm.missingCount} 項未盤點` : '', sm.low ? `${sm.low} 項偏低` : '', sm.high ? `${sm.high} 項偏高` : ''].filter(Boolean).join('、')}，請確認庫存</span></div>`;
  const rows = sm.groups.map(g => `<div class="sum-row grp"><span>【${esc(g.cat)}】小計</span><b>${fmt(g.subtotal)}</b></div>` + g.rows.map(r =>
    `<div class="sum-row${r.badge ? ' has-' + r.badge : ''}" data-pid="${esc(r.pid)}"><span class="nm">▸ ${esc(r.name)}</span><span class="rt"><span class="qt">${esc(r.qty)}</span>${r.badge ? `<span class="inv-badge ${r.badge}">${r.badge === 'low' ? '偏低' : '偏高'}</span>` : ''}<b>${fmt(r.total)}</b></span></div>`).join('')).join('');
  const miss = sm.missing.length ? `<section class="card inv-miss"><h2>⚠️ 未盤點品項（攤車＋現場均無數量）<span class="inv-missn">${sm.missing.length} 項</span></h2>${sm.missing.map(i => `<div class="sum-row has-missing"><span class="nm">▸ ${esc(i.name)}</span><span class="inv-badge missing">未盤點</span></div>`).join('')}</section>` : '';
  el.innerHTML = `<div class="inv-printhead"><div class="ph">麻的小辛辣｜庫存金額彙整報表</div><div class="pm" id="invPm"></div></div>
    <div class="inv-subs"><div class="inv-subc food"><span>食材總金額</span><b id="invFood">${fmt(sm.food)}</b></div><div class="inv-subc pack"><span>包材總金額</span><b id="invPack">${fmt(sm.pack)}</b></div>
      <div class="inv-subc total"><span>全店總庫存金額</span><b id="invGrandSum">${fmt(sm.grand)}</b><small>食材＋包材合計</small></div></div>
    <div class="inv-noprint"><div class="inv-actions"><button class="btn" id="invPrintBtn" type="button">🖨️ 列印 PDF</button><button class="btn ghost" id="invCsvBtn" type="button">📊 匯出 Excel</button>
      <button class="btn ghost" id="invJsonBtn" type="button">📤 匯出資料（JSON）</button><button class="btn ghost" id="invFinishBtn" type="button">✅ 完成盤點</button></div>
      <div class="hint" id="invFinishMsg" role="status">${S.lastFinish ? '上次完成盤點：' + new Date(S.lastFinish).toLocaleString('zh-TW', { hour12: false }) : '還沒有完成過盤點。盤完按「完成盤點」，這一輪的數字會存進「歷史」。'}</div></div>
    ${bar}<section class="card inv-sumcard"><h2>📋 庫存彙整（攤車＋現場）<span class="inv-sumtotal" id="invSumTotal">${fmt(sm.total)}</span></h2>${rows || '<div class="inv-empty">尚無資料</div>'}</section>${miss}`;

  el.querySelector('#invPrintBtn').onclick = async () => {                       // 1343–1357 doPrint
    await flushNow();
    const now = new Date();
    el.querySelector('#invPm').textContent = (storeName ? storeName + ' ｜ ' : '') + '盤點時間：' + tsOf(now) + '　麻的小辛辣 — 內部使用';
    const old = document.title; document.title = exportBaseName(storeName, now);
    document.body.classList.add('inv-printing');
    const done = () => { document.body.classList.remove('inv-printing'); document.title = old; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done); setTimeout(done, 60000);
    setTimeout(() => window.print(), 100);
  };
  el.querySelector('#invCsvBtn').onclick = async () => {
    await flushNow();
    const now = new Date();
    download(exportBaseName(storeName, now) + '.csv', toCsv(excelRows(S.data, storeName, tsOf(now))), 'text/csv;charset=utf-8'); snack('Excel 已下載');
  };
  el.querySelector('#invJsonBtn').onclick = async () => {                        // 928–938 exportConfig
    await flushNow();
    download(exportBaseName(storeName, new Date()) + '.json', JSON.stringify(legacyJson(storeName), null, 2), 'application/json;charset=utf-8'); snack('資料已匯出');
  };
  el.querySelector('#invFinishBtn').onclick = async e => {
    const b = e.currentTarget, msg = el.querySelector('#invFinishMsg');
    b.disabled = true;
    try {
      await flushNow();
      const r = await track('finish', () => api('POST', '/m/inventory/finish', {}));
      S.lastFinish = r.at; msg.textContent = '已完成盤點，這一輪已存進「歷史」（' + new Date(r.at).toLocaleTimeString('zh-TW', { hour12: false }) + '）'; msg.className = 'hint ok';
    } catch (er) { msg.textContent = '完成盤點失敗：' + er.message; msg.className = 'hint warn'; }
    b.disabled = false;
  };
}
