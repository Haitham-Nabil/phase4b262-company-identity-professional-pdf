import { authService } from './authService.js';
// Phase 4B.6 — editing and cancelling an already recorded movement, with the audit
// event written in the SAME IndexedDB transaction as the change itself.
//
// This service adds NO financial rule: the amount of a crop purchase is still derived
// by the approved crop calculators, the direction of Settlement / GoodsExchange is
// still the persisted statement the user made, the debit / credit / cash columns are
// still produced by `deriveFinancials()`, and every balance is still produced by
// `balanceService`. Its only new job is the lifecycle: validate, re-derive, and write
// the row together with its audit event — all or nothing.
import { runTransaction, req } from '../storage/db.js';
import { STORE } from '../storage/schema.js';
import { transactionRepository } from '../repositories/transactionRepository.js';
import { auditLogRepository } from '../repositories/auditLogRepository.js';
import { customerRepository } from '../repositories/customerRepository.js';
import { receivingCompanyService, cartonTypeService, strawberryVarietyService } from './referenceDataService.js';
import { validateTransactionEdit } from '../validation/transactionValidation.js';
import { buildTransactionEditForm } from '../validation/transactionFormInput.js';
import { buildAuditEntry, AUDIT_EVENT_TYPE } from '../domain/auditTrail.js';
// Additive re-export: the screen reads the audit vocabulary through the services
// layer only, exactly as it already reads the type catalogue from balanceService.
export { AUDIT_EVENT_TYPE, AUDIT_EVENT_LABEL_AR, AUDIT_EVENT_TYPES, describeAuditEntry, buildAuditSnapshot } from '../domain/auditTrail.js';
import { canEditTransaction, canCancelTransaction, linkedOperationReason } from '../domain/transactionLifecycle.js';
import { deriveFinancials } from '../domain/financialDirection.js';
import { STATUS } from '../domain/transactionTypes.js';
import { cropPurchaseService } from './cropPurchaseService.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';
import { createId, ID_PREFIX } from '../utils/id.js';
import { nowIso } from '../domain/dateUtils.js';

// The operation value keeps EXACTLY ONE source per type, exactly as at creation time:
// a crop purchase is computed from its crop inputs, every other type takes the
// validated entered amount. An explicit amount can never override a crop value.
// Phase 4B.11 — the package weight a movement must keep using on edit: the weight STORED
// on the row when it is confirmed, and (only for a legacy row whose weight was never
// recorded) the current setting, exactly as the pre-4B.11 code behaved.
function editPackageWeight(previous) {
  if (previous && previous.TransactionType === 'CropPurchaseLocal'
    && previous.PackageWeightStatus === 'Confirmed' && Number.isFinite(previous.PackageWeightKg)) {
    return previous.PackageWeightKg;
  }
  return null;
}

async function resolveAmountMinor(validated, previous) {
  // The validator returns the crop inputs at the top level of its data (it spreads
  // readCropFields), so both shapes are accepted here and neither is guessed.
  const crop = validated.crop && validated.crop.LocalUnitsMilli !== undefined ? validated.crop : validated;
  if (validated.TransactionType === 'CropPurchaseLocal') {
    return cropPurchaseService.computeLocalAmountMinor({
      units: (crop.LocalUnitsMilli ?? 0) / 1000,
      looseKg: (crop.LocalLooseKgMilli ?? 0) / 1000,
      deductionKg: (crop.LocalDeductionKgMilli ?? 0) / 1000,
      unitPrice: (crop.LocalUnitPriceMinor ?? 0) / 100,
      packageWeightKg: editPackageWeight(previous)
    });
  }
  if (validated.TransactionType === 'CropPurchaseCarton') {
    return cropPurchaseService.computeCartonAmountMinor({
      quantity: (crop.CartonQuantityMilli ?? 0) / 1000,
      discount: (crop.CartonDiscountMinor ?? 0) / 100,
      unitPrice: (crop.CartonUnitPriceMinor ?? 0) / 100
    });
  }
  if (Number.isInteger(validated.AmountMinor) && validated.AmountMinor > 0) return validated.AmountMinor;
  if (Number.isInteger(previous.AmountMinor) && previous.AmountMinor > 0) return previous.AmountMinor;
  throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'المبلغ مطلوب لهذا النوع من الحركة.', { field: 'Amount' });
}

