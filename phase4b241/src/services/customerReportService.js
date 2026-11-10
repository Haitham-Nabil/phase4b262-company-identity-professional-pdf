import { authService } from './authService.js';
// Phase 4B.21 — read-only customer and account reports.
// All financial figures are taken from balanceService's canonical running ledger.
// This module only selects periods, status and report projections; it never derives
// Debit/Credit or re-implements the balance formula.
import { balanceService } from './balanceService.js';
import { customerService } from './customerService.js';
import { isValidIsoDate } from '../domain/dateUtils.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';
import { TRANSACTION_TYPE_LABELS_AR } from '../domain/transactionTypes.js';

export const CUSTOMER_REPORT_MODE = Object.freeze({
  STATEMENT: 'statement', CONSOLIDATED: 'consolidated', BALANCES: 'balances', ACTIVITY: 'activity'
});
export const CUSTOMER_REPORT_STATUS = Object.freeze({ ACTIVE: 'active', CANCELLED: 'cancelled', ALL: 'all' });
export const CUSTOMER_REPORT_TYPE_LABELS_AR = TRANSACTION_TYPE_LABELS_AR;

const clean = (value) => value === null || value === undefined ? '' : String(value).trim();

export function normalizeCustomerReportFilters(input = {}) {
  const from = clean(input.from);
  const to = clean(input.to);
  const customerId = clean(input.customerId);
  const status = clean(input.status) || CUSTOMER_REPORT_STATUS.ACTIVE;
  if (from && !isValidIsoDate(from)) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'تاريخ البداية غير صالح؛ الصيغة المعتمدة YYYY-MM-DD.', { field: 'from' });
  if (to && !isValidIsoDate(to)) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'تاريخ النهاية غير صالح؛ الصيغة المعتمدة YYYY-MM-DD.', { field: 'to' });
  if (from && to && from > to) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'تاريخ البداية يجب ألا يكون بعد تاريخ النهاية.', { field: 'from' });
  if (!Object.values(CUSTOMER_REPORT_STATUS).includes(status)) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'حالة الحركة المحددة غير معتمدة.', { field: 'status' });
  return { from, to, customerId, status };
}

function isBefore(row, date) { return Boolean(date) && clean(row.Date) < date; }
function isWithin(row, filters) {
  return (!filters.from || clean(row.Date) >= filters.from) && (!filters.to || clean(row.Date) <= filters.to);
}
function visibleByStatus(row, status) {
  if (status === CUSTOMER_REPORT_STATUS.ALL) return true;
  return status === CUSTOMER_REPORT_STATUS.CANCELLED ? row.IsCancelled === true : row.IsCancelled !== true;
}

// Uses the service-provided RunningBalanceMinor to establish period opening/closing.
// Cancelled rows already leave this value unchanged in balanceService.
export function buildCustomerStatementFromLedger({ customer, summary, ledger, filters = {} } = {}) {
  const normalized = normalizeCustomerReportFilters(filters);
  if (!customer || !ledger || !Array.isArray(ledger.Entries)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'بيانات كشف الحساب غير مكتملة.');
  }
  const entries = ledger.Entries;
  const before = entries.filter((row) => isBefore(row, normalized.from));
  const openingBalanceMinor = before.length
    ? before[before.length - 1].RunningBalanceMinor
    : ledger.OpeningBalanceMinor;
  const inPeriod = entries.filter((row) => isWithin(row, normalized));
  const activeInPeriod = inPeriod.filter((row) => row.IsCancelled !== true);
  const shownRows = inPeriod.filter((row) => visibleByStatus(row, normalized.status));
  const throughEnd = entries.filter((row) => !normalized.to || clean(row.Date) <= normalized.to);
  const closingBalanceMinor = throughEnd.length
    ? throughEnd[throughEnd.length - 1].RunningBalanceMinor
    : openingBalanceMinor;
  const totalDebitMinor = activeInPeriod.reduce((sum, row) => sum + (Number.isInteger(row.DebitMinor) ? row.DebitMinor : 0), 0);
  const totalCreditMinor = activeInPeriod.reduce((sum, row) => sum + (Number.isInteger(row.CreditMinor) ? row.CreditMinor : 0), 0);
  const byTypeMap = new Map();
  for (const row of activeInPeriod) {
    const key = clean(row.TransactionType) || 'Unknown';
    if (!byTypeMap.has(key)) byTypeMap.set(key, { TransactionType: key, MovementCount: 0, TotalDebitMinor: 0, TotalCreditMinor: 0 });
    const group = byTypeMap.get(key);
    group.MovementCount += 1;
    group.TotalDebitMinor += Number.isInteger(row.DebitMinor) ? row.DebitMinor : 0;
    group.TotalCreditMinor += Number.isInteger(row.CreditMinor) ? row.CreditMinor : 0;
  }
  const typeGroups = [...byTypeMap.values()].sort((a, b) => a.TransactionType.localeCompare(b.TransactionType));
  return {
    Customer: { Id: customer.Id, Code: customer.Code ?? null, Name: customer.Name ?? null, IsActive: customer.IsActive === true },
    Filters: normalized,
    OpeningBalanceMinor: openingBalanceMinor,
    TotalDebitMinor: totalDebitMinor,
    TotalCreditMinor: totalCreditMinor,
    NetChangeMinor: totalCreditMinor - totalDebitMinor,
    TypeGroups: typeGroups,
    ClosingBalanceMinor: closingBalanceMinor,
    MovementCount: activeInPeriod.length,
    CancelledCount: inPeriod.filter((row) => row.IsCancelled === true).length,
    Rows: shownRows,
    AllPeriodRows: inPeriod,
    CurrentBalanceMinor: summary?.BalanceMinor ?? ledger.BalanceMinor
  };
}

