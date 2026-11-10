// Phase 4B.6 — Transaction Editing, Cancellation & Audit Trail (core).
// Every scenario runs against a real (fake-indexeddb) database through the real
// services: no financial service is ever stubbed, and the atomicity tests provoke a
// genuine storage failure rather than pretending one happened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from 'fake-indexeddb';
import { freshDatabase, simulateReload, closeDatabase, deleteDatabase, configureDatabase } from './helpers.js';
import { configureIndexedDB, openDatabase, runTransaction } from '../src/storage/db.js';
import { STORE, DB_VERSION } from '../src/storage/schema.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { transactionFormService } from '../src/services/transactionFormService.js';
import { transactionLifecycleService, AUDIT_EVENT_TYPE } from '../src/services/transactionLifecycleService.js';
import { balanceService } from '../src/services/balanceService.js';
import { paymentService } from '../src/services/paymentService.js';
import { debtTransferService } from '../src/services/debtTransferService.js';
import { auditLogRepository } from '../src/repositories/auditLogRepository.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { validateTransactionEdit } from '../src/validation/transactionValidation.js';
import { deriveFinancials } from '../src/domain/financialDirection.js';
import { TRANSACTION_TYPE, STATUS } from '../src/domain/transactionTypes.js';
import { logger } from '../src/utils/logger.js';

logger.disable?.();

const MONEY = 100;

async function seedCustomer({ code = 'C-900', name = 'مزارع دورة الحياة', opening = 1000 } = {}) {
  return customerService.createCustomer({ Code: code, Name: name, Phone: '0100000000', Region: 'طنطا', OpeningBalance: opening });
}

// A plain (non-crop) movement created through the approved creation service.
async function seedTransaction(customerId, { type = TRANSACTION_TYPE.SALE_PESTICIDES, amount = 300, date = '2026-09-01', description = 'حركة اختبار' } = {}) {
  return transactionService.createTransaction({ CustomerId: customerId, Date: date, TransactionType: type, Amount: amount, Description: description });
}

// A crop purchase created through the approved form service, so the amount is the
// one the core derives from the crop inputs.
async function seedCropPurchase(customerId, form = {}) {
  const result = await transactionFormService.submitTransactionForm({
    TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL,
    CustomerId: customerId,
    Date: '2026-09-02',
    Units: 10,
    LooseKg: 0,
    DeductionKg: 0,
    UnitPrice: 5,
    ...form
  });
  return result.Record;
}

async function seedSettlement(customerId, { amount = 200, direction = 'Credit', date = '2026-09-03' } = {}) {
  const result = await transactionFormService.submitTransactionForm({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customerId, Date: date, Amount: amount, Direction: direction
  });
  return result.Record;
}

// The form shape the edit dialog submits: raw human input keyed by the approved keys.
function editForm(overrides = {}) {
  return { Date: '2026-09-01', Description: 'وصف بعد التعديل', Amount: 450, EditReason: 'تصحيح مبلغ مسجل بالخطأ', ...overrides };
}

// ---------------------------------------------------------------------------
// 1-9 — editing a movement.
// ---------------------------------------------------------------------------

test('1 — the amount of an active movement can be edited', async () => {
  await freshDatabase('life_edit_amount');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id, { amount: 300 });

  const result = await transactionLifecycleService.editTransaction(record.Id, editForm({ Amount: 450 }));

  assert.equal(result.Record.AmountMinor, 450 * MONEY);
  assert.equal(result.Record.TransactionType, TRANSACTION_TYPE.SALE_PESTICIDES);
  const stored = await transactionRepository.getById(record.Id);
  assert.equal(stored.AmountMinor, 450 * MONEY);
});

test('2 — the date and the description can be edited', async () => {
  await freshDatabase('life_edit_date');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id, { date: '2026-09-01', description: 'قبل التعديل' });

  const result = await transactionLifecycleService.editTransaction(record.Id, editForm({ Date: '2026-09-20', Description: 'بعد التعديل', Amount: 300 }));

  assert.equal(result.Record.Date, '2026-09-20');
  assert.equal(result.Record.Description, 'بعد التعديل');
});

test('3 — the type-specific fields of a movement can be edited', async () => {
  await freshDatabase('life_edit_fields');
  const customer = await seedCustomer();
  const record = await seedCropPurchase(customer.Id);

  const result = await transactionLifecycleService.editTransaction(record.Id, editForm({
    Units: 20, LooseKg: 0, DeductionKg: 0, UnitPrice: 5, Date: '2026-09-02', Description: 'تعديل حقول المحصول'
  }));

  assert.equal(result.Record.LocalUnitsMilli, 20 * 1000);
  assert.equal(result.Record.LocalUnitPriceMinor, 5 * MONEY);
});

test('4 — the original Id is preserved and no second row is created', async () => {
  await freshDatabase('life_edit_id');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id, { amount: 300 });
  const before = await transactionRepository.count();

  const result = await transactionLifecycleService.editTransaction(record.Id, editForm({ Amount: 500 }));

  assert.equal(result.Record.Id, record.Id);
  assert.equal(await transactionRepository.count(), before, 'an edit must never add a row');
  assert.equal(result.Record.CreatedAt, record.CreatedAt, 'creation timestamp is preserved');
});

