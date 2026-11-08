// 貨單價格同步的畫面（docs/price-sync/spec.md 3.5、7.2；task.md T13、T14）：只在這家店有開同步（mode 不是 off）時出現。
// 商品價格頁多：每列「貨單對照」「不自動更新」「改價紀錄」；頁首四個分頁籤（商品價格／待確認／還沒對上／換不過去）；
// 預覽模式（preview）頁首多「第一次同步對照表」，按「套用」只限 Eason。盤點鎖定時這一區照常能用（價格確認不受盤點鎖定影響，P3 決定）。
import { esc, confirmBox } from '../../js/ui.js';
import { api, apiBlob } from '../../js/api.js';
import { S } from './state.js';
import { snack } from './count.js';

const FRESH_MS = 30000;
export const PS = { st: null, at: 0, sub: 'list', key: null, seen: new Set() };     // seen：看過貨單照片的待確認（標紅的要先看才能套用）
const money = n => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('zh-TW', { maximumFractionDigits: 2 }));
const pctTxt = p => (p === null || p === undefined ? '' : (p > 0 ? '+' : '') + p + '%');
const REASON = { jump10: '漲跌超過 1 成', jump50: '漲跌超過 5 成（請先看貨單照片）', first_price: '原本沒有價格', tax_unknown: '貨單沒寫稅額，不知道含不含稅', revert_conflict: '貨單取消入帳，要不要退回原價', recheck: '取消入帳後重算出來的，請確認' };
const CHOICE = { apply: '套用', dismiss: '不改', taxfree: '這張是免稅，原價就是未稅', tax5: '含 5% 稅，扣掉再用' };

export async function loadSync(force) {
  const key = S.key;
  if (!force && PS.st && PS.key === key && Date.now() - PS.at < FRESH_MS) return PS.st;
  try { PS.st = await api('POST', '/m/inventory/priceSync', {}); }
  catch (e) { PS.st = { mode: 'off', error: e.code === 'NOT_FOUND' ? null : e.message }; PS.at = 0; PS.key = key; return PS.st; }   // 舊版伺服器（沒有這個動作）＝沒開；其他錯誤要顯示、也不快取（Codex #9）
  PS.key = key; PS.at = Date.now();
  return PS.st;
}
export const syncOn = () => !!(PS.st && PS.st.mode && PS.st.mode !== 'off');
const linksOf = pid => (PS.st.links || []).filter(l => l.pid === pid);

// 商品表多兩欄：貨單對照（＋對應、× 拿掉）、不自動更新；品名旁的 🕘＝改價紀錄
export const syncHead = () => syncOn() ? '<th class="inv-sync">貨單對照</th><th class="inv-sync">不自動更新</th>' : '';
export function syncCells(p) {
  if (!syncOn()) return '';
  const chips = linksOf(p.id).map(l => `<span class="ps-chip">${esc(l.itemName || '品項 ' + l.itemId)}／${esc(l.unit || '')}${l.ratio !== 1 ? ` ×${esc(+Number(l.ratio).toPrecision(4))}` : ''}<button type="button" class="ps-x" data-ps="unlink" data-item="${l.itemId}" data-unit="${esc(l.unit || '')}" aria-label="拿掉這個對照">×</button></span>`).join('');
  const off = (PS.st.autoOff || []).includes(p.id);
  return `<td class="inv-sync ps-links">${chips}<button type="button" class="btn ghost sm" data-ps="pick" data-pid="${esc(p.id)}">＋對應</button></td>
    <td class="inv-sync ps-c"><input type="checkbox" data-ps="autooff" data-pid="${esc(p.id)}"${off ? ' checked' : ''} aria-label="不自動更新"></td>`;
}
export const logBtn = p => syncOn() ? `<button type="button" class="ps-log inv-sync" data-ps="log" data-pid="${esc(p.id)}" title="改價紀錄" aria-label="改價紀錄">🕘</button>` : '';

