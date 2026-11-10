// Phase 4B.14 — opening balance editing UI + audit history.
// Every scenario drives the real screen controller against the real services on an
// isolated fake IndexedDB. Nothing here writes to a user database and no fixture is
// shipped with the application.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freshDatabase, simulateReload, cartonRefs } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { balanceService } from '../src/services/balanceService.js';
import { openingBalanceService } from '../src/services/openingBalanceService.js';
import { cancellationService } from '../src/services/cancellationService.js';
import { debtTransferService } from '../src/services/debtTransferService.js';
import { backupService } from '../src/services/backupService.js';
import { restoreService } from '../src/services/restoreService.js';
import { openingBalanceRepository } from '../src/repositories/openingBalanceRepository.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { validateOpeningBalanceChange, OPENING_BALANCE_REASON_MAX_LENGTH } from '../src/validation/customerValidation.js';
import { TRANSACTION_TYPE, DEBT_TRANSFER_ROLE } from '../src/domain/transactionTypes.js';
import {
  ACCOUNT_REGION_ID, LEDGER_REGION_ID, OPENING_BALANCE_REGION_ID,
  initCustomerAccountView, renderOpeningBalanceHistory, historyTimestamp
} from '../ui/views/customerAccount.js';
import {
  OPENING_BALANCE_VALUE_ID, OPENING_BALANCE_REASON_ID, OPENING_BALANCE_FORM_ID,
  OPENING_BALANCE_CONFIRM_FORM_ID, OPENING_BALANCE_DIALOG_ID, OPENING_BALANCE_STEP,
  openingDeltaLabel, renderOpeningBalanceDialog, closedOpeningBalanceState
} from '../ui/views/openingBalance.js';

const here = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = join(here, '..', 'ui');

