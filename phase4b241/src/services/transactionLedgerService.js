import { authService } from './authService.js';
// Phase 4B.15 — the central transactions ledger (READ ONLY).
//
// ONE service owns every rule of the ledger: which rows exist, how a linked operation is
// presented, how the search matches, how the filters combine and in which order the rows
// are returned. The screen prints what this module returns and decides nothing.
//
// What this module deliberately does NOT do:
//   • it never writes: every path here is a repository READ, so opening the screen,
//     searching or filtering cannot move a balance or add a row;
//   • it never computes an amount, a debit, a credit, a cash figure or a balance. Those
//     figures come from `deriveFinancials()` — the same engine every balance already uses;
//   • it never merges two DIFFERENT movements into one row. The only merge is the approved
//     debt-transfer operation, whose two legs are ONE user action recorded as two rows with
//     one shared LinkId (`debtTransferService.createDebtTransfer`). They are shown as one
//     operation naming both parties, never as two unexplained transfers;
//   • it never invents a customer, a company, a carton type, a variety, a count or a weight.
//     A reference that resolves to nothing is reported as unavailable, and a value the row
//     never had stays «غير محدد» — never a fabricated zero.
//
// Sorting is the project's own ledger order (Date, then CreatedAt, then Id), applied in
// REVERSE so the newest movement is first, which is what a central register shows.
import { transactionRepository } from '../repositories/transactionRepository.js';
import { customerRepository } from '../repositories/customerRepository.js';
import { receivingCompanyRepository } from '../repositories/receivingCompanyRepository.js';
import { cartonTypeRepository } from '../repositories/cartonTypeRepository.js';
import { strawberryVarietyRepository } from '../repositories/strawberryVarietyRepository.js';
import { deriveFinancials } from '../domain/financialDirection.js';
import { STATUS, TRANSACTION_TYPE, TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS_AR, DEBT_TRANSFER_ROLE } from '../domain/transactionTypes.js';
import { isValidIsoDate } from '../domain/dateUtils.js';
import { cartonReferenceParts, localReferenceParts, UNSPECIFIED, UNAVAILABLE } from './movementNotes.js';
import { cropPurchaseService } from './cropPurchaseService.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';

// The three status choices of the screen. `all` is the absence of a filter, not a status.
export const LEDGER_STATUS_FILTER = Object.freeze({
  ALL: 'all',
  ACTIVE: STATUS.ACTIVE,
  CANCELLED: STATUS.CANCELLED
});

export const LEDGER_STATUS_OPTIONS = Object.freeze([
  Object.freeze({ value: LEDGER_STATUS_FILTER.ALL, label: 'الكل' }),
  Object.freeze({ value: LEDGER_STATUS_FILTER.ACTIVE, label: 'نشطة' }),
  Object.freeze({ value: LEDGER_STATUS_FILTER.CANCELLED, label: 'ملغاة' })
]);

// Presentation labels for values the domain produced. They are not decisions: `Direction`
// is the engine's own output and `Status` is the stored lifecycle value.
export const LEDGER_DIRECTION_LABELS_AR = Object.freeze({ Credit: 'دائن', Debit: 'مدين' });
export const LEDGER_STATUS_LABELS_AR = Object.freeze({ Active: 'نشطة', Cancelled: 'ملغاة' });

// Wording reused from the statement layer so the two screens can never disagree.
export const LEDGER_UNSPECIFIED = UNSPECIFIED;
export const LEDGER_UNAVAILABLE = UNAVAILABLE;
export const LEDGER_EMPTY_VALUE = '—';
export const LEDGER_TRANSFER_TITLE = 'تحويل مديونية';
export const LEDGER_MERGED_TRANSFER_NOTE = 'عملية واحدة بسجلين مرتبطين (طرفان) — تُعرض مرة واحدة ولا تُحتسب إلا مرة واحدة.';

// ---------------------------------------------------------------------------
// Filters — pure functions, testable without a database.
// ---------------------------------------------------------------------------