// 頁首：分頁籤＋（preview）首次同步提示
export function syncTop() {
  if (PS.st && PS.st.error) return `<div class="note warn inv-sync" id="psErr">貨單價格同步的資料讀不到（${esc(PS.st.error)}），先顯示商品價格；請稍後重新整理。</div>`;
  if (!syncOn()) return '';
  const c = PS.st.counts || {}, tab = (id, label, n) => `<button type="button" class="ps-tab${PS.sub === id ? ' on' : ''}" data-ps="sub" data-sub="${id}">${label}${n ? ` <b>${n}</b>` : ''}</button>`;
  const first = PS.st.mode === 'preview' ? `<div class="note ps-first inv-sync"><b>貨單價格同步：第一次同步前</b>，目前只收貨單、不改任何價格。對照都對好之後，請 Eason 打開對照表看過按「套用」，價格才會開始跟著貨單更新。
    <div class="mt"><button type="button" class="btn sm" data-ps="first">看第一次同步對照表</button></div></div>` : '';
  const stop = PS.st.stopped === 'epoch' ? '<div class="note warn inv-sync">貨單資料庫換過（從備份還原），這家店的價格同步已暫停，請總部在 Mac mini 上「重建」後才會恢復。</div>' : '';
  return `${stop}${first}<div class="ps-tabs inv-sync" role="tablist">${tab('list', '商品價格', 0)}${tab('pending', '待確認', c.pending)}${tab('unmatched', '還沒對上', c.unmatched)}${tab('unconv', '換不過去', c.unconvertible)}</div>`;
}

// ---------- 各分頁內容 ----------
async function pendingHtml() {
  const r = await api('POST', '/m/inventory/pendingList', {});
  if (!r.items.length) return '<div class="card inv-sync"><div class="inv-empty">沒有要確認的價格</div></div>';
  const can = r.canConfirm;
  return `${can ? '' : '<div class="note inv-sync">你沒有「價格確認」權限，只能看。要套用或不改，請店長在「本店同仁權限」幫你開「價格確認」。</div>'}` + r.items.map(q => {
    const photo = (q.photos || []).length && q.slipId ? `<button type="button" class="btn ghost sm" data-ps="photo" data-q="${q.id}" data-slip="${esc(q.slipId)}" data-seq="${q.photos[0]}">🧾 看貨單照片</button>` : '';
    const needPhoto = q.red && (q.photos || []).length > 0 && !PS.seen.has(q.id);     // 沒有照片的單不卡（Fable 🟢3）
    const btns = can ? q.choices.map(c => `<button type="button" class="btn${c === 'dismiss' ? ' ghost' : ''} sm" data-ps="resolve" data-q="${q.id}" data-choice="${c}"${c !== 'dismiss' && needPhoto ? ' disabled title="請先看貨單照片"' : ''}>${esc(CHOICE[c])}</button>`).join('') : '';
    const changed = q.currentPrice !== null && q.currentPrice !== undefined && Math.abs(q.currentPrice - q.prevPrice) >= 0.005;
    const created = changed ? `<div class="ps-sub ps-bad">建立時是 ${money(q.prevPrice)}，之後已經改成 ${money(q.currentPrice)}；按套用會重新檢查</div>` : '';   // 兩邊都抓到：卡片的「現價」要是現在的價格
    return `<div class="card ps-card inv-sync${q.red ? ' red' : ''}" data-q="${q.id}"><div class="ps-h"><b>${esc(q.productName || q.pid)}</b><span class="tag${q.red ? ' bad' : ''}">${esc(REASON[q.reason] || q.reason)}</span></div>
      <div class="ps-line">現價 ${money(changed ? q.currentPrice : q.prevPrice)} → 貨單算出 <b>${money(q.proposedPrice)}</b> ${(changed ? q.pctNow : q.pct) !== null ? `<span class="${Math.abs(changed ? q.pctNow : q.pct) > 50 ? 'ps-bad' : ''}">${pctTxt(changed ? q.pctNow : q.pct)}</span>` : ''}${q.spec ? `<span class="ps-sub">（每 ${esc(q.spec)}${esc(q.unit || '')}）</span>` : ''}</div>${created}
      <div class="ps-sub">${[q.vendor, q.itemName, q.docDate, q.slipId, q.qty ? `數量 ${q.qty}、未稅 ${money(q.netAmount)}` : ''].filter(Boolean).map(esc).join('｜')}</div>
      <div class="inv-actions mt">${photo}${btns}</div>${needPhoto && can ? '<div class="ps-sub">跳動很大：先看貨單照片確認沒有讀錯，才能套用。</div>' : ''}<div class="err" role="alert"></div></div>`;
  }).join('');
}
async function unmatchedHtml() {
  const r = await api('POST', '/m/inventory/unmatchedList', {});
  const note = r.noItem ? `<p class="hint">另外有 ${r.noItem} 列貨單明細，貨單系統還沒認出是哪個品項，要先在貨單系統對好品名才會出現在這裡。</p>` : '';
  if (!r.items.length) return `<div class="card inv-sync"><div class="inv-empty">貨單裡的品項都對上了</div>${note}</div>`;
  return `<div class="card inv-sync"><p class="hint">貨單有、庫存還沒對上的品項。按「對應」選它是哪個庫存商品，並確認「1 個貨單單位＝幾個庫存規格」。</p>${note}
    ${r.items.map(i => `<div class="ps-um" data-item="${i.itemId}" data-unit="${esc(i.unit || '')}"><div><b>${esc(i.itemName || i.rawName || '品項 ' + i.itemId)}</b>／${esc(i.unit || '')}
      <div class="ps-sub">${[i.vendor, i.docDate, i.unitPrice !== null ? `每${i.unit || '單位'}未稅 ${money(i.unitPrice)}` : '', `${i.lines} 筆`].filter(Boolean).map(esc).join('｜')}</div></div>
      <button type="button" class="btn sm" data-ps="match">對應</button><div class="ps-form"></div></div>`).join('')}</div>`;
}
async function unconvHtml() {
  const r = await api('POST', '/m/inventory/unconvertibleList', {});
  if (!r.items.length) return '<div class="card inv-sync"><div class="inv-empty">沒有換不過去的品項</div></div>';
  return `<div class="card inv-sync"><p class="hint">對上了，但最近一張貨單算不出單價，所以這幾項不會自動改價。多半是貨單數量或金額沒讀到，請到貨單系統看那張單。</p>
    ${r.items.map(i => `<div class="ps-um"><div><b>${esc(i.productName || i.pid)}</b> ← ${esc(i.itemName || '')}／${esc(i.unit || '')}<div class="ps-sub">${[i.why, i.docDate, i.slipId].filter(Boolean).map(esc).join('｜')}</div></div></div>`).join('')}</div>`;
}
export async function syncBody(el) {
  const fn = PS.sub === 'pending' ? pendingHtml : PS.sub === 'unmatched' ? unmatchedHtml : PS.sub === 'unconv' ? unconvHtml : null;
  if (!fn) return false;
  el.innerHTML = '<div class="card"><p class="hint" style="margin:0">讀取中…</p></div>';
  try { const h = await fn(); if (el.isConnected) el.innerHTML = h; }
  catch (e) { if (el.isConnected) el.innerHTML = `<div class="card"><div class="err" role="alert">${esc(e.message)}</div></div>`; }
  return true;
}

