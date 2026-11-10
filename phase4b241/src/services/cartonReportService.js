import { authService } from './authService.js';
// Phase 4B.12 — carton purchase reports.
//
// ONE service owns every filtering, counting and grouping rule of the four approved
// reports. The screen only prints what is returned here.
//
// What this module deliberately does NOT do:
//   • it never recomputes an amount, a debit, a credit, a cash figure or a balance. It
//     copies the stored unit price and AmountMinor, and derives only the count left after
//     the already-stored carton-count deduction so a weighted unit price can be described;
//   • it never writes anything (reads only, so opening a report cannot move a balance);
//   • it never invents a farmer, a company, a carton type or a count. A reference that
//     resolves to nothing is reported as «مرجع غير متاح» and a row whose stored count is
//     not a valid integer is reported as «عدد غير محدد» — never as zero;
//   • it never back-fills a reference on a historical row.
//
// The counting rule is the project's own: a row enters a total only when the canonical
// domain projection says it is active (`deriveFinancials(row).isActive`), which is the same
// rule every balance and statement already uses. Cancelled rows are therefore excluded
// from the figures and reported separately, so nothing disappears silently.
import { transactionRepository } from '../repositories/transactionRepository.js';
import { customerRepository } from '../repositories/customerRepository.js';
import { receivingCompanyRepository } from '../repositories/receivingCompanyRepository.js';
import { cartonTypeRepository } from '../repositories/cartonTypeRepository.js';
import { deriveFinancials } from '../domain/financialDirection.js';
import { TRANSACTION_TYPE } from '../domain/transactionTypes.js';
import { isValidIsoDate } from '../domain/dateUtils.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';
import { divRoundHalfUp } from '../domain/money.js';

// The four approved reports. The identifiers are stable: the screen, the tests and the
// deep-link all use them.
export const CARTON_REPORT_KIND = Object.freeze({
  BY_FARMER: 'byFarmer',
  BY_COMPANY: 'byCompany',
  BY_CARTON_TYPE: 'byCartonType',
  CROSS: 'cross'
});

export const CARTON_REPORT_KINDS = Object.freeze(Object.values(CARTON_REPORT_KIND));

export const CARTON_REPORT_TITLES_AR = Object.freeze({
  byFarmer: 'مشتريات الكرتون حسب المزارع',
  byCompany: 'مشتريات الكرتون حسب الشركة المستلمة',
  byCartonType: 'مشتريات الكرتون حسب نوع الكرتونة',
  cross: 'التقرير التفصيلي التقاطعي'
});

export const DEFAULT_CARTON_REPORT_KIND = CARTON_REPORT_KIND.BY_FARMER;

// The label used for a reference id that no longer resolves to a record. It is the same
// wording the statement already uses, so the two screens never disagree.
export const UNAVAILABLE_REFERENCE_LABEL = 'مرجع غير متاح';
// The label used when a row carries no usable carton count at all.
export const UNSPECIFIED_CARTON_COUNT_LABEL = 'عدد غير محدد';

// Which reference ids identify a group, per report. Grouping is ALWAYS by the stored id,
// never by the display name: two distinct records that happen to share a name stay apart.
export const CARTON_REPORT_DIMENSIONS = Object.freeze({
  byFarmer: Object.freeze(['CustomerId']),
  byCompany: Object.freeze(['ReceivingCompanyId']),
  byCartonType: Object.freeze(['CartonTypeId']),
  cross: Object.freeze(['CustomerId', 'ReceivingCompanyId', 'CartonTypeId'])
});

function textOf(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function referenceId(value) {
  const text = textOf(value);
  return text === '' ? null : text;
}

function normalizeBound(value, field, label) {
  const text = textOf(value);
  if (text === '') return null;
  if (!isValidIsoDate(text)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, `${label} غير صالح؛ يجب أن يكون بصيغة YYYY-MM-DD.`, { field });
  }
  return text;
}

export function emptyCartonReportFilters() {
  return { from: null, to: null, customerId: null, receivingCompanyId: null, cartonTypeId: null };
}

// Every filter is optional. A date bound that is present must be a real ISO date, and the
// period is inclusive of both ends (dates are stored as date-only `YYYY-MM-DD`).
export function normalizeCartonReportFilters(input = {}) {
  const from = normalizeBound(input.from, 'from', 'تاريخ البداية');
  const to = normalizeBound(input.to, 'to', 'تاريخ النهاية');
  if (from !== null && to !== null && from > to) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'تاريخ البداية يجب ألا يكون بعد تاريخ النهاية.', { field: 'from' });
  }
  return {
    from,
    to,
    customerId: referenceId(input.customerId),
    receivingCompanyId: referenceId(input.receivingCompanyId),
    cartonTypeId: referenceId(input.cartonTypeId)
  };
}

