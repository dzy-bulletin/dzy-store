// 貨單辨識：門市收貨時拍廠商貨單送出。流程與規則照原系統門市上傳頁（dzy-purchase/upload.html），外觀用本系統元件。
// 兩個分頁：上傳／我的貨單。照片縮圖要帶入口通行證，所以用 fetch 帶標頭取 Blob，不把 token 放網址。
import { api, apiUpload, apiBlob } from '../../js/api.js';
import { esc, busy, setMsg, fmtTime } from '../../js/ui.js';

const MAX_PHOTOS = 6;
const MAX_SIDE = 2400, JPEG_QUALITY = 0.85;   // 前端壓縮規則：長邊 2400px、JPEG 0.85（同原上傳頁）
const STATUS_TEXT = { uploaded: '已送出', queued: '已送出', recognizing: '辨識中', review: '待核對', confirmed: '已入帳', failed: '辨識失敗', returned: '退回重拍' };
const STATUS_CLS = { confirmed: 'ok', failed: 'bad', returned: 'bad' };

// 跨分頁保留的待送內容（切到「我的貨單」再回來不會掉）
let staged = [];          // [{ blob, url }]
let batchCid = null;      // 同一批照片只產生一次 client_id；送出成功才換新的，失敗重按沿用，伺服器就不會收兩筆
let vendors = null;
let vendorSel = '', vendorOther = '';
let sending = false;
let lastOk = '';          // 剛送出成功的提示，回到上傳頁還看得到
let thumbUrls = [];       // 「我的貨單」裡建立的縮圖網址，換頁時一併釋放
let sessKey = null;       // 目前這些狀態屬於哪一次登入（比照收支登記）：換了登入就全部清掉，不留上一家店的廠商清單與待送照片

function resetFor(key) {
  if (sessKey === key) return;
  staged.forEach(s => URL.revokeObjectURL(s.url));
  releaseThumbs();
  staged = []; batchCid = null; vendors = null; vendorSel = vendorOther = ''; lastOk = ''; sending = false;
  sessKey = key;
}

function uuid4() {
  if (crypto.randomUUID) return crypto.randomUUID().toLowerCase();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return h.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

function resize(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight, m = Math.max(w, h), k = m > MAX_SIDE ? MAX_SIDE / m : 1;
      const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? res(b) : rej(new Error('縮圖失敗')), 'image/jpeg', JPEG_QUALITY);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('這張照片讀不出來')); };
    img.src = url;
  });
}

