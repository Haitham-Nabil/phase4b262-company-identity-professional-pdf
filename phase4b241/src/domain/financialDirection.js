import { ERROR_CODE, AppError } from './errors.js';
import { STATUS, DEBT_TRANSFER_ROLE, TRANSACTION_TYPE, DIRECTIONAL_TYPES, usesExplicitDirection } from './transactionTypes.js';

export const DIRECTION = Object.freeze({ DEBIT: 'Debit', CREDIT: 'Credit' });
export const DIRECTIONS = Object.freeze([DIRECTION.CREDIT, DIRECTION.DEBIT]);
const SIDE_DEPENDENT = 'SideDependent';
const NON_CASH_BUCKET = 'NonCash';

// Phase 4B.5.1 — Settlement and GoodsExchange may move in EITHER direction, so their
// direction is an explicit, user-chosen fact that is PERSISTED on the record and read
// back from it. Every other type keeps the fixed direction of the approved matrix.
export const EXPLICIT_DIRECTION_TYPES = DIRECTIONAL_TYPES;
export { usesExplicitDirection };

// Backward compatibility: a row stored before the direction field existed is read as
// a Credit — exactly the behaviour of the approved release. Stored rows are never
// rewritten by a migration.
export const LEGACY_DIRECTION = DIRECTION.CREDIT;

export function isDirection(value) {
  return DIRECTIONS.includes(value);
}

// The only accepted direction values are Credit and Debit. A missing value falls back
// to the legacy default; anything else is refused.
export function normalizeDirection(value) {
  if (value === null || value === undefined || value === '') return LEGACY_DIRECTION;
  if (!isDirection(value)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'اتجاه الحركة غير صالح؛ القيم المسموحة: Credit أو Debit.', {
      field: 'Direction',
      details: { direction: value }
    });
  }
  return value;
}

// Financial direction matrix (approved). Debit/Credit/Cash/Settlement are DERIVED
// from TransactionType + AmountMinor (+ TransferRole for debt transfer, + the
// persisted Direction for the two side-dependent non-cash types). They are never
// re-entered in the UI as a Debit/Credit figure and no derived column is ever sent
// back to the core.
export const FINANCIAL_RULES = Object.freeze({
  SalePesticides: Object.freeze({ direction: DIRECTION.DEBIT, bucket: 'None' }),
  SaleIrrigation: Object.freeze({ direction: DIRECTION.DEBIT, bucket: 'None' }),
  SalesReturn: Object.freeze({ direction: DIRECTION.CREDIT, bucket: 'None' }),
  CropPurchaseLocal: Object.freeze({ direction: DIRECTION.CREDIT, bucket: 'None' }),
  CropPurchaseCarton: Object.freeze({ direction: DIRECTION.CREDIT, bucket: 'None' }),
  CashReceived: Object.freeze({ direction: DIRECTION.CREDIT, bucket: 'CashReceived' }),
  CashPaid: Object.freeze({ direction: DIRECTION.DEBIT, bucket: 'CashPaid' }),
  Settlement: Object.freeze({ direction: SIDE_DEPENDENT, bucket: NON_CASH_BUCKET }),
  GoodsExchange: Object.freeze({ direction: SIDE_DEPENDENT, bucket: NON_CASH_BUCKET }),
  DebtTransfer: Object.freeze({ direction: SIDE_DEPENDENT, bucket: NON_CASH_BUCKET })
});

export function resolveDirection(transactionType, transferRole = null, direction = null) {
  const rule = FINANCIAL_RULES[transactionType];
  if (!rule) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'نوع الحركة غير معروف.', { field: 'TransactionType', details: { transactionType } });
  }
  if (rule.direction !== SIDE_DEPENDENT) return rule.direction;
  if (transactionType === TRANSACTION_TYPE.DEBT_TRANSFER) {
    return transferRole === DEBT_TRANSFER_ROLE.DEBIT_SIDE ? DIRECTION.DEBIT : DIRECTION.CREDIT;
  }
  // Settlement / GoodsExchange: the persisted direction is the source of truth; a row
  // written before the field existed keeps the approved Credit behaviour.
  return normalizeDirection(direction);
}

// Derived financial view of a transaction record. Throws only on corrupt input.
export function deriveFinancials(record) {
  const transactionType = record ? record.TransactionType : null;
  const rule = FINANCIAL_RULES[transactionType];
  if (!rule) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'نوع الحركة غير معروف.', { field: 'TransactionType', details: { transactionType } });
  }
  const amountMinor = record.AmountMinor;
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'قيمة الحركة يجب أن تكون أكبر من صفر.', { field: 'AmountMinor' });
  }
  const storedDirection = record.Direction === undefined ? null : record.Direction;
  // The direction field belongs to the two side-dependent non-cash types only.
  if (!usesExplicitDirection(transactionType) && storedDirection !== null) {
    throw new AppError(ERROR_CODE.BUSINESS_RULE_ERROR, 'حقل الاتجاه مسموح فقط لحركات التسوية وتبادل البضائع.', {
      field: 'Direction',
      details: { transactionType }
    });
  }
  const direction = resolveDirection(transactionType, record.TransferRole ?? null, storedDirection);
  const out = {
    direction,
    DebitMinor: 0,
    CreditMinor: 0,
    CashReceivedMinor: 0,
    CashPaidMinor: 0,
    SettlementMinor: 0,
    isCash: false,
    isNonCash: true,
    isActive: record.Status !== STATUS.CANCELLED
  };
  if (direction === DIRECTION.DEBIT) out.DebitMinor = amountMinor;
  else out.CreditMinor = amountMinor;
  if (rule.bucket === 'CashReceived') out.CashReceivedMinor = amountMinor;
  else if (rule.bucket === 'CashPaid') out.CashPaidMinor = amountMinor;
  // The non-cash bucket keeps its approved meaning: the VALUE of a non-cash movement,
  // independent of the side it was posted on. It is never a substitute for the derived
  // Credit or Debit column.
  else if (rule.bucket === NON_CASH_BUCKET) out.SettlementMinor = amountMinor;
  out.isCash = out.CashReceivedMinor > 0 || out.CashPaidMinor > 0;
  out.isNonCash = !out.isCash;
  return out;
}

// Guard: a record must have exactly one financial side (derived, never both).
export function assertSingleSided(record) {
  const f = deriveFinancials(record);
  if (f.DebitMinor > 0 && f.CreditMinor > 0) {
    throw new AppError(ERROR_CODE.BUSINESS_RULE_ERROR, 'لا يمكن أن تكون الحركة مدينة ودائنة في الوقت نفسه.', { field: 'TransactionType' });
  }
  return f;
}
