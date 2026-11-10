import { authService } from './authService.js';
// Phase 4B.18 — local crop purchase reports.
//
// ONE service owns every rule of the local crop report: which rows are read, which
// filters apply, which rows are COUNTED, how they are grouped, and what each total means.
// The screen prints what is returned here and computes no figure of its own.
//
// What this module deliberately does NOT do:
//   • it never reads the CURRENT DefaultPackageWeight. A historical net weight comes from
//     the values frozen on the row itself: `NetWeightMilli` when it is a valid stored
//     value, otherwise the approved formula applied to the STORED `PackageWeightKg`, the
//     stored loose weight (E) and the stored per-package deduction (F). Changing the
//     setting today therefore cannot rewrite a past movement;
//   • it never recomputes `AmountMinor`. The stored value is the financial truth of the
//     movement; the weight and the price are descriptions, not inputs to a new amount;
//   • it never turns the weight deduction (F) into a money discount. F is a weight in
//     kilograms only — there is no cash-discount concept for a local crop purchase;
//   • it never mixes package count with net weight: they are separate stored quantities
//     with separate totals and separate units;
//   • it never invents a weight, a variety or a farmer. A movement with no usable weight
//     is reported as «الوزن غير محسوم», kept OUT of the trusted weight total and counted
//     separately; a movement with no variety is grouped under «بدون صنف» and never
//     dropped from the figures; a reference that no longer resolves is «مرجع غير متاح»;
//   • it never writes anything and never caches: opening a report or changing a filter
//     cannot move a balance, and every run recomputes from the stored rows.
//
// The counting rule is the project's own `deriveFinancials().isActive`: a cancelled
// movement is displayed when asked for, but it never enters a financial or quantitative
// total and is never treated as an effective purchase.
import { transactionRepository } from '../repositories/transactionRepository.js';
import { customerRepository } from '../repositories/customerRepository.js';
import { strawberryVarietyRepository } from '../repositories/strawberryVarietyRepository.js';
import { deriveFinancials } from '../domain/financialDirection.js';
import { TRANSACTION_TYPE, STATUS } from '../domain/transactionTypes.js';
import { isValidIsoDate } from '../domain/dateUtils.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';
import { netWeightMilli, divRoundHalfUp } from '../domain/money.js';

// ---- report shape ----------------------------------------------------------
export const CROP_REPORT_GROUPING = Object.freeze({
  BY_FARMER: 'byFarmer',
  BY_VARIETY: 'byVariety'
});
export const CROP_REPORT_GROUPINGS = Object.freeze(Object.values(CROP_REPORT_GROUPING));
export const DEFAULT_CROP_REPORT_GROUPING = CROP_REPORT_GROUPING.BY_FARMER;

export const CROP_REPORT_MODE = Object.freeze({ SUMMARY: 'summary', DETAILS: 'details' });
export const CROP_REPORT_MODES = Object.freeze(Object.values(CROP_REPORT_MODE));

export const CROP_REPORT_STATUS = Object.freeze({
  ACTIVE: 'Active',
  CANCELLED: 'Cancelled',
  ALL: 'All'
});
export const CROP_REPORT_STATUSES = Object.freeze(Object.values(CROP_REPORT_STATUS));
export const DEFAULT_CROP_REPORT_STATUS = CROP_REPORT_STATUS.ACTIVE;

export const CROP_REPORT_STATUS_OPTIONS = Object.freeze([
  Object.freeze({ value: CROP_REPORT_STATUS.ACTIVE, label: 'النشطة فقط' }),
  Object.freeze({ value: CROP_REPORT_STATUS.CANCELLED, label: 'الملغاة فقط' }),
  Object.freeze({ value: CROP_REPORT_STATUS.ALL, label: 'الكل (نشطة وملغاة)' })
]);

export const CROP_REPORT_STATUS_LABELS_AR = Object.freeze({
  Active: 'نشطة',
  Cancelled: 'ملغاة',
  All: 'الكل'
});