// ---------- 上傳 ----------
async function renderUpload(ctx) {
  const el = ctx.el;
  el.innerHTML = `<div class="card" style="max-width:560px">
    <div class="step"><b>1</b><h2>選廠商</h2></div>
    <div class="fld"><select id="vendorSel" aria-label="廠商"><option value="">讀取廠商中…</option></select>
    <input id="vendorName" type="text" placeholder="請輸入廠商名稱" hidden></div>
    <div class="step mt"><b>2</b><h2>拍貨單</h2></div>
    <p class="hint">長單可拍多張，算同一張貨單。最多 ${MAX_PHOTOS} 張。</p>
    <input id="cam" type="file" accept="image/*" capture="environment" hidden>
    <input id="pick" type="file" accept="image/*" multiple hidden>
    <div class="row"><button class="btn" id="camBtn" type="button">拍照</button><button class="btn ghost" id="pickBtn" type="button">從相簿選</button><span class="hint" id="photoCount" style="margin:0"></span></div>
    <div id="thumbs" class="thumbs"></div>
    <button class="btn wide mt" id="sendBtn" type="button">送出這張貨單</button>
    <div id="upMsg" class="err" role="alert"></div>
  </div>`;
  const $ = id => el.querySelector('#' + id);
  const msg = (t, ok) => setMsg($('upMsg'), t, ok);
  if (lastOk) msg(lastOk, true);

  const sel = $('vendorSel'), other = $('vendorName');
  function drawVendors() {
    const list = vendors || [];
    sel.innerHTML = '<option value="">請選擇廠商</option>' + list.map(v => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('') + '<option value="__other">（找不到，手動輸入）</option>';
    sel.value = vendorSel; if (sel.value !== vendorSel) sel.value = '';
    other.hidden = sel.value !== '__other'; other.value = vendorOther;
  }
  drawVendors();
  if (!vendors) {
    const k = sessKey;      // 讀取途中若換了登入，回來的是上一家店的清單，丟掉
    api('POST', '/m/purchase/vendors', {}).then(list => { if (sessKey !== k) return; vendors = list; if (!vendors.length) vendorSel = '__other'; }, () => { if (sessKey !== k) return; vendors = []; vendorSel = '__other'; })
      .then(() => { if (el.isConnected && sessKey === k) drawVendors(); });
  }
  sel.onchange = () => { vendorSel = sel.value; other.hidden = sel.value !== '__other'; msg(''); };
  other.oninput = () => { vendorOther = other.value; };

  function drawThumbs() {
    $('thumbs').innerHTML = staged.map((s, i) => `<div class="thumb"><img src="${s.url}" alt="第${i + 1}張"><button type="button" data-i="${i}" aria-label="刪除第${i + 1}張">✕</button></div>`).join('');
    $('thumbs').querySelectorAll('button').forEach(b => {
      b.onclick = () => { if (sending) return; const s = staged.splice(+b.dataset.i, 1)[0]; URL.revokeObjectURL(s.url); if (!staged.length) batchCid = null; drawThumbs(); };
    });
    $('photoCount').textContent = staged.length ? `已選 ${staged.length}／${MAX_PHOTOS} 張` : '';
  }
  drawThumbs();

  async function addFiles(files) {
    msg('');
    const list = Array.from(files);
    const room = MAX_PHOTOS - staged.length;
    if (list.length > room) msg(room <= 0 ? `最多只能 ${MAX_PHOTOS} 張，請先刪掉幾張再加` : `最多只能 ${MAX_PHOTOS} 張，只加入前 ${room} 張，其餘沒有加入`);
    for (const f of list.slice(0, Math.max(room, 0))) {
      try { const b = await resize(f); if (!batchCid) batchCid = uuid4(); staged.push({ blob: b, url: URL.createObjectURL(b) }); }
      catch (e) { msg(e.message); }
    }
    if (el.isConnected) drawThumbs();
  }
  $('camBtn').onclick = () => $('cam').click();
  $('pickBtn').onclick = () => $('pick').click();
  $('cam').onchange = $('pick').onchange = e => { const inp = e.target; addFiles(inp.files).then(() => { inp.value = ''; }); };

  $('sendBtn').onclick = ev => {
    if (sending) return;
    let v = null;
    if (sel.value === '__other') { const n = other.value.trim(); if (n) v = { vendor_name: n }; }
    else if (sel.value) v = { vendor_id: sel.value };
    if (!v) return msg(sel.value === '__other' ? '請輸入廠商名稱' : '請先選廠商');
    if (!staged.length) return msg('請先拍照或選照片，至少一張');
    if (staged.length > MAX_PHOTOS) return msg(`最多只能 ${MAX_PHOTOS} 張`);
    sending = true;
    msg('');
    const batch = staged.slice();
    const fd = new FormData();
    fd.append('client_id', batchCid || (batchCid = uuid4()));
    if (v.vendor_id) fd.append('vendor_id', v.vendor_id); else fd.append('vendor_name', v.vendor_name);
    batch.forEach((s, i) => fd.append('photos[]', s.blob, `p${i + 1}.jpg`));
    busy(ev.currentTarget, async () => {
      try {
        const r = await apiUpload('/m/purchase/slips', fd);
        batch.forEach(s => URL.revokeObjectURL(s.url));
        staged = []; batchCid = null; vendorSel = vendorOther = '';
        lastOk = `已送出，貨單編號 ${r.id}${r.duplicate ? '（這張先前已收到，沒有重複建立）' : ''}。可到「我的貨單」查看。`;
        if (el.isConnected) { drawVendors(); drawThumbs(); msg(lastOk, true); }
      } catch (e) {
        if (el.isConnected) msg(e.message + (e.code === 'NETWORK' || e.code === 'TIMEOUT' || e.code === 'UPSTREAM' ? '（照片還在，可以再按一次送出，不會重複）' : ''));
      } finally { sending = false; }
    });
  };
}

// ---------- 我的貨單 ----------
function releaseThumbs() { thumbUrls.forEach(u => URL.revokeObjectURL(u)); thumbUrls = []; }

function showBig(url) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg'; bg.id = 'bigPhoto';
  bg.innerHTML = `<div class="modal" style="max-width:520px"><img src="${url}" alt="貨單照片" style="width:100%;border-radius:6px"><div class="row mt"><button class="btn ghost" type="button">關閉</button></div></div>`;
  bg.querySelector('button').onclick = () => bg.remove();
  bg.onclick = e => { if (e.target === bg) bg.remove(); };
  document.body.appendChild(bg);
}

