// Phase 4B.9 — Debt Transfer UI: form, validation, preview, write, statement and
// lifecycle protection. Every test exercises the real modules; nothing is asserted
// from a mock of the financial path except where a stub is explicitly the subject
// (the controller tests), and the integration tests go through the real services on
// a real (fake-indexeddb) database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { freshDatabase } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { balanceService } from '../src/services/balanceService.js';
import { transactionFormService, previewTransfer, TRANSACTION_TYPE_LABELS_AR } from '../src/services/transactionFormService.js';
import { debtTransferService } from '../src/services/debtTransferService.js';
import { paymentService } from '../src/services/paymentService.js';
import { transactionLifecycleService } from '../src/services/transactionLifecycleService.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { auditLogRepository } from '../src/repositories/auditLogRepository.js';
import { runTransaction } from '../src/storage/db.js';
import { STORE, DB_VERSION } from '../src/storage/schema.js';
import { TRANSACTION_TYPE, DEBT_TRANSFER_ROLE, NON_CASH_TYPES, DIRECTIONAL_TYPES } from '../src/domain/transactionTypes.js';
import { FORM_KEY, buildTransactionForm } from '../src/validation/transactionFormInput.js';
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from 'fake-indexeddb';
import { LEDGER_COLUMNS, ledgerRow, ledgerCounterpartyNote } from '../ui/views/customerAccount.js';
import {
  initTransactionFormView, FIELD_ID, TRANSACTION_FORM_REGION_ID, TRANSFER_PREVIEW_ID,
  TRANSFER_CONFIRM_SUBMIT_ID, renderTransferPreview, transferParties, isTransferType,
  SAME_CUSTOMER_MESSAGE, TRANSFER_CONFIRM_MESSAGE, renderDynamicFields, transactionTypeOptions
} from '../ui/views/transactionForm.js';

async function waitFor(check, { timeoutMs = 1500 } = {}) {
  const started = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const PROJECT_ROOT = join(import.meta.dirname, '..');
const UI_ROOT = join(PROJECT_ROOT, 'ui');
const TODAY = '2026-10-05';

function walkFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return walkFiles(full);
    return [full];
  });
}

async function seedCustomer({ code, name, opening = 0 }) {
  return customerService.createCustomer({ Code: code, Name: name, Phone: null, Region: null, OpeningBalance: opening });
}

// ---------------------------------------------------------------------------
// Minimal stand-in for the screen DOM: the REAL controller is exercised against it.
// ---------------------------------------------------------------------------
function stubScreen() {
  const controls = {};
  const handlers = {};
  const regionEl = {
    innerHTML: '',
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    querySelector(selector) {
      if (!selector.startsWith('#')) return null;
      const key = selector.slice(1);
      if (!controls[key]) {
        controls[key] = {
          value: '', disabled: false, innerHTML: '', attributes: {},
          setAttribute(name, value) { this.attributes[name] = value; },
          getAttribute(name) { return this.attributes[name] ?? null; }
        };
      }
      return controls[key];
    }
  };
  const container = {
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    querySelector(selector) { return selector === `#${TRANSACTION_FORM_REGION_ID}` ? regionEl : null; },
    addEventListener(type, handler) { handlers[type] = handler; },
    querySelectorAll() { return []; }
  };
  controls['transaction-form'] = { id: 'transaction-form', value: '' };
  return {
    container,
    regionEl,
    handlers,
    control(id) { return regionEl.querySelector(`#${id}`); },
    setValue(key, value) { regionEl.querySelector(`#${key}`).value = String(value); },
    fire(key, value) {
      this.setValue(key, value);
      if (!handlers.input) return;
      handlers.input({ preventDefault() {}, target: { getAttribute: (name) => (name === 'id' ? key : null), value: String(value), closest: () => null } });
    },
    // The real browser sequence for a <select>: input, then change.
    fireSelect(value) {
      const id = FIELD_ID.TransactionType;
      const payload = () => ({ preventDefault() {}, target: { getAttribute: (name) => (name === 'id' ? id : null), value: String(value), closest: () => null } });
      if (handlers.input) handlers.input(payload());
      if (handlers.change) handlers.change(payload());
      this.control(id).value = String(value);
    },
    click(action) {
      if (!handlers.click) return;
      handlers.click({ preventDefault() {}, target: { closest: (selector) => (selector === `[data-action="${action}"]` ? { getAttribute: () => null } : null) } });
    }
  };
}

function transferScreen({ customers, services = null, transactionType = TRANSACTION_TYPE.DEBT_TRANSFER } = {}) {
  const screen = stubScreen();
  const base = {
    ...transactionFormService,
    currentIsoDate: () => TODAY,
    listSelectableCustomers: async () => customers,
    getDefaultPackageWeight: async () => 25
  };
  const view = initTransactionFormView({
    container: screen.container,
    transactionType,
    services: services ? { ...base, ...services } : base,
    autoLoad: false
  });
  return { screen, view };
}

