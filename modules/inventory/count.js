// 攤車庫存／現場庫存（同一份邏輯，照正本 684–927 行）：每個分類一張卡，裡面是盤點列（品名、規格、數量、金額），
// 底下用下拉選商品加一列；可改分類名稱、刪分類、一鍵清除數量。輸入只改記憶體＋標記待存，3 秒後自動存（見 state.js）。
import { esc } from '../../js/ui.js';
import { S, zoneItems, zoneCats, addLine, delLine, clearQty, touch, flushNow, track, paintStatus } from './state.js';
import { api } from '../../js/api.js';
import { findProduct, itemValue, fmt, grandTotal } from './calc.js';

const LABEL = { cart: '攤車庫存', stock: '現場庫存' };
const PINPAN = ['蔬菜', '火鍋料', '常溫食材'];

// 735–750 makeProductSelect：分類名稱跟商品類別同名就只列該類；「拼盤燙炸」合併三類；其他（自訂分類）列全部
function productsFor(cat) {
  const P = S.data.products;
  if (cat === '拼盤燙炸') return PINPAN.flatMap(c => P[c] || []);
  if (P[cat] !== undefined) return P[cat] || [];
  return Object.values(P).flat();
}
const catTotal = (zone, cat) => (zoneItems(zone)[cat] || []).reduce((s, i) => s + itemValue(S.data, i), 0);

