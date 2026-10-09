// 加模組只改這支。moduleId 固定六個；每個模組在 web/modules/<id>/index.js。
export const MODULES = [
  { id: 'purchase',  label: '貨單辨識', desc: '拍照上傳進貨單',   load: () => import('../modules/purchase/index.js') },
  { id: 'cashbook',  label: '收支登記', desc: '記帳、明細、月結', load: () => import('../modules/cashbook/index.js') },
  { id: 'duty',      label: '出勤核定', desc: '工時、裝置、名冊', load: () => import('../modules/duty/index.js') },
  { id: 'transfer',  label: '門市調撥', desc: '門市之間調貨',     load: () => import('../modules/transfer/index.js') },
  { id: 'loss',      label: '耗損登記', desc: '耗損登記與品項',   load: () => import('../modules/loss/index.js') },
  { id: 'inventory', label: '庫存盤點', desc: '盤點與歷史',       load: () => import('../modules/inventory/index.js') },
];
export const ADMIN_TABS = [
  { id: 'accounts', label: '帳號' }, { id: 'features', label: '功能開關' }, { id: 'duty', label: '出勤核定密碼' }, { id: 'alias', label: '門市對照' },
  { id: 'ui', label: '介面設定' }, { id: 'audit', label: '紀錄' },
];