test('5 — the balance is recalculated from the full sequence after an edit', async () => {
  await freshDatabase('life_edit_balance');
  const customer = await seedCustomer({ opening: 1000 });
  const record = await seedTransaction(customer.Id, { amount: 300, type: TRANSACTION_TYPE.SALE_PESTICIDES });

  const beforeSummary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(beforeSummary.BalanceMinor, 1000 * MONEY - 300 * MONEY);

  await transactionLifecycleService.editTransaction(record.Id, editForm({ Amount: 450 }));

  const afterSummary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(afterSummary.BalanceMinor, 1000 * MONEY - 450 * MONEY);
  assert.equal(afterSummary.TotalDebitMinor, 450 * MONEY);
  const ledger = await balanceService.getRunningBalance(customer.Id);
  assert.equal(ledger.Entries[0].RunningBalanceMinor, 1000 * MONEY - 450 * MONEY);
});

test('6 — the audit event keeps the previous and the new values', async () => {
  await freshDatabase('life_edit_snapshot');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id, { amount: 300, description: 'قبل' });

  await transactionLifecycleService.editTransaction(record.Id, editForm({ Amount: 450, Description: 'بعد' }));

  const entries = await transactionLifecycleService.listAuditTrail(record.Id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].EventType, AUDIT_EVENT_TYPE.EDITED);
  assert.equal(entries[0].Previous.AmountMinor, 300 * MONEY);
  assert.equal(entries[0].Next.AmountMinor, 450 * MONEY);
  assert.equal(entries[0].Previous.Description, 'قبل');
  assert.equal(entries[0].Next.Description, 'بعد');
  assert.equal(entries[0].Previous.DebitMinor, 300 * MONEY);
  assert.equal(entries[0].Next.DebitMinor, 450 * MONEY);
});

test('7 — the edit reason is stored on the audit event', async () => {
  await freshDatabase('life_edit_reason');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id);

  await transactionLifecycleService.editTransaction(record.Id, editForm({ EditReason: 'تصحيح تاريخ التوريد' }));

  const entries = await transactionLifecycleService.listAuditTrail(record.Id);
  assert.equal(entries[0].Reason, 'تصحيح تاريخ التوريد');
  assert.ok(entries[0].OccurredAt, 'the event time is stored');
});

test('8 — the explicit Direction of Settlement and GoodsExchange is preserved', async () => {
  await freshDatabase('life_edit_direction');
  const customer = await seedCustomer({ opening: 5000 });
  const settlement = await seedSettlement(customer.Id, { amount: 200, direction: 'Credit' });

  const kept = await transactionLifecycleService.editTransaction(settlement.Id, editForm({ Amount: 250, Direction: 'Credit', Date: '2026-09-03' }));
  assert.equal(kept.Record.Direction, 'Credit');
  assert.equal(deriveFinancials(kept.Record).CreditMinor, 250 * MONEY);
  assert.equal(deriveFinancials(kept.Record).DebitMinor, 0);
  assert.equal(deriveFinancials(kept.Record).CashReceivedMinor, 0);

  const switched = await transactionLifecycleService.editTransaction(settlement.Id, editForm({ Amount: 250, Direction: 'Debit', Date: '2026-09-03' }));
  assert.equal(switched.Record.Direction, 'Debit');
  assert.equal(deriveFinancials(switched.Record).DebitMinor, 250 * MONEY);
  assert.equal(deriveFinancials(switched.Record).CreditMinor, 0);
  assert.equal(deriveFinancials(switched.Record).isCash, false);
});

test('9 — a crop purchase is recomputed from its source fields, never from an entered amount', async () => {
  await freshDatabase('life_edit_crop');
  const customer = await seedCustomer();
  const record = await seedCropPurchase(customer.Id);
  assert.equal(record.AmountMinor, 700 * MONEY, 'seed: 10 * (14 - 0) * 5 = 700.00');

  const result = await transactionLifecycleService.editTransaction(record.Id, editForm({
    Units: 20, LooseKg: 0, DeductionKg: 0, UnitPrice: 5,
    // An amount that must be ignored: the crop inputs are the only source.
    Amount: 999999, AmountMinor: 99999900,
    Date: '2026-09-02', Description: 'تعديل عبوات'
  }));

  assert.equal(result.Record.AmountMinor, 1400 * MONEY, '20 * (14 - 0) * 5 = 1400.00');
  const entries = await transactionLifecycleService.listAuditTrail(record.Id);
  assert.equal(entries[0].Next.AmountMinor, 1400 * MONEY);
  assert.equal(entries[0].Previous.AmountMinor, 700 * MONEY);
});

// ---------------------------------------------------------------------------
// 10-12 — refusals.
// ---------------------------------------------------------------------------

