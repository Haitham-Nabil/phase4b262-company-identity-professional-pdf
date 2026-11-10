import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGeneralReportFromRows, GENERAL_REPORT_STATUS, normalizeGeneralReportFilters } from '../src/services/generalReportService.js';
import { TRANSACTION_TYPE as T } from '../src/domain/transactionTypes.js';

const rows = [
  { Id: 'cash1', TransactionType: T.CASH_RECEIVED, Date: '2026-01-01', CustomerId: 'c1', CustomerName: 'أحمد', AmountMinor: 12500, CashReceivedMinor: 12500, IsCancelled: false },
  { Id: 'cash2', TransactionType: T.CASH_RECEIVED, Date: '2026-01-02', CustomerId: 'c1', CustomerName: 'أحمد', AmountMinor: 5000, CashReceivedMinor: 5000, IsCancelled: true, CancellationReason: 'خطأ' },
  { Id: 'sale1', TransactionType: T.SALE_PESTICIDES, Date: '2026-01-03', CustomerId: 'c2', CustomerName: 'محمد', AmountMinor: 30000, IsCancelled: false },
  { Id: 'transfer1', TransactionType: T.DEBT_TRANSFER, Date: '2026-01-04', CustomerId: 'c1', CustomerName: 'أحمد', CounterpartyId: 'c2', CounterpartyName: 'محمد', AmountMinor: 7000, IsLinkedOperation: true, LegCount: 2, IsCancelled: false }
];

test('general report filters by one transaction type and excludes cancelled by default', () => {
  const report = buildGeneralReportFromRows(rows, T.CASH_RECEIVED, {});
  assert.equal(report.Rows.length, 1);
  assert.equal(report.Totals.MovementCount, 1);
  assert.equal(report.Totals.AmountMinor, 12500);
  assert.equal(report.Totals.CancelledCount, 0);
});

test('cancelled-only report shows cancelled rows but never adds them to active totals', () => {
  const report = buildGeneralReportFromRows(rows, T.CASH_RECEIVED, { status: GENERAL_REPORT_STATUS.CANCELLED });
  assert.equal(report.Rows.length, 1);
  assert.equal(report.Rows[0].CancellationReason, 'خطأ');
  assert.equal(report.Totals.MovementCount, 0);
  assert.equal(report.Totals.AmountMinor, 0);
  assert.equal(report.Totals.CancelledCount, 1);
});

test('all status shows both active and cancelled rows while totals remain active-only', () => {
  const report = buildGeneralReportFromRows(rows, T.CASH_RECEIVED, { status: 'all' });
  assert.equal(report.Rows.length, 2);
  assert.equal(report.Totals.MovementCount, 1);
  assert.equal(report.Totals.AmountMinor, 12500);
  assert.equal(report.Totals.CancelledCount, 1);
});

test('DebtTransfer operation is counted once from the ledger operation row', () => {
  const report = buildGeneralReportFromRows(rows, T.DEBT_TRANSFER, {});
  assert.equal(report.Rows.length, 1);
  assert.equal(report.Totals.MovementCount, 1);
  assert.equal(report.Totals.AmountMinor, 7000);
  assert.equal(report.Totals.GroupCount, 1);
});

test('date and customer filters combine with AND', () => {
  const report = buildGeneralReportFromRows(rows, T.CASH_RECEIVED, { from: '2026-01-02', to: '2026-01-02', customerId: 'c1', status: 'all' });
  assert.equal(report.Rows.length, 1);
  assert.equal(report.Rows[0].Id, 'cash2');
});

test('invalid date range is rejected', () => {
  assert.throws(() => normalizeGeneralReportFilters({ from: '2026-02-02', to: '2026-01-01' }));
});

test('report rejects crop transaction types already covered by dedicated reports', () => {
  assert.throws(() => buildGeneralReportFromRows(rows, T.CROP_PURCHASE_LOCAL, {}));
});

test('DebtTransfer customer filter can select either side and groups under the selected customer', () => {
  const report = buildGeneralReportFromRows(rows, T.DEBT_TRANSFER, { customerId: 'c2' });
  assert.equal(report.Rows.length, 1);
  assert.equal(report.Groups[0].CustomerId, 'c2');
  assert.equal(report.Groups[0].CustomerName, 'محمد');
  assert.equal(report.Totals.AmountMinor, 7000);
});
