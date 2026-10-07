// 記帳分頁：一筆一送。送出後停在同一頁、清空欄位、日期留著，可以連續打下一筆——
// 店長通常是拿著一疊收據一次打完，每打一筆就跳走會很難用。流程與規則照原系統 js/views/entry.js。
import { esc } from '../../js/ui.js';
import { splitTax, summarize, money } from './calc.js';
import * as Mem from './memory.js';
import { S, call, isLocked, monthOf, todayISO, subjectsOf, blankDraft } from './state.js';
import { runBusy } from './busy.js';

export function summaryHtml(rows, month) {
  const s = summarize(rows);
  return `<div class="cb-sum" id="cbSum"><div class="exp"><span>${esc(month)} 支出</span><b>${money(s.expense)}</b></div>
    <div class="inc"><span>收入</span><b>${money(s.income)}</b></div>
    <div class="net"><span>淨額</span><b class="${s.net < 0 ? 'minus' : ''}">${money(s.net)}</b></div></div>`;
}

// 手機拍的收據動輒 3～5MB，壓到長邊 1280、JPEG 0.7——收據上的字還看得清楚，檔案通常降到 200KB 以內。
function compress(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1280 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.7).split(',')[1]);
      };
      img.onerror = () => reject(Object.assign(new Error('PHOTO_FAIL'), { code: 'PHOTO_FAIL' }));
      img.src = reader.result;
    };
    reader.onerror = () => reject(Object.assign(new Error('PHOTO_FAIL'), { code: 'PHOTO_FAIL' }));
    reader.readAsDataURL(file);
  });
}

/* 這一次送出的識別碼（clientToken），後端拿它擋掉重複的第二筆。三條規則：
   ① 同一份內容重按用同一個；② 內容一改就換新的（否則逾時後改金額再送會被當成重複擋掉）；③ 記成功後忘掉（否則真的買兩次一樣的東西記不進去）。 */
