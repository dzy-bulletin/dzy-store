// 歷史：每次「完成盤點」、匯入舊版前的備份、以及自動快照（有變動且距上筆 ≥5 分鐘）。點「查看」只讀，不會改現在的資料。
// 完成盤點那幾筆可以直接列印／匯出 Excel，金額用當時的價格（解鎖、改價之後重印舊盤點，金額不變；price-sync 7.2[14]）。
import { esc } from '../../js/ui.js';
import { api } from '../../js/api.js';
import { buildSummary, itemValue, fmt, findProduct } from './calc.js';
import { printData, csvData, frozenNote, subsHtml, bodyHtml } from './print.js';
import { snack } from './count.js';

const KIND = { finish: '完成盤點', auto: '自動快照', 'import-backup': '匯入前備份' };
const when = iso => new Date(iso).toLocaleString('zh-TW', { hour12: false });

export async function renderHistory(ctx) {
  const el = ctx.el;
  el.innerHTML = '<div class="card"><p class="hint" style="margin:0">讀取中…</p></div>';
  let list;
  try { list = (await api('POST', '/m/inventory/listHistory', { limit: 100 })).items; }
  catch (e) { if (!el.isConnected) return; el.innerHTML = `<div class="card"><div class="err" role="alert">${esc(e.message)}</div></div>`; return; }
  if (!el.isConnected) return;
  el.innerHTML = `<div class="inv-printhead"><div class="ph">麻的小辛辣｜庫存金額彙整報表</div><div class="pm" id="invHPm"></div></div><div class="card inv-noprint"><h2>歷史</h2><p class="hint">「完成盤點」會一定留一筆；平常有改動時，每隔 5 分鐘自動留一筆快照（最多留最近 300 筆）。</p>
    ${list.length ? `<div class="inv-hlist">${list.map(h => `<div class="inv-hitem" data-id="${h.id}"><div><b>${esc(when(h.at))}</b><span class="tag${h.kind === 'finish' ? ' ok' : ''}">${esc(KIND[h.kind] || h.kind)}</span></div><div class="inv-htotal">${fmt(h.total)}</div><button class="btn ghost sm" type="button" data-act="view">查看</button></div>`).join('')}</div>` : '<div class="inv-empty">還沒有歷史紀錄</div>'}</div><div id="invHView"></div>`;
  el.querySelectorAll('[data-act=view]').forEach(b => { b.onclick = async () => {
    const box = el.querySelector('#invHView');
    box.innerHTML = '<div class="card"><p class="hint" style="margin:0">讀取中…</p></div>';
    try {
      const r = await api('POST', '/m/inventory/getHistory', { id: b.closest('.inv-hitem').dataset.id });
      box.innerHTML = viewHtml(r); box.scrollIntoView({ block: 'nearest' });
      const storeName = ctx.session.name || ctx.session.code || '';
      const pb = box.querySelector('#invHPrint'), cb = box.querySelector('#invHCsv');
      if (pb) pb.onclick = () => printData(el.querySelector('#invHPm'), storeName, r.at);
      if (cb) cb.onclick = () => { csvData(r.data, storeName, r.at); snack('Excel 已下載'); };
    }
    catch (e) { box.innerHTML = `<div class="card"><div class="err" role="alert">${esc(e.message)}</div></div>`; }
  }; });
}

function viewHtml(r) {
  const S = r.data, sm = buildSummary(S);
  const zone = (label, cats, items) => {
    const parts = cats.map(c => {
      const ls = (items[c] || []).filter(i => (parseFloat(i.qty) || 0) > 0);
      if (!ls.length) return '';
      return `<div class="sum-row grp"><span>【${esc(c)}】</span><b>${fmt(ls.reduce((s, i) => s + itemValue(S, i), 0))}</b></div>` + ls.map(i => {
        const p = findProduct(S, i.pid);
        return `<div class="sum-row"><span class="nm">▸ ${esc(i.name)}</span><span class="rt"><span class="qt">${esc(i.qty)} × ${esc(i.spec)}${esc(p ? p.unit : '')}</span><b>${fmt(itemValue(S, i))}</b></span></div>`;
      }).join('');
    }).join('');
    return `<h3 class="inv-h3">${label}</h3>${parts || '<div class="inv-empty">沒有數量</div>'}`;
  };
  // 完成盤點：畫面照舊（攤車／現場分開），列印改印跟「列印與匯出」同一種報表（只在列印時顯示）
  const report = r.kind === 'finish' ? `<div class="inv-printonly" id="invHReport">${subsHtml(sm)}${bodyHtml(sm)}</div>` : '';
  const acts = r.kind === 'finish' ? `<div class="inv-actions inv-noprint"><button class="btn" id="invHPrint" type="button">🖨️ 列印這次盤點</button><button class="btn ghost" id="invHCsv" type="button">📊 匯出 Excel</button></div><p class="hint inv-noprint">${esc(frozenNote(r.at))}，之後改過的價格不影響這次的金額。</p>` : '';
  return `${report}<div class="card${r.kind === 'finish' ? ' inv-noprint' : ''}" id="invHDetail"><h2>${esc(when(r.at))}　${esc(KIND[r.kind] || r.kind)}</h2>${acts}
    <div class="inv-subs"><div class="inv-subc food"><span>食材</span><b>${fmt(sm.food)}</b></div><div class="inv-subc pack"><span>包材</span><b>${fmt(sm.pack)}</b></div><div class="inv-subc total"><span>全店總庫存金額</span><b>${fmt(sm.grand)}</b></div></div>
    ${zone('攤車庫存', S.cartCats || [], S.cartItems || {})}${zone('現場庫存', S.stockCats || [], S.stockItems || {})}</div>`;
}
