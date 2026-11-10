// Phase 4B.6 — Direction preservation on the EDIT path (fix only).
//
// A stored Debit on Settlement / GoodsExchange must survive any edit that does not
// state a Direction. Only an explicit, valid value may change the stored direction.
// Nothing here changes a financial rule: the derived columns still come from
// deriveFinancials() and every balance still comes from balanceService.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, simulateReload } from './helpers.js';
import { runTransaction } from '../src/storage/db.js';
import { STORE } from '../src/storage/schema.js';
import { customerService } from '../src/services/customerService.js';
import { transactionFormService } from '../src/services/transactionFormService.js';
import { transactionLifecycleService } from '../src/services/transactionLifecycleService.js';
import { balanceService } from '../src/services/balanceService.js';
import { debtTransferService } from '../src/services/debtTransferService.js';
import { auditLogRepository } from '../src/repositories/auditLogRepository.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { validateTransactionEdit, validateTransactionDraft } from '../src/validation/transactionValidation.js';
import { deriveFinancials } from '../src/domain/financialDirection.js';
import { TRANSACTION_TYPE, STATUS } from '../src/domain/transactionTypes.js';
import { logger } from '../src/utils/logger.js';

logger.disable?.();

const MONEY = 100;

async function seedCustomer({ code = 'C-960', opening = 5000 } = {}) {
  return customerService.createCustomer({ Code: code, Name: 'مزارع الاتجاه', Phone: '0100000001', Region: 'طنطا', OpeningBalance: opening });
}

async function seedDirectional(customerId, { type = TRANSACTION_TYPE.SETTLEMENT, amount = 200, direction = 'Debit', date = '2026-09-03' } = {}) {
  const result = await transactionFormService.submitTransactionForm({
    TransactionType: type, CustomerId: customerId, Date: date, Amount: amount, Direction: direction, Description: 'حركة اتجاه'
  });
  return result.Record;
}

// The edit form exactly as the dialog builds it: raw keys, and NO Direction key at all
// unless the user actually stated one.
function editForm(overrides = {}) {
  return { Date: '2026-09-03', Description: 'بعد التعديل', Amount: 200, EditReason: 'تصحيح مدخل', ...overrides };
}

// Writes a row in the shape the previous release left it: no Direction property at all.
async function stripDirection(record) {
  const legacy = { ...record };
  delete legacy.Direction;
  await runTransaction(STORE.TRANSACTIONS, 'readwrite', (stores) => new Promise((resolve, reject) => {
    const request = stores[STORE.TRANSACTIONS].put(legacy);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  }));
  return legacy;
}

// ---------------------------------------------------------------------------
// 1-2 — a stored Debit survives an edit that states no direction.
// ---------------------------------------------------------------------------

test('1 — editing the description of a stored Debit Settlement without stating a Direction keeps Debit', async () => {
  await freshDatabase('dir_keep_debit_desc');
  const customer = await seedCustomer();
  const settlement = await seedDirectional(customer.Id, { direction: 'Debit', amount: 200 });
  assert.equal(settlement.Direction, 'Debit', 'seed: the direction was persisted at creation');

  const result = await transactionLifecycleService.editTransaction(settlement.Id, {
    Date: '2026-09-03', Description: 'وصف جديد فقط', Amount: 200, EditReason: 'تصحيح الوصف'
  });

  assert.equal(result.Record.Direction, 'Debit', 'an omitted field must not flip Debit to Credit');
  const stored = await transactionRepository.getById(settlement.Id);
  assert.equal(stored.Direction, 'Debit');
  const financials = deriveFinancials(stored);
  assert.equal(financials.direction, 'Debit');
  assert.equal(financials.DebitMinor, 200 * MONEY);
  assert.equal(financials.CreditMinor, 0);

  // The validator itself resolves the omitted value to the stored one.
  const direct = validateTransactionEdit(
    { Date: '2026-09-03', Amount: 200, EditReason: 'تصحيح الوصف' }, settlement, { customerExists: true }
  );
  assert.equal(direct.ok, true);
  assert.equal(direct.data.Direction, 'Debit');
});

test('2 — editing the date and the amount of a stored Debit Settlement without stating a Direction keeps Debit', async () => {
  await freshDatabase('dir_keep_debit_amount');
  const customer = await seedCustomer({ opening: 5000 });
  const settlement = await seedDirectional(customer.Id, { direction: 'Debit', amount: 200 });

  const result = await transactionLifecycleService.editTransaction(settlement.Id, editForm({ Date: '2026-09-07', Amount: 350 }));

  assert.equal(result.Record.Date, '2026-09-07');
  assert.equal(result.Record.AmountMinor, 350 * MONEY);
  assert.equal(result.Record.Direction, 'Debit', 'the amount/date edit never changes the side');
  const financials = deriveFinancials(result.Record);
  assert.equal(financials.DebitMinor, 350 * MONEY);
  assert.equal(financials.CreditMinor, 0);
  assert.equal(financials.CashReceivedMinor, 0);
  assert.equal(financials.CashPaidMinor, 0);
  assert.equal(financials.isNonCash, true);
  assert.equal(financials.SettlementMinor, 350 * MONEY, 'the non-cash bucket keeps its approved meaning');
});

