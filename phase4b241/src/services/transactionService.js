import { transactionRepository } from '../repositories/transactionRepository.js';
import { customerRepository } from '../repositories/customerRepository.js';
import { validateTransactionDraft } from '../validation/transactionValidation.js';
import { deriveFinancials } from '../domain/financialDirection.js';
import { STATUS, TRANSACTION_TYPE, isCropPurchaseType, isCashType } from '../domain/transactionTypes.js';
import { cropPurchaseService } from './cropPurchaseService.js';
import { settingsService } from './settingsService.js';
import { receivingCompanyService, cartonTypeService, strawberryVarietyService } from './referenceDataService.js';
import { PACKAGE_WEIGHT_STATUS } from '../storage/schema.js';
import { balanceService, orderTransactions } from './balanceService.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';
import { createId, ID_PREFIX } from '../utils/id.js';
import { nowIso } from '../domain/dateUtils.js';
import { authService } from './authService.js';

// The operation value has EXACTLY ONE source, decided by the transaction type:
//   - CropPurchaseLocal / CropPurchaseCarton -> derived from the crop inputs and
//     DefaultPackageWeight (read from Settings). No explicit amount is ever read,
//     so no second source of the operation value can exist.
//   - Every other type -> the amount already validated and normalised to minor units.
async function resolveAmount(draft, validatedAmountMinor = null, packageWeightKg = null) {
  const type = draft.TransactionType;
  const crop = draft.crop || {};
  if (type === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL) {
    // G = D x (DefaultPackageWeight - F) + E   then   Amount = G x H
    return cropPurchaseService.computeLocalAmountMinor({
      units: (crop.LocalUnitsMilli ?? 0) / 1000,
      looseKg: (crop.LocalLooseKgMilli ?? 0) / 1000,
      deductionKg: (crop.LocalDeductionKgMilli ?? 0) / 1000,
      unitPrice: (crop.LocalUnitPriceMinor ?? 0) / 100,
      packageWeightKg
    });
  }
  if (type === TRANSACTION_TYPE.CROP_PURCHASE_CARTON) {
    // Amount = (K - M) x L
    return cropPurchaseService.computeCartonAmountMinor({
      quantity: (crop.CartonQuantityMilli ?? 0) / 1000,
      discount: (crop.CartonDiscountMinor ?? 0) / 100,
      unitPrice: (crop.CartonUnitPriceMinor ?? 0) / 100
    });
  }
  if (Number.isInteger(validatedAmountMinor) && validatedAmountMinor > 0) return validatedAmountMinor;
  throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'المبلغ مطلوب لهذا النوع من الحركة.', { field: 'Amount' });
}

// Phase 4B.11 — the two reference ids of a carton purchase. They are validated through
// their own services (existence + active flag) and are OPTIONAL so that a movement can
// still be recorded when the catalogue has not been filled yet; an id that IS supplied
// must exist and be active. No financial figure is produced here.
async function resolveCartonReferences(draft) {
  if (draft.TransactionType !== TRANSACTION_TYPE.CROP_PURCHASE_CARTON) {
    return { ReceivingCompanyId: null, CartonTypeId: null };
  }
  const receivingCompanyId = draft.ReceivingCompanyId ? String(draft.ReceivingCompanyId).trim() : '';
  const cartonTypeId = draft.CartonTypeId ? String(draft.CartonTypeId).trim() : '';
  // Phase 4B.11 FINAL — a carton purchase is "N cartons of THIS type delivered to THIS
  // company": both references are REQUIRED on every new movement. They are refused with
  // field-level errors so the screen can point at the exact dropdown.
  const errors = [];
  if (!receivingCompanyId) {
    errors.push({ code: 'VALIDATION_ERROR', message: 'يجب اختيار الشركة المستلمة للمحصول.', field: 'ReceivingCompanyId' });
  }
  if (!cartonTypeId) {
    errors.push({ code: 'VALIDATION_ERROR', message: 'يجب اختيار نوع الكرتونة.', field: 'CartonTypeId' });
  }
  if (errors.length) {
    throw new AppError(errors[0].code, errors[0].message, { field: errors[0].field, details: { errors } });
  }
  await receivingCompanyService.requireActive(receivingCompanyId, 'ReceivingCompanyId');
  await cartonTypeService.requireActive(cartonTypeId, 'CartonTypeId');
  return { ReceivingCompanyId: receivingCompanyId, CartonTypeId: cartonTypeId };
}

// Phase 4B.13.1 — the strawberry variety of a LOCAL crop purchase. It is a descriptive
// reference only: it changes no input, no formula, no amount and no balance. A supplied
// id must exist and be ACTIVE, so an inactive variety can never enter a new movement;
// an absent id stays null and is never replaced by a default.
async function resolveStrawberryVariety(draft) {
  if (draft.TransactionType !== TRANSACTION_TYPE.CROP_PURCHASE_LOCAL) return null;
  const crop = draft.crop || {};
  const raw = crop.StrawberryVarietyId;
  const id = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!id) return null;
  await strawberryVarietyService.requireActive(id, 'StrawberryVarietyId');
  return id;
}

