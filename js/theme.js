// 品牌主題（搬自貨單辨識系統 ~/mala-purchase/web/js/theme.js 的 THEMES，改用營運系統的 brand 代號）。
// 各品牌只換：--brand（側邊欄選中膠囊／小字／首頁卡片上緣色條）、--brand-ink（膠囊上的字）、側邊欄品牌區的 logo、品牌名與英文副名。
// 主要按鈕仍是紅色（--red，由後台「介面設定」控制），不跟品牌走。
export const THEMES = {
  mala: { name: '小辛辣', full: '麻的小辛辣', en: 'MADE SIAO SIN LA', brand: '#FABE00', ink: '#231815', logos: ['mala'] },
  mzt: { name: '墨竹亭', en: 'MO ZHU TING', brand: '#86CBBF', ink: '#202B66', logos: ['mzt'] },
  cf: { name: '央廚', en: 'CENTRAL KITCHEN', brand: '#1F4E8C', ink: '#FFFFFF', logos: ['mzt', 'mala'] },
  hq: { name: '鼎兆元', en: 'DING ZHAO YUAN', brand: '#FABE00', ink: '#231815', logos: [] },
  yiwu: { name: '鼎兆元', en: 'DING ZHAO YUAN', brand: '#FABE00', ink: '#231815', logos: [] },
  _: { name: '鼎兆元', en: 'DING ZHAO YUAN', brand: '#FABE00', ink: '#231815', logos: [] },
};
const ALT = { mala: '麻的小辛辣', mzt: '墨竹亭' };
export const themeOf = brand => THEMES[brand] || THEMES._;

// 套用品牌：設 CSS 變數，並把 logo／品牌名／英文副名放進頁面上的 .logos／.js-bt／.js-bs。
// logoUrl（後台介面設定的自訂 Logo）只在沒有品牌 logo 時（鼎兆元預設）取代「鼎兆元」字樣。
export function applyTheme(brand, logoUrl) {
  const t = themeOf(brand);
  const root = document.documentElement;
  root.style.setProperty('--brand', t.brand);
  root.style.setProperty('--brand-ink', t.ink);
  root.setAttribute('data-brand', THEMES[brand] ? brand : '_');
  const html = t.logos.length
    ? t.logos.map(k => `<span class="lg lg-${k}"><img src="img/emblem-${k}.png" alt="${ALT[k]} logo"></span>`).join('')
    : logoUrl ? `<span class="lg lg-custom"><img src="${String(logoUrl).replace(/"/g, '&quot;')}" alt=""></span>` : '<span class="txt">鼎兆元</span>';
  document.querySelectorAll('.logos').forEach(el => { el.innerHTML = html; });
  document.querySelectorAll('.js-bt').forEach(el => { el.textContent = t.full || t.name; });
  document.querySelectorAll('.js-bs').forEach(el => { el.textContent = t.en; });
  return t;
}