export const CROP_REPORT_TITLE = 'تقارير مشتريات المحصول المحلي';
export const CROP_REPORT_GROUPING_TITLES_AR = Object.freeze({
  byFarmer: 'تجميع حسب المزارع',
  byVariety: 'تجميع حسب صنف الفراولة'
});

// A movement without a variety is a real, countable movement. It is grouped under this
// stable key so it can never disappear from the totals, and it can be filtered explicitly.
export const NO_VARIETY_KEY = 'no-variety';
export const NO_VARIETY_LABEL = 'بدون صنف';
export const NO_VARIETY_ID = null;

// The honest states. A value that is not available is never printed as a number.
export const UNRESOLVED_WEIGHT_LABEL = 'الوزن غير محسوم';
export const UNAVAILABLE_REFERENCE_LABEL = 'مرجع غير متاح';
export const UNSPECIFIED_LABEL = 'غير محدد';

function textOf(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function referenceId(value) {
  const text = textOf(value);
  return text === '' ? null : text;
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

// ---- filters ---------------------------------------------------------------
export function emptyCropReportFilters() {
  return {
    from: null,
    to: null,
    customerId: null,
    varietyId: null,
    status: DEFAULT_CROP_REPORT_STATUS,
    search: ''
  };
}

function normalizeBound(value, field, label) {
  const text = textOf(value);
  if (text === '') return null;
  if (!isValidIsoDate(text)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, `${label} غير صالح؛ يجب أن يكون بصيغة YYYY-MM-DD.`, { field });
  }
  return text;
}

// Every filter is optional except the status, which defaults to ACTIVE. A present date
// bound must be a real ISO date and the period is INCLUSIVE of both ends, because dates
// are stored as date-only `YYYY-MM-DD` strings.
export function normalizeCropReportFilters(input = {}) {
  const source = input || {};
  const from = normalizeBound(source.from, 'from', 'تاريخ البداية');
  const to = normalizeBound(source.to, 'to', 'تاريخ النهاية');
  if (from !== null && to !== null && from > to) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'تاريخ البداية يجب ألا يكون بعد تاريخ النهاية.', { field: 'from' });
  }
  const statusText = textOf(source.status);
  const status = statusText === '' ? DEFAULT_CROP_REPORT_STATUS : statusText;
  if (!CROP_REPORT_STATUSES.includes(status)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'حالة الحركة غير معتمدة؛ القيم المسموحة: Active أو Cancelled أو All.', { field: 'status' });
  }
  const varietyRaw = textOf(source.varietyId);
  return {
    from,
    to,
    customerId: referenceId(source.customerId),
    // The sentinel is preserved as-is: it is a real filter value, not a missing one.
    varietyId: varietyRaw === '' ? null : varietyRaw,
    status,
    search: textOf(source.search)
  };
}

function fold(value) {
  return textOf(value).toLowerCase();
}

// ---- stored weight of one row ---------------------------------------------
// Order of truth: the stored net weight, then the approved formula on the STORED package
// weight. The current setting is never consulted; nothing is defaulted.
export function resolveStoredWeight(row = {}) {
  // A valid stored G is authoritative even when one or more descriptive formula
  // components are absent from a legacy movement.
  const storedNet = integerOrNull(row.NetWeightMilli);
  if (storedNet !== null && Number.isSafeInteger(storedNet) && storedNet >= 0) {
    return { NetWeightMilli: storedNet, WeightResolved: true, WeightSource: 'StoredNetWeight' };
  }

  // Derivation is allowed only when EVERY historical component exists and is valid.
  // In particular, missing values must never silently become zero.
  const has = (key) => Object.prototype.hasOwnProperty.call(row, key) && row[key] !== null && row[key] !== undefined;
  const d = integerOrNull(row.LocalUnitsMilli);
  const e = integerOrNull(row.LocalLooseKgMilli);
  const f = integerOrNull(row.LocalDeductionKgMilli);
  const w = row.PackageWeightKg;
  const componentsValid = has('LocalUnitsMilli') && Number.isSafeInteger(d) && d >= 0
    && has('LocalLooseKgMilli') && Number.isSafeInteger(e) && e >= 0
    && has('LocalDeductionKgMilli') && Number.isSafeInteger(f) && f >= 0
    && has('PackageWeightKg') && typeof w === 'number' && Number.isFinite(w) && w > 0
    && f <= Math.round(w * 1000);

  if (!componentsValid) {
    return { NetWeightMilli: null, WeightResolved: false, WeightSource: null };
  }

  let computed;
  try {
    computed = netWeightMilli({
      units: d / 1000,
      looseKg: e / 1000,
      deductionKg: f / 1000,
      packageWeightKg: w
    });
  } catch {
    return { NetWeightMilli: null, WeightResolved: false, WeightSource: null };
  }
  if (!Number.isSafeInteger(computed) || computed < 0) {
    return { NetWeightMilli: null, WeightResolved: false, WeightSource: null };
  }
  return { NetWeightMilli: computed, WeightResolved: true, WeightSource: 'DerivedFromStoredComponents' };
}