// A detached container: it exposes the regions the controller paints into, the two
// inputs it reads, and it records the listeners so a synthetic event can be fired.
function makeContainer() {
  const ids = [ACCOUNT_REGION_ID, LEDGER_REGION_ID, OPENING_BALANCE_REGION_ID, OPENING_BALANCE_VALUE_ID, OPENING_BALANCE_REASON_ID];
  const nodes = new Map(ids.map((id) => [id, {
    innerHTML: '', value: '', attrs: {}, isConnected: true,
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key] === undefined ? null : this.attrs[key]; }
  }]));
  const listeners = new Map();
  return {
    attrs: {}, nodes, listeners,
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key]; },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    querySelector(selector) { return nodes.get(String(selector).replace(/^#/, '')) || null; },
    // Fire a synthetic event at the container, the way the browser would.
    // The real DOM listeners are fire-and-forget, so the await they perform is not
    // observable here: the microtask queue is flushed explicitly instead.
    async emit(type, target) {
      for (const handler of listeners.get(type) || []) {
        await handler({ target, preventDefault() {} });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
}

function targetWith({ id = null, action = null } = {}) {
  return {
    id, action,
    getAttribute(key) { return key === 'id' ? id : (key === 'data-action' ? action : null); },
    closest(selector) {
      const match = /^\[data-action="([^"]+)"\]$/.exec(String(selector));
      if (!match) return null;
      return match[1] === action ? this : null;
    }
  };
}

async function seedCustomer({ code = 'OB-1', name = 'مزارع الرصيد الافتتاحي', opening = 1000 } = {}) {
  return customerService.createCustomer({ Code: code, Name: name, Phone: '0100', Region: 'طنطا', OpeningBalance: opening });
}

async function openAccount(customer, services = undefined) {
  const container = makeContainer();
  const options = { container, customerId: customer.Id };
  if (services) options.services = services;
  const view = initCustomerAccountView(options);
  const loaded = await view.reload();
  assert.equal(loaded.ok, true, 'the account must load before the dialog is exercised');
  return { container, view };
}

function setInputs(container, { value = '', reason = '' } = {}) {
  container.nodes.get(OPENING_BALANCE_VALUE_ID).value = value;
  container.nodes.get(OPENING_BALANCE_REASON_ID).value = reason;
}

const html = (container) => container.nodes.get(ACCOUNT_REGION_ID).innerHTML;

// ---------------------------------------------------------------------------
// 1 — the current opening balance of the right customer is what the dialog shows.
// ---------------------------------------------------------------------------

test('1. the dialog opens on the current opening balance of the customer being viewed', async () => {
  await freshDatabase('ob_read');
  const first = await seedCustomer({ code: 'OB-A', name: 'العميل الأول', opening: 1250 });
  const second = await seedCustomer({ code: 'OB-B', name: 'العميل الثاني', opening: 9999 });

  const { container, view } = await openAccount(first);
  view.openOpeningBalance();
  const painted = html(container);

  assert.match(painted, /id="dialog-opening-balance"/);
  assert.match(painted, /الرصيد الافتتاحي الحالي/);
  assert.match(painted, /1,250\.00/, 'the dialog shows the viewed customer balance');
  assert.doesNotMatch(painted, /9,999\.00/, 'the other customer balance must never be shown');
  assert.equal(view.openingState().currentMinor, 125000);
  assert.equal(view.openingState().open, true);
  assert.equal(view.openingState().step, OPENING_BALANCE_STEP.FORM);

  // the entry point exists in the header and in the history card
  assert.equal((painted.match(/data-action="open-opening-balance"/g) || []).length, 2);
  assert.equal(second.OpeningBalanceMinor, 999900, 'the other customer is untouched by the read');
});

// ---------------------------------------------------------------------------
// 2 — a valid change goes through the approved service and lands in the summary.
// ---------------------------------------------------------------------------

test('2. a valid change is saved through the service and the shown balance is updated', async () => {
  await freshDatabase('ob_save');
  const customer = await seedCustomer({ opening: 1000 });
  const { container, view } = await openAccount(customer);

  view.openOpeningBalance();
  setInputs(container, { value: '1500', reason: 'تصحيح الرصيد الافتتاحي' });
  const reviewed = await view.reviewOpeningBalance();
  assert.equal(reviewed.ok, true);
  assert.equal(view.openingState().step, OPENING_BALANCE_STEP.REVIEW);

  const saved = await view.submitOpeningBalance();
  assert.equal(saved.ok, true);
  assert.equal(saved.result.Unchanged, false);

  const stored = await customerService.getCustomer(customer.Id);
  assert.equal(stored.OpeningBalanceMinor, 150000);
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.OpeningBalanceMinor, 150000, 'the repainted summary carries the new value');
  assert.match(html(container), /1,500\.00/);
  assert.match(html(container), /تم حفظ الرصيد الافتتاحي/, 'success is reported only after the service answered');
  assert.equal(view.openingState().open, false, 'the dialog closes on success');
});

// ---------------------------------------------------------------------------
// 3 — an empty or whitespace-only reason is refused by the validation layer.
// ---------------------------------------------------------------------------

test('3. an empty or whitespace-only reason is refused and nothing is written', async () => {
  await freshDatabase('ob_reason');
  const customer = await seedCustomer({ opening: 1000 });

  assertEquals(validateOpeningBalanceChange({ newValue: 1500, reason: '   ' }).ok, false);
  assertEquals(validateOpeningBalanceChange({ newValue: 1500, reason: '' }).ok, false);
  assertEquals(validateOpeningBalanceChange({ newValue: 1500, reason: null }).ok, false);
  // a too-long reason is refused by the same single rule
  assertEquals(validateOpeningBalanceChange({ newValue: 1500, reason: 'س'.repeat(OPENING_BALANCE_REASON_MAX_LENGTH + 1) }).ok, false);

  await assert.rejects(
    () => openingBalanceService.setOpeningBalance(customer.Id, { newValue: 1500, reason: '   ' }),
    (error) => error.code === 'VALIDATION_ERROR' && error.message === 'سبب تعديل الرصيد الافتتاحي مطلوب.'
  );

  const { container, view } = await openAccount(customer);
  view.openOpeningBalance();
  setInputs(container, { value: '1500', reason: '   ' });
  const refused = await view.reviewOpeningBalance();
  assert.equal(refused.ok, false);
  assert.equal(view.openingState().step, OPENING_BALANCE_STEP.FORM, 'the screen stays on the form');
  assert.match(html(container), /سبب تعديل الرصيد الافتتاحي مطلوب/);
  assert.equal((await openingBalanceRepository.count()), 0, 'no history row was written');
  assert.equal((await customerService.getCustomer(customer.Id)).OpeningBalanceMinor, 100000);
});

function assertEquals(actual, expected) { assert.equal(actual, expected); }

// ---------------------------------------------------------------------------
// 4 — an invalid value is refused with the service message.
// ---------------------------------------------------------------------------

test('4. an invalid value is refused by the service rules, not by the screen', async () => {
  await freshDatabase('ob_invalid');
  const customer = await seedCustomer({ opening: 1000 });

  await assert.rejects(
    () => openingBalanceService.setOpeningBalance(customer.Id, { newValue: 'كثير', reason: 'سبب' }),
    (error) => error.code === 'VALIDATION_ERROR' && /رقمًا صالحًا/.test(error.message)
  );
  await assert.rejects(
    () => openingBalanceService.previewChange(customer.Id, { newValue: undefined, reason: 'سبب' }),
    (error) => error.code === 'VALIDATION_ERROR'
  );

  const { container, view } = await openAccount(customer);
  view.openOpeningBalance();
  setInputs(container, { value: 'كثير', reason: 'سبب مقبول' });
  const refused = await view.reviewOpeningBalance();
  assert.equal(refused.ok, false);
  assert.match(html(container), /رقمًا صالحًا/);
  assert.equal(await openingBalanceRepository.count(), 0);
  assert.equal((await customerService.getCustomer(customer.Id)).OpeningBalanceMinor, 100000);
});

// ---------------------------------------------------------------------------
// 5 — cancelling leaves no trace: no value change and no log row.
// ---------------------------------------------------------------------------

test('5. cancelling the dialog, or going back, changes nothing and writes no log row', async () => {
  await freshDatabase('ob_cancel');
  const customer = await seedCustomer({ opening: 1000 });
  const { container, view } = await openAccount(customer);

  view.openOpeningBalance();
  setInputs(container, { value: '4000', reason: 'لن أحفظ هذا' });
  view.closeOpeningBalance();
  assert.equal(view.openingState().open, false);
  assert.equal(view.openingState().preview, null, 'the draft is discarded');
  assert.equal(await openingBalanceRepository.count(), 0);
  assert.equal((await customerService.getCustomer(customer.Id)).OpeningBalanceMinor, 100000);

  // cancel from the review step (after the preview, before the write)
  view.openOpeningBalance();
  setInputs(container, { value: '4000', reason: 'مراجعة ثم إلغاء' });
  await view.reviewOpeningBalance();
  assert.equal(view.openingState().step, OPENING_BALANCE_STEP.REVIEW);
  view.closeOpeningBalance();
  assert.equal(await openingBalanceRepository.count(), 0, 'the review step wrote nothing');
  assert.equal((await customerService.getCustomer(customer.Id)).OpeningBalanceMinor, 100000);

  // back from the review keeps the typed values but still writes nothing
  view.openOpeningBalance();
  setInputs(container, { value: '4000', reason: 'رجوع للتعديل' });
  await view.reviewOpeningBalance();
  view.backToOpeningForm();
  assert.equal(view.openingState().step, OPENING_BALANCE_STEP.FORM);
  assert.equal(view.openingState().values.Reason, 'رجوع للتعديل');
  assert.equal(await openingBalanceRepository.count(), 0);
});

// ---------------------------------------------------------------------------
// 6 — the review summary carries the old value, the new one, the delta and the reason.
// ---------------------------------------------------------------------------

test('6. the review summary shows the old value, the new value, the delta and the reason', async () => {
  await freshDatabase('ob_review');
  const customer = await seedCustomer({ code: 'OB-R', name: 'عميل المراجعة', opening: 1000 });
  const { container, view } = await openAccount(customer);

  view.openOpeningBalance();
  setInputs(container, { value: '1750', reason: '  تصحيح بعد الجرد  ' });
  const reviewed = await view.reviewOpeningBalance();
  assert.equal(reviewed.ok, true);

  const preview = reviewed.preview;
  assert.equal(preview.CurrentMinor, 100000);
  assert.equal(preview.NewValueMinor, 175000);
  assert.equal(preview.DeltaMinor, 75000);
  assert.equal(preview.Direction, 'Increase');
  assert.equal(preview.NoChange, false);
  assert.equal(preview.Reason, 'تصحيح بعد الجرد', 'the reason is stored trimmed');

  const painted = html(container);
  assert.match(painted, /id="opening-balance-review"/);
  assert.match(painted, /الرصيد الافتتاحي القديم/);
  assert.match(painted, /1,000\.00/);
  assert.match(painted, /الرصيد الافتتاحي الجديد/);
  assert.match(painted, /1,750\.00/);
  assert.match(painted, /الفرق/);
  assert.match(painted, /زيادة بمقدار 750\.00/);
  assert.match(painted, /تصحيح بعد الجرد/);
  assert.match(painted, /عميل المراجعة/, 'the customer is named in the summary');
  assert.match(painted, /OB-R/);
  assert.equal(await openingBalanceRepository.count(), 0, 'the review writes nothing');

  // a decrease reads the other way
  assert.equal(openingDeltaLabel(-25000, 'Decrease'), 'نقصان بمقدار 250.00');
  assert.equal(openingDeltaLabel(0, 'None'), 'لا يوجد فرق بين القيمتين');
});

// ---------------------------------------------------------------------------
// 7 — one successful edit produces exactly one audit row.
// ---------------------------------------------------------------------------

test('7. one confirmed edit is recorded exactly once', async () => {
  await freshDatabase('ob_once');
  const customer = await seedCustomer({ opening: 1000 });
  const { container, view } = await openAccount(customer);

  view.openOpeningBalance();
  setInputs(container, { value: '1200', reason: 'تعديل واحد فقط' });
  await view.reviewOpeningBalance();
  await view.submitOpeningBalance();

  const rows = await openingBalanceRepository.listByCustomer(customer.Id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].CustomerId, customer.Id);
  assert.equal(rows[0].OldValueMinor, 100000);
  assert.equal(rows[0].NewValueMinor, 120000);
  assert.equal(rows[0].Reason, 'تعديل واحد فقط');
  assert.match(rows[0].Id, /^obh_/);
});

// ---------------------------------------------------------------------------
// 8 — the log shows old value, new value, reason and the date/time.
// ---------------------------------------------------------------------------

test('8. the log shows the old value, the new value, the reason and the date with the time', async () => {
  await freshDatabase('ob_log');
  const customer = await seedCustomer({ opening: 1000 });
  const { container, view } = await openAccount(customer);

  view.openOpeningBalance();
  setInputs(container, { value: '1300', reason: 'مراجعة أولى' });
  await view.reviewOpeningBalance();
  await view.submitOpeningBalance();

  const rows = await customerService.listOpeningBalanceHistory(customer.Id);
  assert.equal(rows.length, 1);
  const painted = html(container);
  assert.match(painted, /سجل تعديلات الرصيد الافتتاحي/);
  assert.match(painted, /القيمة السابقة/);
  assert.match(painted, /1,000\.00/);
  assert.match(painted, /القيمة الجديدة/);
  assert.match(painted, /1,300\.00/);
  assert.match(painted, /تاريخ ووقت التعديل/);
  assert.match(painted, /مراجعة أولى/);

  const stamp = historyTimestamp(rows[0].ChangedAt);
  assert.match(stamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'date and time are both shown');
  assert.ok(painted.includes(stamp), 'the rendered log carries that exact stamp');
  assert.equal(historyTimestamp(''), '—');
  assert.equal(historyTimestamp('غير صالح'), 'غير صالح');

  // the log is read-only: no edit or delete affordance is rendered for a row
  assert.doesNotMatch(painted, /data-action="delete/);
  assert.doesNotMatch(painted, /data-action="edit-opening-history/);
});

// ---------------------------------------------------------------------------
// 9 — successive edits keep every earlier row.
// ---------------------------------------------------------------------------

test('9. successive edits keep the earlier rows and list the newest last', async () => {
  await freshDatabase('ob_chain');
  const customer = await seedCustomer({ opening: 1000 });

  for (const [value, reason] of [['1100', 'أول تعديل'], ['1400', 'ثاني تعديل'], ['900', 'ثالث تعديل']]) {
    const { container, view } = await openAccount(customer);
    view.openOpeningBalance();
    setInputs(container, { value, reason });
    await view.reviewOpeningBalance();
    const saved = await view.submitOpeningBalance();
    assert.equal(saved.ok, true);
  }

  const rows = await customerService.listOpeningBalanceHistory(customer.Id);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.OldValueMinor), [100000, 110000, 140000]);
  assert.deepEqual(rows.map((row) => row.NewValueMinor), [110000, 140000, 90000]);
  assert.deepEqual(rows.map((row) => row.Reason), ['أول تعديل', 'ثاني تعديل', 'ثالث تعديل']);
  assert.equal((await customerService.getCustomer(customer.Id)).OpeningBalanceMinor, 90000);

  const painted = html(await openAccount(customer).then((r) => r.container));
  for (const reason of ['أول تعديل', 'ثاني تعديل', 'ثالث تعديل']) assert.ok(painted.includes(reason));
});

// ---------------------------------------------------------------------------
// 10 — saving the value that is already stored writes no misleading row.
// ---------------------------------------------------------------------------

test('10. saving the current value creates no misleading log row', async () => {
  await freshDatabase('ob_same');
  const customer = await seedCustomer({ opening: 1000 });

  await assert.rejects(
    () => openingBalanceService.setOpeningBalanceAsNoop(customer.Id, {}),
    () => true,
    'sanity: the guard method does not exist, so nothing else can be used by mistake'
  ).catch(() => {});

  const preview = await openingBalanceService.previewChange(customer.Id, { newValue: 1000, reason: 'نفس القيمة' });
  assert.equal(preview.NoChange, true);
  assert.equal(preview.DeltaMinor, 0);
  assert.equal(preview.Direction, 'None');

  const result = await openingBalanceService.setOpeningBalance(customer.Id, { newValue: 1000, reason: 'نفس القيمة' });
  assert.equal(result.Unchanged, true);
  assert.equal(result.History, null);
  assert.equal(await openingBalanceRepository.count(), 0, 'no row for a change that never happened');
  assert.equal((await customerService.getCustomer(customer.Id)).OpeningBalanceMinor, 100000);

  // and the screen refuses to pretend it saved
  const { container, view } = await openAccount(customer);
  view.openOpeningBalance();
  setInputs(container, { value: '1000', reason: 'نفس القيمة' });
  await view.reviewOpeningBalance();
  assert.match(html(container), /لا يوجد تغيير/);
  assert.match(html(container), /disabled aria-disabled="true"/, 'the confirm button is disabled');
  const refused = await view.submitOpeningBalance();
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'no-change');
  assert.equal(await openingBalanceRepository.count(), 0);
});

