import { renderSkeleton } from '../../js/skeleton.js';
const LINK = 'https://eason0728.github.io/mala-transfer/';
export default {
  id: 'transfer',
  tabs: [{ id: 'new', label: '開單' }, { id: 'todo', label: '待處理' }, { id: 'query', label: '查詢' }],
  render(ctx) { renderSkeleton(ctx.el, LINK); },
};
