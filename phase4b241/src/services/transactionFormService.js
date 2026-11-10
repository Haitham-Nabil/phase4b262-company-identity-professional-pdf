// Phase 4B.3 — the single service entry point behind the Add Transaction screen.
//
// It orchestrates the EXISTING approved services: it validates nothing itself,
// decides no direction, no cash / non-cash flag and no balance. It maps form input,
// delegates the write to transactionService / debtTransferService, and reads the
// resulting balance back through balanceService so the UI can display a value it
// never computed.
import { transactionService } from './transactionService.js';
import { debtTransferService } from './debtTransferService.js';
import { balanceService } from './balanceService.js';
import { cropPurchaseService } from './cropPurchaseService.js';
import { customerService } from './customerService.js';
import { settingsService } from './settingsService.js';
import { buildTransactionForm, previewFieldsFor, formFieldsFor, requiredFormKeys } from '../validation/transactionFormInput.js';
import { receivingCompanyService, cartonTypeService, strawberryVarietyService } from './referenceDataService.js';
import { TRANSACTION_TYPE, isCropPurchaseType } from '../domain/transactionTypes.js';
import { toIsoDate } from '../domain/dateUtils.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';
import { authService } from './authService.js';

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function customerRef(summary) {
  return {
    Id: summary.CustomerId,
    Code: summary.Code ?? null,
    Name: summary.Name ?? null,
    NewBalanceMinor: summary.BalanceMinor,
    NewBalanceSide: summary.BalanceSide
  };
}

// Additive re-exports: the UI reaches these definitions through the services layer
// only, exactly as it already reads the transaction type catalogue from balanceService.
export { TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS_AR, TRANSACTION_TYPE, isCropPurchaseType } from '../domain/transactionTypes.js';
export { FORM_KEY, emptyForm } from '../validation/transactionFormInput.js';

// Phase 4B.9 — read-only preview of a debt transfer. The raw form is mapped to the
// approved input shape and the projection itself is delegated to debtTransferService,
// which uses the same approved engine as the write path. This facade decides no
// direction and computes no balance of its own.
//
// It is exported as a NAMED function and deliberately NOT added as a property of the
// transactionFormService object, so the approved surface of that object — asserted
// exactly by the existing Phase 4B.3 tests — stays unchanged.
export async function previewTransfer(form = {}) {
  const built = buildTransactionForm(form);
  if (built.Kind !== 'debtTransfer') {
    return { Valid: false, Message: 'نوع الحركة غير معتمد.', Field: 'TransactionType' };
  }
  const preview = await debtTransferService.previewTransfer(built.Input);
  return { ...preview, Missing: built.Missing };
}

// Phase 4B.11 — read-only reference options for the carton-purchase screen, and the two
// "add new" actions. Exported as NAMED functions (not object properties) so the approved
// surface of `transactionFormService` — asserted exactly by the Phase 4B.3 tests — stays
// unchanged. Creating a reference record writes no movement and no amount.
export async function listReferenceOptions() {
  const [companies, cartonTypes, varieties] = await Promise.all([
    receivingCompanyService.list(),
    cartonTypeService.list(),
    strawberryVarietyService.list()
  ]);
  const project = (row) => ({ Id: row.Id, Name: row.Name, IsActive: row.IsActive === true });
  return {
    ReceivingCompanies: companies.map(project),
    CartonTypes: cartonTypes.map(project),
    // Phase 4B.13.1 — the variety catalogue read by the local crop purchase screen,
    // including the inactive records so a historical choice can still be shown.
    StrawberryVarieties: varieties.map(project)
  };
}

export async function createReceivingCompany(name) {
  return receivingCompanyService.create(name);
}

export async function createCartonType(name) {
  return cartonTypeService.create(name);
}

// Phase 4B.13.1 — the variety catalogue through the same facade. Creating a variety
// writes ONE reference row: no movement, no amount and no balance.
export async function createStrawberryVariety(name) {
  return strawberryVarietyService.create(name);
}

export async function listStrawberryVarietyRows() { return strawberryVarietyService.list(); }

export async function renameStrawberryVariety(id, name) { return strawberryVarietyService.rename(id, name); }

export async function setStrawberryVarietyActive(id, isActive) { return strawberryVarietyService.setActive(id, isActive); }

export async function listReceivingCompanyRows() { return receivingCompanyService.list(); }

export async function listCartonTypeRows() { return cartonTypeService.list(); }

export async function renameReceivingCompany(id, name) { return receivingCompanyService.rename(id, name); }

export async function renameCartonType(id, name) { return cartonTypeService.rename(id, name); }

export async function setReceivingCompanyActive(id, isActive) { return receivingCompanyService.setActive(id, isActive); }

export async function setCartonTypeActive(id, isActive) { return cartonTypeService.setActive(id, isActive); }

