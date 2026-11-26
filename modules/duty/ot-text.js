// 審單出勤試算的字句（2026-11-25 Eason 開工確認 ot-review-hint 第 4 題「照表」，24 句逐字照確認頁，不在別處另寫）。
// 資料是伺服器附在待審加班單上的 ot_check（server/ot-check.js build）；沒有這欄（開關關著、舊伺服器、日期未到、副本沒有這天）＝什麼都不畫。
// 純函式，不碰畫面：request.js（申請審核、核定卡片裡的待審單）、quick.js（一頁核定）共用；測試 test/server/ot-text.test.js 逐句比對。
const f = (x) => String(Math.round(Number(x) * 100) / 100);
export const OT_TITLE = '當天出勤（照核定規則試算）';                                          // 第 1 句
const NA = { store: '這家店的出勤資料還沒接到管理系統', today: '今天還沒下班', miss: '還有待審的忘打卡單' };   // 第 19 句的三個原因
export const OT_TAG = { bad: '時數對不上', ok: '時數相符', est: '試算僅供參考' };                   // 第 23 句

/** ot_check 合不合格式（舊伺服器、壞資料＝不畫） */
export const otOk = (oc) => !!oc && typeof oc === 'object' && oc.v === 1;

/** 試算框每一行 → [{text, cls}]；cls：'' 一般、'ok' 綠、'bad' 紅、'dim' 灰、'est' 黃 */
export function otLines(oc) {
  if (!otOk(oc)) return [];
  if (oc.na === 'rest_nopunch') return [{ text: '這天是休息日又沒有打卡，核定時不能只憑加班單（加班單只是憑證）', cls: 'dim' }];      // 第 20 句
  if (oc.na) return NA[oc.na] ? [{ text: '這天沒辦法試算（' + NA[oc.na] + '），請自己核對上面的打卡。', cls: 'dim' }] : [];             // 第 19 句
  const out = [], own = oc.own || {};
  out.push({ text: own.est ? '本店：還沒核定，照打卡估 ' + f(own.h) + ' 小時（' + (own.range || '') + '，含這張加班單）'          // 第 3 句
                           : '本店：已核定 ' + f(own.h) + ' 小時（' + (own.range || '') + '）', cls: '' });                        // 第 2 句
  for (const p of Array.isArray(oc.peers) ? oc.peers : []) {
    if (!p) continue;
    if (p.state === 'approved') out.push({ text: p.label + '：已核定 ' + f(p.h) + ' 小時', cls: '' });                            // 第 4 句
    else if (p.state === 'est') out.push({ text: p.label + '：還沒核定，照打卡估 ' + f(p.h) + ' 小時', cls: '' });                // 第 5 句
    else if (p.state === 'unread') out.push({ text: p.label + '：資料暫時讀不到，沒有算進來', cls: 'dim' });                     // 第 6 句
    else if (p.state === 'dup') out.push({ text: p.label + '有同名同仁，分不出是不是同一人，沒有算進來', cls: 'dim' });          // 第 7 句
  }
  if (oc.rule === 'here' || oc.rule === 'away') {
    out.push({ text: '合計 ' + f(oc.comb) + ' 小時（正職上班日：同一單位合計超過 8 小時的部分才算加班）', cls: '' });             // 第 8 句
    out.push(oc.rule === 'away' && oc.away
      ? { text: '超過 8 小時的 ' + f(oc.away.h) + ' 小時算在' + oc.away.label + '，加班單應開在' + oc.away.label + '；本店應有加班 ' + f(oc.need) + ' 小時', cls: '' }   // 第 10 句
      : { text: '照核定規則，這天在本店應有加班 ' + f(oc.need) + ' 小時', cls: '' });                                               // 第 9 句
  } else if (oc.rule === 'rest') out.push({ text: '這天班表是休息日（或例假），核定的時數全部算加班：應有加班 ' + f(oc.need) + ' 小時', cls: '' });   // 第 11 句
  else if (oc.rule === 'single') out.push({ text: '本店超過 8 小時的部分算加班：應有加班 ' + f(oc.need) + ' 小時', cls: '' });              // 第 12 句
  else if (oc.rule === 'pt_cross') out.push({ text: '這天不是正職上班日，打卡系統不把兩家相加，只看本店：應有加班 ' + f(oc.need) + ' 小時', cls: 'dim' });   // 第 13 句
  if (oc.verdict === 'match') out.push({ text: '✓ 加班單 ' + f(oc.n) + ' 小時，和應有的時數相符', cls: 'ok' });                                 // 第 14 句
  else if (oc.verdict === 'near') out.push({ text: '✓ 加班單 ' + f(oc.n) + ' 小時，和應有的 ' + f(oc.need) + ' 小時相差 15 分鐘以內', cls: 'ok' });   // 第 15 句
  else if (oc.verdict === 'over') out.push({ text: '⚠ 加班單 ' + f(oc.n) + ' 小時，比應有的 ' + f(oc.need) + ' 小時多 ' + f(oc.x) + ' 小時。照現在的資料，核定這天時打卡系統會擋下，要作廢或改單', cls: 'bad' });   // 第 16 句
  else if (oc.verdict === 'under') out.push({ text: '加班單 ' + f(oc.n) + ' 小時，比試算的 ' + f(oc.need) + ' 小時少 ' + f(oc.x) + ' 小時（提醒，不影響核准）', cls: 'dim' });   // 第 17 句
  if (oc.est) out.push({ text: '有店還沒核定，時數是估的，僅供參考', cls: 'est' });                                                             // 第 18 句
  return out;
}
/** 清單上的小標籤（第 23 句）→ {text, cls} 或 null。少了、算不出來＝不標 */
export function otTag(oc) {
  if (!otOk(oc) || oc.na || oc.verdict === 'under') return null;
  if (oc.verdict == null || oc.est || oc.unread) return { text: OT_TAG.est, cls: 'est' };
  if (oc.verdict === 'over') return { text: OT_TAG.bad, cls: 'bad' };
  return { text: OT_TAG.ok, cls: 'ok' };
}
export const otOver = (oc) => otOk(oc) && !oc.na && oc.verdict === 'over';
/** 單張核准確認框多一段（第 21 句）；不是「多了」＝'' */
export function otConfirmText(oc) {
  return otOver(oc) ? '⚠ 照核定規則試算，這張加班單 ' + f(oc.n) + ' 小時比應有的 ' + f(oc.need) + ' 小時多 ' + f(oc.x) + ' 小時。確定要核准嗎？' : '';
}
/** 批次核准確認框多一段（第 22 句）：rows＝[{store, name, date(m/d), oc}]（只放「多了」的）；沒有＝'' */
export function otBatchText(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && otOver(r.oc));
  if (!list.length) return '';
  return '⚠ 其中 ' + list.length + ' 張加班單和當天出勤對不上：\n' + list.map((r) => '・' + (r.store ? r.store + ' ' : '') + r.name + ' ' + r.date + ' 加班 ' + f(r.oc.n) + ' 小時（試算應有 ' + f(r.oc.need) + ' 小時）').join('\n');
}
/** 試算框（DOM）：h＝state.js 的 h；沒有可畫的＝null（畫面跟沒這功能時一樣） */
export function otBoxEl(h, oc) {
  const lines = otLines(oc);
  if (!lines.length) return null;
  const box = h('div', 'du-rq-ot');
  box.append(h('div', 'du-rq-ot-t', OT_TITLE), ...lines.map((x) => h('div', 'du-rq-ot-l' + (x.cls ? ' ' + x.cls : ''), x.text)));
  return box;
}
/** 清單小標籤（DOM）；沒有＝null */
export function otTagEl(h, oc) {
  const t = otTag(oc);
  return t ? h('span', 'du-rq-ottag ' + t.cls, t.text) : null;
}
