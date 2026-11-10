import { authService } from './authService.js';
// Phase 4B.20 — read-only reports for the non-crop transaction types.
// The central ledger is the sole read model: linked DebtTransfer legs are already
// represented once, and financial fields come from deriveFinancials().
import { transactionLedgerService } from './transactionLedgerService.js';
import { TRANSACTION_TYPE, TRANSACTION_TYPE_LABELS_AR } from '../domain/transactionTypes.js';
import { isValidIsoDate } from '../domain/dateUtils.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';
import { customerService } from './customerService.js';

export const GENERAL_REPORT_TYPES = Object.freeze([
  TRANSACTION_TYPE.SALE_PESTICIDES,
  TRANSACTION_TYPE.SALE_IRRIGATION,
  TRANSACTION_TYPE.SALES_RETURN,
  TRANSACTION_TYPE.CASH_RECEIVED,
  TRANSACTION_TYPE.CASH_PAID,
  TRANSACTION_TYPE.SETTLEMENT,
  TRANSACTION_TYPE.GOODS_EXCHANGE,
  TRANSACTION_TYPE.DEBT_TRANSFER
]);
export const GENERAL_REPORT_TITLES_AR = Object.freeze(Object.fromEntries(
  GENERAL_REPORT_TYPES.map((type) => [type, `تقرير ${TRANSACTION_TYPE_LABELS_AR[type]}`])
));
export const GENERAL_REPORT_STATUS = Object.freeze({ ACTIVE: 'active', CANCELLED: 'cancelled', ALL: 'all' });
export const GENERAL_REPORT_TYPE_LABELS_AR = TRANSACTION_TYPE_LABELS_AR;
export const GENERAL_REPORT_CASH_RECEIVED_TYPE = TRANSACTION_TYPE.CASH_RECEIVED;
export const GENERAL_REPORT_CASH_PAID_TYPE = TRANSACTION_TYPE.CASH_PAID;

const clean = (value) => value === null || value === undefined ? '' : String(value).trim();

export function normalizeGeneralReportFilters(input = {}) {
  const from = clean(input.from);
  const to = clean(input.to);
  if (from && !isValidIsoDate(from)) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'تاريخ البداية غير صالح؛ الصيغة المعتمدة YYYY-MM-DD.', { field: 'from' });
  if (to && !isValidIsoDate(to)) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'تاريخ النهاية غير صالح؛ الصيغة المعتمدة YYYY-MM-DD.', { field: 'to' });
  if (from && to && from > to) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'تاريخ البداية يجب ألا يكون بعد تاريخ النهاية.', { field: 'from' });
  const status = clean(input.status) || GENERAL_REPORT_STATUS.ACTIVE;
  if (!Object.values(GENERAL_REPORT_STATUS).includes(status)) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'حالة الحركة المحددة غير معتمدة.', { field: 'status' });
  return { from, to, customerId: clean(input.customerId), status };
}

function amountFor(row, type) {
  if (type === TRANSACTION_TYPE.CASH_RECEIVED) return Number.isInteger(row.CashReceivedMinor) ? row.CashReceivedMinor : null;
  if (type === TRANSACTION_TYPE.CASH_PAID) return Number.isInteger(row.CashPaidMinor) ? row.CashPaidMinor : null;
  return Number.isInteger(row.AmountMinor) ? row.AmountMinor : null;
}

export function buildGeneralReportFromRows(rows = [], type, filters = {}) {
  if (!GENERAL_REPORT_TYPES.includes(type)) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'نوع التقرير غير معتمد.', { field: 'type' });
  const normalized = normalizeGeneralReportFilters(filters);
  const matched = rows.filter((row) => {
    if (!row || row.TransactionType !== type) return false;
    if (normalized.from && clean(row.Date) < normalized.from) return false;
    if (normalized.to && clean(row.Date) > normalized.to) return false;
    if (normalized.customerId && clean(row.CustomerId) !== normalized.customerId
      && clean(row.CounterpartyId) !== normalized.customerId) return false;
    if (normalized.status === GENERAL_REPORT_STATUS.ACTIVE && row.IsCancelled) return false;
    if (normalized.status === GENERAL_REPORT_STATUS.CANCELLED && !row.IsCancelled) return false;
    return true;
  });
  const activeRows = matched.filter((row) => !row.IsCancelled);
  const groupsMap = new Map();
  for (const row of activeRows) {
    // For DebtTransfer the ledger row represents the whole linked operation once.
    const counterpartySelected = type === TRANSACTION_TYPE.DEBT_TRANSFER
      && normalized.customerId && clean(row.CustomerId) !== normalized.customerId
      && clean(row.CounterpartyId) === normalized.customerId;
    const groupCustomerId = counterpartySelected ? row.CounterpartyId : row.CustomerId;
    const groupCustomerName = counterpartySelected ? row.CounterpartyName : row.CustomerName;
    const groupCustomerCode = counterpartySelected ? row.CounterpartyCode : row.CustomerCode;
    const key = clean(groupCustomerId) || '__NO_CUSTOMER__';
    if (!groupsMap.has(key)) groupsMap.set(key, {
      CustomerId: groupCustomerId ?? null, CustomerName: groupCustomerName ?? null,
      CustomerCode: groupCustomerCode ?? null, MovementCount: 0, AmountMinor: 0,
      AmountKnownCount: 0, Rows: []
    });
    const group = groupsMap.get(key);
    group.MovementCount += 1;
    const amount = amountFor(row, type);
    if (amount !== null) { group.AmountMinor += amount; group.AmountKnownCount += 1; }
    group.Rows.push(row);
  }
  const groups = [...groupsMap.values()].sort((a, b) => String(a.CustomerName || '').localeCompare(String(b.CustomerName || ''), 'ar'));
  const totalAmount = activeRows.reduce((sum, row) => sum + (amountFor(row, type) ?? 0), 0);
  const knownAmountCount = activeRows.filter((row) => amountFor(row, type) !== null).length;
  return {
    Type: type,
    Title: GENERAL_REPORT_TITLES_AR[type],
    Filters: normalized,
    Rows: matched,
    Groups: groups,
    Totals: {
      MovementCount: activeRows.length,
      AmountMinor: totalAmount,
      AmountKnownCount: knownAmountCount,
      MissingAmountCount: activeRows.length - knownAmountCount,
      GroupCount: groups.length,
      CancelledCount: matched.filter((row) => row.IsCancelled).length
    }
  };
}

export async function listGeneralReportCustomers() {
  authService.assertCanManageData();
  const rows = await customerService.listCustomers();
  return rows.map((row) => ({ value: row.Id, label: `${row.Name || 'عميل بدون اسم'} (${row.Code || '—'})`, IsActive: row.IsActive === true }));
}

export async function buildGeneralReport({ type, filters = {} } = {}) {
  authService.assertCanManageData();
  const normalized = normalizeGeneralReportFilters(filters);
  const ledger = await transactionLedgerService.buildLedger();
  return buildGeneralReportFromRows(ledger.Rows, type, normalized);
}

export const generalReportService = {
  reportTypes: GENERAL_REPORT_TYPES,
  titles: GENERAL_REPORT_TITLES_AR,
  typeLabels: GENERAL_REPORT_TYPE_LABELS_AR,
  normalizeFilters: normalizeGeneralReportFilters,
  buildFromRows: buildGeneralReportFromRows,
  buildReport: buildGeneralReport,
  listCustomers: listGeneralReportCustomers
};
