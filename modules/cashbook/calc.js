// 收支登記：純計算。逐字照抄自原系統前端 ~/mala-cashbook/js/calc.js（分支 store-ops-multistore），規則必須與後端 server/actions.js 的 splitTax 完全一致。
// 稅額以後端為準，這裡只是即時預覽與合計。改這裡之前先改原系統並跑它的 node test/logic.test.js。

/* 有統一發票：金額是含稅價，未稅＝金額÷1.05 四捨五入，稅額＝差額。
   沒發票（收據）：未稅＝金額、稅額 0。
   一律用「稅額＝金額−未稅」而不是各自四捨五入，未稅＋稅額才會恰好等於金額。 */
export function splitTax(amount, hasInvoice) {
  var amt = Math.round(Number(amount) || 0);
  if (!hasInvoice) return { net: amt, tax: 0 };
  var net = Math.round(amt / 1.05);
  return { net: net, tax: amt - net };
}

function isLive(r) { return r && r.status !== '作廢'; }

/* 當月三個數字：支出、收入、淨額（收入−支出）。作廢的不算。 */
export function summarize(rows) {
  var expense = 0, income = 0, count = 0;
  (rows || []).filter(isLive).forEach(function (r) {
    var amt = Number(r.amount) || 0;
    if (r.kind === '收入') income += amt; else expense += amt;
    count++;
  });
  return { expense: expense, income: income, net: income - expense, count: count };
}

export function money(n) { return (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US'); }
