import { authService } from './authService.js';
// Phase 4B.16 — the Dashboard read model (READ ONLY).
//
// Every figure on the dashboard is produced HERE, in the services layer, by reusing the
// approved engines — never by re-implementing them:
//   • balances           -> balanceService.listCustomerBalances()  (Balance = Opening + Credits − Debits)
//   • movements / cash   -> transactionLedgerService.buildLedger()  (one row per operation,
//                           a debt transfer collapsed to ONE row from its two legs by LinkId,
//                           figures from deriveFinancials(), cancelled state from Status)
//   • period filtering   -> transactionLedgerService.applyFilters() (the ledger's own date rule)
//   • crop facts         -> the row fields the weight service already resolved
//                           (cropPurchaseService.localMovementFacts, via the ledger row)
//
// What this module deliberately does NOT do:
//   • it never writes: no repository write, no settings write, no balance update. Opening the
//     dashboard or changing the period is a sequence of reads and nothing else;
//   • it never re-derives an amount, a debit, a credit, a cash figure or a balance. All of
//     them arrive from the ledger rows / the balance read model;
//   • it never recomputes a historical net weight from today's package weight. A local
//     purchase whose weight is not resolved stays UNRESOLVED and is counted, never zeroed;
//   • it never invents a customer, a company, a carton type or a variety name. Ids are the
//     grouping key; a reference that does not resolve is reported as unavailable.
//
// Scope of the two kinds of indicators, kept explicit so the screen can label them:
//   • CURRENT  — balances and customer counts: they are as of now and are NOT affected by the
//                selected period (changing the period must never move a balance);
//   • PERIOD   — sales, returns, cash, settlements, purchases, alerts of the period: they are
//                the sum of the movements whose stored Date falls inside the selected range,
//                boundaries inclusive.
import { transactionLedgerService } from './transactionLedgerService.js';
import { balanceService } from './balanceService.js';
import { TRANSACTION_TYPE, TRANSACTION_TYPE_LABELS_AR } from '../domain/transactionTypes.js';
import { isValidIsoDate, nowIso } from '../domain/dateUtils.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';
import { UNSPECIFIED, UNAVAILABLE } from './movementNotes.js';

// ---------------------------------------------------------------------------
// Period selector — the approved four ranges.
// ---------------------------------------------------------------------------
export const DASHBOARD_PERIOD = Object.freeze({
  LAST_7: 'last7',
  LAST_30: 'last30',
  LAST_90: 'last90',
  YEAR: 'year'
});

export const DASHBOARD_PERIOD_OPTIONS = Object.freeze([
  Object.freeze({ value: DASHBOARD_PERIOD.LAST_7, label: 'آخر 7 أيام', Days: 7 }),
  Object.freeze({ value: DASHBOARD_PERIOD.LAST_30, label: 'آخر 30 يومًا', Days: 30 }),
  Object.freeze({ value: DASHBOARD_PERIOD.LAST_90, label: 'آخر 90 يومًا', Days: 90 }),
  Object.freeze({ value: DASHBOARD_PERIOD.YEAR, label: 'السنة الحالية', Days: null })
]);

export const DEFAULT_DASHBOARD_PERIOD = DASHBOARD_PERIOD.LAST_30;

// The two indicator scopes. The screen prints them next to every number.
export const DASHBOARD_SCOPE = Object.freeze({
  CURRENT_BALANCE: 'current-balance',
  CURRENT_COUNT: 'current-count',
  PERIOD_TOTAL: 'period-total'
});

export const DASHBOARD_SCOPE_LABELS_AR = Object.freeze({
  'current-balance': 'رصيد حالي',
  'current-count': 'عدد حالي',
  'period-total': 'خلال الفترة'
});

export const DASHBOARD_LATEST_LIMIT = 10;

export const DASHBOARD_ALERT_KIND = Object.freeze({
  NON_ZERO_BALANCE: 'nonZeroBalance',
  CANCELLED_IN_PERIOD: 'cancelledInPeriod',
  NAMELESS_CUSTOMER: 'namelessCustomer',
  INACTIVE_CUSTOMER: 'inactiveCustomer',
  UNRESOLVED_WEIGHT: 'unresolvedWeight',
  MISSING_CARTON_COUNT: 'missingCartonCount'
});