function aggregateCustomerRows(statements, filters) {
  return statements.map((statement) => ({
    Customer: statement.Customer,
    OpeningBalanceMinor: statement.OpeningBalanceMinor,
    TotalDebitMinor: statement.TotalDebitMinor,
    TotalCreditMinor: statement.TotalCreditMinor,
    NetChangeMinor: statement.NetChangeMinor,
    ClosingBalanceMinor: statement.ClosingBalanceMinor,
    MovementCount: statement.MovementCount,
    CancelledCount: statement.CancelledCount,
    Rows: statement.Rows,
    Filters: filters
  }));
}

export async function listCustomerReportOptions() {
  authService.assertCanManageData();
  const customers = await customerService.listCustomers();
  return customers
    .slice()
    .sort((a, b) => String(a.Name || '').localeCompare(String(b.Name || ''), 'ar'))
    .map((customer) => ({ value: customer.Id, label: `${customer.Name || 'عميل بدون اسم'} (${customer.Code || '—'})`, IsActive: customer.IsActive === true }));
}

async function loadStatement(customerId, filters) {
  const customer = await customerService.getCustomer(customerId);
  if (!customer) throw new AppError(ERROR_CODE.NOT_FOUND, 'العميل غير موجود.', { field: 'CustomerId' });
  const [summary, ledger] = await Promise.all([
    balanceService.getCustomerSummary(customerId),
    balanceService.getRunningBalance(customerId)
  ]);
  return buildCustomerStatementFromLedger({ customer, summary, ledger, filters });
}

export async function buildCustomerReport({ mode = CUSTOMER_REPORT_MODE.STATEMENT, filters = {} } = {}) {
  authService.assertCanManageData();
  if (!Object.values(CUSTOMER_REPORT_MODE).includes(mode)) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'نوع تقرير العملاء غير معتمد.', { field: 'mode' });
  const parsed = normalizeCustomerReportFilters(filters);
  // The balances view is an as-of-date snapshot, not a movement-period report.
  const normalized = mode === CUSTOMER_REPORT_MODE.BALANCES ? { ...parsed, from: '' } : parsed;
  if (mode === CUSTOMER_REPORT_MODE.STATEMENT && !normalized.customerId) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'اختر العميل لعرض كشف حسابه.', { field: 'customerId' });
  }
  if (mode === CUSTOMER_REPORT_MODE.STATEMENT) {
    return { Mode: mode, Title: 'كشف حساب العميل', Filters: normalized, Statement: await loadStatement(normalized.customerId, normalized) };
  }
  const customers = await customerService.listCustomers();
  const selected = normalized.customerId ? customers.filter((c) => c.Id === normalized.customerId) : customers;
  const statements = [];
  for (const customer of selected) statements.push(await loadStatement(customer.Id, normalized));
  const rows = aggregateCustomerRows(statements, normalized);
  const totals = rows.reduce((acc, row) => {
    acc.OpeningBalanceMinor += row.OpeningBalanceMinor;
    acc.TotalDebitMinor += row.TotalDebitMinor;
    acc.TotalCreditMinor += row.TotalCreditMinor;
    acc.NetChangeMinor += row.NetChangeMinor;
    acc.ClosingBalanceMinor += row.ClosingBalanceMinor;
    acc.MovementCount += row.MovementCount;
    acc.CancelledCount += row.CancelledCount;
    return acc;
  }, { OpeningBalanceMinor: 0, TotalDebitMinor: 0, TotalCreditMinor: 0, NetChangeMinor: 0, ClosingBalanceMinor: 0, MovementCount: 0, CancelledCount: 0 });
  return { Mode: mode, Title: mode === CUSTOMER_REPORT_MODE.BALANCES ? 'أرصدة العملاء' : mode === CUSTOMER_REPORT_MODE.ACTIVITY ? 'حركة العملاء' : 'كشف حساب مجمع لجميع العملاء', Filters: normalized, Customers: rows, Totals: totals };
}

export const customerReportService = Object.freeze({
  modes: CUSTOMER_REPORT_MODE,
  statuses: CUSTOMER_REPORT_STATUS,
  typeLabels: CUSTOMER_REPORT_TYPE_LABELS_AR,
  normalizeFilters: normalizeCustomerReportFilters,
  buildStatementFromLedger: buildCustomerStatementFromLedger,
  listCustomers: listCustomerReportOptions,
  buildReport: buildCustomerReport
});