test('10 — derived financial values sent from the screen are refused, not stored', async () => {
  await freshDatabase('life_edit_derived');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id, { amount: 300 });

  const result = await transactionLifecycleService.editTransaction(record.Id, editForm({
    Amount: 300, CreditMinor: 777700, DebitMinor: 0, SettlementMinor: 5000, CashReceivedMinor: 5000, CashPaidMinor: 5000
  }));

  // The screen cannot inject a derived column: the row never stores one, and the
  // engine still derives the single approved side from the stored data.
  assert.equal(result.Record.CreditMinor, undefined, 'the row never stores a derived column');
  assert.equal(deriveFinancials(result.Record).CreditMinor, 0);
  assert.equal(deriveFinancials(result.Record).DebitMinor, 300 * MONEY);

  // The validator itself refuses a draft that carries a derived field, and the
  // service refuses it too instead of quietly dropping it.
  const direct = validateTransactionEdit({ ...editForm(), CreditMinor: 777700 }, record, { customerExists: true });
  assert.equal(direct.ok, false);
  assert.match(direct.errors[0].message, /مشتقة/);
  await assert.rejects(
    () => transactionLifecycleService.editTransaction(record.Id, { ...editForm(), CreditMinor: 777700 }, { validatedDraft: true }),
    /مشتقة/
  );
});

test('11 — an edit reason is mandatory', async () => {
  await freshDatabase('life_edit_no_reason');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id);

  await assert.rejects(
    () => transactionLifecycleService.editTransaction(record.Id, editForm({ EditReason: '   ' })),
    /سبب تعديل الحركة مطلوب/
  );
  const stored = await transactionRepository.getById(record.Id);
  assert.equal(stored.AmountMinor, 300 * MONEY, 'nothing was written');
  assert.equal((await transactionLifecycleService.listAuditTrail(record.Id)).length, 0);
});

test('12 — a cancelled movement cannot be edited', async () => {
  await freshDatabase('life_edit_cancelled');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id);
  await transactionLifecycleService.cancelTransaction(record.Id, 'سبب الإلغاء للاختبار', { confirmed: true });

  await assert.rejects(
    () => transactionLifecycleService.editTransaction(record.Id, editForm({ Amount: 900 })),
    /لا يمكن تعديل حركة ملغاة/
  );
  const stored = await transactionRepository.getById(record.Id);
  assert.equal(stored.AmountMinor, 300 * MONEY);
  assert.equal(stored.Status, STATUS.CANCELLED);
});

// ---------------------------------------------------------------------------
// 13-22 — cancellation.
// ---------------------------------------------------------------------------

test('13 — a cancellation without a reason is refused', async () => {
  await freshDatabase('life_cancel_no_reason');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id);

  await assert.rejects(
    () => transactionLifecycleService.cancelTransaction(record.Id, '  ', { confirmed: true }),
    /سبب إلغاء الحركة مطلوب/
  );
  const stored = await transactionRepository.getById(record.Id);
  assert.notEqual(stored.Status, STATUS.CANCELLED);
  assert.equal((await transactionLifecycleService.listAuditTrail(record.Id)).length, 0);
});

test('14 — a cancellation without explicit confirmation is refused', async () => {
  await freshDatabase('life_cancel_no_confirm');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id);

  await assert.rejects(
    () => transactionLifecycleService.cancelTransaction(record.Id, 'سبب واضح'),
    /تأكيدًا صريحًا/
  );
  await assert.rejects(
    () => transactionLifecycleService.cancelTransaction(record.Id, 'سبب واضح', { confirmed: false }),
    /تأكيدًا صريحًا/
  );
  const stored = await transactionRepository.getById(record.Id);
  assert.notEqual(stored.Status, STATUS.CANCELLED);
  assert.equal((await transactionLifecycleService.listAuditTrail(record.Id)).length, 0);
});

test('15/16 — an active movement is cancelled logically and the original row is retained', async () => {
  await freshDatabase('life_cancel_ok');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id, { amount: 300 });
  const countBefore = await transactionRepository.count();

  const result = await transactionLifecycleService.cancelTransaction(record.Id, 'فاتورة مكررة', { confirmed: true });

  assert.equal(result.Record.Status, STATUS.CANCELLED);
  assert.equal(await transactionRepository.count(), countBefore, 'the row is kept, not deleted');
  const stored = await transactionRepository.getById(record.Id);
  assert.equal(stored.Id, record.Id);
  assert.equal(stored.AmountMinor, 300 * MONEY, 'the original figures are untouched');
  assert.equal(stored.CancellationReason, 'فاتورة مكررة');
});

test('17 — the cancelled movement is excluded from the balance', async () => {
  await freshDatabase('life_cancel_balance');
  const customer = await seedCustomer({ opening: 1000 });
  const record = await seedTransaction(customer.Id, { amount: 300 });

  const before = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(before.BalanceMinor, 700 * MONEY);

  await transactionLifecycleService.cancelTransaction(record.Id, 'إلغاء لاختبار الرصيد', { confirmed: true });

  const after = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(after.BalanceMinor, 1000 * MONEY, 'the cancelled debit no longer reduces the balance');
  assert.equal(after.TotalDebitMinor, 0);
  const ledger = await balanceService.getRunningBalance(customer.Id);
  assert.equal(ledger.Entries.length, 1, 'the row stays visible in the statement');
  assert.equal(ledger.Entries[0].IsCancelled, true);
  assert.equal(ledger.Entries[0].RunningBalanceMinor, 1000 * MONEY);
});