async function fillTransfer(screen, { from, to, amount, date = TODAY, description = 'تحويل مديونية' }) {
  screen.setValue(FIELD_ID.TransactionType, TRANSACTION_TYPE.DEBT_TRANSFER);
  screen.setValue(FIELD_ID.FromCustomerId, from);
  screen.setValue(FIELD_ID.ToCustomerId, to);
  screen.setValue(FIELD_ID.Date, date);
  screen.setValue(FIELD_ID.Amount, amount);
  screen.setValue(FIELD_ID.Description, description);
}

// ===========================================================================
// A — the form
// ===========================================================================

test('A1. DebtTransfer is offered in the transaction type list with an Arabic label', async () => {
  await freshDatabase('t49_a1');
  const options = transactionTypeOptions();
  const transfer = options.find((option) => option.value === TRANSACTION_TYPE.DEBT_TRANSFER);
  assert.ok(transfer, 'the transfer type is offered in the picker');
  assert.equal(transfer.label, 'تحويل مديونية');
  assert.equal(TRANSACTION_TYPE_LABELS_AR[TRANSACTION_TYPE.DEBT_TRANSFER], 'تحويل مديونية');
  const built = buildTransactionForm({ TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER, FromCustomerId: 'x', ToCustomerId: 'y', Amount: 1, Date: TODAY });
  assert.equal(built.Kind, 'debtTransfer', 'the approved mapping routes it to the two-leg path');
  assert.equal(renderDynamicFields({ transactionType: TRANSACTION_TYPE.DEBT_TRANSFER }).includes(`id="${TRANSFER_PREVIEW_ID}"`), true);
});

test('A2. Choosing the transfer replaces the single customer picker with From / To', async () => {
  await freshDatabase('t49_a2');
  const a = await seedCustomer({ code: 'C-490', name: 'أ' });
  const b = await seedCustomer({ code: 'C-491', name: 'ب' });
  const { screen, view } = transferScreen({ customers: [a, b], transactionType: '' });
  await view.reload();
  screen.fireSelect(TRANSACTION_TYPE.DEBT_TRANSFER);
  const html = screen.regionEl.innerHTML;
  assert.equal(html.includes(`id="${FIELD_ID.FromCustomerId}"`), true, 'the From party field must be rendered');
  assert.equal(html.includes(`id="${FIELD_ID.ToCustomerId}"`), true, 'the To party field must be rendered');
  assert.equal(html.includes(`id="${FIELD_ID.CustomerSearch}"`), false, 'the single customer picker is not shown for a transfer');
  assert.equal(html.includes(`id="${FIELD_ID.CustomerId}"`), false, 'no single-customer select for a transfer');
});

test('A3. Switching types renders exactly the fields of the new type', async () => {
  await freshDatabase('t49_a3');
  const a = await seedCustomer({ code: 'C-492', name: 'أ' });
  const { screen, view } = transferScreen({ customers: [a], transactionType: '' });
  await view.reload();
  screen.fireSelect(TRANSACTION_TYPE.DEBT_TRANSFER);
  assert.equal(view.state().values.TransactionType, TRANSACTION_TYPE.DEBT_TRANSFER);
  assert.equal(screen.regionEl.innerHTML.includes(`id="${FIELD_ID.Amount}"`), true);
  screen.fireSelect(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL);
  assert.equal(screen.regionEl.innerHTML.includes(`id="${FIELD_ID.FromCustomerId}"`), false, 'the transfer fields are gone');
  assert.equal(screen.regionEl.innerHTML.includes(`id="${FIELD_ID.Units}"`), true, 'the crop fields are shown');
  screen.fireSelect(TRANSACTION_TYPE.DEBT_TRANSFER);
  assert.equal(screen.regionEl.innerHTML.includes(`id="${FIELD_ID.FromCustomerId}"`), true, 'back to the transfer fields');
});

test('A4. A transfer never inherits a value chosen for another type', async () => {
  await freshDatabase('t49_a4');
  const a = await seedCustomer({ code: 'C-493', name: 'أ' });
  const b = await seedCustomer({ code: 'C-494', name: 'ب' });
  const { screen, view } = transferScreen({ customers: [a, b], transactionType: '' });
  await view.reload();
  screen.fireSelect(TRANSACTION_TYPE.CASH_RECEIVED);
  screen.fire(FIELD_ID.CustomerId, a.Id);
  screen.fire(FIELD_ID.Amount, '500');
  assert.equal(view.state().values[FORM_KEY.AMOUNT], '500', 'the single-customer type holds its own amount');
  screen.fireSelect(TRANSACTION_TYPE.DEBT_TRANSFER);
  const values = view.state().values;
  assert.equal(values[FORM_KEY.FROM_CUSTOMER] === a.Id, false, 'the single customer does not become the From party');
  assert.equal(values[FORM_KEY.TO_CUSTOMER] === a.Id, false, 'and does not become the To party either');
  assert.equal(values[FORM_KEY.AMOUNT], '', 'the previous amount is not carried into the transfer');
});

test('A5. The refusal message for the same customer on both sides is Arabic', async () => {
  await freshDatabase('t49_a5');
  const a = await seedCustomer({ code: 'C-495', name: 'أ' });
  const { screen, view } = transferScreen({ customers: [a] });
  await view.reload();
  await fillTransfer(screen, { from: a.Id, to: a.Id, amount: '100' });
  await view.submit();
  const html = screen.regionEl.innerHTML;
  assert.match(SAME_CUSTOMER_MESSAGE, /[\u0600-\u06FF]/, 'the message is Arabic');
  assert.equal(html.includes(SAME_CUSTOMER_MESSAGE), true, 'the Arabic refusal is rendered');
});

