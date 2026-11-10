import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { customerReportService, CUSTOMER_REPORT_MODE } from '../src/services/customerReportService.js';
import { TRANSACTION_TYPE as T } from '../src/domain/transactionTypes.js';

test('real customer statement includes every transaction type in chronological order', async () => {
  await freshDatabase('customer-report-statement');
  const c = await customerService.createCustomer({ Code: 'CR1', Name: 'عميل التقرير', OpeningBalance: 100 });
  await transactionService.createTransaction({ CustomerId: c.Id, Date: '2026-02-03', TransactionType: T.SALE_PESTICIDES, Amount: 30 });
  await transactionService.createTransaction({ CustomerId: c.Id, Date: '2026-02-01', TransactionType: T.CASH_RECEIVED, Amount: 20 });
  await transactionService.createTransaction({ CustomerId: c.Id, Date: '2026-02-04', TransactionType: T.SETTLEMENT, Amount: 10, Direction: 'Debit' });
  const report = await customerReportService.buildReport({ mode: CUSTOMER_REPORT_MODE.STATEMENT, filters: { customerId: c.Id } });
  assert.deepEqual(report.Statement.Rows.map((r) => r.Date), ['2026-02-01', '2026-02-03', '2026-02-04']);
  assert.equal(report.Statement.OpeningBalanceMinor, 10000);
  assert.equal(report.Statement.ClosingBalanceMinor, 8000);
});

test('all-customer consolidated and balances reports keep each customer as a separate account', async () => {
  await freshDatabase('customer-report-all');
  const a = await customerService.createCustomer({ Code: 'CRA', Name: 'ألف', OpeningBalance: 100 });
  const b = await customerService.createCustomer({ Code: 'CRB', Name: 'باء', OpeningBalance: 200 });
  await transactionService.createTransaction({ CustomerId: a.Id, Date: '2026-03-01', TransactionType: T.CASH_RECEIVED, Amount: 50 });
  await transactionService.createTransaction({ CustomerId: b.Id, Date: '2026-03-02', TransactionType: T.SALE_IRRIGATION, Amount: 25 });
  const report = await customerReportService.buildReport({ mode: CUSTOMER_REPORT_MODE.CONSOLIDATED, filters: {} });
  assert.equal(report.Customers.length, 2);
  assert.equal(report.Totals.MovementCount, 2);
  const balances = await customerReportService.buildReport({ mode: CUSTOMER_REPORT_MODE.BALANCES, filters: { to: '2026-03-01' } });
  assert.equal(balances.Customers.length, 2);
  assert.equal(balances.Customers.find((r) => r.Customer.Id === b.Id).ClosingBalanceMinor, 20000);
});

test('activity report totals are derived from the canonical per-customer ledger', async () => {
  await freshDatabase('customer-report-activity');
  const c = await customerService.createCustomer({ Code: 'CRA1', Name: 'عميل النشاط' });
  await transactionService.createTransaction({ CustomerId: c.Id, Date: '2026-04-01', TransactionType: T.CASH_RECEIVED, Amount: 100 });
  await transactionService.createTransaction({ CustomerId: c.Id, Date: '2026-04-02', TransactionType: T.SALE_PESTICIDES, Amount: 40 });
  const report = await customerReportService.buildReport({ mode: CUSTOMER_REPORT_MODE.ACTIVITY, filters: {} });
  assert.equal(report.Customers[0].MovementCount, 2);
  assert.equal(report.Customers[0].TotalCreditMinor, 10000);
  assert.equal(report.Customers[0].TotalDebitMinor, 4000);
});