// ---------- 小視窗 ----------
function sheet(html) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ps-modal" role="dialog">${html}<div class="row mt"><button class="btn ghost" type="button" data-close>關閉</button></div></div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  return { el: bg.querySelector('.modal'), close };
}
async function showLog(pid) {
  const p = Object.values(S.data.products).flat().find(x => x.id === pid);
  const m = sheet(`<h2>改價紀錄：${esc(p ? p.name : pid)}</h2><div class="ps-logl"><p class="hint">讀取中…</p></div>`);
  try {
    const r = await api('POST', '/m/inventory/priceLog', { pid, limit: 20 });
    m.el.querySelector('.ps-logl').innerHTML = r.items.length ? r.items.map(l => `<div class="ps-logr"><span>${esc(new Date(l.at).toLocaleString('zh-TW', { hour12: false }))}</span><span class="tag">${esc(l.sourceLabel)}</span>
      <span>${money(l.oldPrice)} → <b>${money(l.newPrice)}</b></span><div class="ps-sub">${[l.slipId, l.docDate, l.by, l.note].filter(Boolean).map(esc).join('｜')}</div></div>`).join('') : '<div class="inv-empty">還沒有改價紀錄</div>';
  } catch (e) { m.el.querySelector('.ps-logl').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
async function showPhoto(slip, seq) {
  const m = sheet(`<h2>貨單照片 ${esc(slip)}</h2><div class="ps-photo"><p class="hint">讀取中…</p></div>`);
  try {
    const url = URL.createObjectURL(await apiBlob(`/m/purchase/photo/${encodeURIComponent(slip)}/${encodeURIComponent(seq)}`));
    m.el.querySelector('.ps-photo').innerHTML = `<img src="${url}" alt="貨單照片">`;
    return true;
  } catch (e) {
    // 照片讀不到就不放行（Codex #7）；沒開貨單辨識的人，要自己按「我已經在貨單系統看過這張單」才解鎖
    m.el.querySelector('.ps-photo').innerHTML = `<div class="err">${esc(e.code === 'FORBIDDEN' ? '你的帳號沒有開「貨單辨識」，這裡看不到照片。請到貨單系統看這張單，確認數量、單位、金額沒讀錯。' : '照片讀不到：' + e.message)}</div>
      ${e.code === 'FORBIDDEN' ? '<button type="button" class="btn ghost sm mt" data-seen-ok>我已經在貨單系統看過這張單</button>' : ''}`;
    const ok = m.el.querySelector('[data-seen-ok]');
    if (!ok) return false;
    return new Promise(resolve => { ok.onclick = () => { m.close(); resolve(true); }; m.el.closest('.modal-bg').addEventListener('click', ev => { if (ev.target.closest('[data-close]')) resolve(false); }); });
  }
}
// 對應表單：選庫存商品（相似的排前面）＋ratio（系統先填建議，克／毫升這種要人填）
async function matchForm(box, itemId, unit, pid) {
  box.innerHTML = '<p class="hint">讀取中…</p>';
  let r;
  try { r = await api('POST', '/m/inventory/linkSuggest', { item_id: itemId, unit, pid: pid || undefined }); }
  catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const all = Object.entries(S.data.products).flatMap(([cat, ps]) => ps.map(p => ({ cat, p })));
  const sel = pid || (r.current && r.current.pid) || (r.candidates[0] && r.candidates[0].pid) || '';
  const opt = ({ p }) => `<option value="${esc(p.id)}"${p.id === sel ? ' selected' : ''}>${esc(p.name)}（${esc(p.spec)}${esc(p.unit)}，${money(p.price)} 元）</option>`;
  const candIds = new Set(r.candidates.map(c => c.pid));
  const ratio0 = pid ? r.ratio : (r.current ? r.current.ratio : (r.candidates.find(c => c.pid === sel) || {}).ratio);
  box.innerHTML = `<div class="ps-mf"><div class="ps-sub">貨單：${esc(r.item.itemName || r.item.rawName || '')}／${esc(r.item.unit || '')}${r.item.unitPrice !== null ? `，最近一張每${esc(r.item.unit || '單位')}未稅 ${money(r.item.unitPrice)} 元` : ''}</div>
    <div class="fld"><label>對到哪個庫存商品</label><select class="ps-pid">${r.candidates.length ? `<optgroup label="名字相近">${all.filter(x => candIds.has(x.p.id)).map(opt).join('')}</optgroup>` : ''}<optgroup label="全部">${all.filter(x => !candIds.has(x.p.id)).map(opt).join('')}</optgroup></select></div>
    <div class="fld"><label>1 ${esc(r.item.unit || '個貨單單位')}＝幾個庫存規格</label><input class="ps-ratio" type="number" inputmode="decimal" step="any" min="0" value="${ratio0 === null || ratio0 === undefined ? '' : esc(ratio0)}" placeholder="${r.weightUnit ? '請填（貨單是以重量計）' : '1'}"></div>
    ${r.weightUnit ? '<div class="ps-sub">這個品項貨單是用克／毫升算的，系統不預設，請算好再填（例：庫存規格 600 克，1 克＝0.001667 個）。</div>' : ''}
    <div class="ps-prev ps-sub"></div><div class="row"><button type="button" class="btn sm" data-ps="save">存對照</button><button type="button" class="btn ghost sm" data-ps="cancel">取消</button></div><div class="err" role="alert"></div></div>`;
  const preview = () => {
    const p = all.find(x => x.p.id === box.querySelector('.ps-pid').value), ratio = parseFloat(box.querySelector('.ps-ratio').value);
    box.querySelector('.ps-prev').textContent = p && ratio > 0 && r.item.unitPrice !== null ? `照最近一張算：每 ${p.p.spec}${p.p.unit} ${money(Math.round(r.item.unitPrice / ratio * 100) / 100)} 元（現價 ${money(p.p.price)}）` : '';
  };
  box.querySelector('.ps-pid').onchange = () => matchForm(box, itemId, unit, box.querySelector('.ps-pid').value);
  box.querySelector('.ps-ratio').oninput = preview; preview();
}

// ---------- 事件（掛在商品價格頁的根元素上） ----------
export function bindSync(root, ctx, redraw) {
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-ps]'); if (!b || b.tagName === 'INPUT') return;
    const act = b.dataset.ps;
    if (act === 'sub') { PS.sub = b.dataset.sub; return redraw(); }
    if (act === 'log') return showLog(b.dataset.pid);
    if (act === 'first') return firstSync(ctx, redraw);
    if (act === 'photo') { if (await showPhoto(b.dataset.slip, b.dataset.seq)) { PS.seen.add(Number(b.dataset.q)); redraw(false); } return; }
    if (act === 'resolve') {
      const card = b.closest('.ps-card'), err = card.querySelector('.err');
      if (b.dataset.choice !== 'dismiss' && !(await confirmBox(`確定「${CHOICE[b.dataset.choice]}」？`, '確定'))) return;
      b.disabled = true;
      try {
        const r = await api('POST', '/m/inventory/pendingResolve', { id: Number(b.dataset.q), choice: b.dataset.choice, seenPhoto: PS.seen.has(Number(b.dataset.q)) || undefined });
        if (r.stale) await confirmBox(r.message, '知道了');
        else snack(r.status === 'applied' ? `已套用，現價 ${money(r.price)} 元` : '已記下不改');
        await refreshAfterWrite(); return redraw();
      } catch (er) { err.textContent = er.message; b.disabled = false; }
      return;
    }
    if (act === 'unlink') {
      if (!(await confirmBox('拿掉這個對照？之後這個貨單品項就不會再改這個商品的價格。', '拿掉'))) return;
      try { await api('POST', '/m/inventory/linkDelete', { item_id: Number(b.dataset.item), unit: b.dataset.unit || null }); await refreshAfterWrite(); redraw(); }
      catch (er) { snack('拿掉失敗：' + er.message); }
      return;
    }
    if (act === 'pick') return pickItem(b.dataset.pid, ctx, redraw);
    if (act === 'match') { const row = b.closest('.ps-um'); return matchForm(row.querySelector('.ps-form'), Number(row.dataset.item), row.dataset.unit || null); }
    if (act === 'cancel') { b.closest('.ps-form').innerHTML = ''; return; }
    if (act === 'save') {
      const box = b.closest('.ps-form'), row = b.closest('[data-item]'), err = box.querySelector('.err');
      const ratio = parseFloat(box.querySelector('.ps-ratio').value);
      if (!(ratio > 0)) { err.textContent = '「1 個貨單單位＝幾個庫存規格」要填大於 0 的數字'; return; }
      b.disabled = true;
      try {
        const r = await api('POST', '/m/inventory/linkSave', { item_id: Number(row.dataset.item), unit: row.dataset.unit || null, pid: box.querySelector('.ps-pid').value, ratio });
        snack(r.applied ? `已對上，價格照貨單更新成 ${money(r.price)} 元` : r.pending ? '已對上，價格變動較大，已放進「待確認」' : '已對上');
        const sm = document.querySelector('.ps-modal'); if (sm && sm.contains(b)) sm.closest('.modal-bg').remove();
        await refreshAfterWrite(); redraw();
      } catch (er) { err.textContent = er.message; b.disabled = false; }
    }
  });
  root.addEventListener('change', async e => {
    const inp = e.target; if (inp.dataset.ps !== 'autooff') return;
    try { await api('POST', '/m/inventory/setAutoOff', { pid: inp.dataset.pid, off: inp.checked }); await refreshAfterWrite(); snack(inp.checked ? '這個商品不會再被貨單改價' : '已恢復跟著貨單更新'); redraw(); }
    catch (er) { inp.checked = !inp.checked; snack('存不成功：' + er.message); }
  });
}
// 寫入後：同步狀態重讀，商品價格（可能被自動改了）也重讀
async function refreshAfterWrite() {
  await loadSync(true);
  try { const d = await api('POST', '/m/inventory/bootstrap', {}); S.data.products = d.data.products; }
  catch (e) { snack('已存好，但最新的商品價格讀不到，請按上方「重新讀取」'); S.loaded = false; }   // 不要靜靜留著舊價格（Codex #9）
}
// 從商品那一列「＋對應」：列出還沒對上的貨單品項讓人挑
async function pickItem(pid, ctx, redraw) {
  const p = Object.values(S.data.products).flat().find(x => x.id === pid);
  const m = sheet(`<h2>「${esc(p ? p.name : pid)}」對應貨單品項</h2><div class="ps-pick"><p class="hint">讀取中…</p></div>`);
  m.el.addEventListener('click', ev => {
    const b = ev.target.closest('[data-ps]'); if (!b) return;
    if (b.dataset.ps === 'pickone') { const row = b.closest('.ps-um'); matchForm(row.querySelector('.ps-form'), Number(row.dataset.item), row.dataset.unit || null, pid); }
  });
  bindSync(m.el, ctx, () => { m.close(); redraw(); });
  try {
    const r = await api('POST', '/m/inventory/unmatchedList', {});
    m.el.querySelector('.ps-pick').innerHTML = r.items.length ? r.items.map(i => `<div class="ps-um" data-item="${i.itemId}" data-unit="${esc(i.unit || '')}"><div><b>${esc(i.itemName || i.rawName || '')}</b>／${esc(i.unit || '')}<div class="ps-sub">${[i.vendor, i.docDate, i.unitPrice !== null ? '未稅 ' + money(i.unitPrice) : ''].filter(Boolean).map(esc).join('｜')}</div></div>
      <button type="button" class="btn ghost sm" data-ps="pickone">選這個</button><div class="ps-form"></div></div>`).join('') : '<div class="inv-empty">沒有還沒對上的貨單品項</div>';
  } catch (e) { m.el.querySelector('.ps-pick').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
// 第一次同步對照表（preview）
async function firstSync(ctx, redraw) {
  const m = sheet('<h2>第一次同步對照表</h2><div class="ps-fs"><p class="hint">讀取中…</p></div>');
  m.el.classList.add('ps-wide');
  let r;
  try { r = await api('POST', '/m/inventory/firstSyncPreview', {}); }
  catch (e) { m.el.querySelector('.ps-fs').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const row = x => `<div class="ps-fsr"><b>${esc(x.name)}</b><span class="ps-sub">${esc(x.spec)}${esc(x.unit)}</span><span>${money(x.price)}${x.after !== undefined && x.after !== x.price ? ` → 先照較早的單改成 ${money(x.after)}，再確認` : ''} → <b>${money(x.to !== undefined ? x.to : x.proposed)}</b> ${pctTxt(x.pct)}</span>${x.reason ? `<span class="tag${x.reason === 'jump50' ? ' bad' : ''}">${esc(REASON[x.reason] || x.reason)}</span>` : ''}<span class="ps-sub">${esc([x.docDate, x.slipId].filter(Boolean).join('｜'))}</span></div>`;
  const sec = (title, list, hint) => `<h3 class="inv-h3">${title}（${list.length}）</h3>${hint ? `<p class="hint">${hint}</p>` : ''}${list.length ? list.map(row).join('') : '<div class="inv-empty">沒有</div>'}`;
  m.el.querySelector('.ps-fs').innerHTML = `<p class="hint">這張表是照目前收到的貨單（到第 ${r.throughId} 筆）算的，還沒改任何價格。按「套用」後：第一區直接改價、第二區放進「待確認」，之後進來的貨單照規則自動更新。</p>
    ${r.suspect.length ? sec('⚠️ 疑似單位或規格填錯', r.suspect, '跳超過 5 成，多半是庫存的單位、規格，或對照的換算填錯；請先修好再套用。') : ''}
    ${sec('可以直接改', r.direct)}${sec('要確認（套用後放進「待確認」）', r.confirm)}${sec('換不過去（不會改）', r.unconvertible, '最近的貨單算不出單價，請到貨單系統看那張單。')}
    ${r.autoOff.length ? sec('勾了不自動更新（不會改）', r.autoOff) : ''}
    <div class="mt">${r.owner ? '<button type="button" class="btn" data-fs="apply">套用（開始跟著貨單更新）</button>' : '<p class="hint">只有 Eason 可以按「套用」。</p>'}<div class="err" role="alert"></div></div>`;
  const ab = m.el.querySelector('[data-fs="apply"]');
  if (ab) ab.onclick = async () => {
    if (!(await confirmBox('套用後，這家店的庫存價格會開始跟著貨單自動更新。確定？', '套用'))) return;
    ab.disabled = true;
    try { const x = await api('POST', '/m/inventory/firstSyncApply', { throughId: r.throughId }); m.close(); await refreshAfterWrite(); snack(`已套用：直接改 ${x.direct} 項、待確認 ${x.confirm} 項`); redraw(); }
    catch (e) { m.el.querySelector('.err').textContent = e.message; ab.disabled = false; }
  };
}