// ===========================================================================
// B — validation and preview
// ===========================================================================

test('B6. The same customer on both sides is refused without writing anything', async () => {
  await freshDatabase('t49_b6');
  const a = await seedCustomer({ code: 'C-496', name: 'أ' });
  const { screen, view } = transferScreen({ customers: [a] });
  await view.reload();
  const before = await transactionRepository.count();
  await fillTransfer(screen, { from: a.Id, to: a.Id, amount: '100' });
  const result = await view.submit();
  assert.equal(result, null);
  assert.equal(await transactionRepository.count(), before, 'nothing was written');
  assert.equal(screen.regionEl.innerHTML.includes(SAME_CUSTOMER_MESSAGE), true);
});

test('B7. A missing party is refused by the core validator with an Arabic message', async () => {
  await freshDatabase('t49_b7');
  const a = await seedCustomer({ code: 'C-497', name: 'أ' });
  const preview = await previewTransfer({ TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER, FromCustomerId: a.Id, ToCustomerId: '', Amount: '10', Date: TODAY });
  assert.equal(preview.Valid, false);
  assert.match(preview.Message, /يجب تحديد العميل المدين/);
  const before = await transactionRepository.count();
  await assert.rejects(
    () => transactionFormService.submitTransactionForm({ TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER, FromCustomerId: a.Id, ToCustomerId: '', Amount: '10', Date: TODAY }),
    /يجب تحديد العميل المدين/
  );
  assert.equal(await transactionRepository.count(), before, 'no row and no half transfer');
});

test('B8. An invalid amount and an invalid date are refused', async () => {
  await freshDatabase('t49_b8');
  const a = await seedCustomer({ code: 'C-498', name: 'أ' });
  const b = await seedCustomer({ code: 'C-499', name: 'ب' });
  const base = { TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER, FromCustomerId: a.Id, ToCustomerId: b.Id, Date: TODAY };
  assert.equal((await previewTransfer({ ...base, Amount: '0' })).Valid, false);
  assert.equal((await previewTransfer({ ...base, Amount: '-5' })).Valid, false);
  assert.equal((await previewTransfer({ ...base, Amount: 'abc' })).Valid, false);
  assert.equal((await previewTransfer({ ...base, Amount: '10', Date: '05/10/2026' })).Valid, false);
  const before = await transactionRepository.count();
  for (const amount of ['0', '-5', 'abc']) {
    await assert.rejects(() => transactionFormService.submitTransactionForm({ ...base, Amount: amount }));
  }
  assert.equal(await transactionRepository.count(), before);
});

test('B9. The preview shows the real current balance of both parties', async () => {
  await freshDatabase('t49_b9');
  const from = await seedCustomer({ code: 'C-500', name: 'الطرف الأول', opening: 0 });
  const to = await seedCustomer({ code: 'C-501', name: 'الطرف الثاني', opening: 0 });
  await transactionFormService.submitTransactionForm({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: from.Id, Amount: '300', Date: TODAY });
  await transactionFormService.submitTransactionForm({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: to.Id, Amount: '500', Date: TODAY });
  const preview = await previewTransfer({ TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER, FromCustomerId: from.Id, ToCustomerId: to.Id, Amount: '200', Date: TODAY });
  assert.equal(preview.Valid, true);
  assert.equal(preview.From.CurrentBalanceMinor, 30000);
  assert.equal(preview.To.CurrentBalanceMinor, 50000);
  assert.equal(preview.From.Code, 'C-500');
  assert.equal(preview.To.Code, 'C-501');
});

test('B10. The projected balances equal what the account services report after the save', async () => {
  await freshDatabase('t49_b10');
  const from = await seedCustomer({ code: 'C-502', name: 'أ', opening: 300 });
  const to = await seedCustomer({ code: 'C-503', name: 'ب', opening: 0 });
  const preview = await previewTransfer({ TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER, FromCustomerId: from.Id, ToCustomerId: to.Id, Amount: '120', Date: TODAY });
  assert.equal(preview.From.ProjectedBalanceMinor, 42000);
  assert.equal(preview.To.ProjectedBalanceMinor, -12000);
  await transactionFormService.submitTransactionForm({ TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER, FromCustomerId: from.Id, ToCustomerId: to.Id, Amount: '120', Date: TODAY });
  const afterFrom = await balanceService.getCustomerSummary(from.Id);
  const afterTo = await balanceService.getCustomerSummary(to.Id);
  assert.equal(afterFrom.BalanceMinor, preview.From.ProjectedBalanceMinor, 'the projection matched the stored result (from side)');
  assert.equal(afterTo.BalanceMinor, preview.To.ProjectedBalanceMinor, 'the projection matched the stored result (to side)');
  assert.equal(preview.TotalAfter, preview.TotalBefore, 'the two balances together are unchanged by the transfer');
});