test('18 — the cancelled movement is excluded from every total, cash included', async () => {
  await freshDatabase('life_cancel_totals');
  const customer = await seedCustomer({ opening: 0 });
  const cash = await seedTransaction(customer.Id, { type: TRANSACTION_TYPE.CASH_RECEIVED, amount: 500, date: '2026-09-01' });
  await seedTransaction(customer.Id, { type: TRANSACTION_TYPE.CASH_PAID, amount: 200, date: '2026-09-02' });

  const before = await paymentService.listCashMovements();
  assert.equal(paymentService.summarize(before).CashReceivedMinor, 500 * MONEY);

  await transactionLifecycleService.cancelTransaction(cash.Id, 'دفعة مسجلة بالخطأ', { confirmed: true });

  const after = await paymentService.listCashMovements();
  const totals = paymentService.summarize(after);
  assert.equal(totals.CashReceivedMinor, 0, 'the cancelled receipt leaves the cash totals');
  assert.equal(totals.CashPaidMinor, 200 * MONEY);
  assert.equal(totals.CancelledCount, 1);
  const portfolio = await balanceService.getPortfolioSummary();
  assert.equal(portfolio.CashReceivedMinor, 0);
});

test('19 — the cancellation reason and its time are stored', async () => {
  await freshDatabase('life_cancel_meta');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id);

  const result = await transactionLifecycleService.cancelTransaction(record.Id, 'خطأ في نوع الحركة', { confirmed: true });

  assert.equal(result.Record.CancellationReason, 'خطأ في نوع الحركة');
  assert.ok(result.Record.CancelledAt, 'a cancellation timestamp is stored');
  assert.equal(result.Record.CancelledAt, result.Record.UpdatedAt);
  const stored = await transactionRepository.getById(record.Id);
  assert.equal(stored.CancelledAt, result.Record.CancelledAt);
  const entries = await transactionLifecycleService.listAuditTrail(record.Id);
  assert.equal(entries[0].EventType, AUDIT_EVENT_TYPE.CANCELLED);
  assert.equal(entries[0].Reason, 'خطأ في نوع الحركة');
});

test('20 — cancelling the same movement twice is refused', async () => {
  await freshDatabase('life_cancel_twice');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id);
  await transactionLifecycleService.cancelTransaction(record.Id, 'الإلغاء الأول', { confirmed: true });

  await assert.rejects(
    () => transactionLifecycleService.cancelTransaction(record.Id, 'الإلغاء الثاني', { confirmed: true }),
    /ملغاة بالفعل/
  );
  const entries = await transactionLifecycleService.listAuditTrail(record.Id);
  assert.equal(entries.length, 1, 'no second cancellation event');
  assert.equal(entries[0].Reason, 'الإلغاء الأول');
});

test('21 — the cancellation path contains no physical delete', async () => {
  await freshDatabase('life_no_delete');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id);
  await transactionLifecycleService.cancelTransaction(record.Id, 'سبب', { confirmed: true });

  assert.equal(typeof transactionLifecycleService.deleteTransaction, 'undefined');
  assert.equal(typeof transactionRepository.delete, 'undefined');
  assert.equal(typeof transactionRepository.remove, 'undefined');
  const all = await transactionRepository.getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].Status, STATUS.CANCELLED);
});

// ---------------------------------------------------------------------------
// 23-32 — audit trail and atomicity.
// ---------------------------------------------------------------------------

test('23 — every edit appends its own audit event', async () => {
  await freshDatabase('life_audit_each');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id, { amount: 100 });

  await transactionLifecycleService.editTransaction(record.Id, editForm({ Amount: 200, EditReason: 'التعديل الأول' }));
  await transactionLifecycleService.editTransaction(record.Id, editForm({ Amount: 300, EditReason: 'التعديل الثاني' }));

  const entries = await transactionLifecycleService.listAuditTrail(record.Id);
  assert.equal(entries.length, 2, 'two edits -> two independent events');
  assert.equal(entries[0].Reason, 'التعديل الأول');
  assert.equal(entries[1].Reason, 'التعديل الثاني');
  assert.equal(entries[0].Next.AmountMinor, 200 * MONEY);
  assert.equal(entries[1].Previous.AmountMinor, 200 * MONEY);
  assert.equal(entries[1].Next.AmountMinor, 300 * MONEY);
  assert.notEqual(entries[0].Id, entries[1].Id);
});

test('24 — the audit trail records the cancellation event', async () => {
  await freshDatabase('life_audit_cancel');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id, { amount: 100 });

  await transactionLifecycleService.cancelTransaction(record.Id, 'إلغاء موثق', { confirmed: true });

  const entries = await transactionLifecycleService.listAuditTrail(record.Id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].EventType, AUDIT_EVENT_TYPE.CANCELLED);
  assert.equal(entries[0].Next, null, 'a cancellation has no "after" snapshot');
  assert.equal(entries[0].Previous.AmountMinor, 100 * MONEY);
  assert.equal(entries[0].Previous.Status, STATUS.ACTIVE);
});

