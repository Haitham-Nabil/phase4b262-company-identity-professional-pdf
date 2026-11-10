// Phase 4B.6 — the audit trail model.
//
// One immutable event per lifecycle change. The snapshot is STRUCTURED (never a free
// text note): it carries the business fields of the movement exactly as stored, plus
// the financial impact DERIVED from those fields by the approved engine. The derived
// side is computed here from the stored record, never accepted from the caller, so the
// log can never carry a Debit / Credit figure the UI invented.
import { deriveFinancials } from './financialDirection.js';
import { STATUS } from './transactionTypes.js';
import { AppError, ERROR_CODE } from './errors.js';

export const AUDIT_EVENT_TYPE = Object.freeze({
  EDITED: 'TransactionEdited',
  CANCELLED: 'TransactionCancelled'
});

export const AUDIT_EVENT_LABEL_AR = Object.freeze({
  TransactionEdited: 'تعديل حركة',
  TransactionCancelled: 'إلغاء حركة'
});

export const AUDIT_EVENT_TYPES = Object.freeze(Object.values(AUDIT_EVENT_TYPE));

export function isAuditEventType(value) {
  return AUDIT_EVENT_TYPES.includes(value);
}

// The business fields that make up a snapshot. Everything here is read straight from
// the stored row; nothing is recalculated by hand.
export const SNAPSHOT_FIELDS = Object.freeze([
  'CustomerId', 'Date', 'TransactionType', 'Description', 'AmountMinor', 'Direction',
  'Status', 'CancellationReason', 'CancelledAt', 'LinkId', 'TransferRole',
  'LocalUnitsMilli', 'LocalLooseKgMilli', 'LocalDeductionKgMilli', 'LocalUnitPriceMinor',
  'CartonQuantityMilli', 'CartonUnitPriceMinor', 'CartonDiscountMinor'
]);

// Structured snapshot: the stored business values + the derived financial impact.
// `deriveFinancials` is the single authority for the debit / credit / cash columns.
export function buildAuditSnapshot(record) {
  if (!record) return null;
  const snapshot = {};
  for (const field of SNAPSHOT_FIELDS) {
    snapshot[field] = record[field] === undefined ? null : record[field];
  }
  const financials = deriveFinancials(record);
  snapshot.DebitMinor = financials.DebitMinor;
  snapshot.CreditMinor = financials.CreditMinor;
  snapshot.CashReceivedMinor = financials.CashReceivedMinor;
  snapshot.CashPaidMinor = financials.CashPaidMinor;
  snapshot.SettlementMinor = financials.SettlementMinor;
  snapshot.Direction = financials.direction;
  snapshot.IsActive = financials.isActive;
  return snapshot;
}

// Builds the audit event. `reason` is mandatory for both operations: a cancellation
// reason and an edit reason are equally part of the record.
export function buildAuditEntry({ eventType, record, previousRecord = null, reason, occurredAt, entryId }) {
  if (!isAuditEventType(eventType)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'نوع حدث سجل التدقيق غير معتمد.', { field: 'EventType' });
  }
  if (!record) {
    throw new AppError(ERROR_CODE.NOT_FOUND, 'الحركة غير موجودة.', { field: 'TransactionId' });
  }
  const text = reason === null || reason === undefined ? '' : String(reason).trim();
  if (!text) {
    const message = eventType === AUDIT_EVENT_TYPE.CANCELLED ? 'سبب إلغاء الحركة مطلوب.' : 'سبب تعديل الحركة مطلوب.';
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, message, { field: 'Reason' });
  }
  if (!occurredAt) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'تاريخ حدث سجل التدقيق مطلوب.', { field: 'OccurredAt' });
  }
  return {
    Id: entryId,
    TransactionId: record.Id,
    EventType: eventType,
    OccurredAt: occurredAt,
    Reason: text,
    Previous: previousRecord ? buildAuditSnapshot(previousRecord) : null,
    Next: eventType === AUDIT_EVENT_TYPE.EDITED ? buildAuditSnapshot(record) : null,
    // Identity of the actor is recorded only when the application really has one.
    // This release has no authenticated user, so the field stays null rather than
    // carrying an invented identity.
    ActorId: null,
    CreatedAt: occurredAt,
    Status: STATUS.ACTIVE
  };
}

// Read model for the screen. It exposes the stored values plus the side each snapshot
// was posted on, so a reviewer can see the debit / credit effect before and after
// without any free-text interpretation.
export function describeAuditEntry(entry) {
  if (!entry) return null;
  return {
    Id: entry.Id,
    TransactionId: entry.TransactionId,
    EventType: entry.EventType,
    EventLabel: AUDIT_EVENT_LABEL_AR[entry.EventType] || entry.EventType,
    OccurredAt: entry.OccurredAt,
    Reason: entry.Reason,
    ActorId: entry.ActorId ?? null,
    Previous: entry.Previous ?? null,
    Next: entry.Next ?? null
  };
}
