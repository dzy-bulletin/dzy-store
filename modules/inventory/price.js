// 商品價格（照正本「商品管理」984–1115 行）＋異常通知門檻（正本 1118–1165，原本藏在「長按總金額 3 秒」的後台，這裡直接放在每個商品那一列）。
// 單位成本＝價格÷規格；門檻是「盤點列金額（元）」，低於「低於」的算偏低、高於「高於」的算偏高，留空＝不設定。
// 欄位改完離開（change）就存；存不成功狀態燈會顯示失敗，按狀態燈重試。
import { esc } from '../../js/ui.js';
import { api } from '../../js/api.js';
import { S, track, flushNow } from './state.js';
import { pgForProduct, fmtpg } from './calc.js';
import { snack } from './count.js';

const numStr = v => (v === null || v === undefined ? '' : String(v));

function tableHtml(cat) {
  const rows = (S.data.products[cat] || []).map(p => {
    const t = S.data.thresholds[p.id] || { low: null, high: null };
    return `<tr data-pid="${esc(p.id)}">
      <td><input class="pn" value="${esc(p.name)}" data-f="name" aria-label="品名"></td>
      <td><input class="pp" type="number" inputmode="decimal" value="${esc(p.price)}" data-f="price" aria-label="價格"></td>
      <td><input class="ps" type="number" inputmode="decimal" value="${esc(p.spec)}" data-f="spec" aria-label="規格"></td>
      <td><input class="pu" value="${esc(p.unit)}" data-f="unit" aria-label="單位"></td>
      <td class="cmp">${fmtpg(pgForProduct(p))}</td>
      <td><input class="pt" type="number" inputmode="decimal" placeholder="不設定" value="${esc(numStr(t.low))}" data-t="low" aria-label="低於幾元算偏低"></td>
      <td><input class="pt" type="number" inputmode="decimal" placeholder="不設定" value="${esc(numStr(t.high))}" data-t="high" aria-label="高於幾元算偏高"></td>
      <td><button class="btn ghost sm" type="button" data-act="del">刪除</button></td></tr>`;
  }).join('');
  return `<section class="card inv-pcat" data-cat="${esc(cat)}"><h2>【${esc(cat)}】</h2>
    <div class="scroll"><table class="inv-ptable"><thead><tr><th>品名</th><th>價格(元)</th><th>規格</th><th>單位</th><th>每克/件(元)</th><th>低於(元)</th><th>高於(元)</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="inv-padd"><div class="inv-padd-t">＋ 新增品項到「${esc(cat)}」</div>
      <div class="row"><div class="fld grow"><label>品名</label><input type="text" class="an" placeholder="例：新品（包）" maxlength="60"></div>
      <div class="fld"><label>價格(元)</label><input type="number" inputmode="decimal" class="ap" placeholder="0"></div>
      <div class="fld"><label>規格數量</label><input type="number" inputmode="decimal" class="as" placeholder="1"></div>
      <div class="fld"><label>單位</label><input type="text" class="au" placeholder="克" maxlength="8"></div></div>
      <button class="btn sm mt" type="button" data-act="add">＋ 新增</button><div class="err" role="alert"></div></div></section>`;
}