test('25 — the audit trail cannot be rewritten or erased through the data layer', async () => {
  await freshDatabase('life_audit_immutable');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id);
  await transactionLifecycleService.editTransaction(record.Id, editForm({ Amount: 200 }));

  // No single-entry overwrite and no single-entry removal exists at all.
  assert.equal(typeof auditLogRepository.put, 'undefined');
  assert.equal(typeof auditLogRepository.remove, 'undefined');
  assert.equal(typeof auditLogRepository.delete, 'undefined');
  assert.equal(typeof transactionLifecycleService.deleteAuditEntry, 'undefined');
  assert.equal(typeof transactionLifecycleService.updateAuditEntry, 'undefined');

  // Appending a duplicate key is refused by storage, so an existing event is safe.
  const existing = (await auditLogRepository.getAll())[0];
  await assert.rejects(() => auditLogRepository.add(existing), /مكررة|تخزين/);
  const after = await auditLogRepository.getAll();
  assert.equal(after.length, 1);
  assert.equal(after[0].Reason, existing.Reason);
});

test('26/27 — the snapshot is structured and carries the direction of the movement', async () => {
  await freshDatabase('life_audit_snapshot');
  const customer = await seedCustomer({ opening: 5000 });
  const settlement = await seedSettlement(customer.Id, { amount: 200, direction: 'Debit' });

  await transactionLifecycleService.editTransaction(settlement.Id, editForm({
    Amount: 260, Direction: 'Credit', Date: '2026-09-03', EditReason: 'تصحيح اتجاه التسوية'
  }));

  const entry = (await transactionLifecycleService.listAuditTrail(settlement.Id))[0];
  assert.equal(entry.Previous.TransactionType, TRANSACTION_TYPE.SETTLEMENT);
  assert.equal(entry.Previous.CustomerId, customer.Id);
  assert.equal(entry.Previous.Direction, 'Debit');
  assert.equal(entry.Previous.DebitMinor, 200 * MONEY);
  assert.equal(entry.Previous.CreditMinor, 0);
  assert.equal(entry.Next.Direction, 'Credit');
  assert.equal(entry.Next.CreditMinor, 260 * MONEY);
  assert.equal(entry.Next.DebitMinor, 0);
  assert.equal(entry.Next.CashReceivedMinor, 0);
  assert.equal(entry.Next.CashPaidMinor, 0);
  assert.equal(entry.Previous.CashReceivedMinor, 0);
  // The snapshot is structured, not a free-text note.
  assert.equal(typeof entry.Previous, 'object');
  assert.equal(entry.Previous.Date, '2026-09-03');
});

test('28 — the edit and its audit event are both written', async () => {
  await freshDatabase('life_atomic_ok');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id, { amount: 100 });

  const result = await transactionLifecycleService.editTransaction(record.Id, editForm({ Amount: 250 }));

  const stored = await transactionRepository.getById(record.Id);
  assert.equal(stored.AmountMinor, 250 * MONEY);
  assert.equal(await auditLogRepository.count(), 1);
  assert.equal((await auditLogRepository.getById(result.AuditEntry.Id)).TransactionId, record.Id);
});

test('29 — a failed audit write rolls the whole edit back (no half-applied change)', async () => {
  await freshDatabase('life_atomic_audit_fail');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id, { amount: 100, description: 'قبل الفشل' });
  const first = await transactionLifecycleService.editTransaction(record.Id, editForm({ Amount: 150 }));
  const before = await transactionRepository.getById(record.Id);

  // A real storage failure: the audit key already exists, so `add` is rejected by
  // the unique key path and the shared transaction aborts.
  await assert.rejects(
    () => transactionLifecycleService.editTransaction(record.Id, editForm({ Amount: 900 }), { auditEntryId: first.AuditEntry.Id }),
    /تعذر حفظ/
  );

  const after = await transactionRepository.getById(record.Id);
  assert.equal(after.AmountMinor, before.AmountMinor, 'the movement kept its previous value');
  assert.equal(after.Description, before.Description);
  assert.equal(after.UpdatedAt, before.UpdatedAt);
  assert.equal(await auditLogRepository.count(), 1, 'no orphan audit event was left behind');
});

test('29b — a failed audit write rolls a cancellation back as well', async () => {
  await freshDatabase('life_atomic_cancel_fail');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id, { amount: 100 });
  const first = await transactionLifecycleService.editTransaction(record.Id, editForm({ Amount: 150 }));

  await assert.rejects(
    () => transactionLifecycleService.cancelTransaction(record.Id, 'إلغاء سيفشل', { confirmed: true, auditEntryId: first.AuditEntry.Id }),
    /تعذر حفظ/
  );

  const stored = await transactionRepository.getById(record.Id);
  assert.notEqual(stored.Status, STATUS.CANCELLED, 'the cancellation was rolled back');
  assert.equal(stored.CancellationReason, null);
  assert.equal(await auditLogRepository.count(), 1);
});