// ---------------------------------------------------------------------------
// Dates — ISO 'YYYY-MM-DD', UTC arithmetic only (no timezone drift).
// ---------------------------------------------------------------------------
const DAY_MS = 86400000;

function pad(value) {
  return String(value).padStart(2, '0');
}

// Today as a wall-clock ISO date built from local components (the app's stored format).
export function todayIso(clock = new Date()) {
  return `${clock.getFullYear()}-${pad(clock.getMonth() + 1)}-${pad(clock.getDate())}`;
}

function isoToUtc(iso) {
  const [year, month, day] = iso.split('-').map((part) => Number(part));
  return Date.UTC(year, month - 1, day);
}

function utcToIso(utcMs) {
  const date = new Date(utcMs);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function isoAddDays(iso, delta) {
  if (!isValidIsoDate(iso)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'التاريخ غير صالح؛ الصيغة المعتمدة YYYY-MM-DD.', { field: 'Date' });
  }
  return utcToIso(isoToUtc(iso) + (Number(delta) || 0) * DAY_MS);
}

export function daysInclusive(from, to) {
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) return 0;
  return Math.round((isoToUtc(to) - isoToUtc(from)) / DAY_MS) + 1;
}

export function normalizeDashboardPeriod(period) {
  const value = period === null || period === undefined ? '' : String(period).trim();
  if (value === '') return DEFAULT_DASHBOARD_PERIOD;
  if (!DASHBOARD_PERIOD_OPTIONS.some((option) => option.value === value)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'الفترة المحددة غير معتمدة.', { field: 'period' });
  }
  return value;
}

/**
 * The selected period as an inclusive ISO range.
 * last7 -> today-6 .. today (7 days including today), year -> 01-01 .. today.
 */
export function resolvePeriodRange(period, todayIsoValue = todayIso()) {
  const selected = normalizeDashboardPeriod(period);
  if (!isValidIsoDate(todayIsoValue)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'تاريخ اليوم غير صالح؛ الصيغة المعتمدة YYYY-MM-DD.', { field: 'today' });
  }
  const option = DASHBOARD_PERIOD_OPTIONS.find((entry) => entry.value === selected);
  let from;
  if (selected === DASHBOARD_PERIOD.YEAR) from = `${todayIsoValue.slice(0, 4)}-01-01`;
  else from = isoAddDays(todayIsoValue, -(option.Days - 1));
  return {
    Period: selected,
    Label: option.label,
    From: from,
    To: todayIsoValue,
    Days: daysInclusive(from, todayIsoValue)
  };
}

// ---------------------------------------------------------------------------
// Chart buckets — calendar buckets of the selected range.
// ---------------------------------------------------------------------------
function monthRanges(from, to) {
  const ranges = [];
  let cursor = from;
  while (cursor <= to) {
    const monthKey = cursor.slice(0, 7);
    const [year, month] = monthKey.split('-').map(Number);
    const monthEnd = utcToIso(Date.UTC(year, month, 0));
    const end = monthEnd > to ? to : monthEnd;
    ranges.push({ From: cursor, To: end, Key: monthKey, Label: monthKey });
    cursor = isoAddDays(end, 1);
  }
  return ranges;
}

export function buildBuckets(from, to) {
  if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'نطاق الفترة غير صالح.', { field: 'from' });
  }
  const days = daysInclusive(from, to);
  if (days <= 31) {
    const out = [];
    for (let index = 0; index < days; index += 1) {
      const day = isoAddDays(from, index);
      out.push({ From: day, To: day, Key: day, Label: day.slice(5) });
    }
    return out;
  }
  if (days <= 92) {
    const out = [];
    for (let start = from; start <= to; start = isoAddDays(start, 7)) {
      const end = isoAddDays(start, 6) > to ? to : isoAddDays(start, 6);
      out.push({ From: start, To: end, Key: start, Label: start.slice(5) });
    }
    return out;
  }
  return monthRanges(from, to);
}

/**
 * Cash flow series of the period: cash IN and cash OUT per bucket, from the ledger rows only.
 * Cancelled rows are skipped. A movement's balance is never used as a cash flow.
 */
