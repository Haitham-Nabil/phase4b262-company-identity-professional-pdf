import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.js';
import { databaseInit } from '../src/services/databaseInit.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { balanceService } from '../src/services/balanceService.js';
import { TRANSACTION_TYPE } from '../src/domain/transactionTypes.js';

test('Balance = OpeningBalance + Credits - Debits (1000 + 500 - 200 = 1300)', async () => {
  await freshDatabase('balance');
  const customer = await customerService.createCustomer({ Code: 'C1', Name: 'عميل واحد', OpeningBalance: 1000 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 500 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-02', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 200 });
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.TotalCreditMinor, 50000);
  assert.equal(summary.TotalDebitMinor, 20000);
  assert.equal(summary.BalanceMinor, 130000); // 1300.00
  assert.equal(summary.BalanceSide, 'Credit');
});

test('Negative balance is a valid financial state (-1500)', async () => {
  await freshDatabase('negative');
  const customer = await customerService.createCustomer({ Code: 'C2', Name: 'عميل مدين', OpeningBalance: 0 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_IRRIGATION, Amount: 1500 });
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.BalanceMinor, -150000);
  assert.equal(summary.BalanceSide, 'Debit');
});

test('CashReceived affects balance AND actual cash received', async () => {
  await freshDatabase('cashin');
  const customer = await customerService.createCustomer({ Code: 'C3', Name: 'نقدية واردة' });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 20000 });
  const s = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(s.BalanceMinor, 2000000);
  assert.equal(s.CashReceivedMinor, 2000000);
  assert.equal(s.CashPaidMinor, 0);
});

test('CashPaid affects balance AND actual cash paid', async () => {
  await freshDatabase('cashout');
  const customer = await customerService.createCustomer({ Code: 'C4', Name: 'دفعة نقدية' });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.CASH_PAID, Amount: 30000 });
  const s = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(s.BalanceMinor, -3000000);
  assert.equal(s.CashPaidMinor, 3000000);
  assert.equal(s.CashReceivedMinor, 0);
});

test('Settlement affects the balance but actual cash stays 0', async () => {
  await freshDatabase('settlement');
  const customer = await customerService.createCustomer({ Code: 'C5', Name: 'تسوية' });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SETTLEMENT, Amount: 10000 });
  const s = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(s.BalanceMinor, 1000000);
  assert.equal(s.CashReceivedMinor, 0);
  assert.equal(s.CashPaidMinor, 0);
  assert.equal(s.NonCashSettlementMinor, 1000000);
});

test('GoodsExchange affects the balance but cash stays 0', async () => {
  await freshDatabase('exchange');
  const customer = await customerService.createCustomer({ Code: 'C6', Name: 'مبادلة' });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, Amount: 7000 });
  const s = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(s.BalanceMinor, 700000);
  assert.equal(s.CashReceivedMinor, 0);
  assert.equal(s.CashPaidMinor, 0);
});

test('Acceptance scenario: opening -100000 + cash 20000 + settlement 10000 => -70000, cash = 20000, settlement = 10000', async () => {
  await freshDatabase('acceptance');
  const customer = await customerService.createCustomer({ Code: 'C7', Name: 'سيناريو القبول', OpeningBalance: -100000 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 20000 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-02', TransactionType: TRANSACTION_TYPE.SETTLEMENT, Amount: 10000 });
  const s = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(s.BalanceMinor, -7000000);      // -70,000
  assert.equal(s.CashReceivedMinor, 2000000);  // 20,000 - cash measured separately
  assert.equal(s.NonCashSettlementMinor, 1000000); // 10,000 - non-cash measured separately
  assert.equal(s.CashPaidMinor, 0);
  // No aggregated "total collection" field may exist (cash and non-cash never merged).
  assert.equal(Object.prototype.hasOwnProperty.call(s, 'TotalCollection'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(s, 'TotalCollectionMinor'), false);
});

test('Running balance is computed per row with Date ASC ordering and excludes cancellations', async () => {
  await freshDatabase('running');
  const customer = await customerService.createCustomer({ Code: 'C8', Name: 'كشف حساب', OpeningBalance: 1000 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-05', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 300 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 500 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-03', TransactionType: TRANSACTION_TYPE.SALES_RETURN, Amount: 200 });
  const ledger = await balanceService.getRunningBalance(customer.Id);
  assert.deepEqual(ledger.Entries.map((e) => e.Date), ['2026-09-01', '2026-09-03', '2026-09-05']);
  assert.deepEqual(ledger.Entries.map((e) => e.RunningBalanceMinor), [150000, 170000, 140000]);
  assert.equal(ledger.BalanceMinor, 140000);
});

test('Repeated identical amounts with the same date keep a stable, deterministic order', async () => {
  await freshDatabase('ordering');
  const customer = await customerService.createCustomer({ Code: 'C9', Name: 'ترتيب ثابت' });
  for (let i = 0; i < 5; i += 1) {
    await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 100 });
  }
  const ledgerA = await balanceService.getRunningBalance(customer.Id);
  const ledgerB = await balanceService.getRunningBalance(customer.Id);
  assert.deepEqual(ledgerA.Entries.map((e) => e.Id), ledgerB.Entries.map((e) => e.Id));
  assert.deepEqual(ledgerA.Entries.map((e) => e.RunningBalanceMinor), [-10000, -20000, -30000, -40000, -50000]);
});