test('30 — a failing movement write leaves no audit event behind', async () => {
  await freshDatabase('life_atomic_tx_fail');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id, { amount: 100 });
  const before = await transactionRepository.getById(record.Id);

  // The record cannot be structurally cloned, so the very first write of the shared
  // transaction fails; nothing may be committed from the second store either.
  const poisoned = { ...before, Id: before.Id, AmountMinor: 999 * MONEY, Broken: () => true };
  await assert.rejects(() => transactionLifecycleService.writeWithAudit({
    record: poisoned,
    entry: { Id: 'aud-poison', TransactionId: before.Id, EventType: AUDIT_EVENT_TYPE.EDITED, OccurredAt: '2026-10-12T00:00:00.000Z', Reason: 'اختبار الذرية', Previous: null, Next: null, ActorId: null, CreatedAt: '2026-10-12T00:00:00.000Z', Status: 'Active' }
  }));

  assert.equal(await auditLogRepository.count(), 0, 'no orphan audit event');
  const after = await transactionRepository.getById(record.Id);
  assert.equal(after.AmountMinor, before.AmountMinor);
});

test('31 — the audit trail survives an application reload', async () => {
  await freshDatabase('life_audit_reload');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id, { amount: 100 });
  await transactionLifecycleService.editTransaction(record.Id, editForm({ Amount: 200, EditReason: 'قبل إعادة التحميل' }));

  await simulateReload();

  const entries = await transactionLifecycleService.listAuditTrail(record.Id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].Reason, 'قبل إعادة التحميل');
  assert.equal(entries[0].Next.AmountMinor, 200 * MONEY);
});

test('32 — the audit trail stays correct after the database is closed and reopened', async () => {
  await freshDatabase('life_audit_reopen');
  const customer = await seedCustomer();
  const record = await seedTransaction(customer.Id, { amount: 100 });
  await transactionLifecycleService.editTransaction(record.Id, editForm({ Amount: 200, EditReason: 'تعديل أول' }));
  await transactionLifecycleService.editTransaction(record.Id, editForm({ Amount: 300, EditReason: 'تعديل ثانٍ' }));

  await closeDatabase();
  await openDatabase();

  const entries = await transactionLifecycleService.listAuditTrail(record.Id);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].Reason, 'تعديل أول');
  assert.equal(entries[1].Reason, 'تعديل ثانٍ');
  const stored = await transactionRepository.getById(record.Id);
  assert.equal(stored.AmountMinor, 300 * MONEY);
  assert.equal(deriveFinancials(stored).DebitMinor, 300 * MONEY);
});

// ---------------------------------------------------------------------------
// 33-35 — the linked operation (DebtTransfer).
// ---------------------------------------------------------------------------

async function seedDebtTransfer() {
  const from = await seedCustomer({ code: 'C-901', name: 'عميل دائن', opening: 5000 });
  const to = await seedCustomer({ code: 'C-902', name: 'عميل مدين', opening: 0 });
  const transfer = await debtTransferService.createDebtTransfer({
    FromCustomerId: from.Id, ToCustomerId: to.Id, Amount: 400, Date: '2026-09-05', Description: 'تحويل مديونية'
  });
  return { from, to, transfer };
}

test('33 — editing one leg of a debt transfer is blocked', async () => {
  await freshDatabase('life_link_edit');
  const { transfer } = await seedDebtTransfer();
  const leg = transfer.CreditRow;

  const editability = await transactionLifecycleService.getEditability(leg.Id);
  assert.equal(editability.CanEdit, false);
  assert.match(editability.EditReason, /مرتبطة/);

  await assert.rejects(
    () => transactionLifecycleService.editTransaction(leg.Id, editForm({ Amount: 999 })),
    /مرتبطة بحركة أخرى/
  );
  const stored = await transactionRepository.getById(leg.Id);
  assert.equal(stored.AmountMinor, 400 * MONEY);
  assert.equal(await auditLogRepository.count(), 0);
});

test('34 — cancelling one leg of a debt transfer is blocked', async () => {
  await freshDatabase('life_link_cancel');
  const { transfer } = await seedDebtTransfer();
  const leg = transfer.DebitRow;

  const editability = await transactionLifecycleService.getEditability(leg.Id);
  assert.equal(editability.CanCancel, false);
  assert.match(editability.CancelReason, /مرتبطة/);

  await assert.rejects(
    () => transactionLifecycleService.cancelTransaction(leg.Id, 'محاولة إلغاء طرف واحد', { confirmed: true }),
    /مرتبطة بحركة أخرى/
  );
  const stored = await transactionRepository.getById(leg.Id);
  assert.notEqual(stored.Status, STATUS.CANCELLED);
  assert.equal(await auditLogRepository.count(), 0);
});

