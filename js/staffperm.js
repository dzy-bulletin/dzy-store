// 本店同仁權限（spec §4.4、§11 第 5、19 條）：店長（或管理員）逐人逐功能勾選。
// 每個人三種模式：跟本店預設（沒有自己的設定）／自訂／全部關；「回到預設」＝刪掉他自己的設定。
// 出勤核定與收支作廢由總部設定（管理系統），這裡兩欄唯讀。支援同仁＝別家店的同仁，要有到期日（最長 90 天）。
// 只給個人登入的店長（含管理系統管理員）用；伺服器端每一筆寫入都會再驗操作者（店長或管理員、不是改自己、不給上限外的功能）；這裡的停用只是輔助。
import { esc, busy, setMsg } from './ui.js';
import { MODULES } from './registry.js';

const MODE_TEXT = { inherit: '跟本店預設', custom: '自訂', deny: '全部關' };
const TITLE_TEXT = { sm: '店長', ft: '正職', pt: '計時' };
const taipeiToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);

export default async function view({ el, api, session, ui }) {
  const labelOf = id => ((ui.cards || []).find(c => c.id === id) || MODULES.find(m => m.id === id) || {}).label || id;

  const head = `<div class="card"><h2>本店同仁權限</h2>
    <p class="hint">勾選的功能，這位同仁才看得到、用得到；沒有自己設定的同仁跟著「本店預設」。出勤核定與收支作廢由總部設定，這裡只能看。</p>
    <div id="spMsg" class="err" role="alert"></div></div><div id="spData"></div>`;
  el.innerHTML = head;
  const msg = el.querySelector('#spMsg');

  const data = el.querySelector('#spData');
  data.innerHTML = '<div class="card"><p class="hint" style="margin:0">讀取中…</p></div>';
  let d;
  try { d = await api('GET', '/store-perm'); } catch (e) { data.innerHTML = ''; return setMsg(msg, e.message); }
  if (!el.isConnected) return;

  const feats = d.assignable || [];
  const lock = '<span class="sp-lock" title="由總部設定" aria-label="由總部設定">🔒</span>';
  const boxes = (have, off) => feats.map(f => `<td class="sp-c"><input type="checkbox" data-mod="${esc(f)}" aria-label="${esc(labelOf(f))}"${have.includes(f) ? ' checked' : ''}${off ? ' disabled' : ''}></td>`).join('');
  const thead = `<thead><tr><th>同仁</th><th>模式</th>${feats.map(f => `<th class="sp-c">${esc(labelOf(f))}</th>`).join('')}<th class="sp-c">出勤核定<div class="sp-sub">由總部設定</div></th><th class="sp-c">收支作廢<div class="sp-sub">由總部設定</div></th><th></th></tr></thead>`;
  const locks = `<td class="sp-c">${lock}</td><td class="sp-c">${lock}</td>`;
  const defRow = `<tr data-sub="__default" class="sp-def"><td><b>本店預設</b><div class="sp-sub">沒有自己設定的同仁都跟這一列</div></td><td><span class="tag">預設</span></td>${boxes(d.default.features, false)}${locks}<td></td></tr>`;
  const personRow = p => `<tr data-sub="${esc(p.sub)}"${p.self ? ' data-self="1"' : ''}><td><b>${esc(p.name)}</b> <span class="sp-sub">${esc(TITLE_TEXT[p.title] || p.title || '')}${p.self ? '・本人' : ''}</span>${p.stale ? '<div class="sp-sub sp-stale">已失效（轉調或復職），目前跟本店預設</div>' : ''}</td>
    <td><span class="tag${p.mode === 'deny' ? ' bad' : p.mode === 'custom' ? ' ok' : ''} sp-mode" data-mode-of="${esc(p.sub)}">${esc(MODE_TEXT[p.mode] || p.mode)}</span></td>
    ${boxes(p.features, p.self)}${locks}
    <td>${(p.mode !== 'inherit' || p.stale) && !p.self ? '<button type="button" class="btn ghost sm" data-act="reset">回到預設</button>' : ''}</td></tr>`;
  const supRow = p => `<tr data-sub="${esc(p.sub)}" data-support="1"><td><b>${esc(p.name)}</b> <span class="sp-sub">${esc(p.sub)}</span></td>
    <td>${esc(p.until)}${p.expired ? ' <span class="tag bad">已到期</span>' : ''}</td>${boxes(p.features, p.expired)}${locks}
    <td>${p.expired ? '<button type="button" class="btn sm" data-act="renew">續期</button> ' : ''}<button type="button" class="btn ghost sm" data-act="unsupport">取消支援</button></td></tr>`;   // 到期的列勾選框停用，只能「續期」（回到下面的加入表單重新加入）或取消
  const today = taipeiToday();
  data.innerHTML = `<div class="card"><h2>${esc(d.store.name)}　同仁</h2>
      <div class="scroll"><table id="spTable" class="sp-tbl">${thead}<tbody>${defRow}${d.people.map(personRow).join('')}</tbody></table></div>
      ${d.people.length ? '' : '<p class="hint mt">管理系統沒有列出這家店的在職同仁。</p>'}</div>
    <div class="card"><h2>支援同仁</h2><p class="hint">別家店的同仁來支援時，在這裡給他本店的功能，到期自動失效（最長 90 天，到期後可以再續）。</p>
      ${d.support.length ? `<div class="scroll"><table id="spSupport" class="sp-tbl"><thead><tr><th>同仁</th><th>到期日</th>${feats.map(f => `<th class="sp-c">${esc(labelOf(f))}</th>`).join('')}<th class="sp-c">出勤核定<div class="sp-sub">由總部設定</div></th><th class="sp-c">收支作廢<div class="sp-sub">由總部設定</div></th><th></th></tr></thead><tbody>${d.support.map(supRow).join('')}</tbody></table></div>` : '<p class="hint" id="spNoSupport">目前沒有支援同仁。</p>'}
      <form id="spForm" class="sp-form mt" novalidate><h3>加入支援同仁</h3>
        <div class="grid2"><div class="fld"><label for="spSub">DZY 編號（例如 DZY023）</label><input id="spSub" type="text" autocomplete="off" autocapitalize="characters" maxlength="12"></div>
        <div class="fld"><label for="spUntil">支援到期日（最長 90 天）</label><input id="spUntil" type="date" min="${today}" max="${addDays(today, 90)}" value="${addDays(today, 30)}"></div></div>
        <div class="sp-newboxes">${feats.map(f => `<label class="ft-row"><input type="checkbox" data-mod="${esc(f)}" class="sp-new"><span>${esc(labelOf(f))}</span></label>`).join('')}</div>
        <div class="row mt"><button class="btn" id="spAdd" type="submit">加入支援同仁</button></div></form></div>`;

  const reload = () => view({ el, api, session, ui });
  const rowFeatures = tr => [...tr.querySelectorAll('input[data-mod]:checked')].map(i => i.dataset.mod);
  async function save(tr, body, path) {
    setMsg(msg, '');
    tr.querySelectorAll('input').forEach(i => { i.disabled = true; });
    try { await api('POST', path, body); }
    catch (e) { await reload(); return setMsg(el.querySelector('#spMsg'), e.message); }   // 失敗就照伺服器上的真實狀態重畫（勾選自動復原）
    await reload();
    setMsg(el.querySelector('#spMsg'), '已儲存', true);
  }
  data.querySelectorAll('tr[data-sub] input[data-mod]').forEach(box => {
    box.onchange = () => {
      const tr = box.closest('tr'), sub = tr.dataset.sub, features = rowFeatures(tr);
      if (sub === '__default') return save(tr, { features }, '/store-perm/default');
      save(tr, { sub, mode: features.length ? 'custom' : 'deny', features }, '/store-perm');       // 全部取消勾選＝全部關
    };
  });
  data.querySelectorAll('[data-act=reset],[data-act=unsupport]').forEach(b => {
    b.onclick = () => busy(b, () => save(b.closest('tr'), { sub: b.closest('tr').dataset.sub, mode: 'inherit' }, '/store-perm'));
  });
  const f = data.querySelector('#spForm');
  data.querySelectorAll('[data-act=renew]').forEach(b => {
    b.onclick = () => {                                   // 續期＝把這位帶進「加入支援同仁」表單（原功能預先勾好、到期日預設 30 天），按加入才生效
      const tr = b.closest('tr'), have = rowFeatures(tr);
      f.spSub.value = tr.dataset.sub; f.spUntil.value = addDays(today, 30);
      f.querySelectorAll('input.sp-new').forEach(i => { i.checked = have.includes(i.dataset.mod); });
      f.spUntil.focus(); setMsg(msg, '請確認到期日後按「加入支援同仁」', true);
    };
  });
  f.onsubmit = e => {
    e.preventDefault();
    busy(f.querySelector('#spAdd'), async () => {
      const m = el.querySelector('#spMsg');
      try {
        await api('POST', '/store-perm/support', { sub: f.spSub.value.trim().toUpperCase(), until: f.spUntil.value, features: [...f.querySelectorAll('input.sp-new:checked')].map(i => i.dataset.mod) });
      } catch (er) { return setMsg(m, er.message); }
      await reload();
      setMsg(el.querySelector('#spMsg'), '已加入支援同仁', true);
    });
  };
}