// ---------------------------------------------------------------------------
// 3-4 — the same behaviour on GoodsExchange, and an explicit value still wins.
// ---------------------------------------------------------------------------

test('3 — GoodsExchange keeps its stored direction on an edit that states none', async () => {
  await freshDatabase('dir_keep_goods_exchange');
  const customer = await seedCustomer({ opening: 5000 });
  const debit = await seedDirectional(customer.Id, { type: TRANSACTION_TYPE.GOODS_EXCHANGE, direction: 'Debit', amount: 150 });
  const credit = await seedDirectional(customer.Id, { type: TRANSACTION_TYPE.GOODS_EXCHANGE, direction: 'Credit', amount: 150 });

  const keptDebit = await transactionLifecycleService.editTransaction(debit.Id, editForm({ Amount: 175 }));
  assert.equal(keptDebit.Record.Direction, 'Debit');
  assert.equal(deriveFinancials(keptDebit.Record).DebitMinor, 175 * MONEY);
  assert.equal(deriveFinancials(keptDebit.Record).CreditMinor, 0);

  const keptCredit = await transactionLifecycleService.editTransaction(credit.Id, editForm({ Amount: 175 }));
  assert.equal(keptCredit.Record.Direction, 'Credit');
  assert.equal(deriveFinancials(keptCredit.Record).CreditMinor, 175 * MONEY);
  assert.equal(deriveFinancials(keptCredit.Record).DebitMinor, 0);
});

test('4 — an explicit valid Direction is still applied as the approved behaviour allows', async () => {
  await freshDatabase('dir_explicit_wins');
  const customer = await seedCustomer({ opening: 5000 });
  const settlement = await seedDirectional(customer.Id, { direction: 'Debit', amount: 200 });

  const switched = await transactionLifecycleService.editTransaction(settlement.Id, editForm({ Amount: 260, Direction: 'Credit' }));
  assert.equal(switched.Record.Direction, 'Credit');
  assert.equal(deriveFinancials(switched.Record).CreditMinor, 260 * MONEY);
  assert.equal(deriveFinancials(switched.Record).DebitMinor, 0);

  // And back again, explicitly.
  const back = await transactionLifecycleService.editTransaction(settlement.Id, editForm({ Amount: 260, Direction: 'Debit' }));
  assert.equal(back.Record.Direction, 'Debit');
  assert.equal(deriveFinancials(back.Record).DebitMinor, 260 * MONEY);
});

// ---------------------------------------------------------------------------
// 5 — an invalid value never slips past validation.
// ---------------------------------------------------------------------------

test('5 — an invalid explicit Direction is refused and nothing is written', async () => {
  await freshDatabase('dir_invalid_refused');
  const customer = await seedCustomer({ opening: 5000 });
  const settlement = await seedDirectional(customer.Id, { direction: 'Debit', amount: 200 });
  const before = await transactionRepository.getById(settlement.Id);

  await assert.rejects(
    () => transactionLifecycleService.editTransaction(settlement.Id, editForm({ Amount: 900, Direction: 'Sideways' })),
    /اتجاه الحركة غير صالح/
  );

  const after = await transactionRepository.getById(settlement.Id);
  assert.equal(after.AmountMinor, before.AmountMinor);
  assert.equal(after.Direction, 'Debit', 'the stored direction is untouched by a refused edit');
  assert.equal(await auditLogRepository.count(), 0);

  // A direction is still refused outright on a type that has no direction field.
  const other = validateTransactionDraft(
    { CustomerId: customer.Id, Date: '2026-09-03', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 100, Direction: 'Credit' },
    { customerExists: true }
  );
  assert.equal(other.ok, false);
  assert.match(other.errors[0].message, /الاتجاه مسموح فقط/);
});

// ---------------------------------------------------------------------------
// 6 — legacy compatibility: no direction stored, read as Credit, never rewritten to Credit.
// ---------------------------------------------------------------------------