test('35 — both legs of a debt transfer stay consistent', async () => {
  await freshDatabase('life_link_consistency');
  const { from, to, transfer } = await seedDebtTransfer();

  const rows = await transactionRepository.listByLinkId(transfer.LinkId);
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.LinkId)).size, 1);
  assert.equal(new Set(rows.map((row) => row.Date)).size, 1);
  assert.equal(new Set(rows.map((row) => row.AmountMinor)).size, 1);
  assert.equal(new Set(rows.map((row) => row.Description)).size, 1);
  assert.deepEqual(rows.map((row) => row.TransferRole).sort(), ['CreditSide', 'DebitSide']);
  assert.equal(rows.every((row) => row.Status === STATUS.ACTIVE), true);

  const fromSummary = await balanceService.getCustomerSummary(from.Id);
  const toSummary = await balanceService.getCustomerSummary(to.Id);
  assert.equal(fromSummary.BalanceMinor, 5000 * MONEY + 400 * MONEY, 'the credit side gains the amount');
  assert.equal(toSummary.BalanceMinor, -400 * MONEY, 'the debit side owes the amount');
  assert.equal(fromSummary.CashReceivedMinor + toSummary.CashReceivedMinor, 0, 'a transfer never moves cash');
  assert.equal(fromSummary.CashPaidMinor + toSummary.CashPaidMinor, 0);
});

// ---------------------------------------------------------------------------
// 36-39 — regression against the approved rules.
// ---------------------------------------------------------------------------

test('36 — cash totals are unaffected by non-cash settlements', async () => {
  await freshDatabase('life_reg_cash');
  const customer = await seedCustomer({ opening: 0 });
  await seedSettlement(customer.Id, { amount: 700 });
  await seedTransaction(customer.Id, { type: TRANSACTION_TYPE.CASH_RECEIVED, amount: 100 });

  const movements = await paymentService.listCashMovements();
  assert.equal(movements.length, 1, 'the settlement never appears as a cash movement');
  const totals = paymentService.summarize(movements);
  assert.equal(totals.CashReceivedMinor, 100 * MONEY);
  assert.equal(totals.CashPaidMinor, 0);
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.NonCashSettlementMinor, 700 * MONEY);
  assert.equal(summary.CashReceivedMinor, 100 * MONEY);
});

test('37 — totals stay correct after a non-cash edit and a cash cancellation', async () => {
  await freshDatabase('life_reg_totals');
  const customer = await seedCustomer({ opening: 0 });
  const settlement = await seedSettlement(customer.Id, { amount: 300 });
  const cash = await seedTransaction(customer.Id, { type: TRANSACTION_TYPE.CASH_RECEIVED, amount: 100 });

  await transactionLifecycleService.editTransaction(settlement.Id, editForm({ Amount: 900, Direction: 'Credit', Date: '2026-09-03' }));
  await transactionLifecycleService.cancelTransaction(cash.Id, 'قيد خاطئ', { confirmed: true });

  const totals = paymentService.summarize(await paymentService.listCashMovements());
  assert.equal(totals.CashReceivedMinor, 0, 'the non-cash edit never entered the cash totals');
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.NonCashSettlementMinor, 900 * MONEY);
  assert.equal(summary.CashReceivedMinor, 0);
  assert.equal(summary.BalanceMinor, 900 * MONEY, 'balance = opening + credits - debits');
});

test('38 — the statement stays correct when filters are applied', async () => {
  await freshDatabase('life_reg_filters');
  const customer = await seedCustomer({ opening: 1000 });
  await seedTransaction(customer.Id, { type: TRANSACTION_TYPE.SALE_PESTICIDES, amount: 200, date: '2026-09-01' });
  await seedSettlement(customer.Id, { amount: 300, date: '2026-09-02' });
  const cash = await seedTransaction(customer.Id, { type: TRANSACTION_TYPE.CASH_RECEIVED, amount: 100, date: '2026-09-03' });
  await transactionLifecycleService.cancelTransaction(cash.Id, 'إلغاء للاختبار', { confirmed: true });

  const ledger = await balanceService.getRunningBalance(customer.Id);
  assert.equal(ledger.Entries.length, 3);
  const finalRunning = ledger.Entries[ledger.Entries.length - 1].RunningBalanceMinor;
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(finalRunning, summary.BalanceMinor, 'the last running balance equals the summary');

  // Filtering only hides rows: each shown row keeps the running balance of the full sequence.
  const { visibleLedger, defaultLedgerCriteria } = await import('../ui/views/customerAccount.js');
  const visible = visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), filter: 'cancelled' });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].Id, cash.Id);
  assert.equal(visible[0].RunningBalanceMinor, ledger.Entries[2].RunningBalanceMinor);
});

test('39 — legacy movements without a Direction are read as Credit and stay editable', async () => {
  await freshDatabase('life_reg_legacy');
  const customer = await seedCustomer({ opening: 0 });
  const record = await seedSettlement(customer.Id, { amount: 250, direction: 'Credit' });

  // Simulate a row written by the previous release: no Direction property at all.
  const legacy = { ...record };
  delete legacy.Direction;
  await runTransaction(STORE.TRANSACTIONS, 'readwrite', (stores) => new Promise((resolve, reject) => {
    const request = stores[STORE.TRANSACTIONS].put(legacy);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  }));

  const stored = await transactionRepository.getById(record.Id);
  assert.equal('Direction' in stored, false, 'the stored data was not rewritten');
  assert.equal(deriveFinancials(stored).direction, 'Credit');
  assert.equal(deriveFinancials(stored).CreditMinor, 250 * MONEY);

  const editability = await transactionLifecycleService.getEditability(record.Id);
  assert.equal(editability.CanEdit, true, 'a legacy row is still editable');
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.BalanceMinor, 250 * MONEY);
});