export function buildSeries(rows = [], range) {
  const buckets = buildBuckets(range.From, range.To).map((bucket) => ({
    ...bucket, CashInMinor: 0, CashOutMinor: 0, MovementCount: 0
  }));
  let hasData = false;
  let hasCashFlow = false;
  for (const row of rows) {
    const bucket = buckets.find((entry) => String(row.Date) >= entry.From && String(row.Date) <= entry.To) ?? null;
    if (!bucket) continue;
    if (row.IsCancelled) continue;
    bucket.MovementCount += 1;
    bucket.CashInMinor += Number.isInteger(row.CashReceivedMinor) ? row.CashReceivedMinor : 0;
    bucket.CashOutMinor += Number.isInteger(row.CashPaidMinor) ? row.CashPaidMinor : 0;
    hasData = true;
    if (bucket.CashInMinor > 0 || bucket.CashOutMinor > 0) hasCashFlow = true;
  }
  return {
    Buckets: buckets,
    HasData: hasData,
    HasCashFlow: hasCashFlow,
    TotalCashInMinor: buckets.reduce((total, bucket) => total + bucket.CashInMinor, 0),
    TotalCashOutMinor: buckets.reduce((total, bucket) => total + bucket.CashOutMinor, 0)
  };
}

// ---------------------------------------------------------------------------
// Period totals — every category kept apart, cancelled rows excluded.
// ---------------------------------------------------------------------------
function amountOf(row) {
  return Number.isInteger(row.AmountMinor) ? row.AmountMinor : null;
}

/**
 * Category totals of the given ledger rows. One row = one operation (a debt transfer is a
 * single row, so its amount is counted ONCE). Cancelled rows are counted, never summed.
 */
export function summarizePeriod(rows = []) {
  const totals = {
    MovementCount: 0,
    CancelledCount: 0,
    MissingAmountCount: 0,
    SalesMinor: 0,
    SalesReturnMinor: 0,
    CashReceivedMinor: 0,
    CashPaidMinor: 0,
    SettlementMinor: 0,
    GoodsExchangeMinor: 0,
    DebtTransferMinor: 0,
    DebtTransferCount: 0,
    LocalCropMinor: 0,
    CartonMinor: 0,
    ByType: []
  };
  const byType = new Map();
  for (const row of rows) {
    if (row.IsCancelled) {
      totals.CancelledCount += 1;
      continue;
    }
    totals.MovementCount += 1;
    const amount = amountOf(row);
    if (amount === null) totals.MissingAmountCount += 1;
    const bucket = byType.get(row.TransactionType) ?? {
      TransactionType: row.TransactionType,
      Label: TRANSACTION_TYPE_LABELS_AR[row.TransactionType] ?? row.TransactionType,
      MovementCount: 0,
      AmountMinor: 0,
      MissingAmountCount: 0,
      CashReceivedMinor: 0,
      CashPaidMinor: 0
    };
    bucket.MovementCount += 1;
    if (amount === null) bucket.MissingAmountCount += 1;
    else bucket.AmountMinor += amount;
    bucket.CashReceivedMinor += Number.isInteger(row.CashReceivedMinor) ? row.CashReceivedMinor : 0;
    bucket.CashPaidMinor += Number.isInteger(row.CashPaidMinor) ? row.CashPaidMinor : 0;
    byType.set(row.TransactionType, bucket);

    switch (row.TransactionType) {
      case TRANSACTION_TYPE.SALE_PESTICIDES:
      case TRANSACTION_TYPE.SALE_IRRIGATION:
        if (amount !== null) totals.SalesMinor += amount;
        break;
      case TRANSACTION_TYPE.SALES_RETURN:
        if (amount !== null) totals.SalesReturnMinor += amount;
        break;
      case TRANSACTION_TYPE.CASH_RECEIVED:
        totals.CashReceivedMinor += Number.isInteger(row.CashReceivedMinor) ? row.CashReceivedMinor : 0;
        break;
      case TRANSACTION_TYPE.CASH_PAID:
        totals.CashPaidMinor += Number.isInteger(row.CashPaidMinor) ? row.CashPaidMinor : 0;
        break;
      case TRANSACTION_TYPE.SETTLEMENT:
        if (amount !== null) totals.SettlementMinor += amount;
        break;
      case TRANSACTION_TYPE.GOODS_EXCHANGE:
        if (amount !== null) totals.GoodsExchangeMinor += amount;
        break;
      case TRANSACTION_TYPE.DEBT_TRANSFER:
        // ONE operation: the ledger already collapsed the two legs into this single row.
        totals.DebtTransferCount += 1;
        if (amount !== null) totals.DebtTransferMinor += amount;
        break;
      case TRANSACTION_TYPE.CROP_PURCHASE_LOCAL:
        if (amount !== null) totals.LocalCropMinor += amount;
        break;
      case TRANSACTION_TYPE.CROP_PURCHASE_CARTON:
        if (amount !== null) totals.CartonMinor += amount;
        break;
      default:
        break;
    }
  }
  totals.ByType = [...byType.values()].sort((a, b) => a.Label.localeCompare(b.Label, 'ar'));
  return totals;
}

