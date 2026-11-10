// Phase 4B.6 — who may be edited and who may be cancelled.
//
// This module states NO financial rule of its own: it only answers whether an already
// stored movement is in a state that allows the operation. Every debit / credit /
// cash figure stays the exclusive output of `deriveFinancials()`.
import { STATUS, TRANSACTION_TYPE } from './transactionTypes.js';

// A linked operation is one user action that produced more than one row. Today the
// only such operation is the debt transfer pair (same LinkId, complementary roles),
// and the check below is written against the STORED LinkId rather than against the
// type name alone, so any other linked row that ever appears in real data is caught
// by the same guard instead of being silently treated as a standalone movement.
export const LINKED_OPERATION_MESSAGE = 'هذه الحركة مرتبطة بحركة أخرى (تحويل مديونية بين طرفين)؛ العملية تُعالَج كاملة ولا يمكن تعديل أو إلغاء طرف واحد منها.';

export const CANCELLED_EDIT_MESSAGE = 'لا يمكن تعديل حركة ملغاة.';
export const CANCELLED_CANCEL_MESSAGE = 'الحركة ملغاة بالفعل.';

export function linkedOperationReason(record) {
  if (!record) return null;
  if (record.LinkId) return LINKED_OPERATION_MESSAGE;
  if (record.TransactionType === TRANSACTION_TYPE.DEBT_TRANSFER) return LINKED_OPERATION_MESSAGE;
  return null;
}

export function isLinkedOperation(record) {
  return linkedOperationReason(record) !== null;
}

export function canEditTransaction(record) {
  if (!record) return { allowed: false, reason: 'الحركة غير موجودة.' };
  const linked = linkedOperationReason(record);
  if (linked) return { allowed: false, reason: linked };
  if (record.Status === STATUS.CANCELLED) return { allowed: false, reason: CANCELLED_EDIT_MESSAGE };
  return { allowed: true, reason: null };
}

export function canCancelTransaction(record) {
  if (!record) return { allowed: false, reason: 'الحركة غير موجودة.' };
  const linked = linkedOperationReason(record);
  if (linked) return { allowed: false, reason: linked };
  if (record.Status === STATUS.CANCELLED) return { allowed: false, reason: CANCELLED_CANCEL_MESSAGE };
  return { allowed: true, reason: null };
}

// The nine standalone types are handled by the same safe path. DebtTransfer is the
// only type excluded, and only because it is a two-row operation.
export const EDITABLE_TYPES = Object.freeze([
  TRANSACTION_TYPE.SALE_PESTICIDES,
  TRANSACTION_TYPE.SALE_IRRIGATION,
  TRANSACTION_TYPE.SALES_RETURN,
  TRANSACTION_TYPE.CROP_PURCHASE_LOCAL,
  TRANSACTION_TYPE.CROP_PURCHASE_CARTON,
  TRANSACTION_TYPE.CASH_RECEIVED,
  TRANSACTION_TYPE.CASH_PAID,
  TRANSACTION_TYPE.SETTLEMENT,
  TRANSACTION_TYPE.GOODS_EXCHANGE
]);

export function isEditableType(transactionType) {
  return EDITABLE_TYPES.includes(transactionType);
}
