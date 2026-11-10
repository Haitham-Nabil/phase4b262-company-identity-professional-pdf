// The 10 approved transaction types. No type may be added outside this list.
export const TRANSACTION_TYPE = Object.freeze({
  SALE_PESTICIDES: 'SalePesticides',
  SALE_IRRIGATION: 'SaleIrrigation',
  SALES_RETURN: 'SalesReturn',
  CROP_PURCHASE_LOCAL: 'CropPurchaseLocal',
  CROP_PURCHASE_CARTON: 'CropPurchaseCarton',
  CASH_RECEIVED: 'CashReceived',
  CASH_PAID: 'CashPaid',
  SETTLEMENT: 'Settlement',
  GOODS_EXCHANGE: 'GoodsExchange',
  DEBT_TRANSFER: 'DebtTransfer'
});

export const TRANSACTION_TYPES = Object.freeze(Object.values(TRANSACTION_TYPE));

export const TRANSACTION_TYPE_LABELS_AR = Object.freeze({
  SalePesticides: 'بيع مبيدات',
  SaleIrrigation: 'بيع شبكات ري',
  SalesReturn: 'مرتجع مبيعات',
  CropPurchaseLocal: 'مشتريات محصول محلي',
  CropPurchaseCarton: 'مشتريات كرتون',
  CashReceived: 'استلام نقدية',
  CashPaid: 'دفعة نقدية',
  Settlement: 'تسوية',
  GoodsExchange: 'تبادل بضائع',
  DebtTransfer: 'تحويل مديونية'
});

export const TRANSACTION_GROUP_AR = Object.freeze({
  SALES: 'المبيعات',
  RETURNS: 'المرتجعات',
  CROP: 'المشتريات',
  CASH: 'الحركة النقدية',
  NON_CASH: 'التسويات غير النقدية'
});

export const TRANSACTION_GROUP_MEMBERS = Object.freeze({
  SALES: Object.freeze(['SalePesticides', 'SaleIrrigation']),
  RETURNS: Object.freeze(['SalesReturn']),
  CROP: Object.freeze(['CropPurchaseLocal', 'CropPurchaseCarton']),
  CASH: Object.freeze(['CashReceived', 'CashPaid']),
  NON_CASH: Object.freeze(['Settlement', 'GoodsExchange', 'DebtTransfer'])
});

export const CASH_TYPES = Object.freeze(['CashReceived', 'CashPaid']);
export const NON_CASH_TYPES = Object.freeze(['Settlement', 'GoodsExchange', 'DebtTransfer']);
export const CROP_PURCHASE_TYPES = Object.freeze(['CropPurchaseLocal', 'CropPurchaseCarton']);

// Phase 4B.5.1 — Settlement and GoodsExchange move in EITHER direction, so their
// direction is an explicit, persisted statement rather than a fixed matrix value.
export const DIRECTIONAL_TYPES = Object.freeze(['Settlement', 'GoodsExchange']);

export function usesExplicitDirection(value) {
  return DIRECTIONAL_TYPES.includes(value);
}

export const STATUS = Object.freeze({ ACTIVE: 'Active', CANCELLED: 'Cancelled' });

// Debt transfer internal representation: one operation -> two linked records.
export const DEBT_TRANSFER_ROLE = Object.freeze({
  CREDIT_SIDE: 'CreditSide',
  DEBIT_SIDE: 'DebitSide'
});

export function isTransactionType(value) {
  return TRANSACTION_TYPES.includes(value);
}

export function isCashType(value) {
  return CASH_TYPES.includes(value);
}

export function isNonCashType(value) {
  return NON_CASH_TYPES.includes(value);
}

export function isCropPurchaseType(value) {
  return CROP_PURCHASE_TYPES.includes(value);
}