export const transactionFormService = {
  // Reuses the approved ISO date helper; no timezone shifting is applied.
  currentIsoDate(date = new Date()) {
    return toIsoDate(date);
  },

  formFields(transactionType) {
    return formFieldsFor(transactionType);
  },

  previewFields(transactionType) {
    return previewFieldsFor(transactionType);
  },

  requiredKeys(transactionType) {
    return requiredFormKeys(transactionType);
  },

  // Customers shown in the picker: Code + Name, read through the services layer.
  async listSelectableCustomers() {
    return customerService.listSelectableCustomers();
  },

  // The one setting the crop formula depends on, read through its own service.
  async getDefaultPackageWeight() {
    return settingsService.getDefaultPackageWeight();
  },

  // Preview only. The Core calculators are called as-is; nothing is duplicated and
  // nothing computed here is ever stored. A preview failure is reported as null.
  async previewCrop(form = {}) {
    const transactionType = form.TransactionType;
    if (!isCropPurchaseType(transactionType)) return null;
    try {
      if (transactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL) {
        const preview = await cropPurchaseService.previewLocal({
          units: asNumber(form.Units),
          looseKg: asNumber(form.LooseKg),
          deductionKg: asNumber(form.DeductionKg),
          unitPrice: asNumber(form.UnitPrice)
        });
        return {
          PackageWeightKg: preview.packageWeightKg,
          NetWeightMilli: preview.NetWeightMilli,
          AmountMinor: preview.LocalTotalMinor
        };
      }
      const amountMinor = cropPurchaseService.computeCartonAmountMinor({
        quantity: asNumber(form.CartonQuantity),
        discount: asNumber(form.CartonDiscount),
        unitPrice: asNumber(form.CartonPrice)
      });
      return { PackageWeightKg: null, NetWeightMilli: null, AmountMinor: amountMinor };
    } catch (error) {
      return null;
    }
  },

  /**
   * One user action -> exactly one write.
   *  - any type except DebtTransfer: ONE transaction row.
   *  - DebtTransfer: one operation, TWO linked rows written atomically by the
   *    approved debtTransferService (single storage transaction, all-or-nothing).
   * Throws the existing AppError taxonomy; no Success is ever reported by this
   * layer, and no partial state is left behind on failure.
   */
  async submitTransactionForm(form = {}) {
    const built = buildTransactionForm(form);
    if (built.Kind === 'invalid') {
      throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'نوع الحركة غير معتمد.', { field: 'TransactionType' });
    }

    if (built.Kind === 'debtTransfer') {
      const transfer = await debtTransferService.createDebtTransfer(built.Input);
      if (authService.isEnforced() && !authService.isAdmin()) {
        const [creditCustomer, debitCustomer] = await Promise.all([customerService.getSelectableCustomer(transfer.CreditRow.CustomerId), customerService.getSelectableCustomer(transfer.DebitRow.CustomerId)]);
        return { Kind: 'debtTransfer', LinkId: transfer.LinkId, CashImpactMinor: 0, Records: [transfer.CreditRow, transfer.DebitRow], Customer: creditCustomer, CustomerId: transfer.CreditRow.CustomerId, NewBalanceMinor: null, NewBalanceSide: null, Counterparty: debitCustomer };
      }
      const creditSummary = await balanceService.getCustomerSummary(transfer.CreditRow.CustomerId);
      const debitSummary = await balanceService.getCustomerSummary(transfer.DebitRow.CustomerId);
      return {
        Kind: 'debtTransfer',
        LinkId: transfer.LinkId,
        CashImpactMinor: transfer.CashImpactMinor,
        Records: [transfer.CreditRow, transfer.DebitRow],
        Customer: (!authService.isEnforced() || authService.isAdmin()) ? customerRef(creditSummary) : { Id: creditSummary.CustomerId },
        CustomerId: creditSummary.CustomerId,
        NewBalanceMinor: (!authService.isEnforced() || authService.isAdmin()) ? creditSummary.BalanceMinor : null,
        NewBalanceSide: (!authService.isEnforced() || authService.isAdmin()) ? creditSummary.BalanceSide : null,
        Counterparty: (!authService.isEnforced() || authService.isAdmin()) ? customerRef(debitSummary) : { Id: debitSummary.CustomerId }
      };
    }

    const record = await transactionService.createTransaction(built.Draft);
    if (authService.isEnforced() && !authService.isAdmin()) {
      const customer = await customerService.getSelectableCustomer(record.CustomerId);
      return { Kind: 'transaction', Record: record, Customer: customer, CustomerId: record.CustomerId, NewBalanceMinor: null, NewBalanceSide: null };
    }
    const summary = await balanceService.getCustomerSummary(record.CustomerId);
    return {
      Kind: 'transaction',
      Record: record,
      Customer: (!authService.isEnforced() || authService.isAdmin()) ? customerRef(summary) : { Id: summary.CustomerId },
      CustomerId: record.CustomerId,
      NewBalanceMinor: (!authService.isEnforced() || authService.isAdmin()) ? summary.BalanceMinor : null,
      NewBalanceSide: (!authService.isEnforced() || authService.isAdmin()) ? summary.BalanceSide : null
    };
  }
};