export function renderPrice(ctx) {
  const el = ctx.el;
  const cats = Object.keys(S.data.products);
  el.innerHTML = `<div id="invPrice"><p class="hint">價格、規格改完離開欄位就自動存。「低於／高於」是盤點列金額（元），列印頁會用它標示偏低、偏高。</p>
    ${cats.map(tableHtml).join('')}
    <div class="inv-addcat card"><input id="invNewPCat" type="text" placeholder="新商品類別名稱" maxlength="30"><button class="btn sm" type="button" data-act="addcat">＋ 新增類別</button><div class="err" id="invPCatErr" role="alert"></div></div></div>`;
  const root = el.querySelector('#invPrice');

  const productOf = tr => (S.data.products[tr.closest('.inv-pcat').dataset.cat] || []).find(p => p.id === tr.dataset.pid);
  root.addEventListener('change', async e => {
    const inp = e.target, tr = inp.closest('tr[data-pid]'); if (!tr) return;
    const p = productOf(tr); if (!p) return;
    if (inp.dataset.t) {                                                      // 1121–1129 setThresh
      const v = inp.value === '' ? null : parseFloat(inp.value);
      const t = S.data.thresholds[p.id] || (S.data.thresholds[p.id] = { low: null, high: null });
      t[inp.dataset.t] = v === null || isNaN(v) ? null : v;
      const send = () => api('POST', '/m/inventory/saveThreshold', { pid: p.id, low: t.low, high: t.high });
      try { await track('th:' + p.id, send); } catch (er) { /* 狀態燈顯示 */ }
      return;
    }
    const f = inp.dataset.f;                                                  // 1061–1073 pUpd
    if (f === 'name' || f === 'unit') { if (f === 'name' && !inp.value.trim()) { inp.value = p.name; return; } p[f] = inp.value.trim() || (f === 'unit' ? '克' : p.name); }
    else p[f] = parseFloat(inp.value) || 0;
    if (f === 'spec' && !(p.spec > 0)) p.spec = 0;
    tr.querySelector('.cmp').textContent = fmtpg(pgForProduct(p));
    if (f === 'name') Object.values([S.data.cartItems, S.data.stockItems]).forEach(m => Object.values(m).forEach(arr => arr.forEach(i => { if (i.pid === p.id) i.name = p.name; })));   // 正本 syncInvItemMeta：只同步品名
    try { await track('prod:' + p.id, () => api('POST', '/m/inventory/saveProduct', { id: p.id, name: p.name, price: p.price, spec: p.spec || 1, unit: p.unit })); } catch (er) { /* 狀態燈顯示 */ }
  });
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'del') {
      const tr = b.closest('tr'), p = productOf(tr), cat = tr.closest('.inv-pcat').dataset.cat;
      if (!confirm('確定刪除此商品？攤車與現場庫存中同品項的盤點資料將一併自動移除。')) return;       // 1075
      try {
        await flushNow();
        await track('del:' + p.id, () => api('POST', '/m/inventory/deleteProduct', { id: p.id }));
      } catch (er) { snack('刪除失敗：' + er.message); return; }
      S.data.products[cat] = S.data.products[cat].filter(x => x.id !== p.id); delete S.data.thresholds[p.id];
      [S.data.cartItems, S.data.stockItems].forEach(m => Object.keys(m).forEach(c => { m[c] = m[c].filter(i => i.pid !== p.id); }));
      renderPrice(ctx); snack('已刪除，庫存已同步');
    } else if (act === 'add') {                                                // 1080–1093 pAdd
      const box = b.closest('.inv-pcat'), cat = box.dataset.cat, err = box.querySelector('.err');
      const name = box.querySelector('.an').value.trim();
      err.textContent = '';
      if (!name) { err.textContent = '請填入品名'; return; }
      const body = { cat, name, price: parseFloat(box.querySelector('.ap').value) || 0, spec: parseFloat(box.querySelector('.as').value) || 1, unit: box.querySelector('.au').value.trim() || '克' };
      try {
        const r = await track('add:' + Date.now(), () => api('POST', '/m/inventory/saveProduct', body));
        S.data.products[cat].push(r.product); S.data.thresholds[r.product.id] = r.threshold || { low: null, high: 2000 };
      } catch (er) { err.textContent = er.message; return; }
      renderPrice(ctx); snack('已新增：' + name);
    } else if (act === 'addcat') {                                             // 1101–1109 addPriceCat
      const name = root.querySelector('#invNewPCat').value.trim(), err = root.querySelector('#invPCatErr');
      err.textContent = '';
      if (!name) { err.textContent = '請輸入類別名稱'; return; }
      if (S.data.products[name]) { err.textContent = '類別已存在'; return; }
      try { await track('pcat', () => api('POST', '/m/inventory/saveCats', { zone: 'prod', cats: [...Object.keys(S.data.products), name], renames: [] })); }
      catch (er) { err.textContent = er.message; return; }
      S.data.products[name] = []; renderPrice(ctx); snack('已新增類別：' + name);
    }
  });
}