test('B11. A negative receiving balance raises a warning and needs an explicit confirmation', async () => {
  await freshDatabase('t49_b11');
  const from = await seedCustomer({ code: 'C-504', name: 'أ', opening: 1000 });
  const to = await seedCustomer({ code: 'C-505', name: 'ب', opening: 0 });
  const { screen, view } = transferScreen({ customers: [from, to] });
  await view.reload();
  await fillTransfer(screen, { from: from.Id, to: to.Id, amount: '300', description: 'بلا رصيد كافٍ' });
  const before = await transactionRepository.count();
  const first = await view.submit();
  assert.equal(first, null, 'nothing is saved before the confirmation');
  assert.equal(await transactionRepository.count(), before, 'the warning is not a silent write');
  const panel = screen.control(TRANSFER_PREVIEW_ID).innerHTML;
  assert.equal(panel.includes(TRANSFER_CONFIRM_SUBMIT_ID), true, 'the confirmation button is offered');
  assert.equal(panel.includes(TRANSFER_CONFIRM_MESSAGE), true, 'the negative-balance warning carries the Arabic message');
  screen.click('confirm-transfer');
  assert.equal(await waitFor(async () => (await transactionRepository.count()) === before + 2), true, 'after the explicit confirmation the two legs exist');
});

test('B12. A failed or stale preview can never be saved', async () => {
  await freshDatabase('t49_b12');
  const from = await seedCustomer({ code: 'C-506', name: 'أ' });
  const to = await seedCustomer({ code: 'C-507', name: 'ب' });
  let submits = 0;
  const { screen, view } = transferScreen({
    customers: [from, to],
    services: {
      previewTransfer: async () => ({ Valid: false, Message: 'تعذّر التحقق من بيانات التحويل.', Field: 'Amount' }),
      submitTransactionForm: async () => { submits += 1; return null; }
    }
  });
  await view.reload();
  await fillTransfer(screen, { from: from.Id, to: to.Id, amount: '50' });
  const result = await view.submit();
  assert.equal(result, null);
  assert.equal(submits, 0, 'the write path was never reached with an unverified preview');
  assert.match(screen.regionEl.innerHTML, /تعذّر التحقق من بيانات التحويل/);
  assert.equal(await transactionRepository.count(), 0);
});

test('B12b. The preview panel is refreshed from the service, never from a stale value', async () => {
  await freshDatabase('t49_b12b');
  const from = await seedCustomer({ code: 'C-508', name: 'أ', opening: 400 });
  const to = await seedCustomer({ code: 'C-509', name: 'ب', opening: 0 });
  let calls = 0;
  const { screen, view } = transferScreen({
    customers: [from, to],
    services: { previewTransfer: async (form) => { calls += 1; return previewTransfer(form); } }
  });
  await view.reload();
  screen.fireSelect(TRANSACTION_TYPE.DEBT_TRANSFER);
  screen.fire(FIELD_ID.FromCustomerId, from.Id);
  screen.fire(FIELD_ID.ToCustomerId, to.Id);
  screen.fire(FIELD_ID.Date, TODAY);
  screen.fire(FIELD_ID.Amount, '100');
  screen.fire(FIELD_ID.Description, 'تحديث');
  // The controller refreshes the preview asynchronously on every input event; the panel
  // is therefore read after the refresh has settled, exactly as a user sees it once the
  // change has been processed. The assertion itself is UNCHANGED: the panel must show
  // the balance the SERVICES layer reported for the selected customer.
  assert.equal(await waitFor(() => calls >= 1), true, 'the preview is re-read when the form changes');
  assert.equal(
    await waitFor(() => screen.control(TRANSFER_PREVIEW_ID).innerHTML.includes('400.00')),
    true,
    'the current balance comes from the service'
  );
  // Freshness (strengthened): after a NEW amount the panel shows the new value and keeps
  // no stale one, so a stale figure can never be mistaken for a live one.
  screen.fire(FIELD_ID.Amount, '250');
  assert.equal(
    await waitFor(() => {
      const html = screen.control(TRANSFER_PREVIEW_ID).innerHTML;
      return html.includes('250.00') && !html.includes('100.00');
    }),
    true,
    'the panel follows the latest value and never keeps a stale amount'
  );
});

// ===========================================================================
// C — write and financial integration
// ===========================================================================

async function savedTransfer() {
  await freshDatabase('t49_c');
  const from = await seedCustomer({ code: 'C-600', name: 'أ', opening: 1000 });
  const to = await seedCustomer({ code: 'C-601', name: 'ب', opening: 200 });
  const result = await transactionFormService.submitTransactionForm({
    TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER, FromCustomerId: from.Id, ToCustomerId: to.Id,
    Amount: '150', Date: TODAY, Description: 'تحويل بين طرفين'
  });
  return { from, to, result };
}

