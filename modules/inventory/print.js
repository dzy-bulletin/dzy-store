// 列印與匯出（照正本 1212–1391 行）：異常摘要列、食材／包材／全店三張小計、庫存彙整（攤車＋現場合併）、未盤點品項；
// 「列印 PDF」用瀏覽器列印（另存成 PDF）、「匯出 Excel」是帶 BOM 的 CSV、「匯出資料」是舊版相容的 JSON。另有「完成盤點」把這一輪存進歷史並鎖定（店長解鎖前不能改）。
// 鎖定中（這一輪已完成）列印、Excel、畫面金額都用完成盤點那一刻的快照（S.frozen），之後貨單自動改價不影響（price-sync 7.2[14]）；
// 歷史裡的完成盤點也能直接列印／匯出（history.js 共用這裡的 printData／csvData）。
import { esc } from '../../js/ui.js';
import { api } from '../../js/api.js';
import { S, flushStrict, track } from './state.js';
import { buildSummary, fmt, excelRows, toCsv, exportBaseName } from './calc.js';
import { snack } from './count.js';

const saved = async () => { try { await flushStrict(); return true; } catch (e) { snack(e.message); return false; } };
const tsOf = now => `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
export const frozenNote = at => `價格以 ${tsOf(new Date(at))} 完成盤點時為準`;
const stampOf = at => at ? '完成盤點：' + tsOf(new Date(at)) + '（價格以這個時間為準）' : '盤點時間：' + tsOf(new Date());

// 列印一份資料：pmEl＝列印頁首的小字；at＝完成盤點時間（有就用它當盤點時間並註明價格基準）
export function printData(pmEl, storeName, at) {
  const now = at ? new Date(at) : new Date();
  pmEl.textContent = (storeName ? storeName + ' ｜ ' : '') + stampOf(at) + '　麻的小辛辣 — 內部使用';
  const old = document.title; document.title = exportBaseName(storeName, now);
  document.body.classList.add('inv-printing');
  const done = () => { document.body.classList.remove('inv-printing'); document.title = old; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done); setTimeout(done, 60000);
  setTimeout(() => window.print(), 100);
}
export function csvData(D, storeName, at) {
  const now = at ? new Date(at) : new Date();
  download(exportBaseName(storeName, now) + '.csv', toCsv(excelRows(D, storeName, stampOf(at).replace(/^(完成盤點|盤點時間)：/, ''))), 'text/csv;charset=utf-8');
}

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

// 報表本體（三張小計／異常摘要列／彙整／未盤點）：列印與匯出頁、歷史的「列印這次盤點」共用，同一次盤點印出來長得一樣
export function subsHtml(sm) {
  return `<div class="inv-subs"><div class="inv-subc food"><span>食材總金額</span><b id="invFood">${fmt(sm.food)}</b></div><div class="inv-subc pack"><span>包材總金額</span><b id="invPack">${fmt(sm.pack)}</b></div>
      <div class="inv-subc total"><span>全店總庫存金額</span><b id="invGrandSum">${fmt(sm.grand)}</b><small>食材＋包材合計</small></div></div>`;
}
export function bodyHtml(sm) {
  const bar = (sm.low + sm.high + sm.missingCount) === 0
    ? '<div class="inv-alertbar clean" id="invAlertBar"><span>✅</span><span>所有品項庫存正常，盤點完整</span></div>'
    : `<div class="inv-alertbar has" id="invAlertBar"><span>⚠️</span><span>${[sm.missingCount ? `${sm.missingCount} 項未盤點` : '', sm.low ? `${sm.low} 項偏低` : '', sm.high ? `${sm.high} 項偏高` : ''].filter(Boolean).join('、')}，請確認庫存</span></div>`;
  const rows = sm.groups.map(g => `<div class="sum-row grp"><span>【${esc(g.cat)}】小計</span><b>${fmt(g.subtotal)}</b></div>` + g.rows.map(r =>
    `<div class="sum-row${r.badge ? ' has-' + r.badge : ''}" data-pid="${esc(r.pid)}"><span class="nm">▸ ${esc(r.name)}</span><span class="rt"><span class="qt">${esc(r.qty)}</span>${r.badge ? `<span class="inv-badge ${r.badge}">${r.badge === 'low' ? '偏低' : '偏高'}</span>` : ''}<b>${fmt(r.total)}</b></span></div>`).join('')).join('');
  const miss = sm.missing.length ? `<section class="card inv-miss"><h2>⚠️ 未盤點品項（攤車＋現場均無數量）<span class="inv-missn">${sm.missing.length} 項</span></h2>${sm.missing.map(i => `<div class="sum-row has-missing"><span class="nm">▸ ${esc(i.name)}</span><span class="inv-badge missing">未盤點</span></div>`).join('')}</section>` : '';
  return `${bar}<section class="card inv-sumcard"><h2>📋 庫存彙整（攤車＋現場）<span class="inv-sumtotal" id="invSumTotal">${fmt(sm.total)}</span></h2>${rows || '<div class="inv-empty">尚無資料</div>'}</section>${miss}`;
}

export function renderPrint(ctx) {
  const el = ctx.el, storeName = ctx.session.name || ctx.session.code || '';
  const F = S.lock && S.frozen ? S.frozen : null, D = F ? F.data : S.data;
  const noSnap = !!S.lock && !F;                   // 存檔時才發現被鎖（別支手機剛完成盤點）：還沒拿到那次的快照，先別印，免得用到之後的價格
  const sm = buildSummary(D);
  el.innerHTML = `<div class="inv-printhead"><div class="ph">麻的小辛辣｜庫存金額彙整報表</div><div class="pm" id="invPm"></div></div>
    ${subsHtml(sm)}
    <div class="inv-noprint"><div class="inv-actions"><button class="btn" id="invPrintBtn" type="button"${noSnap ? ' disabled' : ''}>🖨️ 列印 PDF</button><button class="btn ghost" id="invCsvBtn" type="button"${noSnap ? ' disabled' : ''}>📊 匯出 Excel</button>
      <button class="btn ghost" id="invJsonBtn" type="button">📤 匯出資料（JSON）</button><button class="btn ghost" id="invFinishBtn" type="button"${S.lock || !S.canLock ? ' disabled' : ''}>${S.lock ? '🔒 已鎖定' : '✅ 完成盤點'}</button></div>
      <div class="hint" id="invFinishMsg" role="status">${S.lastFinish ? '上次完成盤點：' + new Date(S.lastFinish).toLocaleString('zh-TW', { hour12: false }) : '還沒有完成過盤點。盤完按「完成盤點」，這一輪的數字會存進「歷史」並鎖定。'}${!S.lock && !S.canLock ? '<br>完成盤點會鎖定盤點，只有店長可以按。' : ''}</div></div>
    ${noSnap ? `<div class="note warn" id="invNoSnap">${S.lockedMeanwhile ? '盤點剛被鎖定（有人完成盤點了），請按上方「重新讀取」後再列印或匯出，金額才會是完成盤點那一刻的價格。' : '盤點是鎖定的，但找不到這次「完成盤點」的紀錄，沒辦法用當時的價格列印。請洽總部處理。'}</div>` : ''}
    ${F ? `<div class="note inv-frozen" id="invFrozen">📌 ${esc(frozenNote(F.at))}：這一輪已完成盤點，列印與 Excel 都用當時的價格，之後的改價不會影響這次的金額。</div>` : ''}
    ${bodyHtml(sm)}`;

  el.querySelector('#invPrintBtn').onclick = async () => {                       // 1343–1357 doPrint
    if (!(await saved())) return;
    printData(el.querySelector('#invPm'), storeName, F ? F.at : null);
  };
  el.querySelector('#invCsvBtn').onclick = async () => {
    if (!(await saved())) return;
    csvData(D, storeName, F ? F.at : null); snack('Excel 已下載');
  };
  el.querySelector('#invJsonBtn').onclick = async () => {                        // 928–938 exportConfig
    if (!(await saved())) return;
    download(exportBaseName(storeName, new Date()) + '.json', JSON.stringify(legacyJson(storeName), null, 2), 'application/json;charset=utf-8'); snack('資料已匯出');
  };
  el.querySelector('#invFinishBtn').onclick = async e => {
    const b = e.currentTarget, msg = el.querySelector('#invFinishMsg');
    b.disabled = true;
    try {
      await flushStrict();
      const r = await track('finish', () => api('POST', '/m/inventory/finish', {}));
      S.lastFinish = r.at; S.lock = r.lock || { at: r.at, by: '' }; S.frozen = r.frozen || null;
      ctx.rerender();                                                              // 重畫：上方出現鎖定列、按鈕變「已鎖定」
      return;
    } catch (er) { msg.textContent = '完成盤點失敗：' + er.message; msg.className = 'hint warn'; }
    b.disabled = false;
  };
}
