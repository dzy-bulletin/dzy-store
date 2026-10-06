import { renderSkeleton } from '../../js/skeleton.js';
const LINK = '';
export default {
  id: 'inventory',
  tabs: [{ id: 'count', label: '盤點' }, { id: 'history', label: '歷史' }],
  render(ctx) { renderSkeleton(ctx.el, LINK); },
};