let clientToken = '', tokenFor = '';
function tokenOf(p) {
  const key = [p.date, p.kind, p.subject, p.name, p.amount, p.hasInvoice ? 1 : 0].join('|');
  if (key !== tokenFor) { tokenFor = key; clientToken = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  return clientToken;
}
const forgetToken = () => { tokenFor = ''; clientToken = ''; };

export function renderEntry(ctx) {
  const el = ctx.el, D = S.draft;
  el.innerHTML = `${summaryHtml(S.rows, S.month)}
  <div class="card cb-card">
    <div id="cbOk" class="okmsg cb-msg" role="status" hidden></div>
    <div id="cbErr" class="err cb-msg" role="alert"></div>
    <div id="cbLockNote" class="note warn" hidden></div>
    <div class="cb-seg" id="cbKind"><button type="button" data-kind="支出">支出</button><button type="button" data-kind="收入" class="inc">收入</button></div>
    <div class="fld"><label for="cbDate">日期</label><input id="cbDate" type="date"></div>
    <div class="fld"><label for="cbName">項目名稱</label><input id="cbName" type="text" placeholder="例：廠商名—品項" autocomplete="off"></div>
    <div class="cb-chips" id="cbChips"></div>
    <div class="fld"><label for="cbSubject">科目</label><select id="cbSubject"></select></div>
    <div class="hint" id="cbHint"></div>
    <div class="fld"><label for="cbAmount">金額</label><input id="cbAmount" type="number" inputmode="numeric" min="1" step="1" placeholder="0"></div>
    <div class="fld"><label>單據</label><div class="cb-seg" id="cbInv"><button type="button" data-inv="0">收據／無發票</button><button type="button" data-inv="1">統一發票</button></div></div>
    <div class="cb-tax" id="cbTax"></div>
    <div class="fld"><label>收據照片</label><input id="cbPhoto" type="file" accept="image/*" capture="environment" hidden><input id="cbPhotoPick" type="file" accept="image/*" hidden><div class="row"><button class="btn ghost" id="cbPhotoCam" type="button">拍收據</button><button class="btn ghost" id="cbPhotoAlbum" type="button">從相簿選</button></div><div class="hint" id="cbPhotoNote"></div></div>
    <button class="btn wide mt" id="cbSubmit" type="button" data-busy="送出中">送出這一筆</button>
    <button class="btn ghost wide mt" id="cbClear" type="button">清空重填</button>
  </div>`;
  const $ = id => el.querySelector('#' + id);
  const showMsg = (id, text) => { const e = $(id); if (!e) return; e.textContent = text || ''; if (id === 'cbOk') e.hidden = !text; };
  const clearMsgs = () => { showMsg('cbOk', ''); showMsg('cbErr', ''); };
  const subjects = () => subjectsOf(S.kind);

  function drawSubjects() {
    const sel = $('cbSubject');
    sel.innerHTML = subjects().map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if (subjects().indexOf(D.subject) >= 0) sel.value = D.subject; else D.subject = sel.value;
  }
  function drawKind() { el.querySelectorAll('#cbKind button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.kind === S.kind))); }
  function drawInv() { el.querySelectorAll('#cbInv button').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.inv === '1') === !!D.hasInvoice))); }
  // 候選項目：還沒打字時給最近用過的 8 個，打了字就縮成含有那段字的；點一下＝帶入名稱並順便把科目填好
  function drawChips() {
    $('cbChips').innerHTML = Mem.suggest(S.frequent, $('cbName').value, subjects())
      .map(f => `<button type="button" class="cb-chip" data-name="${esc(f.name)}" data-subject="${esc(f.subject)}">${esc(f.name)}</button>`).join('');
  }
  // 記憶的方向是「項目名稱 → 科目」：打過的名稱自動把科目填好；沒打過的明講沒有紀錄，要自己選一次
  function applyMemory() {
    const name = $('cbName').value.trim(), hint = $('cbHint');
    if (!name) { hint.textContent = ''; hint.className = 'hint'; return; }
    const subject = Mem.subjectOf(S.frequent, name, subjects());
    if (subject) { $('cbSubject').value = subject; D.subject = subject; hint.textContent = `依過去紀錄自動帶入「${subject}」，不對可以改`; hint.className = 'hint ok'; return; }
    // 名稱只打到一半時還有候選，就不要跳警告——那只是還沒打完，不是新項目
    if (Mem.suggest(S.frequent, name, subjects()).length) { hint.textContent = '上面有相符的紀錄，點一下就會連科目一起帶入'; hint.className = 'hint'; }
    else { hint.textContent = '這是新項目，沒有歷史紀錄——請自己選科目，送出後就會記起來'; hint.className = 'hint warn'; }
  }
  function drawTax() {
    const amount = Number($('cbAmount').value) || 0, t = splitTax(amount, D.hasInvoice);
    $('cbTax').innerHTML = amount
      ? `未稅 <b>${t.net.toLocaleString('en-US')}</b>　稅額 <b>${t.tax.toLocaleString('en-US')}</b>　合計 <b>${amount.toLocaleString('en-US')}</b>`
      : (D.hasInvoice ? '有發票：系統會自動拆未稅與稅額' : '沒發票：未稅＝金額，稅額 0');
  }
  function drawLock() {
    const locked = isLocked(monthOf($('cbDate').value));
    const n = $('cbLockNote'); n.hidden = !locked;
    n.textContent = locked ? '這個月已經結帳鎖定，不能再新增。要改請先到「月結」分頁解除鎖定。' : '';
    $('cbSubmit').classList.toggle('is-locked', locked);
    return locked;
  }
  function drawPhoto() { $('cbPhotoNote').textContent = D.photoBase64 ? `已附收據照片（約 ${Math.round(D.photoBase64.length * 0.75 / 1024)} KB）` : ''; }
  function clearForm(keepDate) {
    Object.assign(D, blankDraft(), { date: keepDate ? D.date : todayISO(), subject: D.subject });
    $('cbDate').value = D.date; $('cbName').value = ''; $('cbAmount').value = ''; $('cbPhoto').value = ''; $('cbPhotoPick').value = '';
    $('cbHint').textContent = ''; $('cbHint').className = 'hint';
    drawInv(); drawChips(); drawTax(); drawPhoto(); drawLock();
  }

  // 初始值（草稿跨分頁保留）
  $('cbDate').value = D.date; $('cbName').value = D.name; $('cbAmount').value = D.amount;
  drawKind(); drawSubjects(); drawInv(); drawChips(); drawTax(); drawPhoto(); drawLock();

  el.querySelectorAll('#cbKind button').forEach(b => b.onclick = () => { S.kind = b.dataset.kind; drawKind(); drawSubjects(); drawChips(); applyMemory(); clearMsgs(); });
  el.querySelectorAll('#cbInv button').forEach(b => b.onclick = () => { D.hasInvoice = b.dataset.inv === '1'; drawInv(); drawTax(); });
  $('cbSubject').onchange = () => {
    D.subject = $('cbSubject').value;
    const hint = $('cbHint'); if (hint.classList.contains('ok')) { hint.textContent = ''; hint.className = 'hint'; }   // 手動改過就不再宣稱是自動帶入
  };
  $('cbName').oninput = () => { D.name = $('cbName').value; drawChips(); applyMemory(); };
  $('cbAmount').oninput = () => { D.amount = $('cbAmount').value; drawTax(); };
  $('cbDate').onchange = () => { D.date = $('cbDate').value; drawLock(); };
  $('cbChips').onclick = e => {
    const chip = e.target.closest('.cb-chip'); if (!chip) return;
    $('cbName').value = chip.dataset.name; D.name = chip.dataset.name;
    if (chip.dataset.subject) { $('cbSubject').value = chip.dataset.subject; D.subject = chip.dataset.subject; }
    applyMemory(); drawChips(); $('cbAmount').focus();
  };
  $('cbPhotoCam').onclick = () => $('cbPhoto').click();
  $('cbPhotoAlbum').onclick = () => $('cbPhotoPick').click();
  $('cbPhoto').onchange = $('cbPhotoPick').onchange = e => {
    const file = e.target.files[0]; D.photoBase64 = ''; drawPhoto();
    if (!file) return;
    compress(file).then(b64 => { D.photoBase64 = b64; if (el.isConnected) drawPhoto(); })
      .catch(() => showMsg('cbErr', '這張照片讀不到，換一張或先不拍。'));
  };
  $('cbClear').onclick = () => { clearMsgs(); clearForm(false); };

  $('cbSubmit').onclick = () => {
    const btn = $('cbSubmit');
    if (btn.disabled) return;
    clearMsgs();
    const payload = { date: $('cbDate').value, kind: S.kind, subject: $('cbSubject').value, name: $('cbName').value.trim(),
      amount: Number($('cbAmount').value), hasInvoice: !!D.hasInvoice, photoBase64: D.photoBase64 };
    if (!payload.photoBase64) delete payload.photoBase64;
    if (!payload.date || !payload.name || !(payload.amount > 0)) return showMsg('cbErr', '日期、項目名稱、金額都要填，金額要大於 0。');
    if (drawLock()) return showMsg('cbErr', '這個月已經結帳鎖定，不能再新增。');
    payload.clientToken = tokenOf(payload);
    // 送出前先記下現在有哪些單號：逾時後要靠這份名單認出「哪一筆是剛剛新增的」，用單號差集而不是只比內容——店長真的可能連記兩筆一模一樣的
    const knownIds = {}; S.rows.forEach(r => { knownIds[r.id] = 1; });

    return runBusy(btn, async () => {
      let res;
      try { res = await call('create', payload); }
      catch (err) {
        if (err.code !== 'TIMEOUT' && err.code !== 'NETWORK') throw err;
        /* 逾時只代表瀏覽器不等了，不代表後端沒寫進去。這裡不准猜、也絕不自動重送：去查一次當月清單。
           查到新增的那筆＝其實記進去了；查過確定沒有＝NOT_SAVED；連查都查不到＝TIMEOUT_UNSURE（絕不叫人再按一次）。 */
        let look;
        try { look = await call('list', { month: monthOf(payload.date) }); }
        catch (e2) { throw Object.assign(new Error('TIMEOUT_UNSURE'), { code: 'TIMEOUT_UNSURE' }); }
        const list = (look && look.rows) || [];
        let found = null;
        for (let i = list.length - 1; i >= 0; i--) {
          const r = list[i];
          if (knownIds[r.id]) continue;
          if (r.date === payload.date && r.kind === payload.kind && r.subject === payload.subject && r.name === payload.name && Number(r.amount) === Number(payload.amount)) { found = r; break; }
        }
        if (!found) throw Object.assign(new Error('NOT_SAVED'), { code: 'NOT_SAVED' });
        res = { row: found, recovered: true };
      }
      // 這一筆可能已經在畫面上（後端擋掉重複＝duplicate，或我們自己查回來＝recovered）：不檢查會看到兩列
      if (!S.rows.some(r => r.id === res.row.id) && monthOf(res.row.date) === S.month) S.rows.push(res.row);
      if (res.frequent) S.frequent = res.frequent; else S.frequent = Mem.remember(S.frequent, payload.subject, payload.name);
      forgetToken();   // 記成功了，下一筆要用新的識別碼
      if (!el.isConnected) return;
      el.querySelector('#cbSum').outerHTML = summaryHtml(S.rows, S.month);
      const done = `已記錄：${payload.subject}　${payload.name}　$${payload.amount.toLocaleString('en-US')}（收據編號 ${res.row.seq}）`;
      if (res.warning === 'PHOTO_FAIL') showMsg('cbErr', `⚠️ ${done}　但這張收據照片沒有存成功，請留著紙本收據。`);   // 照片失敗不會害帳記不成，但一定要講出來
      else if (res.recovered || res.duplicate) { const o = $('cbOk'); o.textContent = `這筆其實已經記進去了（收據編號 ${res.row.seq}）。剛才只是網路太慢，不是沒記到，不用再按一次。`; o.hidden = false; }
      else { const o = $('cbOk'); o.textContent = done; o.hidden = false; }
      clearForm(true);   // 日期留著，連續打同一天的收據不用重選
    }, { doneText: '已記錄 ✓', onError: m => { if (el.isConnected) showMsg('cbErr', m); } });
  };
}
