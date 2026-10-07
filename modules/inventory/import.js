// 從舊版匯入：把舊版（手機裡 eason0728.github.io/mala）「匯出資料」存下的 JSON 貼上或選檔，先預覽、確認後整包覆蓋這家店的資料。
// 覆蓋前伺服器會先把目前的整包存成一筆「匯入前備份」歷史，匯錯了可以到「歷史」找回。
import { esc } from '../../js/ui.js';
import { api } from '../../js/api.js';
import { S, flushNow, reload, track } from './state.js';
import { fmt } from './calc.js';

const rowsOf = (a, b) => [['商品類別', 'categories', '個'], ['商品', 'products', '項'], ['攤車盤點列', 'cartLines', '列'], ['現場盤點列', 'stockLines', '列'], ['有數量的盤點列', 'countedLines', '列'], ['已設定門檻的商品', 'thresholds', '項']]
  .map(([n, k, u]) => `<tr><td>${n}</td><td>${a[k]} ${u}</td><td>${b[k]} ${u}</td></tr>`).join('') + `<tr><td>全店庫存金額</td><td>${fmt(a.total)}</td><td>${fmt(b.total)}</td></tr>`;

export function renderImport(ctx) {
  const el = ctx.el;
  el.innerHTML = `<div class="card" id="invImport"><h2>從舊版匯入</h2>
    <p class="hint">舊版庫存 app 存在手機裡，換手機或清快取就沒了。把舊版「匯出資料」存下來的 JSON 檔匯進來，就能接著用。步驟請看操作手冊「庫存盤點」。</p>
    <div class="fld"><label>舊版匯出檔（.json）</label><input id="invFile" type="file" accept=".json,application/json" hidden><div class="row"><button class="btn ghost" id="invFileBtn" type="button">選擇檔案</button><span class="hint" id="invFileName" style="margin:0"></span></div></div>
    <div class="fld mt"><label for="invText">或把檔案內容貼在這裡</label><textarea id="invText" rows="6" placeholder='{"products": {…}, "cartItems": {…} …}' spellcheck="false"></textarea></div>
    <div class="row mt"><button class="btn" id="invPreview" type="button">預覽</button></div><div class="err" id="invImpErr" role="alert"></div><div id="invImpBox"></div></div>`;
  const err = el.querySelector('#invImpErr'), box = el.querySelector('#invImpBox'), text = el.querySelector('#invText');
  el.querySelector('#invFileBtn').onclick = () => el.querySelector('#invFile').click();
  el.querySelector('#invFile').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    el.querySelector('#invFileName').textContent = f.name;
    const rd = new FileReader(); rd.onload = () => { text.value = String(rd.result); err.textContent = ''; box.innerHTML = ''; }; rd.onerror = () => { err.textContent = '這個檔案讀不到，換一個再試'; }; rd.readAsText(f);
  };
  const parse = () => { try { return JSON.parse(text.value); } catch (e) { err.textContent = '這不是正確的 JSON 檔（可能複製不完整），請重新匯出或重新選檔'; return undefined; } };
  el.querySelector('#invPreview').onclick = async () => {
    err.textContent = ''; box.innerHTML = '';
    if (!text.value.trim()) { err.textContent = '請先選擇檔案或貼上內容'; return; }
    const data = parse(); if (data === undefined) return;
    try {
      await flushNow();
      const r = await api('POST', '/m/inventory/importLegacy', { data });
      box.innerHTML = `<div class="note"><b>預覽（還沒有匯入）</b>：匯入後會「整包覆蓋」目前這家店的商品、價格、門檻、攤車與現場的盤點。覆蓋前會先把目前的資料存成一筆「匯入前備份」歷史。</div>
        <div class="scroll"><table class="inv-ptable" id="invImpTable"><thead><tr><th>項目</th><th>目前</th><th>匯入後</th></tr></thead><tbody>${rowsOf(r.current, r.preview)}</tbody></table></div>
        ${r.dropped ? `<p class="hint">有 ${r.dropped} 筆盤點列的商品在檔案裡找不到，不會匯入。</p>` : ''}
        <div class="row mt"><button class="btn" id="invConfirm" type="button">確認匯入（覆蓋目前資料）</button></div>`;
      box.querySelector('#invConfirm').onclick = async b => {
        const btn = b.currentTarget;
        if (!confirm('匯入後會覆蓋這家店目前所有資料（商品設定、攤車庫存、現場庫存）。\n覆蓋前會先備份一份到「歷史」。確定繼續？')) return;
        btn.disabled = true;
        try {
          const done = await track('import', () => api('POST', '/m/inventory/importLegacy', { data, confirm: true }));
          await reload();
          box.innerHTML = `<div class="note" id="invImpDone"><b>匯入完成。</b>已匯入 ${done.preview.products} 項商品、${done.preview.cartLines + done.preview.stockLines} 列盤點，全店庫存金額 ${fmt(done.preview.total)}。匯入前的資料已備份在「歷史」（匯入前備份）。</div>`;
          text.value = '';
        } catch (e) { err.textContent = e.message; btn.disabled = false; }
      };
    } catch (e) { err.textContent = e.message; }
  };
}
