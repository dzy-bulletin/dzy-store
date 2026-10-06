import { esc, busy, setMsg, DEFAULT_COLORS } from '../js/ui.js';

export default async function view({ el, api, refreshUi }) {
  let ui;
  try { ui = await api('GET', '/ui'); } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const cards = [...ui.cards].sort((a, b) => a.order - b.order);
  function draw() {
    el.innerHTML = `<form id="uiForm"><div class="card"><h2>外觀</h2><div class="grid2">
        <div class="fld"><label for="uSys">系統名稱</label><input id="uSys" type="text" value="${esc(ui.systemName)}"></div>
        <div class="fld"><label for="uLogo">Logo 網址（可留空）</label><input id="uLogo" type="text" value="${esc(ui.logoUrl)}" placeholder="https://…"></div>
        <div class="fld"><label for="uRed">主色（紅色主要按鈕；側邊欄與卡片色條由各店品牌決定）</label><input id="uRed" type="color" value="${esc(ui.colors.red)}"></div>
        <div class="fld"><label for="uBlack">頂欄色</label><input id="uBlack" type="color" value="${esc(ui.colors.black)}"></div>
      </div><div class="row mt"><button class="btn ghost sm" id="uReset" type="button">還原預設色票</button></div></div>
      <div class="card"><h2>首頁卡片</h2><p class="hint">用上下移調順序，可改顯示名稱、可暫時隱藏。</p><div class="order-list" id="cardList">
      ${cards.map((c, i) => `<div class="order-item" data-id="${esc(c.id)}"><b style="min-width:3.2em">${i + 1}</b>
        <input type="text" class="cLabel" value="${esc(c.label)}" aria-label="${esc(c.id)} 名稱">
        <label class="row" style="gap:4px"><input type="checkbox" class="cVis" ${c.visible ? 'checked' : ''}> 顯示</label>
        <button class="btn ghost sm" type="button" data-mv="-1" ${i === 0 ? 'disabled' : ''}>上移</button>
        <button class="btn ghost sm" type="button" data-mv="1" ${i === cards.length - 1 ? 'disabled' : ''}>下移</button></div>`).join('')}</div></div>
      <div class="card"><h2>公告橫幅</h2><p class="hint">會顯示在登入頁與首頁最上方；留空就不顯示。</p>
        <textarea id="uBanner" rows="2" style="width:100%">${esc(ui.banner)}</textarea></div>
      <div class="row"><button class="btn" id="uSave" type="submit">存檔並套用</button></div><div id="uMsg" role="alert" class="err"></div></form>`;
    const f = el.querySelector('#uiForm');
    const sync = () => {  // 把畫面上的編輯值先收回 cards，換順序才不會掉
      f.querySelectorAll('.order-item').forEach(it => { const c = cards.find(x => x.id === it.dataset.id); c.label = it.querySelector('.cLabel').value; c.visible = it.querySelector('.cVis').checked; });
      ui.systemName = f.uSys.value; ui.logoUrl = f.uLogo.value; ui.colors = { red: f.uRed.value, black: f.uBlack.value }; ui.banner = f.uBanner.value;
    };
    f.querySelectorAll('[data-mv]').forEach(b => b.onclick = () => {
      sync(); const id = b.closest('.order-item').dataset.id, i = cards.findIndex(c => c.id === id), j = i + +b.dataset.mv;
      [cards[i], cards[j]] = [cards[j], cards[i]]; draw();
    });
    f.querySelector('#uReset').onclick = () => { sync(); ui.colors = { ...DEFAULT_COLORS }; draw(); setMsg(el.querySelector('#uMsg'), '已還原預設色票，按「存檔並套用」才會生效', true); };
    f.onsubmit = e => { e.preventDefault(); busy(f.querySelector('#uSave'), async () => {
      sync();
      try {
        await api('POST', '/admin/ui', { systemName: ui.systemName, logoUrl: ui.logoUrl, colors: ui.colors, banner: ui.banner,
          cards: cards.map((c, i) => ({ id: c.id, label: c.label, visible: c.visible, order: i + 1 })) });
        await refreshUi();
        setMsg(el.querySelector('#uMsg'), '已存檔並套用', true);
      } catch (er) { setMsg(el.querySelector('#uMsg'), er.message); }
    }); };
  }
  draw();
}