test('C13/C14/C15/C16. One operation creates two linked legs with the approved contract', async () => {
  const { from, to, result } = await savedTransfer();
  assert.equal(result.Kind, 'debtTransfer');
  assert.equal(result.Records.length, 2, 'exactly two legs');
  const credit = result.Records.find((row) => row.TransferRole === DEBT_TRANSFER_ROLE.CREDIT_SIDE);
  const debit = result.Records.find((row) => row.TransferRole === DEBT_TRANSFER_ROLE.DEBIT_SIDE);
  assert.equal(credit.CustomerId, from.Id, 'the credit side is the From party');
  assert.equal(debit.CustomerId, to.Id, 'the debit side is the To party');
  assert.equal(credit.LinkId, debit.LinkId, 'both legs share one LinkId');
  assert.equal(credit.LinkId, result.LinkId);
  assert.equal(credit.AmountMinor, 15000);
  assert.equal(debit.AmountMinor, credit.AmountMinor, 'the same amount on both legs');
  assert.equal(credit.Date, TODAY);
  assert.equal(debit.Date, credit.Date);
  assert.equal(credit.Description, 'تحويل بين طرفين');
  assert.equal(debit.Description, credit.Description, 'the same statement text on both legs');
  const stored = await transactionRepository.getAll();
  assert.equal(stored.length, 2, 'nothing but the two legs was written');
  assert.equal(stored.every((row) => row.TransactionType === TRANSACTION_TYPE.DEBT_TRANSFER), true);
  assert.equal(new Set(stored.map((row) => row.LinkId)).size, 1);
});

test('C17. A transfer produces no cash movement on either leg', async () => {
  const { result } = await savedTransfer();
  for (const row of result.Records) {
    assert.equal(row.CashReceivedMinor ?? 0, 0, 'no cash received is stored');
    assert.equal(row.CashPaidMinor ?? 0, 0, 'no cash paid is stored');
  }
  assert.equal(result.CashImpactMinor, 0, 'the service reports a zero cash impact');
  const ledger = await balanceService.getRunningBalance(result.Records[0].CustomerId);
  assert.equal(ledger.Entries.every((entry) => entry.CashReceivedMinor === 0 && entry.CashPaidMinor === 0), true);
});

test('C18/C19. The balances move by the same amount in opposite directions and their sum is unchanged', async () => {
  const { from, to } = await savedTransfer();
  const fromSummary = await balanceService.getCustomerSummary(from.Id);
  const toSummary = await balanceService.getCustomerSummary(to.Id);
  assert.equal(fromSummary.BalanceMinor, 100000 + 15000, 'the From party balance rises');
  assert.equal(toSummary.BalanceMinor, 20000 - 15000, 'the To party balance falls by the same amount');
  assert.equal(fromSummary.BalanceMinor + toSummary.BalanceMinor, 100000 + 20000, 'together they are unchanged');
});

test('C20. The transfer never enters the cash totals of the payments screen', async () => {
  await freshDatabase('t49_c20');
  const a = await seedCustomer({ code: 'C-602', name: 'أ', opening: 0 });
  const b = await seedCustomer({ code: 'C-603', name: 'ب', opening: 0 });
  await transactionFormService.submitTransactionForm({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: a.Id, Amount: '400', Date: TODAY });
  const before = paymentService.summarize(await paymentService.listCashMovements());
  await transactionFormService.submitTransactionForm({ TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER, FromCustomerId: a.Id, ToCustomerId: b.Id, Amount: '120', Date: TODAY });
  const after = paymentService.summarize(await paymentService.listCashMovements());
  assert.equal(after.CashReceivedMinor, before.CashReceivedMinor, 'the cash total is untouched by a transfer');
  assert.equal(after.CashPaidMinor, before.CashPaidMinor);
  assert.equal(after.NetCashMinor, before.NetCashMinor);
  assert.equal(NON_CASH_TYPES.includes(TRANSACTION_TYPE.DEBT_TRANSFER), true, 'the transfer is a non-cash type');
});

test('C21. A failure inside the write transaction leaves no partial transfer', async () => {
  await freshDatabase('t49_c21');
  const from = await seedCustomer({ code: 'C-604', name: 'أ' });
  const to = await seedCustomer({ code: 'C-605', name: 'ب' });
  // (a) the second party does not exist: the service refuses before any row is written
  await assert.rejects(
    () => transactionFormService.submitTransactionForm({ TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER, FromCustomerId: from.Id, ToCustomerId: 'cus_missing', Amount: '10', Date: TODAY }),
    /العميل المدين غير موجود/
  );
  assert.equal(await transactionRepository.count(), 0, 'no leg was written');
  // (b) the very same primitive the service uses aborts atomically when a step inside fails
  await assert.rejects(() => runTransaction([STORE.TRANSACTIONS, STORE.AUDIT_LOG], 'readwrite', (stores) => {
    stores[STORE.TRANSACTIONS].add({ Id: 'trx_probe', TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER, AmountMinor: 100, CustomerId: from.Id, Date: TODAY, Status: 'Active' });
    stores[STORE.AUDIT_LOG].add({ Id: 'aud_probe', TransactionId: 'trx_probe', EventType: 'TransactionEdited' });
    // injected inside the same step, before the transaction can commit
    throw new Error('injected failure inside the write transaction');
  }));
  assert.equal(await transactionRepository.count(), 0, 'the aborted transaction left no movement');
  assert.equal(await auditLogRepository.count(), 0, 'and no audit event');
});