async function buildRecord(draft) {
  const customer = await customerRepository.getById(draft.CustomerId);
  const validation = validateTransactionDraft(draft, { customerExists: Boolean(customer) });
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new AppError(first.code, first.message, { field: first.field, details: { errors: validation.errors } });
  }
  const references = await resolveCartonReferences(draft);
  const strawberryVarietyId = await resolveStrawberryVariety(draft);
  // Phase 4B.11 — a NEW local crop purchase freezes the package weight in effect right
  // now. The value is read once, used for this movement's net weight and stored on the
  // row, so a later change of the setting can never rewrite this movement.
  let packageWeightKg = null;
  if (validation.data.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL) {
    packageWeightKg = await settingsService.getDefaultPackageWeight();
  }
  const amountMinor = await resolveAmount(draft, validation.data.AmountMinor, packageWeightKg);
  const netWeightMilli = validation.data.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL
    ? cropPurchaseService.previewLocalNetWeight({
      units: (validation.data.LocalUnitsMilli ?? 0) / 1000,
      looseKg: (validation.data.LocalLooseKgMilli ?? 0) / 1000,
      deductionKg: (validation.data.LocalDeductionKgMilli ?? 0) / 1000,
      packageWeightKg
    })
    : null;
  const now = nowIso();
  const record = {
    Id: createId(ID_PREFIX.TRANSACTION),
    CustomerId: validation.data.CustomerId,
    Date: validation.data.Date,
    TransactionType: validation.data.TransactionType,
    Description: validation.data.Description,
    AmountMinor: amountMinor,
    LinkId: validation.data.LinkId,
    TransferRole: validation.data.TransferRole,
    // Persisted direction of the two side-dependent non-cash types (null elsewhere).
    Direction: validation.data.Direction ?? null,
    Status: STATUS.ACTIVE,
    CancellationReason: null,
    CancelledAt: null,
    CreatedAt: now,
    UpdatedAt: now,
    LocalUnitsMilli: validation.data.LocalUnitsMilli,
    LocalLooseKgMilli: validation.data.LocalLooseKgMilli,
    LocalDeductionKgMilli: validation.data.LocalDeductionKgMilli,
    LocalUnitPriceMinor: validation.data.LocalUnitPriceMinor,
    CartonQuantityMilli: validation.data.CartonQuantityMilli,
    CartonUnitPriceMinor: validation.data.CartonUnitPriceMinor,
    CartonDiscountMinor: validation.data.CartonDiscountMinor,
    // Phase 4B.11 — carton purchase: farmer (CustomerId) + receiving company + carton
    // type + carton count (CartonQuantityMilli). No weight ever enters this type.
    ReceivingCompanyId: references.ReceivingCompanyId,
    CartonTypeId: references.CartonTypeId,
    // Phase 4B.13.1 — local crop purchase: the variety id the crop was bought as. Stored
    // as an id (never as free text), and null when the movement names no variety.
    StrawberryVarietyId: strawberryVarietyId,
    // Phase 4B.11 — local crop purchase: the package weight used at recording time and
    // the net weight it produced. `Confirmed` means "this row knows its weight".
    PackageWeightKg: packageWeightKg,
    PackageWeightStatus: packageWeightKg === null ? null : PACKAGE_WEIGHT_STATUS.CONFIRMED,
    NetWeightMilli: netWeightMilli
  };
  deriveFinancials(record); // fails fast if the value or type is unusable
  return record;
}

export const transactionService = {
  // One user action => exactly ONE independent transaction row (spec §19).
  async addTransaction(draft) {
    const record = await buildRecord(draft);
    const order = orderTransactions(await transactionRepository.listByCustomer(record.CustomerId));
    const previous = order.length ? order[order.length - 1] : null;
    return { record, postedBalanceMinor: null, previousEntryId: previous ? previous.Id : null };
  },

  async createTransaction(draft) {
    authService.assertCanAdd();
    const { record } = await transactionService.addTransaction(draft);
    await transactionRepository.add(record);
    return record;
  },

  async createMany(drafts) {
    authService.assertCanManageData();
    const records = [];
    for (const draft of drafts) records.push(await buildRecord(draft));
    await transactionRepository.putMany(records);
    return records;
  },

  async getTransaction(transactionId) {
    authService.assertCanManageData(); return transactionRepository.getById(transactionId); },
  async listByCustomer(customerId) {
    authService.assertCanManageData(); return orderTransactions(await transactionRepository.listByCustomer(customerId)); },
  async listByLinkId(linkId) {
    authService.assertCanManageData(); return transactionRepository.listByLinkId(linkId); },

  async getLedger(customerId) {
    authService.assertCanManageData(); return balanceService.getRunningBalance(customerId); },

  async getCashTotals(customerId) {
    authService.assertCanManageData();
    const rows = await transactionRepository.listByCustomer(customerId);
    let CashReceivedMinor = 0;
    let CashPaidMinor = 0;
    for (const row of rows) {
      const f = deriveFinancials(row);
      if (!f.isActive) continue;
      CashReceivedMinor += f.CashReceivedMinor;
      CashPaidMinor += f.CashPaidMinor;
    }
    return { CashReceivedMinor, CashPaidMinor };
  }
};

export { isCropPurchaseType, isCashType };