test('6 — a legacy row without a Direction stays legacy after an edit that states none, and is read as Credit', async () => {
  await freshDatabase('dir_legacy_compat');
  const customer = await seedCustomer({ opening: 1000 });
  const settlement = await seedDirectional(customer.Id, { direction: 'Credit', amount: 250 });
  await stripDirection(settlement);

  const legacy = await transactionRepository.getById(settlement.Id);
  assert.equal('Direction' in legacy, false, 'the previous-release shape is intact');
  assert.equal(deriveFinancials(legacy).direction, 'Credit', 'a legacy row is still read as Credit');
  assert.equal(deriveFinancials(legacy).CreditMinor, 250 * MONEY);

  const result = await transactionLifecycleService.editTransaction(settlement.Id, editForm({ Amount: 250, Description: 'تعديل سطر قديم' }));

  assert.equal(result.Record.Direction, null, 'no Credit is written back onto the old row');
  assert.notEqual(result.Record.Direction, 'Credit');
  const stored = await transactionRepository.getById(settlement.Id);
  assert.equal(stored.Direction, null);
  assert.equal(deriveFinancials(stored).direction, 'Credit');
  assert.equal(deriveFinancials(stored).CreditMinor, 250 * MONEY);

  // The validator reports the legacy default only at derivation time.
  const direct = validateTransactionEdit(
    { Date: '2026-09-03', Amount: 250, EditReason: 'سبب' }, legacy, { customerExists: true }
  );
  assert.equal(direct.ok, true);
  assert.equal(direct.data.Direction, null);
  assert.equal(deriveFinancials({ ...legacy, ...direct.data }).direction, 'Credit');
});

// ---------------------------------------------------------------------------
// 7-9 — audit entry, balance and persistence after a direction-preserving edit.
// ---------------------------------------------------------------------------

test('7 — the audit event records the preserved direction and the derived columns', async () => {
  await freshDatabase('dir_audit_preserved');
  const customer = await seedCustomer({ opening: 5000 });
  const settlement = await seedDirectional(customer.Id, { direction: 'Debit', amount: 200 });

  await transactionLifecycleService.editTransaction(settlement.Id, editForm({ Amount: 260, EditReason: 'تصحيح مبلغ التسوية' }));

  const entry = (await transactionLifecycleService.listAuditTrail(settlement.Id))[0];
  assert.equal(entry.Reason, 'تصحيح مبلغ التسوية');
  assert.equal(entry.Previous.Direction, 'Debit');
  assert.equal(entry.Previous.DebitMinor, 200 * MONEY);
  assert.equal(entry.Previous.CreditMinor, 0);
  assert.equal(entry.Next.Direction, 'Debit', 'the snapshot shows the direction was kept');
  assert.equal(entry.Next.DebitMinor, 260 * MONEY);
  assert.equal(entry.Next.CreditMinor, 0);
  assert.equal(entry.Next.CashReceivedMinor, 0);
  assert.equal(entry.Next.CashPaidMinor, 0);
  assert.equal(entry.Next.SettlementMinor, 260 * MONEY);
});

test('8 — the balance after a direction-preserving edit follows Balance = Opening + Credits - Debits', async () => {
  await freshDatabase('dir_balance_after_edit');
  const customer = await seedCustomer({ opening: 5000 });
  const settlement = await seedDirectional(customer.Id, { direction: 'Debit', amount: 200 });

  const before = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(before.BalanceMinor, 5000 * MONEY - 200 * MONEY);

  await transactionLifecycleService.editTransaction(settlement.Id, editForm({ Amount: 300 }));

  const after = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(after.BalanceMinor, 5000 * MONEY - 300 * MONEY, 'the debit side grew, it did not flip to credit');
  assert.equal(after.TotalDebitMinor, 300 * MONEY);
  assert.equal(after.TotalCreditMinor, 0);
  assert.equal(after.NonCashSettlementMinor, 300 * MONEY);
  assert.equal(after.CashReceivedMinor, 0);
  assert.equal(after.CashPaidMinor, 0);
});

test('9 — the preserved direction survives an application reload', async () => {
  await freshDatabase('dir_survives_reload');
  const customer = await seedCustomer({ opening: 5000 });
  const settlement = await seedDirectional(customer.Id, { direction: 'Debit', amount: 200 });

  await transactionLifecycleService.editTransaction(settlement.Id, editForm({ Amount: 250 }));
  await simulateReload();

  const stored = await transactionRepository.getById(settlement.Id);
  assert.equal(stored.Direction, 'Debit', 'the direction is a persisted statement, not a screen value');
  assert.equal(deriveFinancials(stored).DebitMinor, 250 * MONEY);
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.BalanceMinor, 5000 * MONEY - 250 * MONEY);
});

// ---------------------------------------------------------------------------
// 10-13 — scope: the fix changes nothing else.
// ---------------------------------------------------------------------------