// A guarded in-place edit: the caller may NOT move the row to another type, to another
// customer, or into the linked-operation space.
function assertImmutableFields(previous, validated) {
  if (validated.TransactionType !== previous.TransactionType) {
    throw new AppError(ERROR_CODE.BUSINESS_RULE_ERROR, 'لا يمكن تغيير نوع الحركة بالتعديل؛ يلزم إلغاء الحركة وتسجيل حركة جديدة.', { field: 'TransactionType' });
  }
  if (validated.CustomerId !== previous.CustomerId) {
    throw new AppError(ERROR_CODE.BUSINESS_RULE_ERROR, 'لا يمكن نقل الحركة إلى عميل آخر بالتعديل؛ يلزم إلغاء الحركة وتسجيل حركة جديدة.', { field: 'CustomerId' });
  }
  if (validated.LinkId !== (previous.LinkId ?? null) || (validated.TransferRole ?? null) !== (previous.TransferRole ?? null)) {
    throw new AppError(ERROR_CODE.BUSINESS_RULE_ERROR, 'لا يمكن تعديل ارتباط الحركة أو جهتها.', { field: 'LinkId' });
  }
}

export const transactionLifecycleService = {
  // Editability of one stored movement — read-only, used by the screen to decide
  // whether the action is offered at all.
  async getEditability(transactionId) {
    authService.assertCanManageData();
    const record = await transactionRepository.getById(transactionId);
    if (!record) throw new AppError(ERROR_CODE.NOT_FOUND, 'الحركة غير موجودة.', { field: 'TransactionId' });
    const edit = canEditTransaction(record);
    const cancel = canCancelTransaction(record);
    return {
      TransactionId: record.Id,
      CanEdit: edit.allowed,
      EditReason: edit.reason,
      CanCancel: cancel.allowed,
      CancelReason: cancel.reason
    };
  },

  // The stored values of one movement, in the shape the edit form consumes. Read-only.
  async getEditableTransaction(transactionId) {
    authService.assertCanManageData();
    const record = await transactionRepository.getById(transactionId);
    if (!record) throw new AppError(ERROR_CODE.NOT_FOUND, 'الحركة غير موجودة.', { field: 'TransactionId' });
    return {
      Record: record,
      Editability: await transactionLifecycleService.getEditability(transactionId)
    };
  },

  /**
   * Edit one movement in place, keeping its Id, and append one audit event — both
   * inside a single readwrite transaction over the two stores, so a failure on either
   * side leaves the database exactly as it was.
   */
  async editTransaction(transactionId, form = {}, options = {}) {
    authService.assertCanManageData();
    const previous = await transactionRepository.getById(transactionId);
    if (!previous) throw new AppError(ERROR_CODE.NOT_FOUND, 'الحركة غير موجودة.', { field: 'TransactionId' });

    const gate = canEditTransaction(previous);
    if (!gate.allowed) throw new AppError(ERROR_CODE.BUSINESS_RULE_ERROR, gate.reason, { field: 'TransactionId' });

    // Raw form input -> the approved draft shape (type and customer come from the
    // stored row). Unit scaling stays in the mapping helper, never in the screen.
    // A caller may instead hand over an already built draft (the validator then sees
    // exactly what the caller passed, which is how the derived-value guard is proven).
    const built = options.validatedDraft === true
      ? { Kind: 'transaction', Draft: form }
      : buildTransactionEditForm(previous, form);
    if (built.Kind === 'invalid') {
      throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'نوع الحركة غير معتمد.', { field: 'TransactionType' });
    }

    const customer = await customerRepository.getById(previous.CustomerId);
    const validation = validateTransactionEdit(built.Draft, previous, { customerExists: Boolean(customer) });
    if (!validation.ok) {
      const first = validation.errors[0];
      throw new AppError(first.code, first.message, { field: first.field, details: { errors: validation.errors } });
    }
    const data = validation.data;
    assertImmutableFields(previous, data);

    // Phase 4B.11 fix — the two references are read from the DRAFT the caller built, which is
    // the only place that knows whether a reference was actually supplied. `undefined` means
    // "not mentioned" and keeps the stored value untouched; an explicit id must exist and be
    // active before it replaces the stored one.
    const draftRefs = built.Draft || {};
    const suppliedCompany = Object.prototype.hasOwnProperty.call(draftRefs, 'ReceivingCompanyId')
      ? draftRefs.ReceivingCompanyId : undefined;
    const suppliedType = Object.prototype.hasOwnProperty.call(draftRefs, 'CartonTypeId')
      ? draftRefs.CartonTypeId : undefined;
    // A reference that is UNCHANGED is the historical one: it may be inactive today (or no
    // longer resolvable) and it is still kept exactly as stored. Only a reference the caller
    // actually re-points has to be a usable, active record — otherwise an old movement could
    // never be corrected at all.
    const companyChanged = suppliedCompany !== undefined && suppliedCompany !== (previous.ReceivingCompanyId ?? '');
    const typeChanged = suppliedType !== undefined && suppliedType !== (previous.CartonTypeId ?? '');
    if (previous.TransactionType === 'CropPurchaseCarton') {
      if (companyChanged && suppliedCompany) await receivingCompanyService.requireActive(suppliedCompany, 'ReceivingCompanyId');
      if (typeChanged && suppliedType) await cartonTypeService.requireActive(suppliedType, 'CartonTypeId');
    }

    // Phase 4B.13.1 — the same rule for the strawberry variety of a local purchase: a
    // variety the dialog did not mention keeps the stored one, and only an explicit
    // re-point has to be an existing, active record. An edit therefore never clears a
    // variety by accident.
    const draftCrop = (built.Draft && built.Draft.crop) || {};
    const suppliedVariety = Object.prototype.hasOwnProperty.call(draftCrop, 'StrawberryVarietyId')
      ? (draftCrop.StrawberryVarietyId || '')
      : undefined;
    const varietyChanged = suppliedVariety !== undefined && suppliedVariety !== (previous.StrawberryVarietyId ?? '');
    if (previous.TransactionType === 'CropPurchaseLocal' && varietyChanged && suppliedVariety) {
      await strawberryVarietyService.requireActive(suppliedVariety, 'StrawberryVarietyId');
    }

    const amountMinor = await resolveAmountMinor(data, previous);
    const occurredAt = nowIso();
    const updated = {
      ...previous,
      // The original identity is preserved: an edit never creates a second row.
      Id: previous.Id,
      CreatedAt: previous.CreatedAt,
      Date: data.Date,
      Description: data.Description,
      AmountMinor: amountMinor,
      Direction: data.Direction ?? null,
      LocalUnitsMilli: data.LocalUnitsMilli ?? null,
      LocalLooseKgMilli: data.LocalLooseKgMilli ?? null,
      LocalDeductionKgMilli: data.LocalDeductionKgMilli ?? null,
      LocalUnitPriceMinor: data.LocalUnitPriceMinor ?? null,
      CartonQuantityMilli: data.CartonQuantityMilli ?? null,
      CartonUnitPriceMinor: data.CartonUnitPriceMinor ?? null,
      CartonDiscountMinor: data.CartonDiscountMinor ?? null,
      // Phase 4B.11 — the reference ids may be re-pointed by an edit (validated by the
      // services layer), and the HISTORICAL package weight is carried over untouched:
      // an ordinary edit can never rewrite the weight a movement was recorded with.
      // Phase 4B.11 FINAL — an edit may REPLACE a carton reference but must never erase it:
      // an omitted field keeps the stored reference, and the edit path is therefore unable
      // to leave a carton movement without its company and its type.
      ReceivingCompanyId: previous.TransactionType === 'CropPurchaseCarton'
        ? (suppliedCompany || previous.ReceivingCompanyId || null)
        : (previous.ReceivingCompanyId ?? null),
      CartonTypeId: previous.TransactionType === 'CropPurchaseCarton'
        ? (suppliedType || previous.CartonTypeId || null)
        : (previous.CartonTypeId ?? null),
      // Phase 4B.13.1 — the variety is replaced only by an explicit new choice; otherwise
      // the historical one is carried over untouched (a descriptive field only).
      StrawberryVarietyId: previous.TransactionType === 'CropPurchaseLocal'
        ? (suppliedVariety || previous.StrawberryVarietyId || null)
        : (previous.StrawberryVarietyId ?? null),
      PackageWeightKg: previous.PackageWeightKg ?? null,
      PackageWeightStatus: previous.PackageWeightStatus ?? null,
      NetWeightMilli: previous.TransactionType === 'CropPurchaseLocal'
        ? cropPurchaseService.previewLocalNetWeight({
          units: (data.LocalUnitsMilli ?? 0) / 1000,
          looseKg: (data.LocalLooseKgMilli ?? 0) / 1000,
          deductionKg: (data.LocalDeductionKgMilli ?? 0) / 1000,
          packageWeightKg: editPackageWeight(previous) ?? 0
        })
        : (previous.NetWeightMilli ?? null),
      UpdatedAt: occurredAt
    };
    deriveFinancials(updated); // fails fast if the new values are unusable

    const entry = buildAuditEntry({
      eventType: AUDIT_EVENT_TYPE.EDITED,
      record: updated,
      previousRecord: previous,
      reason: data.EditReason,
      occurredAt,
      // The id is generated here by default; an explicit id is accepted only so a
      // caller can address a specific event (used by the atomicity tests, which force
      // a real storage collision to prove the rollback).
      entryId: options.auditEntryId || createId(ID_PREFIX.AUDIT)
    });

    await transactionLifecycleService.writeWithAudit({ record: updated, entry });
    return { Record: updated, AuditEntry: entry, Previous: previous };
  },

  /**
   * Cancel one movement — logically only. The row is kept, marked cancelled with its
   * reason and timestamp, and an audit event is appended in the same transaction.
   * There is no delete anywhere on this path.
   */
  async cancelTransaction(transactionId, reason, options = {}) {
    authService.assertCanManageData();
    const previous = await transactionRepository.getById(transactionId);
    if (!previous) throw new AppError(ERROR_CODE.NOT_FOUND, 'الحركة غير موجودة.', { field: 'TransactionId' });

    const gate = canCancelTransaction(previous);
    if (!gate.allowed) throw new AppError(ERROR_CODE.BUSINESS_RULE_ERROR, gate.reason, { field: 'TransactionId' });

    // The user must confirm explicitly; without that confirmation nothing is written.
    if (options.confirmed !== true) {
      throw new AppError(ERROR_CODE.BUSINESS_RULE_ERROR, 'إلغاء الحركة يتطلب تأكيدًا صريحًا من المستخدم.', { field: 'Confirm' });
    }

    const occurredAt = nowIso();
    const updated = {
      ...previous,
      Status: STATUS.CANCELLED,
      CancellationReason: reason === null || reason === undefined ? '' : String(reason).trim(),
      CancelledAt: occurredAt,
      UpdatedAt: occurredAt
    };
    const entry = buildAuditEntry({
      eventType: AUDIT_EVENT_TYPE.CANCELLED,
      record: updated,
      previousRecord: previous,
      reason: updated.CancellationReason,
      occurredAt,
      entryId: options.auditEntryId || createId(ID_PREFIX.AUDIT)
    });

    await transactionLifecycleService.writeWithAudit({ record: updated, entry });
    return { Record: updated, AuditEntry: entry, Previous: previous };
  },

  /**
   * The ONE write path of this phase. Both stores are opened in the same readwrite
   * transaction and both writes are awaited inside it: if either request fails the
   * whole transaction aborts, so an edited movement can never exist without its audit
   * event and an audit event can never exist for an edit that did not happen.
   */
  async writeWithAudit({ record, entry }) {
    const stores = [STORE.TRANSACTIONS, STORE.AUDIT_LOG];
    return runTransaction(stores, 'readwrite', async (handles) => {
      const put = (storeName, value) => new Promise((resolve, reject) => {
        const request = handles[storeName].put(value);
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(new AppError(ERROR_CODE.STORAGE_ERROR, 'تعذر حفظ الحركة وسجل التدقيق.', { cause: request.error }));
      });
      const add = (storeName, value) => new Promise((resolve, reject) => {
        const request = handles[storeName].add(value);
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(new AppError(ERROR_CODE.STORAGE_ERROR, 'تعذر حفظ حدث سجل التدقيق.', { cause: request.error }));
      });
      await put(STORE.TRANSACTIONS, record);
      // `add` (never `put`): a historical event can only ever be appended.
      await add(STORE.AUDIT_LOG, entry);
      return { record, entry };
    });
  },

  // Read side of the audit trail, oldest first.
  async listAuditTrail(transactionId) {
    authService.assertCanManageData();
    if (!transactionId) return [];
    const entries = await auditLogRepository.listByTransaction(transactionId);
    return entries.slice().sort((a, b) => {
      const byTime = String(a.OccurredAt || '').localeCompare(String(b.OccurredAt || ''));
      if (byTime !== 0) return byTime;
      return String(a.Id).localeCompare(String(b.Id));
    });
  },

  async getAuditEntry(entryId) {
    authService.assertCanManageData();
    return auditLogRepository.getById(entryId);
  },

  async countAuditEntries() {
    return auditLogRepository.count();
  },

  async listAllAuditEntries() {
    authService.assertCanManageData();
    return auditLogRepository.getAll();
  }
};

export { linkedOperationReason, canEditTransaction, canCancelTransaction, isLinkedOperation, CANCELLED_EDIT_MESSAGE, CANCELLED_CANCEL_MESSAGE, LINKED_OPERATION_MESSAGE } from '../domain/transactionLifecycle.js';