function rowHtml(zone, item) {
  const p = findProduct(S.data, item.pid);
  const v = itemValue(S.data, item);
  return `<div class="inv-row" data-id="${esc(item.id)}">
    <div class="inv-rl"><input class="inv-name" type="text" value="${esc(item.name)}" data-f="name" aria-label="品名">
      <div class="inv-sub"><span>規格</span><input class="inv-spec" type="number" inputmode="decimal" value="${esc(item.spec || 1)}" data-f="spec" aria-label="規格"><span class="inv-unit">${esc(p ? p.unit : '—')}</span></div></div>
    <div class="inv-rr"><input class="inv-qty" type="number" inputmode="decimal" min="0" step="1" value="${item.qty ? esc(item.qty) : ''}" placeholder="0" data-f="qty" aria-label="數量"><div class="inv-qlbl">數量</div>
      <div class="inv-val${v === 0 ? ' zero' : ''}">${v > 0 ? fmt(v) : '—'}</div></div>
    <button class="inv-del" type="button" data-act="delrow" aria-label="刪除品項">🗑</button></div>`;
}
function secHtml(zone, cat) {
  const items = zoneItems(zone)[cat] || [];
  const folded = S.collapsed.has(zone + '|' + cat);
  const opts = productsFor(cat).map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.unit)})</option>`).join('');
  return `<section class="card inv-sec${folded ? ' folded' : ''}" data-cat="${esc(cat)}">
    <div class="inv-sec-hdr"><button class="inv-tog" type="button" data-act="tog" aria-expanded="${folded ? 'false' : 'true'}" aria-label="收合或展開">▼</button>
      <input class="inv-title" value="【${esc(cat)}】" data-act="rename" aria-label="分類名稱"><div class="inv-sec-total">${fmt(catTotal(zone, cat))}</div>
      <button class="inv-secdel" type="button" data-act="delcat" aria-label="刪除分類">✕</button></div>
    <div class="inv-sec-body">${items.map(i => rowHtml(zone, i)).join('')}
      <div class="inv-add"><select class="inv-sel" aria-label="選擇商品"><option value="">選擇商品...</option>${opts}</select><button class="btn sm" type="button" data-act="add">＋</button></div></div></section>`;
}

export function renderZone(ctx, zone) {
  const el = ctx.el;
  const cats = zoneCats(zone);
  el.innerHTML = `<div class="inv-bar"><button class="btn ghost sm" type="button" data-act="clear">🧹 一鍵清除數量</button><span class="inv-total" id="invGrand">${fmt(grandTotal(S.data))}</span></div>
    <div class="inv-zone" data-zone="${zone}">${cats.map(c => secHtml(zone, c)).join('') || '<div class="card"><p class="hint" style="margin:0">還沒有分類，請在下面新增。</p></div>'}</div>
    <div class="inv-addcat card"><input id="invNewCat" type="text" placeholder="新分類名稱" maxlength="30"><button class="btn sm" type="button" data-act="addcat">＋ 新增分類</button><div class="err" id="invCatErr" role="alert"></div></div>`;
  const zoneEl = el.querySelector('.inv-zone');
  const secOf = node => node.closest('.inv-sec');
  const catOf = node => secOf(node).dataset.cat;
  const refresh = (sec, rowEl) => {            // 只更新數字，不重畫（輸入中不能搶掉游標）
    const cat = sec.dataset.cat;
    if (rowEl) {
      const item = zoneItems(zone)[cat].find(i => i.id === rowEl.dataset.id);
      const v = itemValue(S.data, item), vEl = rowEl.querySelector('.inv-val');
      vEl.textContent = v > 0 ? fmt(v) : '—'; vEl.className = 'inv-val' + (v > 0 ? '' : ' zero');
    }
    sec.querySelector('.inv-sec-total').textContent = fmt(catTotal(zone, cat));
    el.querySelector('#invGrand').textContent = fmt(grandTotal(S.data));
  };
  const redrawSec = sec => { const cat = sec.dataset.cat; const t = document.createElement('div'); t.innerHTML = secHtml(zone, cat); sec.replaceWith(t.firstElementChild); el.querySelector('#invGrand').textContent = fmt(grandTotal(S.data)); };

  zoneEl.addEventListener('input', e => {
    const inp = e.target, rowEl = inp.closest('.inv-row'); if (!rowEl) return;
    const sec = secOf(inp), item = zoneItems(zone)[catOf(inp)].find(i => i.id === rowEl.dataset.id); if (!item) return;
    const f = inp.dataset.f;
    if (f === 'qty') item.qty = parseFloat(inp.value) || 0;                 // 810 updateInvQty
    else if (f === 'spec') item.spec = parseFloat(inp.value) || 1;          // 823 updateInvMeta
    else return;
    touch(zone, item.id); refresh(sec, rowEl);
  });
  zoneEl.addEventListener('change', e => {
    const inp = e.target;
    if (inp.dataset.f === 'name') {
      const rowEl = inp.closest('.inv-row'), item = zoneItems(zone)[catOf(inp)].find(i => i.id === rowEl.dataset.id);
      if (item) { item.name = inp.value; touch(zone, item.id); }
    } else if (inp.dataset.act === 'rename') renameCat(secOf(inp), inp);
  });
  zoneEl.addEventListener('focusin', e => { if (e.target.dataset.act === 'rename') e.target.select(); });
  zoneEl.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'INPUT') return;
    const sec = secOf(b), act = b.dataset.act;
    if (act === 'tog') {
      const k = zone + '|' + sec.dataset.cat;
      if (S.collapsed.has(k)) S.collapsed.delete(k); else S.collapsed.add(k);
      sec.classList.toggle('folded', S.collapsed.has(k)); b.setAttribute('aria-expanded', String(!S.collapsed.has(k)));
    } else if (act === 'add') {
      const sel = sec.querySelector('.inv-sel');
      if (!sel.value) { snack('請選擇商品'); return; }
      const line = addLine(zone, sec.dataset.cat, sel.value);
      redrawSec(sec); if (line) snack('已新增：' + line.name);
    } else if (act === 'delrow') {
      delLine(zone, sec.dataset.cat, b.closest('.inv-row').dataset.id); redrawSec(sec); snack('已刪除品項');
    } else if (act === 'delcat') {
      const cat = sec.dataset.cat;
      if (!confirm(`確定刪除「${cat}」分類？\n分類內所有品項將一併刪除，此動作無法復原。`)) return;
      await saveCats(zoneCats(zone).filter(c => c !== cat), []);
    }
  });
  async function saveCats(list, renames) {
    try {
      await flushNow();
      await track('cats:' + zone, async () => { await api('POST', '/m/inventory/saveCats', { zone, cats: list, renames }); });
    } catch (er) { el.querySelector('#invCatErr').textContent = er.message; return false; }
    const items = zoneItems(zone), next = {};
    for (const c of list) { const old = (renames.find(r => r.to === c) || {}).from || c; next[c] = items[old] || items[c] || []; }
    if (zone === 'cart') { S.data.cartCats = list; S.data.cartItems = next; } else { S.data.stockCats = list; S.data.stockItems = next; }
    renderZone(ctx, zone);
    return true;
  }
  async function renameCat(sec, inp) {                                       // 895–907
    const old = sec.dataset.cat, nn = inp.value.replace(/[【】]/g, '').trim();
    if (!nn || nn === old) { inp.value = '【' + old + '】'; return; }
    if (zoneCats(zone).includes(nn)) { inp.value = '【' + old + '】'; snack('分類已存在'); return; }
    if (await saveCats(zoneCats(zone).map(c => (c === old ? nn : c)), [{ from: old, to: nn }])) snack('已重新命名：' + nn);
  }
  el.querySelector('[data-act=clear]').onclick = () => {
    const n = Object.values(zoneItems(zone)).reduce((c, arr) => c + (arr || []).filter(i => parseFloat(i.qty) > 0).length, 0);
    if (!n) { snack(LABEL[zone] + '目前沒有數量可清除'); return; }
    if (!confirm(`確定清除「${LABEL[zone]}」全部 ${n} 筆數量？\n（品項與規格會保留，只把數量歸零）`)) return;
    clearQty(zone); renderZone(ctx, zone); snack('已清除' + LABEL[zone] + '數量');
  };
  el.querySelector('[data-act=addcat]').onclick = async () => {
    const inp = el.querySelector('#invNewCat'), name = inp.value.trim();
    el.querySelector('#invCatErr').textContent = '';
    if (!name) { snack('請輸入分類名稱'); return; }
    if (zoneCats(zone).includes(name)) { snack('分類已存在'); return; }
    if (await saveCats([...zoneCats(zone), name], [])) snack('已新增分類：' + name);
  };
  paintStatus();
}

let snackT;
export function snack(msg) {
  let el = document.getElementById('invSnack');
  if (!el) { el = document.createElement('div'); el.id = 'invSnack'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show'); clearTimeout(snackT); snackT = setTimeout(() => el.classList.remove('show'), 2200);
}