// The stored count, in the project's milli unit (scale 3). A row whose value is not a
// finite integer has NO count — it is not zero.
export function cartonCountMilliOf(row = {}) {
  const value = row.CartonQuantityMilli;
  return Number.isInteger(value) ? value : null;
}

// One single place decides whether a row matches the reference and period filters.
export function cartonRowMatchesFilters(row, filters = {}) {
  if (!row) return false;
  if (row.TransactionType !== TRANSACTION_TYPE.CROP_PURCHASE_CARTON) return false;
  const date = textOf(row.Date);
  if (filters.from && date < filters.from) return false;
  if (filters.to && date > filters.to) return false;
  if (filters.customerId && textOf(row.CustomerId) !== filters.customerId) return false;
  if (filters.receivingCompanyId && textOf(row.ReceivingCompanyId) !== filters.receivingCompanyId) return false;
  if (filters.cartonTypeId && textOf(row.CartonTypeId) !== filters.cartonTypeId) return false;
  return true;
}

function groupKeyOf(row, dimensions) {
  // JSON keeps the ids apart even when one of them contains the separator character.
  return JSON.stringify(dimensions.map((dimension) => textOf(row[dimension])));
}

function nameOf(map, id) {
  if (!id) return null;
  const record = map.get(id);
  if (!record) return null;
  const name = textOf(record.Name);
  return name === '' ? null : name;
}

function activeOf(map, id) {
  if (!id) return null;
  const record = map.get(id);
  if (!record) return null;
  return record.IsActive === true;
}

function labelFor(map, id) {
  if (!id) return UNAVAILABLE_REFERENCE_LABEL;
  const name = nameOf(map, id);
  return name === null ? UNAVAILABLE_REFERENCE_LABEL : name;
}

async function loadReferenceMaps() {
  const [customers, companies, cartonTypes] = await Promise.all([
    customerRepository.getAll(),
    receivingCompanyRepository.getAll(),
    cartonTypeRepository.getAll()
  ]);
  const toMap = (rows) => new Map(rows.map((row) => [row.Id, row]));
  return { customers: toMap(customers), companies: toMap(companies), cartonTypes: toMap(cartonTypes) };
}

// The read model of one movement inside a report. It carries ONLY the stored identifiers,
// the names they resolve to today, and the stored count — no financial value at all.
export function toReportRow(source, maps = { customers: new Map(), companies: new Map(), cartonTypes: new Map() }) {
  const quantityMilli = cartonCountMilliOf(source);
  const customerId = referenceId(source.CustomerId);
  const companyId = referenceId(source.ReceivingCompanyId);
  const typeId = referenceId(source.CartonTypeId);
  const customer = customerId ? maps.customers.get(customerId) : null;
  return {
    Id: source.Id,
    Date: textOf(source.Date),
    Status: source.Status ?? null,
    StatusLabel: source.Status === 'Cancelled' ? 'ملغاة' : 'نشطة',
    CancellationReason: textOf(source.CancellationReason) || null,
    CancelledAt: source.CancelledAt ?? null,
    CustomerId: customerId,
    CustomerName: labelFor(maps.customers, customerId),
    CustomerCode: customer && textOf(customer.Code) !== '' ? textOf(customer.Code) : null,
    CustomerActive: activeOf(maps.customers, customerId),
    ReceivingCompanyId: companyId,
    ReceivingCompanyName: labelFor(maps.companies, companyId),
    ReceivingCompanyActive: activeOf(maps.companies, companyId),
    CartonTypeId: typeId,
    CartonTypeName: labelFor(maps.cartonTypes, typeId),
    CartonTypeActive: activeOf(maps.cartonTypes, typeId),
    CartonQuantityMilli: quantityMilli,
    CartonDiscountMinor: Number.isInteger(source.CartonDiscountMinor) ? source.CartonDiscountMinor : null,
    // CartonDiscountMinor is stored at money scale 2, while carton quantity uses scale 3.
    // The stored value therefore converts to carton milli by multiplying by 10.
    DiscountQuantityMilli: Number.isInteger(source.CartonDiscountMinor) ? source.CartonDiscountMinor * 10 : null,
    NetQuantityMilli: quantityMilli !== null && Number.isInteger(source.CartonDiscountMinor) && quantityMilli >= source.CartonDiscountMinor * 10
      ? quantityMilli - source.CartonDiscountMinor * 10 : null,
    CartonUnitPriceMinor: Number.isInteger(source.CartonUnitPriceMinor) ? source.CartonUnitPriceMinor : null,
    AmountMinor: Number.isInteger(source.AmountMinor) ? source.AmountMinor : null,
    QuantityResolved: quantityMilli !== null
  };
}