// Absent / empty filters mean "not restricted", never "match nothing".
export function normalizeLedgerFilters(filters = {}) {
  const text = (value) => (value === null || value === undefined ? '' : String(value).trim());
  const search = text(filters.search);
  const customerId = text(filters.customerId);
  const type = text(filters.type);
  const from = text(filters.from);
  const to = text(filters.to);
  const rawStatus = text(filters.status);
  const status = rawStatus === '' ? LEDGER_STATUS_FILTER.ALL : rawStatus;

  if (type && !TRANSACTION_TYPES.includes(type)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'نوع الحركة المحدد غير معتمد.', { field: 'type' });
  }
  if (from && !isValidIsoDate(from)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'تاريخ البداية غير صالح؛ الصيغة المعتمدة YYYY-MM-DD.', { field: 'from' });
  }
  if (to && !isValidIsoDate(to)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'تاريخ النهاية غير صالح؛ الصيغة المعتمدة YYYY-MM-DD.', { field: 'to' });
  }
  if (from && to && from > to) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'تاريخ البداية يجب ألا يكون بعد تاريخ النهاية.', { field: 'from' });
  }
  if (!Object.values(LEDGER_STATUS_FILTER).includes(status)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'حالة الحركة المحددة غير معتمدة.', { field: 'status' });
  }
  return { search, customerId, type, from, to, status };
}

// The text a search compares against: the customer of the movement, plus BOTH parties of a
// linked transfer, plus the stored description. Nothing is derived from a figure.
function matchesSearch(row, needle) {
  if (!needle) return true;
  const haystack = String(row.SearchText || '').toLowerCase();
  return haystack.includes(needle);
}

function withinPeriod(row, from, to) {
  if (from && String(row.Date) < from) return false;
  if (to && String(row.Date) > to) return false;
  return true;
}

// All filters combine with AND. A type filter uses the stored type of the operation, so a
// merged transfer only answers to «تحويل مديونية» and never to a leg's type name.
export function applyLedgerFilters(rows = [], filters = {}) {
  const normalized = normalizeLedgerFilters(filters);
  const needle = normalized.search.toLowerCase();
  return rows.filter((row) => {
    if (normalized.customerId && row.CustomerId !== normalized.customerId && row.CounterpartyId !== normalized.customerId) return false;
    if (normalized.type && row.TransactionType !== normalized.type) return false;
    if (normalized.status !== LEDGER_STATUS_FILTER.ALL) {
      const wanted = normalized.status === LEDGER_STATUS_FILTER.CANCELLED;
      if (Boolean(row.IsCancelled) !== wanted) return false;
    }
    if (!withinPeriod(row, normalized.from, normalized.to)) return false;
    return matchesSearch(row, needle);
  });
}

// ---------------------------------------------------------------------------
// Row building — reads only.
// ---------------------------------------------------------------------------

function emptyToNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

// Newest first: the ledger order reversed. Pure and stable for equal keys.
export function orderLedgerRows(rows = []) {
  return rows.slice().sort((a, b) => {
    const byDate = String(b.Date).localeCompare(String(a.Date));
    if (byDate !== 0) return byDate;
    const byCreated = String(b.CreatedAt || '').localeCompare(String(a.CreatedAt || ''));
    if (byCreated !== 0) return byCreated;
    return String(b.Id).localeCompare(String(a.Id));
  });
}

function directionLabel(direction) {
  return LEDGER_DIRECTION_LABELS_AR[direction] ?? null;
}

function statusLabel(status) {
  return LEDGER_STATUS_LABELS_AR[status] ?? null;
}

function typeLabel(transactionType) {
  return TRANSACTION_TYPE_LABELS_AR[transactionType] ?? transactionType;
}

// The stored references of a row, resolved by their ids. An id that resolves to nothing and
// an id that was never stored are reported differently, exactly as the statement does.
function referenceFields({ id, name, isActive, kindLabel }) {
  const label = name ? (isActive === false ? `${name} (غير نشطة)` : name) : (id ? UNAVAILABLE : UNSPECIFIED);
  return { Label: `${kindLabel}: ${label}` };
}

function customerParts(customer) {
  if (!customer) return { CustomerCode: null, CustomerName: null, CustomerActive: null };
  return {
    CustomerCode: customer.Code ?? null,
    CustomerName: customer.Name ?? null,
    CustomerActive: customer.IsActive === true
  };
}

function searchTextFor(parts) {
  return parts.filter((part) => part !== null && part !== undefined && String(part).trim() !== '')
    .map((part) => String(part).trim().toLowerCase())
    .join(' ');
}

/**
 * Build the whole ledger from stored data.
 * Returns { Rows, Summary } where every figure is read from the domain projection or from
 * the stored row — never computed here.
 */
