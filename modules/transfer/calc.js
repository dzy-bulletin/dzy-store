// 金額預覽：照原系統 ~/mala-transfer/gas/Code.gs 的算法抄一份給畫面即時顯示（真正的數字永遠是後端算的，簽收後畫面顯示後端回來的值）。
// 所有金額先乘再四捨五入到小數 2 位，逐列累加時每加一次也進位一次，跟原系統一模一樣。
export const round2 = n => Math.round(n * 100) / 100;                 // Code.gs 第 148 行 round2_
export const money = n => (Math.round(n * 100) / 100).toLocaleString('zh-TW');
const num = v => { const n = Number(v); return v === '' || v === null || v === undefined || isNaN(n) ? null : n; };

// 小計＝單價 × 應撥數量（Code.gs 第 480 行 buildItemRows_：sub = round2_(price * qty)）
export const subtotal = (price, qty) => round2((num(price) || 0) * (num(qty) || 0));
// 應撥總額＝各列小計逐列累加（同函式：total = round2_(total + sub)）
export function planTotal(items) { let t = 0; for (const it of items) t = round2(t + subtotal(it.price, it.qty)); return t; }

// 差異數量＝實收 − 應撥（Code.gs 第 1007 行 act_receive_：diff = round2_(qty - 應撥數量)）；實收沒填回 null
export function diffQty(recv, plan) { const r = num(recv); return r === null ? null : round2(r - (num(plan) || 0)); }
// 實收總額（Code.gs 第 987 行 recalcTotals_：recv = round2_(recv + 實收數量 × 單價)，只算有填實收的列）、差異總額＝實收總額 − 應撥總額
export function recvTotals(lines) {
  let plan = 0, recv = 0, any = false;
  for (const l of lines) {
    plan = round2(plan + (num(l.sub) || 0));
    const q = num(l.recv);
    if (q !== null) { any = true; recv = round2(recv + q * (num(l.price) || 0)); }
  }
  return { plan, recv: any ? recv : null, diff: any ? round2(recv - plan) : null };
}