// The project's own cancellation rule. `deriveFinancials` refuses a row whose stored
// amount is not a positive integer; such a row cannot be an effective purchase either, so
// the stored status is then the only fact available and is used as-is.
export function isCountedRow(row = {}) {
  try {
    return deriveFinancials(row).isActive === true;
  } catch (error) {
    return row.Status !== STATUS.CANCELLED;
  }
}

// ---- reference maps --------------------------------------------------------
async function loadReferenceMaps() {
  const [customers, varieties] = await Promise.all([
    customerRepository.getAll(),
    strawberryVarietyRepository.getAll()
  ]);
  const toMap = (rows) => new Map(rows.map((row) => [row.Id, row]));
  return { customers: toMap(customers), varieties: toMap(varieties) };
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

// ---- read model of one movement -------------------------------------------
// Carries ONLY stored facts plus the display names those identifiers resolve to today.
// `AmountMinor` is copied, never recomputed. `WeightResolved` decides whether the weight
// may enter a trusted total.
export function toCropReportRow(source = {}, maps = { customers: new Map(), varieties: new Map() }) {
  const customerId = referenceId(source.CustomerId);
  const varietyId = referenceId(source.StrawberryVarietyId);
  const customer = customerId ? maps.customers.get(customerId) : null;
  const weight = resolveStoredWeight(source);
  return {
    Id: source.Id,
    Date: textOf(source.Date),
    CreatedAt: source.CreatedAt ?? null,
    Status: source.Status ?? null,
    StatusLabel: source.Status === STATUS.CANCELLED
      ? CROP_REPORT_STATUS_LABELS_AR.Cancelled
      : CROP_REPORT_STATUS_LABELS_AR.Active,
    IsActive: isCountedRow(source),
    CancellationReason: textOf(source.CancellationReason) === '' ? null : textOf(source.CancellationReason),
    CancelledAt: source.CancelledAt ?? null,
    Description: textOf(source.Description) === '' ? null : textOf(source.Description),
    CustomerId: customerId,
    CustomerName: labelFor(maps.customers, customerId),
    CustomerCode: customer && textOf(customer.Code) !== '' ? textOf(customer.Code) : null,
    CustomerActive: activeOf(maps.customers, customerId),
    VarietyId: varietyId,
    VarietyName: varietyId ? labelFor(maps.varieties, varietyId) : NO_VARIETY_LABEL,
    VarietyActive: activeOf(maps.varieties, varietyId),
    HasVariety: varietyId !== null,
    // Stored quantities (scale 3 for counts/weights) and the stored money value (scale 2).
    PackageCountMilli: integerOrNull(source.LocalUnitsMilli),
    PackageWeightKg: Number.isFinite(source.PackageWeightKg) && source.PackageWeightKg > 0 ? source.PackageWeightKg : null,
    PackageWeightStatus: source.PackageWeightStatus ?? null,
    LooseKgMilli: integerOrNull(source.LocalLooseKgMilli),
    DeductionKgMilli: integerOrNull(source.LocalDeductionKgMilli),
    NetWeightMilli: weight.NetWeightMilli,
    WeightResolved: weight.WeightResolved,
    WeightSource: weight.WeightSource,
    UnitPriceMinor: integerOrNull(source.LocalUnitPriceMinor),
    AmountMinor: integerOrNull(source.AmountMinor)
  };
}

// ---- matching --------------------------------------------------------------
// One single place decides whether a mapped row matches the filters. All filters are
// combined with AND; the sentinel `no-variety` matches rows that carry no variety at all.
export function cropRowMatchesFilters(row, filters = {}) {
  if (!row) return false;
  if (filters.from && row.Date < filters.from) return false;
  if (filters.to && row.Date > filters.to) return false;
  if (filters.customerId && row.CustomerId !== filters.customerId) return false;
  if (filters.varietyId) {
    if (filters.varietyId === NO_VARIETY_KEY) {
      if (row.HasVariety) return false;
    } else if (row.VarietyId !== filters.varietyId) {
      return false;
    }
  }
  const needle = fold(filters.search);
  if (needle !== '') {
    const haystack = fold([row.CustomerName, row.CustomerCode, row.Description, row.VarietyName].join(' '));
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

// The project's own ledger order for a detail list: date, then creation time, then id.
export function orderCropRows(rows = []) {
  return rows.slice().sort((a, b) => {
    if (a.Date !== b.Date) return a.Date < b.Date ? -1 : 1;
    const ca = textOf(a.CreatedAt);
    const cb = textOf(b.CreatedAt);
    if (ca !== cb) return ca < cb ? -1 : 1;
    return textOf(a.Id) < textOf(b.Id) ? -1 : (textOf(a.Id) > textOf(b.Id) ? 1 : 0);
  });
}

// ---- totals ----------------------------------------------------------------
// A weight enters `NetWeightMilli` only when it is resolved. An unresolved movement is
// counted in `UnresolvedWeightCount` and its weight is NOT replaced by zero.
export function summarizeCropRows(rows = []) {
  const totals = {
    MovementCount: rows.length,
    FarmerCount: 0,
    PackageCountMilli: 0,
    PackageCountMissingCount: 0,
    NetWeightMilli: 0,
    WeightResolvedCount: 0,
    UnresolvedWeightCount: 0,
    AmountMinor: 0,
    WeightedAmountMinor: 0,
    PriceWeightMilli: 0,
    AverageUnitPriceMinor: null
  };
  const farmers = new Set();
  for (const row of rows) {
    if (row.CustomerId) farmers.add(row.CustomerId);
    if (row.PackageCountMilli === null) totals.PackageCountMissingCount += 1;
    else totals.PackageCountMilli += row.PackageCountMilli;
    if (row.WeightResolved) {
      totals.WeightResolvedCount += 1;
      totals.NetWeightMilli += row.NetWeightMilli;
      if (Number.isInteger(row.AmountMinor)) {
        totals.WeightedAmountMinor += row.AmountMinor;
        totals.PriceWeightMilli += row.NetWeightMilli;
      }
    } else {
      totals.UnresolvedWeightCount += 1;
    }
    if (row.AmountMinor !== null) totals.AmountMinor += row.AmountMinor;
  }
  totals.FarmerCount = farmers.size;
  totals.AverageUnitPriceMinor = totals.PriceWeightMilli > 0
    ? divRoundHalfUp(totals.WeightedAmountMinor * 1000, totals.PriceWeightMilli)
    : null;
  return totals;
}

// ---- grouping --------------------------------------------------------------
function groupingKeyOf(row, grouping) {
  if (grouping === CROP_REPORT_GROUPING.BY_VARIETY) return row.VarietyId || NO_VARIETY_KEY;
  return row.CustomerId || 'unknown-customer';
}

function createGroup(key, sample, grouping) {
  return {
    Key: key,
    Grouping: grouping,
    CustomerId: grouping === CROP_REPORT_GROUPING.BY_FARMER ? sample.CustomerId : null,
    CustomerName: grouping === CROP_REPORT_GROUPING.BY_FARMER ? sample.CustomerName : null,
    CustomerCode: grouping === CROP_REPORT_GROUPING.BY_FARMER ? sample.CustomerCode : null,
    CustomerActive: grouping === CROP_REPORT_GROUPING.BY_FARMER ? sample.CustomerActive : null,
    VarietyId: grouping === CROP_REPORT_GROUPING.BY_VARIETY ? sample.VarietyId : null,
    VarietyName: grouping === CROP_REPORT_GROUPING.BY_VARIETY ? sample.VarietyName : null,
    VarietyActive: grouping === CROP_REPORT_GROUPING.BY_VARIETY ? sample.VarietyActive : null,
    HasVariety: grouping === CROP_REPORT_GROUPING.BY_VARIETY ? sample.HasVariety : null,
    Label: grouping === CROP_REPORT_GROUPING.BY_VARIETY ? sample.VarietyName : sample.CustomerName,
    MovementCount: 0,
    FarmerCount: 0,
    PackageCountMilli: 0,
    PackageCountMissingCount: 0,
    NetWeightMilli: 0,
    WeightResolvedCount: 0,
    UnresolvedWeightCount: 0,
    AmountMinor: 0,
    WeightedAmountMinor: 0,
    PriceWeightMilli: 0,
    AverageUnitPriceMinor: null,
    Farmers: new Set(),
    Rows: []
  };
}

// Groups are keyed by the STORED id (never by a display name), so two records that share a
// name stay apart, and every movement appears in exactly one group.
export function groupCropRows(rows = [], grouping = DEFAULT_CROP_REPORT_GROUPING) {
  if (!CROP_REPORT_GROUPINGS.includes(grouping)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'طريقة التجميع غير معروفة.', { field: 'grouping' });
  }
  const buckets = new Map();
  for (const row of rows) {
    const key = groupingKeyOf(row, grouping);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = createGroup(key, row, grouping);
      buckets.set(key, bucket);
    }
    bucket.MovementCount += 1;
    if (row.CustomerId) bucket.Farmers.add(row.CustomerId);
    if (row.PackageCountMilli === null) bucket.PackageCountMissingCount += 1;
    else bucket.PackageCountMilli += row.PackageCountMilli;
    if (row.WeightResolved) {
      bucket.WeightResolvedCount += 1;
      bucket.NetWeightMilli += row.NetWeightMilli;
      if (Number.isInteger(row.AmountMinor)) {
        bucket.WeightedAmountMinor += row.AmountMinor;
        bucket.PriceWeightMilli += row.NetWeightMilli;
      }
    } else {
      bucket.UnresolvedWeightCount += 1;
    }
    if (row.AmountMinor !== null) bucket.AmountMinor += row.AmountMinor;
    bucket.Rows.push(row);
  }
  const groups = [...buckets.values()].map((group) => {
    const out = { ...group, FarmerCount: group.Farmers.size };
    out.AverageUnitPriceMinor = out.PriceWeightMilli > 0
      ? divRoundHalfUp(out.WeightedAmountMinor * 1000, out.PriceWeightMilli)
      : null;
    delete out.Farmers;
    out.Rows = orderCropRows(group.Rows);
    return out;
  });
  groups.sort((a, b) => {
    if (b.NetWeightMilli !== a.NetWeightMilli) return b.NetWeightMilli - a.NetWeightMilli;
    if (b.MovementCount !== a.MovementCount) return b.MovementCount - a.MovementCount;
    return textOf(a.Label).localeCompare(textOf(b.Label), 'ar');
  });
  return groups;
}

// ---- reading ---------------------------------------------------------------
// One read of the movements store. Only `CropPurchaseLocal` rows are considered; every
// other type — including carton purchases and debt transfers — is ignored entirely.
export async function loadCropReportRows(rawFilters = {}) {
  authService.assertCanManageData();
  const filters = rawFilters && rawFilters.__normalized === true
    ? rawFilters
    : normalizeCropReportFilters(rawFilters);
  const [all, maps] = await Promise.all([transactionRepository.getAll(), loadReferenceMaps()]);
  const local = all.filter((row) => row && row.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL);
  const mapped = orderCropRows(local.map((row) => toCropReportRow(row, maps)));
  const matching = mapped.filter((row) => cropRowMatchesFilters(row, filters));
  const active = matching.filter((row) => row.IsActive);
  const cancelled = matching.filter((row) => !row.IsActive);
  return { filters, all: mapped, matching, active, cancelled, cancelledCount: cancelled.length };
}

// ---- the report ------------------------------------------------------------
export async function buildCropReport({
  grouping = DEFAULT_CROP_REPORT_GROUPING,
  mode = CROP_REPORT_MODE.SUMMARY,
  filters: rawFilters = {}
} = {}) {
  authService.assertCanManageData();
  if (!CROP_REPORT_GROUPINGS.includes(grouping)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'طريقة التجميع غير معروفة.', { field: 'grouping' });
  }
  if (!CROP_REPORT_MODES.includes(mode)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'طريقة العرض غير معروفة.', { field: 'mode' });
  }
  const { filters, active, cancelled, cancelledCount } = await loadCropReportRows(rawFilters);
  // What is DISPLAYED depends on the status filter; what is COUNTED never includes a
  // cancelled movement, because a cancelled movement is not an effective purchase.
  const visible = filters.status === CROP_REPORT_STATUS.CANCELLED
    ? cancelled
    : (filters.status === CROP_REPORT_STATUS.ALL ? orderCropRows([...active, ...cancelled]) : active);
  const counted = visible.filter((row) => row.IsActive);
  const groups = groupCropRows(counted, grouping);
  const totals = summarizeCropRows(counted);
  return {
    Grouping: grouping,
    GroupingTitle: CROP_REPORT_GROUPING_TITLES_AR[grouping],
    Mode: mode,
    Title: CROP_REPORT_TITLE,
    Filters: { ...filters },
    Totals: {
      ...totals,
      GroupCount: groups.length,
      RowCount: counted.length,
      CancelledCount: cancelledCount,
      VisibleRowCount: visible.length,
      UncountedVisibleCount: visible.length - counted.length,
      HasAnyLocalPurchase: true
    },
    Groups: groups,
    Rows: orderCropRows(visible),
    DisplayRows: orderCropRows(visible)
  };
}