export async function buildLedger() {
  authService.assertCanViewLedger();
  const records = await transactionRepository.getAll();
  const customers = await customerRepository.getAll();
  const customerById = new Map(customers.map((customer) => [customer.Id, customer]));

  // Reference catalogues are read once and indexed, so resolving a row costs no extra read.
  const companies = new Map((await receivingCompanyRepository.getAll()).map((row) => [row.Id, row]));
  const cartonTypes = new Map((await cartonTypeRepository.getAll()).map((row) => [row.Id, row]));
  const varieties = new Map((await strawberryVarietyRepository.getAll()).map((row) => [row.Id, row]));

  const rows = [];
  const seenIds = new Set();
  const transferGroups = new Map();

  // Pass 1 — every stored row is classified exactly once. A debt-transfer leg is collected
  // under its LinkId so the operation can be presented as one row in pass 2.
  for (const record of records) {
    if (!record || !record.Id) continue;
    if (seenIds.has(record.Id)) continue;
    seenIds.add(record.Id);
    const linkId = emptyToNull(record.LinkId);
    if (linkId) {
      if (!transferGroups.has(linkId)) transferGroups.set(linkId, []);
      transferGroups.get(linkId).push(record);
    }
  }

  for (const record of records) {
    if (!record || !record.Id) continue;
    const linkId = emptyToNull(record.LinkId);
    // A linked operation is emitted once, by pass 2, from its group.
    if (linkId && transferGroups.has(linkId)) continue;

    const customer = customerById.get(record.CustomerId) ?? null;
    const financials = deriveFinancials(record);
    const parts = [];
    let referenceParts = null;

    if (record.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_CARTON) {
      const company = record.ReceivingCompanyId ? companies.get(record.ReceivingCompanyId) : null;
      const cartonType = record.CartonTypeId ? cartonTypes.get(record.CartonTypeId) : null;
      referenceParts = cartonReferenceParts({
        ReceivingCompanyId: record.ReceivingCompanyId ?? null,
        ReceivingCompanyName: company ? company.Name : null,
        ReceivingCompanyActive: company ? company.IsActive === true : null,
        CartonTypeId: record.CartonTypeId ?? null,
        CartonTypeName: cartonType ? cartonType.Name : null,
        CartonTypeActive: cartonType ? cartonType.IsActive === true : null,
        CartonQuantityMilli: Number.isInteger(record.CartonQuantityMilli) ? record.CartonQuantityMilli : null,
        CartonUnitPriceMinor: Number.isInteger(record.CartonUnitPriceMinor) ? record.CartonUnitPriceMinor : null
      });
    } else if (record.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL) {
      const facts = cropPurchaseService.localMovementFacts(record);
      const variety = record.StrawberryVarietyId ? varieties.get(record.StrawberryVarietyId) : null;
      referenceParts = localReferenceParts({
        StrawberryVarietyId: record.StrawberryVarietyId ?? null,
        StrawberryVarietyName: variety ? variety.Name : null,
        StrawberryVarietyActive: variety ? variety.IsActive === true : null,
        PackageCountMilli: facts.PackageCountMilli,
        CropNetWeightMilli: facts.NetWeightMilli,
        CropWeightResolved: facts.Resolved,
        LocalUnitPriceMinor: Number.isInteger(record.LocalUnitPriceMinor) ? record.LocalUnitPriceMinor : null
      });
    }
    if (referenceParts) parts.push(...referenceParts);

    rows.push({
      RowKey: record.Id,
      Id: record.Id,
      LinkId: null,
      LegIds: [record.Id],
      LegCount: 1,
      Date: record.Date,
      CreatedAt: record.CreatedAt ?? null,
      TransactionType: record.TransactionType,
      TypeLabel: typeLabel(record.TransactionType),
      ...customerParts(customer),
      CustomerId: record.CustomerId ?? null,
      Description: record.Description ?? null,
      AmountMinor: record.AmountMinor,
      Direction: financials.direction,
      DirectionLabel: directionLabel(financials.direction),
      DebitMinor: financials.DebitMinor,
      CreditMinor: financials.CreditMinor,
      CashReceivedMinor: financials.CashReceivedMinor,
      CashPaidMinor: financials.CashPaidMinor,
      SettlementMinor: financials.SettlementMinor,
      IsCash: financials.isCash === true,
      Status: record.Status,
      StatusLabel: statusLabel(record.Status),
      IsCancelled: !financials.isActive,
      CancellationReason: record.CancellationReason ?? null,
      CancelledAt: record.CancelledAt ?? null,
      // Linked-operation fields stay empty on a standalone movement.
      IsLinkedOperation: false,
      CounterpartyId: null,
      CounterpartyCode: null,
      CounterpartyName: null,
      CounterpartyRole: null,
      MergedNote: null,
      // Crop facts, exactly as stored / as the weight service read them.
      PackageCountMilli: record.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL
        ? (cropPurchaseService.localMovementFacts(record).PackageCountMilli ?? null) : null,
      CropNetWeightMilli: record.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL
        ? (cropPurchaseService.localMovementFacts(record).NetWeightMilli ?? null) : null,
      CropWeightResolved: record.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL
        ? cropPurchaseService.localMovementFacts(record).Resolved : null,
      PackageWeightKg: record.PackageWeightKg ?? null,
      StrawberryVarietyId: record.StrawberryVarietyId ?? null,
      StrawberryVarietyName: record.StrawberryVarietyId && varieties.get(record.StrawberryVarietyId)
        ? varieties.get(record.StrawberryVarietyId).Name : null,
      StrawberryVarietyActive: record.StrawberryVarietyId && varieties.get(record.StrawberryVarietyId)
        ? varieties.get(record.StrawberryVarietyId).IsActive === true : null,
      ReceivingCompanyId: record.ReceivingCompanyId ?? null,
      ReceivingCompanyName: record.ReceivingCompanyId && companies.get(record.ReceivingCompanyId)
        ? companies.get(record.ReceivingCompanyId).Name : null,
      ReceivingCompanyActive: record.ReceivingCompanyId && companies.get(record.ReceivingCompanyId)
        ? companies.get(record.ReceivingCompanyId).IsActive === true : null,
      CartonTypeId: record.CartonTypeId ?? null,
      CartonTypeName: record.CartonTypeId && cartonTypes.get(record.CartonTypeId)
        ? cartonTypes.get(record.CartonTypeId).Name : null,
      CartonTypeActive: record.CartonTypeId && cartonTypes.get(record.CartonTypeId)
        ? cartonTypes.get(record.CartonTypeId).IsActive === true : null,
      CartonQuantityMilli: Number.isInteger(record.CartonQuantityMilli) ? record.CartonQuantityMilli : null,
      CartonUnitPriceMinor: Number.isInteger(record.CartonUnitPriceMinor) ? record.CartonUnitPriceMinor : null,
      LocalUnitPriceMinor: Number.isInteger(record.LocalUnitPriceMinor) ? record.LocalUnitPriceMinor : null,
      ReferenceParts: referenceParts,
      SearchText: searchTextFor([
        customer ? customer.Code : null,
        customer ? customer.Name : null,
        record.Description,
        typeLabel(record.TransactionType)
      ])
    });
  }

  // Pass 2 — one user action, one row: the two legs of a debt transfer become ONE entry that
  // names both parties and its single direction. The amount is announced once; the two sides
  // are never added together, so nothing is double counted.
  for (const [linkId, legs] of transferGroups.entries()) {
    const creditLeg = legs.find((leg) => leg.TransferRole === DEBT_TRANSFER_ROLE.CREDIT_SIDE) ?? null;
    const debitLeg = legs.find((leg) => leg.TransferRole === DEBT_TRANSFER_ROLE.DEBIT_SIDE) ?? null;
    const anchor = creditLeg ?? debitLeg ?? legs[0];
    const other = anchor === creditLeg ? debitLeg : creditLeg;
    const anchorCustomer = customerById.get(anchor.CustomerId) ?? null;
    const otherCustomer = other ? (customerById.get(other.CustomerId) ?? null) : null;
    const cancelled = legs.some((leg) => leg.Status === STATUS.CANCELLED);
    const anchorFinancials = deriveFinancials(anchor);
    const anchorParts = customerParts(anchorCustomer);

    rows.push({
      RowKey: linkId,
      Id: anchor.Id,
      LinkId: linkId,
      LegIds: legs.map((leg) => leg.Id),
      LegCount: legs.length,
      Date: anchor.Date,
      CreatedAt: anchor.CreatedAt ?? null,
      TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER,
      TypeLabel: typeLabel(TRANSACTION_TYPE.DEBT_TRANSFER),
      CustomerId: anchor.CustomerId ?? null,
      ...anchorParts,
      Description: anchor.Description ?? null,
      // The operation's amount, announced ONCE. The two legs are not summed.
      AmountMinor: anchor.AmountMinor,
      // A transfer has a side per leg; the operation itself is reported as non-cash with no
      // single debit or credit of its own, so the screen cannot add a leg by accident.
      Direction: null,
      DirectionLabel: null,
      DebitMinor: null,
      CreditMinor: null,
      CashReceivedMinor: 0,
      CashPaidMinor: 0,
      SettlementMinor: anchorFinancials.SettlementMinor,
      IsCash: false,
      Status: cancelled ? STATUS.CANCELLED : anchor.Status,
      StatusLabel: statusLabel(cancelled ? STATUS.CANCELLED : anchor.Status),
      IsCancelled: cancelled,
      CancellationReason: anchor.CancellationReason ?? null,
      CancelledAt: anchor.CancelledAt ?? null,
      IsLinkedOperation: true,
      CounterpartyId: other ? other.CustomerId : null,
      CounterpartyCode: otherCustomer ? otherCustomer.Code : null,
      CounterpartyName: otherCustomer ? otherCustomer.Name : null,
      CounterpartyRole: other ? (other.TransferRole ?? null) : null,
      MergedNote: LEDGER_MERGED_TRANSFER_NOTE,
      PackageCountMilli: null,
      CropNetWeightMilli: null,
      CropWeightResolved: null,
      PackageWeightKg: null,
      StrawberryVarietyId: null,
      StrawberryVarietyName: null,
      StrawberryVarietyActive: null,
      ReceivingCompanyId: null,
      ReceivingCompanyName: null,
      ReceivingCompanyActive: null,
      CartonTypeId: null,
      CartonTypeName: null,
      CartonTypeActive: null,
      CartonQuantityMilli: null,
      ReferenceParts: null,
      SearchText: searchTextFor([
        anchorCustomer ? anchorCustomer.Code : null,
        anchorCustomer ? anchorCustomer.Name : null,
        otherCustomer ? otherCustomer.Code : null,
        otherCustomer ? otherCustomer.Name : null,
        anchor.Description,
        typeLabel(TRANSACTION_TYPE.DEBT_TRANSFER)
      ])
    });
  }

  const ordered = orderLedgerRows(rows);
  const summary = {
    TotalCount: ordered.length,
    ActiveCount: ordered.filter((row) => !row.IsCancelled).length,
    CancelledCount: ordered.filter((row) => row.IsCancelled).length,
    LinkedOperationCount: ordered.filter((row) => row.IsLinkedOperation).length,
    // The stored rows behind the ledger: a linked operation contributes two of them.
    StoredRowCount: ordered.reduce((total, row) => total + row.LegCount, 0)
  };
  return { Rows: ordered, Summary: summary };
}

/**
 * The one entry point the screen uses: build, filter, and report the filtered counts.
 * `Criteria` echoes the normalised filters so the view prints what was applied.
 */
export async function listLedger(criteria = {}) {
  authService.assertCanViewLedger();
  const normalized = normalizeLedgerFilters(criteria);
  const built = await buildLedger();
  const rows = applyLedgerFilters(built.Rows, normalized);
  return {
    Rows: rows,
    Criteria: normalized,
    Summary: {
      ...built.Summary,
      FilteredCount: rows.length,
      FilteredCancelledCount: rows.filter((row) => row.IsCancelled).length
    }
  };
}

// Filter options for the screen: the approved type catalogue and the three status choices.
// No customer list is returned because the search already covers the customer.
export function listLedgerFilterOptions() {
  return {
    Types: TRANSACTION_TYPES.map((value) => ({ value, label: TRANSACTION_TYPE_LABELS_AR[value] ?? value })),
    Statuses: LEDGER_STATUS_OPTIONS
  };
}

export const transactionLedgerService = {
  normalizeFilters: normalizeLedgerFilters,
  applyFilters: applyLedgerFilters,
  listLedger,
  buildLedger,
  listFilterOptions: listLedgerFilterOptions,
  orderRows: orderLedgerRows
};