function createBucket(key, sample) {
  return {
    Key: key,
    CustomerId: sample.CustomerId,
    CustomerName: sample.CustomerName,
    CustomerCode: sample.CustomerCode,
    CustomerActive: sample.CustomerActive,
    ReceivingCompanyId: sample.ReceivingCompanyId,
    ReceivingCompanyName: sample.ReceivingCompanyName,
    ReceivingCompanyActive: sample.ReceivingCompanyActive,
    CartonTypeId: sample.CartonTypeId,
    CartonTypeName: sample.CartonTypeName,
    CartonTypeActive: sample.CartonTypeActive,
    QuantityMilli: 0,
    DiscountQuantityMilli: 0,
    NetQuantityMilli: 0,
    AmountMinor: 0,
    WeightedAmountMinor: 0,
    PriceQuantityMilli: 0,
    AverageUnitPriceMinor: null,
    MovementCount: 0,
    MissingQuantityCount: 0,
    Rows: []
  };
}

// Groups are keyed by the stored ids, so a name collision can never merge two records.
// The sums are integer arithmetic on the stored milli values; conversion to a display
// unit happens in the presentation layer only.
export function groupReportRows(rows, kind) {
  const dimensions = CARTON_REPORT_DIMENSIONS[kind];
  if (!dimensions) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'نوع تقرير غير معروف.', { field: 'kind' });
  }
  const buckets = new Map();
  for (const row of rows) {
    const key = groupKeyOf(row, dimensions);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = createBucket(key, row);
      buckets.set(key, bucket);
    }
    bucket.MovementCount += 1;
    if (row.CartonQuantityMilli === null) {
      bucket.MissingQuantityCount += 1;
    } else {
      bucket.QuantityMilli += row.CartonQuantityMilli;
    }
    if (Number.isInteger(row.DiscountQuantityMilli)) bucket.DiscountQuantityMilli += row.DiscountQuantityMilli;
    if (Number.isInteger(row.NetQuantityMilli)) bucket.NetQuantityMilli += row.NetQuantityMilli;
    if (Number.isInteger(row.AmountMinor)) bucket.AmountMinor += row.AmountMinor;
    if (Number.isInteger(row.AmountMinor) && Number.isInteger(row.NetQuantityMilli)) {
      bucket.WeightedAmountMinor += row.AmountMinor;
      bucket.PriceQuantityMilli += row.NetQuantityMilli;
    }
    bucket.Rows.push(row);
  }
  const groups = [...buckets.values()];
  const labelOf = (group) => [group.CustomerName, group.ReceivingCompanyName, group.CartonTypeName].join(' ');
  for (const group of groups) {
    group.AverageUnitPriceMinor = group.PriceQuantityMilli > 0
      ? divRoundHalfUp(group.WeightedAmountMinor * 1000, group.PriceQuantityMilli)
      : null;
    group.Rows.sort((a, b) => (a.Date === b.Date ? String(a.Id).localeCompare(String(b.Id)) : a.Date.localeCompare(b.Date)));
  }
  groups.sort((a, b) => {
    if (b.QuantityMilli !== a.QuantityMilli) return b.QuantityMilli - a.QuantityMilli;
    if (b.MovementCount !== a.MovementCount) return b.MovementCount - a.MovementCount;
    return labelOf(a).localeCompare(labelOf(b), 'ar');
  });
  return groups;
}