// ---------------------------------------------------------------------------
// Crop purchase indicators — counts and STORED weights only.
// ---------------------------------------------------------------------------
function referenceLabel(name, id, isActive) {
  // Same three states as the statement layer (movementNotes): a name, «سجل غير متاح» for an id
  // that resolves to nothing, and «غير محدد» for a row that never stored one.
  const text = name === null || name === undefined ? '' : String(name).trim();
  if (text) return isActive === false ? `${text} (غير نشطة)` : text;
  return id ? UNAVAILABLE : UNSPECIFIED;
}

function groupAccumulator(map, key, seed) {
  if (!map.has(key)) map.set(key, seed);
  return map.get(key);
}

export function summarizeCrop(rows = []) {
  const local = {
    MovementCount: 0,
    PackageCountMilli: 0,
    PackageCountMissingCount: 0,
    NetWeightMilli: 0,
    WeightResolvedCount: 0,
    UnresolvedWeightCount: 0,
    ByVariety: []
  };
  const carton = {
    MovementCount: 0,
    CartonQuantityMilli: 0,
    QuantityResolvedCount: 0,
    MissingQuantityCount: 0,
    ByCompany: [],
    ByCartonType: []
  };
  const varieties = new Map();
  const companies = new Map();
  const types = new Map();

  for (const row of rows) {
    if (row.IsCancelled) continue;
    if (row.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL) {
      local.MovementCount += 1;
      if (Number.isInteger(row.PackageCountMilli)) local.PackageCountMilli += row.PackageCountMilli;
      else local.PackageCountMissingCount += 1;
      const weightResolved = row.CropWeightResolved === true && Number.isInteger(row.CropNetWeightMilli);
      if (weightResolved) {
        local.NetWeightMilli += row.CropNetWeightMilli;
        local.WeightResolvedCount += 1;
      } else {
        local.UnresolvedWeightCount += 1;
      }
      const key = row.StrawberryVarietyId ?? 'none';
      const entry = groupAccumulator(varieties, key, {
        Id: row.StrawberryVarietyId ?? null,
        Label: referenceLabel(row.StrawberryVarietyName, row.StrawberryVarietyId, row.StrawberryVarietyActive),
        MovementCount: 0,
        PackageCountMilli: 0,
        NetWeightMilli: 0
      });
      entry.MovementCount += 1;
      if (Number.isInteger(row.PackageCountMilli)) entry.PackageCountMilli += row.PackageCountMilli;
      if (weightResolved) entry.NetWeightMilli += row.CropNetWeightMilli;
    } else if (row.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_CARTON) {
      carton.MovementCount += 1;
      if (Number.isInteger(row.CartonQuantityMilli)) {
        carton.CartonQuantityMilli += row.CartonQuantityMilli;
        carton.QuantityResolvedCount += 1;
      } else {
        carton.MissingQuantityCount += 1;
      }
      const companyEntry = groupAccumulator(companies, row.ReceivingCompanyId ?? 'none', {
        Id: row.ReceivingCompanyId ?? null,
        Label: referenceLabel(row.ReceivingCompanyName, row.ReceivingCompanyId, row.ReceivingCompanyActive),
        MovementCount: 0,
        CartonQuantityMilli: 0
      });
      companyEntry.MovementCount += 1;
      if (Number.isInteger(row.CartonQuantityMilli)) companyEntry.CartonQuantityMilli += row.CartonQuantityMilli;

      const typeEntry = groupAccumulator(types, row.CartonTypeId ?? 'none', {
        Id: row.CartonTypeId ?? null,
        Label: referenceLabel(row.CartonTypeName, row.CartonTypeId, row.CartonTypeActive),
        MovementCount: 0,
        CartonQuantityMilli: 0
      });
      typeEntry.MovementCount += 1;
      if (Number.isInteger(row.CartonQuantityMilli)) typeEntry.CartonQuantityMilli += row.CartonQuantityMilli;
    }
  }

  const byLabel = (a, b) => a.Label.localeCompare(b.Label, 'ar');
  local.ByVariety = [...varieties.values()].sort(byLabel);
  carton.ByCompany = [...companies.values()].sort(byLabel);
  carton.ByCartonType = [...types.values()].sort(byLabel);
  return { Local: local, Carton: carton };
}

