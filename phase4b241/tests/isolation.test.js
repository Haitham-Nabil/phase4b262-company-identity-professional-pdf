import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { balanceService } from '../src/services/balanceService.js';
import { openingBalanceService } from '../src/services/openingBalanceService.js';
import { TRANSACTION_TYPE } from '../src/domain/transactionTypes.js';

test('A customer is unaffected by another customer transactions', async () => {
  await freshDatabase('isolation-tx');
  const a = await customerService.createCustomer({ Code: 'A', Name: 'عميل أ' });
  const b = await customerService.createCustomer({ Code: 'B', Name: 'عميل ب' });
  await transactionService.createTransaction({ CustomerId: a.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 400 });
  await transactionService.createTransaction({ CustomerId: b.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 900 });
  assert.equal((await balanceService.getCurrentBalanceMinor(a.Id)), -40000);
  assert.equal((await balanceService.getCurrentBalanceMinor(b.Id)), -90000);
});

test('Changing one opening balance does not touch another customer', async () => {
  await freshDatabase('isolation-ob');
  const a = await customerService.createCustomer({ Code: 'A', Name: 'عميل أ', OpeningBalance: 1000 });
  const b = await customerService.createCustomer({ Code: 'B', Name: 'عميل ب', OpeningBalance: 1000 });
  await openingBalanceService.setOpeningBalance(a.Id, { newValue: 5000, reason: 'تصحيح' });
  assert.equal(await balanceService.getCurrentBalanceMinor(a.Id), 500000);
  assert.equal(await balanceService.getCurrentBalanceMinor(b.Id), 100000);
});

test('Opening balance history records old value, new value, date and reason', async () => {
  await freshDatabase('isolation-history');
  const a = await customerService.createCustomer({ Code: 'A', Name: 'عميل أ', OpeningBalance: 1000 });
  await openingBalanceService.setOpeningBalance(a.Id, { newValue: 2500, reason: 'تصحيح افتتاحي' });
  await openingBalanceService.setOpeningBalance(a.Id, { newValue: 1500, reason: 'مراجعة' });
  const history = await openingBalanceService.listHistory(a.Id);
  assert.equal(history.length, 2);
  assert.equal(history[0].OldValueMinor, 100000);
  assert.equal(history[0].NewValueMinor, 250000);
  assert.equal(history[0].Reason, 'تصحيح افتتاحي');
  assert.ok(history[0].ChangedAt);
  assert.equal(history[1].OldValueMinor, 250000);
  assert.equal(history[1].NewValueMinor, 150000);
});

test('A customer is created without opening balance defaulting to zero and rejected on duplicate code', async () => {
  await freshDatabase('isolation-create');
  const a = await customerService.createCustomer({ Code: 'X1', Name: 'عميل' });
  assert.equal(a.OpeningBalanceMinor, 0);
  await assert.rejects(() => customerService.createCustomer({ Code: 'X1', Name: 'عميل آخر' }), /مستخدم بالفعل/);
  await assert.rejects(() => customerService.createCustomer({ Code: 'X2' }), /اسم العميل مطلوب/);
  assert.equal((await customerService.listCustomers()).length, 1);
});

test('An imported nameless customer is kept and still computes its balance', async () => {
  await freshDatabase('isolation-nameless');
  const nameless = await customerService.createImportedCustomer({ Code: '26', Name: 0 });
  assert.equal(nameless.Name, null);
  await transactionService.createTransaction({ CustomerId: nameless.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 250 });
  const summary = await balanceService.getCustomerSummary(nameless.Id);
  assert.equal(summary.BalanceMinor, -25000);
  const portfolio = await balanceService.getPortfolioSummary();
  assert.equal(portfolio.NamelessCustomerCount, 1);
});