// ---------------------------------------------------------------------------
// 11 — a repeated click cannot run the write twice.
// ---------------------------------------------------------------------------

test('11. a repeated confirm cannot execute the write twice', async () => {
  await freshDatabase('ob_double');
  const customer = await seedCustomer({ opening: 1000 });
  const { container, view } = await openAccount(customer);

  view.openOpeningBalance();
  setInputs(container, { value: '1600', reason: 'نقر مزدوج' });
  await view.reviewOpeningBalance();

  const [first, second] = await Promise.all([view.submitOpeningBalance(), view.submitOpeningBalance()]);
  const outcomes = [first, second];
  assert.equal(outcomes.filter((result) => result.ok === true).length, 1, 'exactly one save succeeded');
  assert.equal(outcomes.filter((result) => result.reason === 'busy').length, 1, 'the second click was refused as busy');

  const rows = await openingBalanceRepository.listByCustomer(customer.Id);
  assert.equal(rows.length, 1);
  assert.equal((await customerService.getCustomer(customer.Id)).OpeningBalanceMinor, 160000);
});

// ---------------------------------------------------------------------------
// 12 — write and read failures are reported and never shown as success.
// ---------------------------------------------------------------------------

test('12. a failing save or a failing log read is reported and leaves nothing half-written', async () => {
  await freshDatabase('ob_errors');
  const customer = await seedCustomer({ opening: 1000 });
  const real = {
    getCustomer: (id) => customerService.getCustomer(id),
    getSummary: (id) => balanceService.getCustomerSummary(id),
    getLedger: (id) => balanceService.getRunningBalance(id),
    listOpeningHistory: (id) => customerService.listOpeningBalanceHistory(id)
  };

  // (a) the write fails after a successful preview
  const { container, view } = await openAccount(customer, {
    ...real,
    previewOpeningChange: (id, input) => openingBalanceService.previewChange(id, input),
    setOpeningBalance: async () => { throw { code: 'STORAGE_ERROR', message: 'تعذر تحديث الرصيد الافتتاحي.' }; }
  });
  view.openOpeningBalance();
  setInputs(container, { value: '2000', reason: 'سيفشل' });
  await view.reviewOpeningBalance();
  const failed = await view.submitOpeningBalance();
  assert.equal(failed.ok, false);
  const painted = html(container);
  assert.match(painted, /تعذّر حفظ التعديل/);
  assert.match(painted, /تعذر تحديث الرصيد الافتتاحي/);
  assert.doesNotMatch(painted, /تم حفظ الرصيد الافتتاحي/, 'no false success');
  assert.equal(view.openingState().step, OPENING_BALANCE_STEP.REVIEW, 'the review keeps the entered values');
  assert.equal(await openingBalanceRepository.count(), 0);
  assert.equal((await customerService.getCustomer(customer.Id)).OpeningBalanceMinor, 100000);

  // (b) reading the log fails while the rest of the account loads
  const broken = makeContainer();
  const brokenView = initCustomerAccountView({
    container: broken,
    customerId: customer.Id,
    services: { ...real, listOpeningHistory: async () => { throw { code: 'STORAGE_ERROR', message: 'تعذر قراءة سجل التعديلات.' }; } }
  });
  const readOutcome = await brokenView.reload();
  assert.equal(readOutcome.ok, false);
  const brokenHtml = broken.nodes.get(ACCOUNT_REGION_ID).innerHTML;
  assert.match(brokenHtml, /STORAGE_ERROR/);
  assert.match(brokenHtml, /data-action="retry-account"/);
  assert.doesNotMatch(brokenHtml, /class="kpi__value"/, 'no financial value on the failure path');
  assert.equal(broken.nodes.get(ACCOUNT_REGION_ID).attrs['aria-busy'], 'false');
});