// ---------------------------------------------------------------------------
// Customer balances — aggregated from the canonical balance read model.
// ---------------------------------------------------------------------------
export function summarizeBalances(rows = []) {
  const out = {
    CustomerCount: rows.length,
    ActiveCustomerCount: 0,
    NamelessCustomerCount: 0,
    InactiveCustomerCount: 0,
    DebitTotalMinor: 0,
    DebitCount: 0,
    CreditTotalMinor: 0,
    CreditCount: 0,
    ZeroCount: 0,
    NonZeroCount: 0,
    NetBalanceMinor: 0
  };
  for (const entry of rows) {
    const customer = entry.Customer ?? {};
    const balance = entry.Summary ? entry.Summary.BalanceMinor : 0;
    if (customer.IsActive === true) out.ActiveCustomerCount += 1;
    else out.InactiveCustomerCount += 1;
    if (customer.Name === null || customer.Name === undefined || String(customer.Name).trim() === '') {
      out.NamelessCustomerCount += 1;
    }
    // Positive balance = credit side, negative = debit side (balanceService.balanceSide).
    if (balance > 0) {
      out.CreditTotalMinor += balance;
      out.CreditCount += 1;
    } else if (balance < 0) {
      out.DebitTotalMinor += -balance;
      out.DebitCount += 1;
    } else {
      out.ZeroCount += 1;
    }
    out.NetBalanceMinor += balance;
  }
  out.NonZeroCount = out.CreditCount + out.DebitCount;
  return out;
}

// ---------------------------------------------------------------------------
// Latest movements — the ledger's own rows, already one row per operation.
// ---------------------------------------------------------------------------
function toLatestRow(row) {
  return {
    RowKey: row.RowKey,
    Id: row.Id,
    Date: row.Date,
    TransactionType: row.TransactionType,
    TypeLabel: row.TypeLabel,
    CustomerId: row.CustomerId ?? null,
    CustomerName: row.CustomerName ?? null,
    CustomerCode: row.CustomerCode ?? null,
    Description: row.Description ?? null,
    AmountMinor: Number.isInteger(row.AmountMinor) ? row.AmountMinor : null,
    StatusLabel: row.StatusLabel ?? null,
    IsCancelled: row.IsCancelled === true,
    IsLinkedOperation: row.IsLinkedOperation === true,
    CounterpartyName: row.CounterpartyName ?? null,
    ReferenceParts: Array.isArray(row.ReferenceParts) ? row.ReferenceParts : null,
    CartonQuantityMilli: Number.isInteger(row.CartonQuantityMilli) ? row.CartonQuantityMilli : null,
    PackageCountMilli: Number.isInteger(row.PackageCountMilli) ? row.PackageCountMilli : null,
    CropNetWeightMilli: Number.isInteger(row.CropNetWeightMilli) ? row.CropNetWeightMilli : null,
    CropWeightResolved: row.CropWeightResolved === true
  };
}

