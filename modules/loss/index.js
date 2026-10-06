import { renderSkeleton } from '../../js/skeleton.js';
const LINK = '';
export default {
  id: 'loss',
  tabs: [{ id: 'add', label: '登記' }, { id: 'log', label: '紀錄' }, { id: 'items', label: '品項維護' }],
  render(ctx) { renderSkeleton(ctx.el, LINK); },
};