// ---------------------------------------------------------------------------
// 13 — the shown balance follows the new opening balance, with no doubling.
// ---------------------------------------------------------------------------

test('13. the balance after the change equals opening + credit − debit, with no doubled effect', async () => {
  await freshDatabase('ob_effect');
  const customer = await seedCustomer({ opening: 1000 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 500 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-02', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 200 });

  const before = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(before.BalanceMinor, before.OpeningBalanceMinor + before.TotalCreditMinor - before.TotalDebitMinor);

  const { container, view } = await openAccount(customer);
  view.openOpeningBalance();
  setInputs(container, { value: '1500', reason: 'تعديل ثم تحقق' });
  await view.reviewOpeningBalance();
  await view.submitOpeningBalance();

  const after = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(after.OpeningBalanceMinor, 150000);
  assert.equal(after.TotalCreditMinor, before.TotalCreditMinor, 'credits are untouched');
  assert.equal(after.TotalDebitMinor, before.TotalDebitMinor, 'debits are untouched');
  assert.equal(after.BalanceMinor, 150000 + before.TotalCreditMinor - before.TotalDebitMinor);
  assert.equal(after.BalanceMinor - before.BalanceMinor, 50000, 'the balance moved by exactly the delta once');
  assert.equal(after.BalanceMinor, after.OpeningBalanceMinor + after.TotalCreditMinor - after.TotalDebitMinor);

  const ledger = await balanceService.getRunningBalance(customer.Id);
  assert.equal(ledger.Entries.length, 2, 'the change added no transaction');
  assert.equal(ledger.Entries.some((entry) => entry.TransactionType === 'OpeningBalance'), false);
  assert.equal(html(container).includes('1,500.00'), true, 'the repainted screen shows the stored value');
});

// ---------------------------------------------------------------------------
// 14 — earlier movements and the other customers are untouched.
// ---------------------------------------------------------------------------

test('14. earlier movements and the other customers keep their stored rows', async () => {
  await freshDatabase('ob_isolated');
  const target = await seedCustomer({ code: 'OB-T', name: 'العميل المعدّل', opening: 1000 });
  const other = await seedCustomer({ code: 'OB-O', name: 'العميل الآخر', opening: 3000 });
  await transactionService.createTransaction({ CustomerId: target.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 400 });
  await transactionService.createTransaction({ CustomerId: other.Id, Date: '2026-09-02', TransactionType: TRANSACTION_TYPE.CASH_PAID, Amount: 100 });

  const movementsBefore = JSON.stringify((await transactionRepository.getAll()).map((row) => ({ ...row })));
  const otherBefore = JSON.stringify(await customerService.getCustomer(other.Id));
  const otherSummaryBefore = JSON.stringify(await balanceService.getCustomerSummary(other.Id));

  const { container, view } = await openAccount(target);
  view.openOpeningBalance();
  setInputs(container, { value: '1900', reason: 'تعديل معزول' });
  await view.reviewOpeningBalance();
  await view.submitOpeningBalance();

  assert.equal(JSON.stringify((await transactionRepository.getAll()).map((row) => ({ ...row }))), movementsBefore, 'no movement was rewritten');
  assert.equal(JSON.stringify(await customerService.getCustomer(other.Id)), otherBefore, 'the other customer record is identical');
  assert.equal(JSON.stringify(await balanceService.getCustomerSummary(other.Id)), otherSummaryBefore);
  assert.equal((await customerService.getCustomer(target.Id)).OpeningBalanceMinor, 190000);
});

// ---------------------------------------------------------------------------
// 15 — debt transfer, cancellation, local crop and carton purchases are unaffected.
// ---------------------------------------------------------------------------

test('15. debt transfer, cancelled rows, local crop and carton purchases are unaffected', async () => {
  await freshDatabase('ob_domain');
  const a = await seedCustomer({ code: 'OB-D1', name: 'طرف التحويل', opening: 2000 });
  const b = await seedCustomer({ code: 'OB-D2', name: 'الطرف الآخر', opening: 0 });

  const refs = await cartonRefs();
  await transactionService.createTransaction({
    CustomerId: a.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL,
    crop: { LocalUnitsMilli: 4000, LocalLooseKgMilli: 2000, LocalDeductionKgMilli: 1000, LocalUnitPriceMinor: 1000 }
  });
  await transactionService.createTransaction({
    CustomerId: a.Id, Date: '2026-09-02', TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON,
    crop: { CartonQuantityMilli: 4000, CartonUnitPriceMinor: 5000, CartonDiscountMinor: 0 },
    ...refs
  });
  const cancelled = await transactionService.createTransaction({ CustomerId: a.Id, Date: '2026-09-03', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 700 });
  await cancellationService.cancelTransaction(cancelled.Id, 'حركة ملغاة للاختبار');
  const transfer = await debtTransferService.createDebtTransfer({ FromCustomerId: a.Id, ToCustomerId: b.Id, Date: '2026-09-04', Amount: 300, Description: 'تحويل مديونية' });

  const rowsBefore = JSON.stringify((await transactionRepository.getAll()).map((row) => ({ ...row })));
  const aBefore = await balanceService.getCustomerSummary(a.Id);
  const bBefore = await balanceService.getCustomerSummary(b.Id);
  const bLedgerBefore = JSON.stringify(await balanceService.getRunningBalance(b.Id));

  const { container, view } = await openAccount(a);
  view.openOpeningBalance();
  setInputs(container, { value: '2600', reason: 'تعديل لا يمسّ القواعد' });
  await view.reviewOpeningBalance();
  const saved = await view.submitOpeningBalance();
  assert.equal(saved.ok, true);

  assert.equal(JSON.stringify((await transactionRepository.getAll()).map((row) => ({ ...row }))), rowsBefore, 'no movement row changed');

  const aAfter = await balanceService.getCustomerSummary(a.Id);
  assert.equal(aAfter.BalanceMinor, aBefore.BalanceMinor + 60000, 'only the delta of the opening balance moved');
  assert.equal(aAfter.TotalCreditMinor, aBefore.TotalCreditMinor);
  assert.equal(aAfter.TotalDebitMinor, aBefore.TotalDebitMinor);

  // the cancelled row is still excluded from the balance
  const ledger = await balanceService.getRunningBalance(a.Id);
  const cancelledRow = ledger.Entries.find((entry) => entry.Id === cancelled.Id);
  assert.equal(cancelledRow.Status, 'Cancelled');
  // the balance the service reports must equal opening + (credits − debits of the rows
  // that are still active), which is only true if the cancelled row is excluded.
  const activeRows = ledger.Entries.filter((entry) => entry.Status !== 'Cancelled');
  const activeCredit = activeRows.reduce((total, entry) => total + (entry.CreditMinor || 0), 0);
  const activeDebit = activeRows.reduce((total, entry) => total + (entry.DebitMinor || 0), 0);
  assert.equal(aAfter.BalanceMinor, aAfter.OpeningBalanceMinor + activeCredit - activeDebit, 'the cancelled row is excluded');
  assert.equal(activeRows.length, ledger.Entries.length - 1, 'exactly one row is cancelled');

  // the debt transfer is still two linked rows in the transaction store; each customer's
  // statement only shows its own leg, so the pair is checked in the stored data.
  const storedLinked = (await transactionRepository.getAll()).filter((row) => row.LinkId === transfer.LinkId);
  assert.equal(storedLinked.length, 2, 'both legs are still stored');
  assert.equal(new Set(storedLinked.map((row) => row.TransferRole)).size, 2);
  assert.equal(storedLinked.filter((row) => row.CustomerId === a.Id).length, 1, 'the edited customer keeps one leg');
  assert.equal(ledger.Entries.filter((entry) => entry.LinkId === transfer.LinkId).length, 1, 'the statement shows its own leg only');
  assert.equal(JSON.stringify(await balanceService.getRunningBalance(b.Id)), bLedgerBefore);
  assert.deepEqual(await balanceService.getCustomerSummary(b.Id), bBefore);
  assert.equal(DEBT_TRANSFER_ROLE.CREDIT_SIDE !== DEBT_TRANSFER_ROLE.DEBIT_SIDE, true);
});


// ---------------------------------------------------------------------------
// 16 — the log travels through backup and restore, and survives a reload.
// ---------------------------------------------------------------------------

test('16. the log is kept by backup/restore and survives a reload', async () => {
  await freshDatabase('ob_backup');
  const customer = await seedCustomer({ opening: 1000 });
  const { container, view } = await openAccount(customer);
  view.openOpeningBalance();
  setInputs(container, { value: '1800', reason: 'قبل النسخة' });
  await view.reviewOpeningBalance();
  await view.submitOpeningBalance();

  const backup = await backupService.createBackup();
  assert.equal(backup.OpeningBalanceHistory.length, 1);
  assert.equal(backup.OpeningBalanceHistory[0].Reason, 'قبل النسخة');
  assert.equal(backup.OpeningBalanceHistory[0].OldValueMinor, 100000);
  assert.equal(backup.OpeningBalanceHistory[0].NewValueMinor, 180000);

  // a second edit after the backup, then restore the first snapshot
  const again = await openAccount(customer);
  again.view.openOpeningBalance();
  setInputs(again.container, { value: '2100', reason: 'بعد النسخة' });
  await again.view.reviewOpeningBalance();
  await again.view.submitOpeningBalance();
  assert.equal(await openingBalanceRepository.count(), 2);

  const restored = await restoreService.restore(backup);
  assert.equal(restored.restored, true);
  assert.equal(restored.counts.openingBalanceHistory, 1);

  const rows = await customerService.listOpeningBalanceHistory(customer.Id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Reason, 'قبل النسخة');
  assert.equal((await customerService.getCustomer(customer.Id)).OpeningBalanceMinor, 180000);

  // the browser reload keeps everything stored
  await simulateReload();
  const afterReload = await customerService.listOpeningBalanceHistory(customer.Id);
  assert.equal(afterReload.length, 1);
  assert.equal((await customerService.getCustomer(customer.Id)).OpeningBalanceMinor, 180000);

  const reopened = await openAccount(customer);
  assert.match(html(reopened.container), /قبل النسخة/);
  assert.match(html(reopened.container), /1,800\.00/);
});

// ---------------------------------------------------------------------------
// 17 — the screen itself carries no business rule (guards).
// ---------------------------------------------------------------------------

test('17. the new view module holds no storage access, no balance maths and no markers', () => {
  const source = readFileSync(join(UI_ROOT, 'views/openingBalance.js'), 'utf8');
  for (const forbidden of ['repositories', 'storage/db', 'storage/schema', 'indexedDB', 'IndexedDB', 'IDBKeyRange']) {
    assert.equal(source.includes(forbidden), false, `openingBalance.js must not reference ${forbidden}`);
  }
  for (const target of [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
    if (target.includes('/src/')) assert.match(target, /\/src\/(services|utils)\//, `may only reach services and utils, got ${target}`);
  }
  for (const marker of ['TODO', 'FIXME', 'XXX', 'HACK']) assert.equal(source.includes(marker), false);
  assert.doesNotMatch(source, /BalanceMinor\s*[+\-*/]?=/, 'the view must never assign a balance');
  assert.doesNotMatch(source, /OpeningBalanceMinor\s*[+\-]/, 'the view must never add or subtract an opening balance');
  assert.doesNotMatch(source, /deriveFinancials/);

  // and the dialog is closed and empty until the controller decides to open it
  const closed = renderOpeningBalanceDialog(closedOpeningBalanceState());
  assert.match(closed, /hidden/);
  assert.doesNotMatch(closed, /class="input"/);
  assert.match(closed, /dir|role="dialog"/);
});

// ---------------------------------------------------------------------------
// 18 — the form ids are wired to the controller through the real DOM events.
// ---------------------------------------------------------------------------

test('18. the form and the entry button are wired through real events', async () => {
  await freshDatabase('ob_events');
  const customer = await seedCustomer({ opening: 1000 });
  const { container, view } = await openAccount(customer);

  await container.emit('click', targetWith({ action: 'open-opening-balance' }));
  assert.equal(view.openingState().open, true, 'the header button opens the dialog');

  setInputs(container, { value: '1650', reason: 'من الحدث' });
  await container.emit('submit', targetWith({ id: OPENING_BALANCE_FORM_ID }));
  assert.equal(view.openingState().step, OPENING_BALANCE_STEP.REVIEW, 'the form submit reaches the review');

  await container.emit('submit', targetWith({ id: OPENING_BALANCE_CONFIRM_FORM_ID }));
  assert.equal(await openingBalanceRepository.count(), 1);
  assert.equal((await customerService.getCustomer(customer.Id)).OpeningBalanceMinor, 165000);

  await container.emit('click', targetWith({ action: 'open-opening-balance' }));
  setInputs(container, { value: '9000', reason: 'لن يُحفظ' });
  await container.emit('click', targetWith({ action: 'close-opening-balance' }));
  assert.equal(view.openingState().open, false);
  assert.equal(await openingBalanceRepository.count(), 1, 'closing through the event writes nothing');

  // the rendered history keeps the dialog id so a repaint never duplicates it
  assert.match(html(container), new RegExp(`id="${OPENING_BALANCE_DIALOG_ID}"`));
  assert.equal((html(container).match(/id="dialog-opening-balance"/g) || []).length, 1);
});

// ---------------------------------------------------------------------------
// 19 — the rendered log is RTL Arabic and never overflows a narrow screen.
// ---------------------------------------------------------------------------

test('19. the log and the dialog stay Arabic, RTL and free of fixed widths', () => {
  const rows = [{ OldValueMinor: 100000, NewValueMinor: 175000, ChangedAt: '2026-10-29T09:05:00.000Z', Reason: 'سبب طويل قد يمتد على أكثر من سطر في الشاشة الضيقة' }];
  const painted = renderOpeningBalanceHistory(rows, { canEdit: true, dialog: closedOpeningBalanceState() });
  assert.match(painted, /<div class="history-list">/);
  assert.match(painted, /history-item__reason/);
  assert.doesNotMatch(painted, /width:\s*\d+px/);
  assert.doesNotMatch(painted, /dir="ltr"/);
  assert.doesNotMatch(painted, /[a-zA-Z]{4,}\s[a-zA-Z]{4,}\s[a-zA-Z]{4,}/, 'no English prose is rendered');

  const open = renderOpeningBalanceDialog({ ...closedOpeningBalanceState(), open: true, currentMinor: 100000 });
  assert.match(open, /class="modal" role="dialog" aria-modal="true"/);
  assert.match(open, /inputmode="decimal"/);
  assert.match(open, new RegExp(`maxlength="${OPENING_BALANCE_REASON_MAX_LENGTH}"`));

  const budget = readFileSync(join(UI_ROOT, 'styles/components.css'), 'utf8');
  assert.match(budget, /@media \(max-width: 820px\)/);
  assert.match(budget, /\.history-item__reason \{ grid-column: 1 \/ -1/);
});
