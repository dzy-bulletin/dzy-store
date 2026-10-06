import { esc } from './ui.js';
export function renderSkeleton(el, link) {
  el.innerHTML = `<div class="card"><h2>這個功能正在搬進來</h2>
    <div class="note"><b>暫時請用原本的系統。</b></div>
    <p>${link ? `原系統連結：<a href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a>` : '原系統連結：尚未提供'}</p></div>`;
}