test('C22. A repeated click during the save cannot create a second transfer', async () => {
  await freshDatabase('t49_c22');
  const from = await seedCustomer({ code: 'C-606', name: 'أ' });
  const to = await seedCustomer({ code: 'C-607', name: 'ب' });
  let calls = 0;
  const { screen, view } = transferScreen({
    customers: [from, to],
    services: {
      // A stub preview (no negative side) so the double-click counting is what is
      // being measured here; the real write path is exercised in C13.
      previewTransfer: async () => ({ Valid: true, Insufficient: false, From: { CustomerId: from.Id }, To: { CustomerId: to.Id } }),
      submitTransactionForm: async (form) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { Kind: 'debtTransfer', Records: [], CustomerId: form.FromCustomerId };
      }
    }
  });
  await view.reload();
  await fillTransfer(screen, { from: from.Id, to: to.Id, amount: '10' });
  const first = view.submit();
  const second = view.submit();
  const third = view.submit();
  const [r1, r2, r3] = await Promise.all([first, second, third]);
  assert.equal(calls, 1, 'only one save call reached the services layer');
  assert.equal(r2, null);
  assert.equal(r3, null);
  assert.notEqual(r1, null);
  assert.equal(await transactionRepository.count(), 0, 'the stub wrote nothing; the real write was exercised in C13');
});

// ===========================================================================
// D — statement and lifecycle
// ===========================================================================

test('D23/D24/D25. Both statements show the transfer with the counterparty and the role', async () => {
  const { from, to, result } = await savedTransfer();
  const creditLedger = await balanceService.getRunningBalance(from.Id);
  const debitLedger = await balanceService.getRunningBalance(to.Id);
  assert.equal(creditLedger.Entries.length, 1);
  assert.equal(debitLedger.Entries.length, 1);
  const creditEntry = creditLedger.Entries[0];
  const debitEntry = debitLedger.Entries[0];
  assert.equal(creditEntry.TransactionType, TRANSACTION_TYPE.DEBT_TRANSFER);
  assert.equal(creditEntry.CreditMinor, 15000);
  assert.equal(debitEntry.DebitMinor, 15000);
  assert.equal(creditEntry.CounterpartyId, to.Id, 'the From statement names the other party');
  assert.equal(debitEntry.CounterpartyId, from.Id, 'the To statement names the other party');
  assert.equal(creditEntry.CounterpartyCode, 'C-601');
  assert.equal(debitEntry.CounterpartyCode, 'C-600');
  assert.equal(creditEntry.TransferRole, DEBT_TRANSFER_ROLE.CREDIT_SIDE);
  assert.equal(debitEntry.TransferRole, DEBT_TRANSFER_ROLE.DEBIT_SIDE);
  assert.equal(creditEntry.CounterpartyTransferRole, DEBT_TRANSFER_ROLE.DEBIT_SIDE);
  const creditHtml = ledgerRow(creditEntry).cells.join('');
  assert.match(creditHtml, /الطرف المقابل: C-601 — ب/, 'the row renders the counterparty');
  assert.match(creditHtml, /دورك في التحويل: دائن/, 'the row renders this side role');
  const debitHtml = ledgerRow(debitEntry).cells.join('');
  assert.match(debitHtml, /دورك في التحويل: مدين/);
  assert.equal(LEDGER_COLUMNS.length, 10, 'the approved ten-column layout is unchanged');
  assert.equal(result.LinkId, creditEntry.LinkId, 'the statement row carries the stored LinkId');
  assert.equal(ledgerCounterpartyNote({}).length, 0, 'a movement without a counterparty renders nothing extra');
});

test('D26/D27/D28. One leg of a transfer can be neither edited nor cancelled, and nothing is written', async () => {
  const { result } = await savedTransfer();
  const leg = result.Records[0];
  const rowsBefore = JSON.stringify((await transactionRepository.getAll()).sort((a, b) => a.Id.localeCompare(b.Id)));
  const auditBefore = await auditLogRepository.count();

  const editability = await transactionLifecycleService.getEditability(leg.Id);
  assert.equal(editability.CanEdit, false);
  assert.equal(editability.CanCancel, false);
  assert.match(editability.EditReason, /مرتبطة بحركة أخرى/, 'the Arabic refusal explains the linked operation');
  assert.match(editability.CancelReason, /مرتبطة بحركة أخرى/);

  await assert.rejects(() => transactionLifecycleService.editTransaction(leg.Id, { Amount: 999, Date: TODAY, Description: 'x', Reason: 'محاولة' }), /مرتبطة بحركة أخرى/);
  await assert.rejects(() => transactionLifecycleService.cancelTransaction(leg.Id, 'محاولة', { confirmed: true }), /مرتبطة بحركة أخرى/);

  assert.equal(JSON.stringify((await transactionRepository.getAll()).sort((a, b) => a.Id.localeCompare(b.Id))), rowsBefore, 'the stored rows are byte-identical after both refusals');
  assert.equal(await auditLogRepository.count(), auditBefore, 'no audit event was appended');
  assert.equal(await transactionRepository.count(), 2, 'the two legs are still there');
});