// ---------------------------------------------------------------------------
// 41 — the additive schema upgrade over real data of the previous version.
// ---------------------------------------------------------------------------

test('41 — a version 1 database upgrades to the current version without losing data', async () => {
  configureIndexedDB({ indexedDB: fakeIndexedDB, IDBKeyRange: fakeIDBKeyRange });
  const name = 'ca_legacy_upgrade';
  configureDatabase({ name, version: 1 });
  await deleteDatabase();
  await closeDatabase();

  // A database exactly as the previous release left it: the five version 1 stores,
  // no auditLog store, one customer and one settlement without a Direction.
  const v1 = await new Promise((resolve, reject) => {
    const request = fakeIndexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const customers = db.createObjectStore('customers', { keyPath: 'Id' });
      customers.createIndex('code', 'Code', { unique: true });
      customers.createIndex('name', 'Name');
      customers.createIndex('phone', 'Phone');
      const transactions = db.createObjectStore('transactions', { keyPath: 'Id' });
      transactions.createIndex('customerId', 'CustomerId');
      transactions.createIndex('date', 'Date');
      transactions.createIndex('transactionType', 'TransactionType');
      transactions.createIndex('status', 'Status');
      transactions.createIndex('linkId', 'LinkId');
      transactions.createIndex('customerId_date', ['CustomerId', 'Date']);
      const opening = db.createObjectStore('openingBalanceHistory', { keyPath: 'Id' });
      opening.createIndex('customerId', 'CustomerId');
      opening.createIndex('changedAt', 'ChangedAt');
      db.createObjectStore('settings', { keyPath: 'Key' });
      db.createObjectStore('metadata', { keyPath: 'Key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  assert.equal(v1.version, 1);
  assert.equal(Array.from(v1.objectStoreNames).includes(STORE.AUDIT_LOG), false, 'the legacy schema has no audit store');
  await new Promise((resolve, reject) => {
    const tx = v1.transaction(['customers', 'transactions'], 'readwrite');
    tx.objectStore('customers').put({
      Id: 'cus-legacy', Code: 'C-950', Name: 'عميل قديم', Phone: null, Region: 'أسيوط', Notes: null,
      OpeningBalanceMinor: 1000 * MONEY, IsActive: true, Source: 'Manual',
      CreatedAt: '2026-08-01T00:00:00.000Z', UpdatedAt: '2026-08-01T00:00:00.000Z'
    });
    tx.objectStore('transactions').put({
      Id: 'trx-legacy', CustomerId: 'cus-legacy', Date: '2026-08-02', TransactionType: TRANSACTION_TYPE.SETTLEMENT,
      Description: 'تسوية قديمة', AmountMinor: 200 * MONEY, Status: STATUS.ACTIVE,
      CancellationReason: null, CancelledAt: null,
      CreatedAt: '2026-08-02T00:00:00.000Z', UpdatedAt: '2026-08-02T00:00:00.000Z'
    });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
  v1.close();

  // Reopen with the new release: the upgrade is additive only.
  configureDatabase({ name, version: DB_VERSION });
  const v2 = await openDatabase();
  // The reopen applies every additive step at once (v1 -> v2 audit trail -> v3 the two
  // reference catalogues). The legacy row written above must survive all of them.
  assert.equal(v2.version, DB_VERSION);
  const stores = Array.from(v2.objectStoreNames);
  for (const expected of ['customers', 'transactions', 'openingBalanceHistory', 'settings', 'metadata', STORE.AUDIT_LOG, STORE.RECEIVING_COMPANIES, STORE.CARTON_TYPES]) {
    assert.equal(stores.includes(expected), true, `store ${expected} must exist`);
  }

  const customer = await customerService.getCustomer('cus-legacy');
  assert.equal(customer.Code, 'C-950');
  assert.equal(customer.OpeningBalanceMinor, 1000 * MONEY);
  const legacy = await transactionRepository.getById('trx-legacy');
  assert.equal(legacy.AmountMinor, 200 * MONEY);
  assert.equal('Direction' in legacy, false, 'legacy rows keep their stored shape');
  assert.equal(deriveFinancials(legacy).direction, 'Credit', 'a legacy row is read as Credit');
  assert.equal(await auditLogRepository.count(), 0);

  // The upgraded database accepts the new lifecycle operations.
  const edited = await transactionLifecycleService.editTransaction('trx-legacy', editForm({
    Amount: 260, Direction: 'Credit', Date: '2026-08-02', EditReason: 'تعديل بعد الترقية'
  }));
  assert.equal(edited.Record.AmountMinor, 260 * MONEY);
  assert.equal(edited.Record.Direction, 'Credit');
  assert.equal(await auditLogRepository.count(), 1);
  const summary = await balanceService.getCustomerSummary('cus-legacy');
  assert.equal(summary.BalanceMinor, 1000 * MONEY + 260 * MONEY);
});