export function totalsOf(groups, rows) {
  const totals = {
    QuantityMilli: groups.reduce((sum, group) => sum + group.QuantityMilli, 0),
    DiscountQuantityMilli: groups.reduce((sum, group) => sum + group.DiscountQuantityMilli, 0),
    NetQuantityMilli: groups.reduce((sum, group) => sum + group.NetQuantityMilli, 0),
    AmountMinor: groups.reduce((sum, group) => sum + group.AmountMinor, 0),
    WeightedAmountMinor: groups.reduce((sum, group) => sum + group.WeightedAmountMinor, 0),
    PriceQuantityMilli: groups.reduce((sum, group) => sum + group.PriceQuantityMilli, 0),
    MovementCount: groups.reduce((sum, group) => sum + group.MovementCount, 0),
    MissingQuantityCount: groups.reduce((sum, group) => sum + group.MissingQuantityCount, 0),
    GroupCount: groups.length,
    RowCount: rows.length
  };
  totals.AverageUnitPriceMinor = totals.PriceQuantityMilli > 0
    ? divRoundHalfUp(totals.WeightedAmountMinor * 1000, totals.PriceQuantityMilli)
    : null;
  return totals;
}

// One read of the movements store, filtered by type + period + references, then split into
// active rows (the only rows used in aggregates) and cancelled rows (available to the
// independent details view). Nothing is written and nothing is cached.
export async function loadCartonReportRows(rawFilters = {}) {
  authService.assertCanManageData();
  const filters = rawFilters && rawFilters.__normalized === true ? rawFilters : normalizeCartonReportFilters(rawFilters);
  const all = await transactionRepository.getAll();
  const matching = all.filter((row) => cartonRowMatchesFilters(row, filters));
  const counted = [];
  const cancelled = [];
  for (const row of matching) {
    if (deriveFinancials(row).isActive) counted.push(row);
    else cancelled.push(row);
  }
  return { filters, matching, counted, cancelled, cancelledCount: cancelled.length };
}

export async function buildCartonReport({ kind = DEFAULT_CARTON_REPORT_KIND, filters: rawFilters = {} } = {}) {
  authService.assertCanManageData();
  if (!CARTON_REPORT_DIMENSIONS[kind]) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'نوع تقرير غير معروف.', { field: 'kind' });
  }
  const { filters, counted, cancelled, cancelledCount } = await loadCartonReportRows(rawFilters);
  const maps = await loadReferenceMaps();
  const sortRows = (items) => items.map((source) => toReportRow(source, maps)).sort((a, b) => (a.Date === b.Date ? String(a.Id).localeCompare(String(b.Id)) : a.Date.localeCompare(b.Date)));
  const rows = sortRows(counted);
  const cancelledRows = sortRows(cancelled);
  const groups = groupReportRows(rows, kind);
  return {
    Kind: kind,
    Title: CARTON_REPORT_TITLES_AR[kind],
    Filters: { ...filters },
    Groups: groups,
    Rows: rows,
    CancelledRows: cancelledRows,
    Totals: { ...totalsOf(groups, rows), CancelledCount: cancelledCount }
  };
}

// The dropdown contents. Both catalogues are listed in full — including a record that was
// deactivated later — because a historical movement still needs to be filterable and
// readable. Nothing here can create or reactivate a record.
export async function listCartonReportFilterOptions() {
  authService.assertCanManageData();
  const [customers, companies, cartonTypes] = await Promise.all([
    customerRepository.getAll(),
    receivingCompanyRepository.getAll(),
    cartonTypeRepository.getAll()
  ]);
  const customersSorted = customers.slice().sort((a, b) => {
    const byCode = textOf(a.Code).localeCompare(textOf(b.Code), 'ar');
    return byCode !== 0 ? byCode : textOf(a.Name).localeCompare(textOf(b.Name), 'ar');
  });
  const sortByName = (a, b) => textOf(a.Name).localeCompare(textOf(b.Name), 'ar');
  return {
    customers: customersSorted.map((row) => ({
      value: row.Id,
      label: textOf(row.Code) === '' ? textOf(row.Name) : `${textOf(row.Code)} — ${textOf(row.Name)}`,
      IsActive: row.IsActive !== false
    })),
    receivingCompanies: companies.slice().sort(sortByName).map((row) => ({
      value: row.Id, label: textOf(row.Name), IsActive: row.IsActive === true
    })),
    cartonTypes: cartonTypes.slice().sort(sortByName).map((row) => ({
      value: row.Id, label: textOf(row.Name), IsActive: row.IsActive === true
    }))
  };
}

export const cartonReportService = {
  kinds: CARTON_REPORT_KINDS,
  buildReport: buildCartonReport,
  listFilterOptions: listCartonReportFilterOptions,
  normalizeFilters: normalizeCartonReportFilters,
  loadRows: loadCartonReportRows
};