test('D29/D30. A whole-transfer edit or cancel is not supported, so the safe refusal stands', async () => {
  const { result } = await savedTransfer();
  for (const leg of result.Records) {
    const editability = await transactionLifecycleService.getEditability(leg.Id);
    assert.equal(editability.CanEdit, false, 'no whole-transfer edit path exists; the refusal is the intended behaviour');
    assert.equal(editability.CanCancel, false, 'no whole-transfer cancel path exists either');
  }
  assert.equal(await auditLogRepository.count(), 0);
  assert.equal((await transactionRepository.getAll()).filter((row) => row.Status === 'Cancelled').length, 0);
});

test('D31. A cancelled movement stays stored and out of the balances', async () => {
  await freshDatabase('t49_d31');
  const a = await seedCustomer({ code: 'C-610', name: 'أ', opening: 0 });
  const created = await transactionFormService.submitTransactionForm({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: a.Id, Amount: '200', Date: TODAY });
  await transactionLifecycleService.cancelTransaction(created.Record.Id, 'سبب اختباري', { confirmed: true });
  const stored = await transactionRepository.getById(created.Record.Id);
  assert.equal(stored.Status, 'Cancelled');
  assert.equal(await transactionRepository.count(), 1, 'the row is kept, never deleted');
  const summary = await balanceService.getCustomerSummary(a.Id);
  assert.equal(summary.BalanceMinor, 0, 'the cancelled movement leaves the balance');
  assert.equal(summary.CashReceivedMinor, 0, 'and leaves the cash totals');
});

test('D32. The lifecycle protection of the other nine types is unchanged', async () => {
  await freshDatabase('t49_d32');
  const a = await seedCustomer({ code: 'C-611', name: 'أ', opening: 0 });
  const created = await transactionFormService.submitTransactionForm({ TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, CustomerId: a.Id, Amount: '100', Date: TODAY });
  const before = await transactionLifecycleService.getEditability(created.Record.Id);
  assert.equal(before.CanEdit, true, 'a standalone type stays editable');
  assert.equal(before.CanCancel, true, 'and cancellable');
  const edited = await transactionLifecycleService.editTransaction(created.Record.Id, { Amount: 150, Date: TODAY, Description: 'معدلة', EditReason: 'تصحيح' });
  assert.equal(edited.Record.AmountMinor, 15000);
  assert.equal(await auditLogRepository.count(), 1, 'one audit event for the edit');
  const cancelled = await transactionLifecycleService.cancelTransaction(created.Record.Id, 'إلغاء اختباري', { confirmed: true });
  assert.equal(cancelled.Record.Status, 'Cancelled');
  assert.equal(await auditLogRepository.count(), 2, 'one more audit event for the cancel');
  assert.equal(created.Record.LinkId ?? null, null, 'a standalone movement carries no link');
});

// ===========================================================================
// E — regression, architecture, contracts
// ===========================================================================

test('E35. No UI module reaches the storage layer or a repository', () => {
  const files = walkFiles(UI_ROOT);
  assert.ok(files.length >= 22, 'the ui tree is intact');
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const forbidden of ['repositories', 'storage/db', 'storage/schema', 'indexedDB', 'IndexedDB', 'IDBKeyRange', 'runTransaction']) {
      assert.equal(source.includes(forbidden), false, `${file} must not reference ${forbidden}`);
    }
    for (const target of [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      if (target.includes('/src/')) assert.match(target, /\/src\/(services|utils)\//, `${file} may only reach services and utils, got ${target}`);
    }
  }
});

test('E36. The UI computes no balance and never calls the financial engine', () => {
  const form = readFileSync(join(UI_ROOT, 'views/transactionForm.js'), 'utf8');
  const account = readFileSync(join(UI_ROOT, 'views/customerAccount.js'), 'utf8');
  for (const source of [form, account]) {
    assert.doesNotMatch(source, /deriveFinancials/, 'the engine is never called from the UI');
    assert.doesNotMatch(source, /BalanceMinor\s*[+\-*/]?=/, 'no balance is assigned in the UI');
    assert.doesNotMatch(source, /balance\s*[+\-]=/, 'no balance is accumulated in the UI');
    assert.doesNotMatch(source, /Total(Credit|Debit)Minor\s*[+\-]?=/, 'no debit / credit total is computed in the UI');
  }
  // the transfer preview consumes service output only
  assert.match(form, /services\.previewTransfer/, 'the preview comes from the service');
  assert.match(form, /CurrentBalanceMinor/, 'the panel prints the value the service returned');
  assert.doesNotMatch(form, /CurrentBalanceMinor\s*[+\-]/, 'and never adds to it');
});