async function openPhotos(box, slip) {
  if (box.dataset.loaded) { box.hidden = !box.hidden; return; }
  box.dataset.loaded = '1'; box.hidden = false;
  box.innerHTML = Array.from({ length: slip.photo_count || 0 }, (_, i) => `<div class="thumb" data-seq="${i + 1}"><span class="hint">讀取中</span></div>`).join('') || '<span class="hint">沒有照片</span>';
  for (let i = 1; i <= (slip.photo_count || 0); i++) {
    const t = box.querySelector(`[data-seq="${i}"]`);
    try {
      const blob = await apiBlob(`/m/purchase/photo/${encodeURIComponent(slip.id)}/${i}`);
      const url = URL.createObjectURL(blob); thumbUrls.push(url);
      t.innerHTML = `<img src="${url}" alt="第${i}張" role="button" tabindex="0">`;
      t.querySelector('img').onclick = () => showBig(url);
    } catch (e) { t.innerHTML = `<span class="err" style="font-size:11px;margin:0">${esc(e.message)}</span>`; }
  }
}

async function renderMine(ctx) {
  const el = ctx.el;
  releaseThumbs();
  el.innerHTML = `<div class="card"><div class="row"><h2 style="margin:0;flex:1">最近 30 天</h2><button class="btn ghost sm" id="refresh" type="button">重新整理</button></div>
    <div id="mineBox" class="hint mt">讀取中…</div></div>`;
  const box = el.querySelector('#mineBox');
  async function load() {
    try {
      const list = await api('POST', '/m/purchase/mine', {});
      if (!el.isConnected) return;
      releaseThumbs();
      if (!list.length) { box.className = 'hint mt'; box.textContent = '最近 30 天還沒有上傳'; return; }
      box.className = 'slips mt';
      box.innerHTML = list.map(s => {
        const ret = s.status === 'returned';
        return `<div class="slip${ret ? ' ret' : ''}" data-id="${esc(s.id)}"><div class="row"><b class="grow">${esc(s.vendor_name || '（未指定廠商）')}</b>
          <span class="tag ${STATUS_CLS[s.status] || ''}" data-status="${esc(s.status)}">${esc(STATUS_TEXT[s.status] || s.status)}</span></div>
          <div class="hint" style="margin:2px 0 0">${esc(s.id)}　${fmtTime(s.uploaded_at)}　${s.photo_count || 0} 張照片</div>
          ${ret ? `<div class="err" style="margin-top:4px">請重新拍照上傳這張貨單${s.return_reason ? '：' + esc(s.return_reason) : ''}</div>` : ''}
          <button class="btn ghost sm mt" type="button" data-photos="${esc(s.id)}">看照片</button>
          <div class="thumbs" hidden></div></div>`;
      }).join('');
      box.querySelectorAll('[data-photos]').forEach(b => {
        b.onclick = () => openPhotos(b.nextElementSibling, list.find(x => x.id === b.dataset.photos));
      });
    } catch (e) { box.className = 'err'; box.textContent = '讀不到上傳紀錄：' + e.message; }
  }
  el.querySelector('#refresh').onclick = load;
  load();
}

export default {
  id: 'purchase',
  tabs: [{ id: 'upload', label: '上傳' }, { id: 'mine', label: '我的貨單' }],
  render(ctx) { resetFor(ctx.session.token || ctx.session.code); return ctx.tab === 'mine' ? renderMine(ctx) : renderUpload(ctx); },
};