test('10 — a non-directional type is untouched: no Direction key is stored and the engine is unchanged', async () => {
  await freshDatabase('dir_other_type_untouched');
  const customer = await seedCustomer({ opening: 0 });
  const sale = await transactionFormService.submitTransactionForm({
    TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, CustomerId: customer.Id, Date: '2026-09-01', Amount: 300, Description: 'بيع مبيدات'
  });

  const result = await transactionLifecycleService.editTransaction(sale.Record.Id, editForm({ Amount: 450, Date: '2026-09-01' }));

  // Every stored row already carries Direction: null for a non-directional type (the
  // creation path stores the field as null); the fix must never turn it into a value.
  assert.equal(result.Record.Direction, null, 'the fix never writes a direction onto another type');
  assert.equal('Direction' in result.Record, true, 'the stored shape is unchanged');
  assert.equal(result.Record.AmountMinor, 450 * MONEY);
  const financials = deriveFinancials(result.Record);
  assert.equal(financials.direction, 'Debit');
  assert.equal(financials.DebitMinor, 450 * MONEY);
  assert.equal(financials.CreditMinor, 0);
});

test('11 — the creation path is unchanged: a missing Direction at creation is still Credit', async () => {
  await freshDatabase('dir_creation_unchanged');
  const customer = await seedCustomer({ opening: 0 });

  const settlement = await transactionFormService.submitTransactionForm({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-09-03', Amount: 200, Description: 'تسوية بلا اتجاه'
  });
  assert.equal(settlement.Record.Direction, 'Credit', 'the approved legacy default still applies at creation');
  assert.equal(deriveFinancials(settlement.Record).CreditMinor, 200 * MONEY);

  const debit = await seedDirectional(customer.Id, { type: TRANSACTION_TYPE.GOODS_EXCHANGE, direction: 'Debit', amount: 100 });
  assert.equal(debit.Direction, 'Debit');
  assert.equal(deriveFinancials(debit).DebitMinor, 100 * MONEY);
});

test('12 — DebtTransfer stays fully blocked and the cancellation path is unaffected', async () => {
  await freshDatabase('dir_debt_transfer_and_cancel');
  const from = await customerService.createCustomer({ Code: 'C-961', Name: 'عميل دائن', Phone: '0100000002', Region: 'طنطا', OpeningBalance: 5000 });
  const to = await customerService.createCustomer({ Code: 'C-962', Name: 'عميل مدين', Phone: '0100000003', Region: 'طنطا', OpeningBalance: 0 });
  const transfer = await debtTransferService.createDebtTransfer({
    FromCustomerId: from.Id, ToCustomerId: to.Id, Amount: 400, Date: '2026-09-05', Description: 'تحويل مديونية'
  });

  await assert.rejects(
    () => transactionLifecycleService.editTransaction(transfer.CreditRow.Id, editForm({ Amount: 999 })),
    /مرتبطة بحركة أخرى/
  );
  await assert.rejects(
    () => transactionLifecycleService.cancelTransaction(transfer.DebitRow.Id, 'محاولة إلغاء طرف واحد', { confirmed: true }),
    /مرتبطة بحركة أخرى/
  );
  assert.equal(await auditLogRepository.count(), 0);
  assert.equal(deriveFinancials(await transactionRepository.getById(transfer.CreditRow.Id)).CreditMinor, 400 * MONEY);

  // An ordinary Settlement is still cancellable, and its direction is still stored.
  const settlement = await seedDirectional(from.Id, { direction: 'Debit', amount: 200 });
  await transactionLifecycleService.cancelTransaction(settlement.Id, 'قيد خاطئ', { confirmed: true });
  const cancelled = await transactionRepository.getById(settlement.Id);
  assert.equal(cancelled.Status, STATUS.CANCELLED);
  assert.equal(cancelled.Direction, 'Debit');
  const summary = await balanceService.getCustomerSummary(from.Id);
  assert.equal(summary.BalanceMinor, 5000 * MONEY + 400 * MONEY, 'a cancelled movement leaves the balance');
});

test('13 — atomicity is unchanged: a failing audit write rolls the edit back and keeps the stored direction', async () => {
  await freshDatabase('dir_atomicity_kept');
  const customer = await seedCustomer({ opening: 5000 });
  const settlement = await seedDirectional(customer.Id, { direction: 'Debit', amount: 200 });

  const first = await transactionLifecycleService.editTransaction(settlement.Id, editForm({ Amount: 220, EditReason: 'التعديل الأول' }));
  assert.equal(first.Record.Direction, 'Debit');
  assert.equal(await auditLogRepository.count(), 1);

  await assert.rejects(
    () => transactionLifecycleService.editTransaction(settlement.Id, editForm({ Amount: 900 }), { auditEntryId: first.AuditEntry.Id }),
    /تعذر حفظ/
  );

  const stored = await transactionRepository.getById(settlement.Id);
  assert.equal(stored.AmountMinor, 220 * MONEY, 'the row is exactly as the successful edit left it');
  assert.equal(stored.Direction, 'Debit');
  assert.equal(await auditLogRepository.count(), 1, 'no orphan audit event');
});