test('E37. The rules of Settlement, GoodsExchange and the crop purchases are untouched', () => {
  const source = readFileSync(join(PROJECT_ROOT, 'src/domain/financialDirection.js'), 'utf8');
  assert.match(source, /Settlement: Object\.freeze\(\{ direction: SIDE_DEPENDENT, bucket: NON_CASH_BUCKET \}\)/);
  assert.match(source, /GoodsExchange: Object\.freeze\(\{ direction: SIDE_DEPENDENT, bucket: NON_CASH_BUCKET \}\)/);
  const types = readFileSync(join(PROJECT_ROOT, 'src/domain/transactionTypes.js'), 'utf8');
  assert.match(types, /DIRECTIONAL_TYPES = Object\.freeze\(\['Settlement', 'GoodsExchange'\]\)/);
  assert.equal(DIRECTIONAL_TYPES.includes(TRANSACTION_TYPE.DEBT_TRANSFER), false, 'a transfer keeps its role-based direction');
  const crop = readFileSync(join(PROJECT_ROOT, 'src/services/cropPurchaseService.js'), 'utf8');
  assert.match(crop, /computeLocalNetWeightMilli/, 'the local net weight still comes from the shared approved calculator');
  assert.match(crop, /computeLocalTotalMinor/, 'and its value from the shared approved calculator');
  assert.doesNotMatch(crop, /\bAmountMinor: *(input|draft|form)\b/, 'a crop purchase still cannot accept an explicit amount');
  assert.doesNotMatch(crop, /\b14\b/, 'no hard-coded package weight in the crop service');
  const validation = readFileSync(join(PROJECT_ROOT, 'src/validation/transactionValidation.js'), 'utf8');
  assert.match(validation, /hasExplicitAmountField/, 'the Phase 3.1 explicit-amount guard is intact');
});

test('E38. The schema, its version and the dependency list are unchanged', () => {
  const schema = readFileSync(join(PROJECT_ROOT, 'src/storage/schema.js'), 'utf8');
  // Phase 4B.11 raised the schema to version 3 to ADD the two reference stores. Nothing
  // was removed: the version 2 surface below is still asserted, element by element.
  // Phase 4B.13.1 raised the schema to 4 to ADD one variety store. The guard keeps its
  // exact intent — the store surface is a known, additive list and the version matches the
  // constant — so it is extended by exactly the one new entry instead of being loosened.
  assert.match(schema, /export const DB_VERSION = 4;/);
  assert.equal(DB_VERSION, 4);
  assert.equal(JSON.stringify(Object.keys(STORE)), JSON.stringify(['CUSTOMERS', 'TRANSACTIONS', 'OPENING_BALANCE_HISTORY', 'SETTINGS', 'METADATA', 'AUDIT_LOG', 'RECEIVING_COMPANIES', 'CARTON_TYPES', 'STRAWBERRY_VARIETIES']));
  assert.match(schema, /LINK_ID: 'linkId'/);
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.devDependencies), ['fake-indexeddb'], 'no dependency was added');
  assert.deepEqual(Object.keys(pkg.dependencies || {}), []);
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.js');
});

test('E39. The existing routes and the form contracts are intact', async () => {
  const routes = await import('../ui/routes.js');
  assert.equal(typeof routes.transactionAddPath, 'function');
  assert.match(routes.transactionAddPath('cus_1'), /\/transactions\/add\?customerId=cus_1/);
  assert.equal(typeof routes.customerAccountPath, 'function');
  const form = readFileSync(join(UI_ROOT, 'views/transactionForm.js'), 'utf8');
  for (const id of [FIELD_ID.TransactionType, FIELD_ID.FromCustomerId, FIELD_ID.ToCustomerId, FIELD_ID.CustomerId, FIELD_ID.CustomerSearch, FIELD_ID.Amount, FIELD_ID.Date, FIELD_ID.Description]) {
    assert.equal(form.includes(id), true, `the contract id ${id} is preserved`);
  }
  assert.equal(transferParties({ [FORM_KEY.FROM_CUSTOMER]: 'x', [FORM_KEY.TO_CUSTOMER]: 'y' }).Same, false);
  assert.equal(transferParties({ [FORM_KEY.FROM_CUSTOMER]: 'x', [FORM_KEY.TO_CUSTOMER]: 'x' }).Same, true);
  assert.equal(isTransferType(TRANSACTION_TYPE.DEBT_TRANSFER), true);
  assert.equal(form.includes('TODO'), false);
  assert.equal(form.includes('FIXME'), false);
  assert.equal(readFileSync(join(PROJECT_ROOT, 'src/services/transactionFormService.js'), 'utf8').includes('TODO'), false);
  assert.equal(renderTransferPreview({ preview: null }).includes('اختر الطرفين'), true);
});

test('E40. The transfer preview carries no mock data and no invented figure', async () => {
  await freshDatabase('t49_e40');
  const a = await seedCustomer({ code: 'C-620', name: 'أ' });
  const preview = await previewTransfer({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: a.Id, Amount: '10', Date: TODAY });
  assert.equal(preview.Valid, false, 'a non-transfer type is refused by the preview');
  const valuesOf = (html) => [...html.matchAll(/preview-item__value">([^<]*)</g)].map((match) => match[1]);
  const empty = renderTransferPreview({ preview: null });
  for (const value of valuesOf(empty)) assert.equal(/[0-9]/.test(value), false, `an empty preview shows no figure, got ${value}`);
  const unavailable = renderTransferPreview({ preview: { Valid: false, Message: 'تعذّر تحميل معاينة التحويل من طبقة الخدمات.' } });
  assert.equal(valuesOf(unavailable).some((value) => /تعذّر تحميل معاينة التحويل/.test(value)), true);
  for (const value of valuesOf(unavailable)) assert.equal(/[0-9]/.test(value), false, 'a failed preview invents no number');
});