// ---------------------------------------------------------------------------
// Operational alerts — only rules the stored data can prove.
// ---------------------------------------------------------------------------
export function buildAlerts({ balances, totals, crop } = {}) {
  const alerts = [];
  if (balances && balances.NonZeroCount > 0) {
    alerts.push({
      Kind: DASHBOARD_ALERT_KIND.NON_ZERO_BALANCE,
      Label: 'عملاء لديهم رصيد غير صفري',
      Count: balances.NonZeroCount,
      Tone: 'info'
    });
  }
  if (totals && totals.CancelledCount > 0) {
    alerts.push({
      Kind: DASHBOARD_ALERT_KIND.CANCELLED_IN_PERIOD,
      Label: 'حركات ملغاة خلال الفترة',
      Count: totals.CancelledCount,
      Tone: 'info'
    });
  }
  if (balances && balances.NamelessCustomerCount > 0) {
    alerts.push({
      Kind: DASHBOARD_ALERT_KIND.NAMELESS_CUSTOMER,
      Label: 'عملاء بلا اسم مسجّل',
      Count: balances.NamelessCustomerCount,
      Tone: 'warning'
    });
  }
  if (balances && balances.InactiveCustomerCount > 0) {
    alerts.push({
      Kind: DASHBOARD_ALERT_KIND.INACTIVE_CUSTOMER,
      Label: 'عملاء غير نشطين',
      Count: balances.InactiveCustomerCount,
      Tone: 'info'
    });
  }
  if (crop && crop.Local.UnresolvedWeightCount > 0) {
    alerts.push({
      Kind: DASHBOARD_ALERT_KIND.UNRESOLVED_WEIGHT,
      Label: 'حركات محصول محلي بوزن صافٍ غير محسوم',
      Count: crop.Local.UnresolvedWeightCount,
      Tone: 'warning'
    });
  }
  if (crop && crop.Carton.MissingQuantityCount > 0) {
    alerts.push({
      Kind: DASHBOARD_ALERT_KIND.MISSING_CARTON_COUNT,
      Label: 'حركات كرتون بعدد كراتين غير محدد',
      Count: crop.Carton.MissingQuantityCount,
      Tone: 'warning'
    });
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// The one entry point the screen uses.
// ---------------------------------------------------------------------------
export async function buildDashboard(criteria = {}) {
  authService.assertCanManageData();
  const period = normalizeDashboardPeriod(criteria.period);
  const today = criteria.todayIso === null || criteria.todayIso === undefined ? todayIso() : criteria.todayIso;
  const range = resolvePeriodRange(period, today);

  const balanceRows = await balanceService.listCustomerBalances();
  const ledger = await transactionLedgerService.buildLedger();
  // The ledger's own date rule, reused as-is (boundaries inclusive).
  const periodRows = transactionLedgerService.applyFilters(ledger.Rows, { from: range.From, to: range.To });

  const balances = summarizeBalances(balanceRows);
  const totals = summarizePeriod(periodRows);
  const crop = summarizeCrop(periodRows);
  const series = buildSeries(periodRows, range);
  // The latest movements are the newest in the WHOLE ledger, not only inside the chosen
  // period: the period selector narrows the totals, the chart and the purchases, never
  // this list. `ledger.Rows` is already ordered by the ledger's own rule (Phase 4B.15)
  // with the two legs of a debt transfer merged into one row, so nothing is re-sorted here.
  const latest = ledger.Rows.slice(0, DASHBOARD_LATEST_LIMIT).map(toLatestRow);
  const alerts = buildAlerts({ balances, totals, crop });

  return {
    Period: range,
    GeneratedAt: nowIso(),
    Balances: balances,
    Totals: totals,
    Series: series,
    Crop: crop,
    Latest: latest,
    Alerts: alerts,
    DataState: {
      RegisteredOperations: ledger.Summary.TotalCount,
      RegisteredStoredRows: ledger.Summary.StoredRowCount,
      PeriodOperations: periodRows.length,
      PeriodActiveOperations: totals.MovementCount,
      HaveAnyTransaction: ledger.Summary.TotalCount > 0,
      HavePeriodData: periodRows.length > 0
    }
  };
}

export const dashboardService = {
  PERIOD: DASHBOARD_PERIOD,
  PERIOD_OPTIONS: DASHBOARD_PERIOD_OPTIONS,
  DEFAULT_PERIOD: DEFAULT_DASHBOARD_PERIOD,
  normalizePeriod: normalizeDashboardPeriod,
  resolvePeriodRange,
  buildBuckets,
  buildSeries,
  summarizePeriod,
  summarizeCrop,
  summarizeBalances,
  buildAlerts,
  buildDashboard
};
