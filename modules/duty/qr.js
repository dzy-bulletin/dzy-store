// 打卡 QR（2026-10-09）：同仁定位抓不到時，主管手機出示，同仁用 LINE 掃描後不需定位直接打這家店。
// 照 ~/mala-clock-in manager.html（feature/requests-qr）的 qrShowToken 搬：後端 mgr_qr_token 簽章、每 expires_in 毫秒換一次。
// QR 裡的店別代碼由伺服器依登入者的打卡對照填（前端不能指定）。產生 QR 圖用 qrcodejs（第一次打開才載入）；
// CDN 載不到時退回顯示網址文字。網址一律寫在 #duQrBox 的 data-url，測試讀它。
import { call, h } from './state.js';
import { qrUrl } from './calc.js';

const LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
let libP = null;
function loadLib() {
  if (window.QRCode) return Promise.resolve(true);
  if (!libP) libP = new Promise(res => {
    const s = document.createElement('script');
    s.src = LIB; s.async = true;
    s.onload = () => res(!!window.QRCode); s.onerror = () => res(false);
    document.head.append(s);
  });
  return libP;
}

// 打卡 QR 分頁（2026-11-16 Eason：從核定工時頁尾的按鈕改成上方分頁）：點進分頁就直接出示，離開分頁（畫面換掉）就停止換新
export function renderQr(ctx) {
  const el = ctx.el;
  const panel = h('div', 'du-qr-panel du-qr-page');
  const box = h('div', 'du-qr-box', '產生中…', { id: 'duQrBox' });
  const count = h('div', 'du-qr-count', '', { id: 'duQrCount' });
  panel.append(h('h3', null, '打卡 QR', { id: 'duQrTitle' }),
    h('div', 'du-qr-sub', '同仁定位抓不到時給他掃。\n請同仁用 LINE 掃描（LINE 主頁搜尋列旁的掃描圖示，或手機相機），掃完直接按上班／下班。\nQR 每 30 秒換一次，拍照傳出去也很快失效。'),
    box, count);
  el.innerHTML = ''; el.append(panel);

  let timer = null, tick = null, dead = false;
  const stop = () => { dead = true; clearTimeout(timer); clearInterval(tick); timer = tick = null; };
  function fetchToken() {
    if (dead) return;
    if (!panel.isConnected) return stop();                    // 換分頁／換頁了：不再背景打後端
    call('mgr_qr_token').then(r => {
      if (dead) return;
      if (!panel.isConnected) return stop();
      const url = qrUrl(r.token);
      box.dataset.url = url; box.textContent = '';
      loadLib().then(ok => {
        if (dead || box.dataset.url !== url) return;
        box.textContent = '';
        if (ok) new window.QRCode(box, { text: url, width: 240, height: 240, correctLevel: window.QRCode.CorrectLevel.M });
        else box.append(h('div', 'du-qr-url', url));
      });
      const ms = Math.max(0, Number(r.expires_in) || 0), until = Date.now() + ms, who = r.manager ? r.manager + ' 出示・' : '';
      const show = () => { if (!panel.isConnected) return stop(); count.textContent = who + Math.max(0, Math.ceil((until - Date.now()) / 1000)) + ' 秒後換新'; };
      clearInterval(tick); tick = setInterval(show, 500); show();
      timer = setTimeout(fetchToken, ms + 300);
    }, e => {
      if (dead) return;
      clearInterval(tick); count.textContent = '';
      box.textContent = '產生失敗，5 秒後重試（' + ((e && e.message) || '網路或伺服器忙碌') + '）';
      timer = setTimeout(fetchToken, 5000);
    });
  }
  fetchToken();
}