// The dropdown contents. Both catalogues are listed in full — including a record that was
// deactivated later — because a historical movement still has to be filterable and
// readable. Nothing here can create, rename or reactivate a record.
export async function listCropReportFilterOptions() {
  const [customers, varieties] = await Promise.all([
    customerRepository.getAll(),
    strawberryVarietyRepository.getAll()
  ]);
  const customersSorted = customers.slice().sort((a, b) => {
    const byCode = textOf(a.Code).localeCompare(textOf(b.Code), 'ar');
    return byCode !== 0 ? byCode : textOf(a.Name).localeCompare(textOf(b.Name), 'ar');
  });
  const varietiesSorted = varieties.slice().sort((a, b) => textOf(a.Name).localeCompare(textOf(b.Name), 'ar'));
  return {
    customers: customersSorted.map((row) => ({
      value: row.Id,
      label: textOf(row.Code) === '' ? textOf(row.Name) : `${textOf(row.Code)} — ${textOf(row.Name)}`,
      IsActive: row.IsActive !== false
    })),
    varieties: varietiesSorted.map((row) => ({
      value: row.Id,
      label: textOf(row.Name),
      IsActive: row.IsActive === true
    })),
    statuses: CROP_REPORT_STATUS_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
    noVariety: { value: NO_VARIETY_KEY, label: NO_VARIETY_LABEL }
  };
}

export const cropReportService = {
  groupings: CROP_REPORT_GROUPINGS,
  modes: CROP_REPORT_MODES,
  statuses: CROP_REPORT_STATUSES,
  buildReport: buildCropReport,
  listFilterOptions: listCropReportFilterOptions,
  normalizeFilters: normalizeCropReportFilters,
  loadRows: loadCropReportRows
};
