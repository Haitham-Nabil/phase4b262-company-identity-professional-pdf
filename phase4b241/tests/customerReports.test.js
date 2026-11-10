import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER_REPORT_STATUS, buildCustomerStatementFromLedger, normalizeCustomerReportFilters } from '../src/services/customerReportService.js';
import { TRANSACTION_TYPE as T } from '../src/domain/transactionTypes.js';

const customer = { Id: 'c1', Code: 'C1', Name: 'أحمد', IsActive: true };
const ledger = {
  OpeningBalanceMinor: 100000,
  BalanceMinor: 135000,
  Entries: [
    { Id: 'old', Date: '2026-01-01', TransactionType: T.CASH_RECEIVED, Description: 'سابق', DebitMinor: 0, CreditMinor: 20000, RunningBalanceMinor: 120000, IsCancelled: false },
    { Id: 'cancelled', Date: '2026-01-03', TransactionType: T.SALE_PESTICIDES, Description: 'ملغاة', DebitMinor: 0, CreditMinor: 0, RunningBalanceMinor: 120000, IsCancelled: true, CancellationReason: 'خطأ إدخال' },
    { Id: 'debit', Date: '2026-01-05', TransactionType: T.SALE_PESTICIDES, Description: 'بيع', DebitMinor: 30000, CreditMinor: 0, RunningBalanceMinor: 90000, IsCancelled: false },
    { Id: 'credit', Date: '2026-01-07', TransactionType: T.SALES_RETURN, Description: 'مرتجع', DebitMinor: 0, CreditMinor: 45000, RunningBalanceMinor: 135000, IsCancelled: false }
  ]
};

test('period statement uses canonical running balance before period as opening balance', () => {
  const report = buildCustomerStatementFromLedger({ customer, ledger, filters: { from: '2026-01-05', to: '2026-01-07' } });
  assert.equal(report.OpeningBalanceMinor, 120000);
  assert.equal(report.TotalDebitMinor, 30000);
  assert.equal(report.TotalCreditMinor, 45000);
  assert.equal(report.ClosingBalanceMinor, 135000);
  assert.deepEqual(report.TypeGroups.map((group) => group.TransactionType).sort(), [T.SALES_RETURN, T.SALE_PESTICIDES].sort());
  assert.deepEqual(report.Rows.map((r) => r.Id), ['debit', 'credit']);
});

test('cancelled rows are visible on request and do not affect opening, totals or closing balance', () => {
  const report = buildCustomerStatementFromLedger({ customer, ledger, filters: { from: '2026-01-03', to: '2026-01-07', status: CUSTOMER_REPORT_STATUS.ALL } });
  assert.equal(report.Rows.length, 3);
  assert.equal(report.Rows[0].CancellationReason, 'خطأ إدخال');
  assert.equal(report.MovementCount, 2);
  assert.equal(report.CancelledCount, 1);
  assert.equal(report.OpeningBalanceMinor, 120000);
  assert.equal(report.ClosingBalanceMinor, 135000);
});

test('cancelled-only view does not add cancelled rows to financial totals', () => {
  const report = buildCustomerStatementFromLedger({ customer, ledger, filters: { from: '2026-01-03', to: '2026-01-07', status: CUSTOMER_REPORT_STATUS.CANCELLED } });
  assert.deepEqual(report.Rows.map((r) => r.Id), ['cancelled']);
  assert.equal(report.TotalDebitMinor, 30000);
  assert.equal(report.TotalCreditMinor, 45000);
  assert.equal(report.ClosingBalanceMinor, 135000);
});

test('full statement starts from opening balance and closes at the latest canonical running balance', () => {
  const report = buildCustomerStatementFromLedger({ customer, ledger, filters: {} });
  assert.equal(report.OpeningBalanceMinor, 100000);
  assert.equal(report.ClosingBalanceMinor, 135000);
  assert.equal(report.Rows.length, 3);
});

test('period ending before first movement closes at the opening balance', () => {
  const report = buildCustomerStatementFromLedger({ customer, ledger, filters: { to: '2025-12-31' } });
  assert.equal(report.OpeningBalanceMinor, 100000);
  assert.equal(report.ClosingBalanceMinor, 100000);
  assert.equal(report.Rows.length, 0);
});

test('invalid date range and status are rejected', () => {
  assert.throws(() => normalizeCustomerReportFilters({ from: '2026-02-02', to: '2026-01-01' }));
  assert.throws(() => normalizeCustomerReportFilters({ status: 'unknown' }));
});


test('customer reports screen exposes the four approved report modes and date/status filters', async () => {
  const { customerReportViewHtml } = await import('../ui/views/reportCustomers.js');
  const html = customerReportViewHtml();
  assert.match(html, /كشف حساب عميل/);
  assert.match(html, /كشف مجمع لجميع العملاء/);
  assert.match(html, /أرصدة العملاء/);
  assert.match(html, /حركة العملاء/);
  assert.match(html, /customer-report-from/);
  assert.match(html, /customer-report-to/);
  assert.match(html, /customer-report-status/);
});

test('reports domain includes the dedicated customer and account reports section', async () => {
  const { reportsViewHtml, REPORT_DOMAIN } = await import('../ui/views/reports.js');
  const html = reportsViewHtml();
  assert.equal(REPORT_DOMAIN.CUSTOMERS, 'customers');
  assert.match(html, /تقارير العملاء والحسابات/);
  assert.match(html, /customer-reports-root/);
});
