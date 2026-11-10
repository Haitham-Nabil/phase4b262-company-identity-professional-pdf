import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { cancellationService } from '../src/services/cancellationService.js';
import { balanceService } from '../src/services/balanceService.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { TRANSACTION_TYPE, STATUS } from '../src/domain/transactionTypes.js';

test('Cancelled transaction stops affecting the balance but remains stored with its reason', async () => {
  await freshDatabase('cancel');
  const customer = await customerService.createCustomer({ Code: 'C1', Name: 'إلغاء', OpeningBalance: 1000 });
  const t1 = await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 300 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-02', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 500 });

  const before = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(before.BalanceMinor, 120000);

  const cancelled = await cancellationService.cancelTransaction(t1.Id, 'فاتورة مكررة');
  assert.equal(cancelled.Status, STATUS.CANCELLED);
  assert.equal(cancelled.CancellationReason, 'فاتورة مكررة');
  assert.ok(cancelled.CancelledAt);

  const after = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(after.BalanceMinor, 150000);
  assert.equal(after.TotalDebitMinor, 0);

  const stored = await transactionRepository.getById(t1.Id);
  assert.ok(stored, 'the cancelled row must still exist (no physical delete)');
  assert.equal(stored.Status, STATUS.CANCELLED);

  const ledger = await balanceService.getRunningBalance(customer.Id);
  const cancelledEntry = ledger.Entries.find((e) => e.Id === t1.Id);
  assert.equal(cancelledEntry.IsCancelled, true);
  assert.equal(cancelledEntry.CancellationReason, 'فاتورة مكررة');
  // The row stays visible but does not move the balance: its running value equals
  // the balance carried in from the previous (unchanged) state = opening 1,000.00.
  assert.equal(cancelledEntry.RunningBalanceMinor, 100000);
  assert.equal(cancelledEntry.Status, STATUS.CANCELLED);
});

test('Cancellation without a reason is rejected and a second cancellation is rejected', async () => {
  await freshDatabase('cancel-guards');
  const customer = await customerService.createCustomer({ Code: 'C2', Name: 'حماية الإلغاء' });
  const t = await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 100 });
  await assert.rejects(() => cancellationService.cancelTransaction(t.Id, ''), /سبب إلغاء الحركة مطلوب/);
  await cancellationService.cancelTransaction(t.Id, 'سبب صحيح');
  await assert.rejects(() => cancellationService.cancelTransaction(t.Id, 'مرة أخرى'), /ملغاة بالفعل/);
  await assert.rejects(() => cancellationService.cancelTransaction('missing-id', 'سبب'), /الحركة غير موجودة/);
});
