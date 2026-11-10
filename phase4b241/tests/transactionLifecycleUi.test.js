// Phase 4B.6 — the statement actions, the dialogs and the audit panel.
// The controller is driven through a detached container so the real services run
// underneath; the render projections are asserted directly. No financial service is
// ever replaced by a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { freshDatabase } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { transactionLifecycleService } from '../src/services/transactionLifecycleService.js';
import { balanceService } from '../src/services/balanceService.js';
import { debtTransferService } from '../src/services/debtTransferService.js';
import { TRANSACTION_TYPE } from '../src/domain/transactionTypes.js';
import { logger } from '../src/utils/logger.js';
import {
  ACCOUNT_REGION_ID, LEDGER_REGION_ID, TOOLBAR_REGION_ID, AUDIT_REGION_ID,
  LEDGER_COLUMNS, ledgerRow, customerAccountHtml, initCustomerAccountView, renderAuditSection
} from '../ui/views/customerAccount.js';
import {
  TRANSACTION_DIALOGS_ID, TRANSACTION_FEEDBACK_ID, EDIT_FORM_ID, CANCEL_FORM_ID,
  EDIT_AMOUNT_ID, EDIT_DATE_ID, EDIT_DESCRIPTION_ID, EDIT_REASON_ID, EDIT_DIRECTION_ID,
  CANCEL_REASON_ID, renderEditDialog, renderCancelDialog, renderAuditTrail, renderAuditEntry,
  rowActionsCell, renderEditFields, majorFromMinor
} from '../ui/views/transactionActions.js';
import { renderDestinationView } from '../ui/views/index.js';
import { customerAccountPath, matchCustomerSubroute } from '../ui/routes.js';

logger.disable?.();

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

const REGION_IDS = [ACCOUNT_REGION_ID, LEDGER_REGION_ID, TOOLBAR_REGION_ID, AUDIT_REGION_ID, TRANSACTION_DIALOGS_ID, TRANSACTION_FEEDBACK_ID];

// A detached container: it holds the region nodes and the input values, records the
// listeners so a synthetic event can be dispatched, and performs no DOM work itself.
function makeContainer({ values = {} } = {}) {
  const nodes = new Map(REGION_IDS.map((id) => [id, { innerHTML: '', attrs: {}, setAttribute(key, value) { this.attrs[key] = value; }, getAttribute(key) { return this.attrs[key]; } }]));
  const listeners = {};
  const fields = new Map(Object.entries(values).map(([id, value]) => [id, { value }]));
  return {
    nodes,
    attrs: {},
    listeners,
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key]; },
    addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
    dispatch(type, target) { (listeners[type] || []).forEach((handler) => handler({ target, preventDefault() {} })); },
    querySelector(selector) {
      const id = String(selector).replace(/^#/, '');
      return nodes.get(id) || fields.get(id) || null;
    },
    setField(id, value) { fields.set(id, { value }); }
  };
}

function clickTarget(action, transactionId) {
  return {
    getAttribute(name) { return name === 'data-transaction-id' ? transactionId : null; },
    closest(selector) { return selector === `[data-action="${action}"]` ? this : null; }
  };
}

function formTarget(formId) {
  return { getAttribute(name) { return name === 'id' ? formId : null; } };
}

async function seedCustomer({ code = 'C-800', opening = 1000 } = {}) {
  return customerService.createCustomer({ Code: code, Name: 'مزارع واجهة الإجراءات', Phone: '0111111111', Region: 'دمنهور', OpeningBalance: opening });
}

async function seedSale(customerId, { amount = 300, date = '2026-09-01', description = 'بيع مبيدات' } = {}) {
  return transactionService.createTransaction({
    CustomerId: customerId, Date: date, TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: amount, Description: description
  });
}

// ---------------------------------------------------------------------------
// The action cell inside the approved ten-column statement.
// ---------------------------------------------------------------------------

test('the statement keeps its ten approved columns and hosts the actions in the status cell', async () => {
  await freshDatabase('ui_actions_columns');
  const customer = await seedCustomer();
  const record = await seedSale(customer.Id);

  const row = ledgerRow({
    Id: record.Id, Date: record.Date, TransactionType: record.TransactionType, Description: record.Description,
    DebitMinor: 30000, CreditMinor: 0, CashReceivedMinor: 0, CashPaidMinor: 0, SettlementMinor: 0,
    RunningBalanceMinor: 70000, IsCancelled: false, CanEdit: true, CanCancel: true
  });

  assert.equal(LEDGER_COLUMNS.length, 10, 'the approved layout is unchanged');
  assert.equal(row.cells.length, 10);
  assert.match(row.cells[9], /نشطة/);
  assert.match(row.cells[9], /data-action="edit-transaction"/);
  assert.match(row.cells[9], /data-action="cancel-transaction"/);
  assert.match(row.cells[9], /data-action="view-audit"/);
});

test('actions that are not allowed for a movement are not offered at all', async () => {
  await freshDatabase('ui_actions_blocked');
  const customer = await seedCustomer();
  const record = await seedSale(customer.Id);

  const cancelledRow = ledgerRow({ Id: record.Id, IsCancelled: true, CancellationReason: 'ملغاة للاختبار', CanEdit: false, CanCancel: false });
  assert.equal(cancelledRow.cells[9].includes('data-action="edit-transaction"'), false);
  assert.equal(cancelledRow.cells[9].includes('data-action="cancel-transaction"'), false);
  assert.match(cancelledRow.cells[9], /سجل التدقيق/);
  assert.equal(cancelledRow.className, 'ledger-row--cancelled');

  const linked = rowActionsCell({ Id: 'trx-1', CanEdit: false, CanCancel: false });
  assert.equal(linked.includes('data-action="edit-transaction"'), false);
  assert.equal(linked.includes('data-action="cancel-transaction"'), false);
});

// ---------------------------------------------------------------------------
// The dialogs render the stored values and require a reason.
// ---------------------------------------------------------------------------

test('the edit dialog shows the stored values, keeps the Id visible and asks for a reason', async () => {
  await freshDatabase('ui_edit_dialog');
  const customer = await seedCustomer();
  const record = await seedSale(customer.Id, { amount: 300, description: 'قيمة محفوظة' });

  const html = renderEditDialog({ record });

  assert.match(html, new RegExp(record.Id));
  assert.match(html, /value="300"/, 'the stored amount is pre-filled in major units');
  assert.match(html, /value="قيمة محفوظة"/);
  assert.match(html, new RegExp(EDIT_REASON_ID));
  assert.match(html, /سبب التعديل \(إلزامي\)/);
  assert.match(html, /id="edit-submit"/);
  assert.doesNotMatch(html, /CreditMinor|DebitMinor|SettlementMinor/, 'no derived value is offered as input');
});

test('a crop purchase dialog offers the crop inputs and never an amount field', async () => {
  await freshDatabase('ui_edit_crop_dialog');
  const customer = await seedCustomer();
  const form = await import('../src/services/transactionFormService.js');
  const result = await form.transactionFormService.submitTransactionForm({
    TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, CustomerId: customer.Id, Date: '2026-09-02',
    Units: 10, LooseKg: 0, DeductionKg: 0, UnitPrice: 5
  });
  const record = result.Record;

  const html = renderEditDialog({ record });

  assert.match(html, /عدد العبوات \(D\)/);
  assert.match(html, /سعر الكيلو \(H\)/);
  assert.equal(html.includes(`id="${EDIT_AMOUNT_ID}"`), false, 'the derived amount is never an editable field');
  assert.equal(majorFromMinor(record.AmountMinor, 100), '700');
});

test('the Settlement dialog keeps the explicit direction and the cancel dialog asks for a reason and a confirmation', async () => {
  await freshDatabase('ui_direction_dialog');
  const customer = await seedCustomer({ opening: 5000 });
  const form = await import('../src/services/transactionFormService.js');
  const result = await form.transactionFormService.submitTransactionForm({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-09-03', Amount: 200, Direction: 'Debit'
  });

  const editHtml = renderEditDialog({ record: result.Record });
  assert.match(editHtml, new RegExp(EDIT_DIRECTION_ID));
  assert.match(editHtml, /خصم من رصيد المزارع — مدين/);
  assert.match(editHtml, /value="Debit" selected/);

  const cancelHtml = renderCancelDialog({ record: result.Record });
  assert.match(cancelHtml, /سبب الإلغاء \(إلزامي\)/);
  assert.match(cancelHtml, /تأكيد مطلوب/);
  assert.match(cancelHtml, /تأكيد الإلغاء/);
});

test('the edit dialog reports a refusal instead of showing a form', async () => {
  const html = renderEditDialog({ record: null, editability: { CanEdit: false, EditReason: 'هذه الحركة مرتبطة بحركة أخرى.' } });
  assert.match(html, /التعديل غير متاح/);
  assert.match(html, /مرتبطة بحركة أخرى/);
  assert.equal(html.includes(EDIT_FORM_ID), false);
});

// ---------------------------------------------------------------------------
// The audit panel.
// ---------------------------------------------------------------------------

test('the audit panel renders each event with its reason and both sides', async () => {
  const entry = {
    Id: 'aud-1', TransactionId: 'trx-1', EventType: 'TransactionEdited', OccurredAt: '2026-10-12T09:00:00.000Z',
    Reason: 'تصحيح مبلغ', ActorId: null,
    Previous: { Date: '2026-09-01', AmountMinor: 30000, Description: 'قبل', Direction: 'Credit', DebitMinor: 30000, CreditMinor: 0 },
    Next: { Date: '2026-09-01', AmountMinor: 45000, Description: 'بعد', Direction: 'Credit', DebitMinor: 45000, CreditMinor: 0 }
  };
  const html = renderAuditTrail({ transactionId: 'trx-1', entries: [entry] });

  assert.match(html, /سجل التدقيق — trx-1/);
  assert.match(html, /تعديل حركة/);
  assert.match(html, /تصحيح مبلغ/);
  assert.match(html, /القيم قبل العملية/);
  assert.match(html, /القيم بعد العملية/);
  assert.match(html, /300\.00/);
  assert.match(html, /450\.00/);
  assert.match(html, /مدين/);
  assert.match(html, /عدد أحداث سجل التدقيق/);
  assert.equal(html.includes('data-action="edit-audit"'), false, 'no edit affordance exists for the log');
  assert.equal(html.includes('data-action="delete-audit"'), false, 'no delete affordance exists for the log');
});

test('the audit panel explains an empty history and the cancellation event', async () => {
  const empty = renderAuditTrail({ transactionId: 'trx-2', entries: [] });
  assert.match(empty, /لا توجد تعديلات أو إلغاءات مسجلة/);

  const cancelled = renderAuditEntry({
    Id: 'aud-2', TransactionId: 'trx-2', EventType: 'TransactionCancelled', OccurredAt: '2026-10-12T10:00:00.000Z',
    Reason: 'فاتورة مكررة', Previous: { Date: '2026-09-01', AmountMinor: 30000, CancellationReason: null }, Next: null
  });
  assert.match(cancelled, /إلغاء حركة/);
  assert.match(cancelled, /فاتورة مكررة/);
  assert.equal(cancelled.includes('القيم بعد العملية'), false);
});

test('the audit region is part of the statement page', async () => {
  await freshDatabase('ui_audit_region');
  const customer = await seedCustomer();
  const record = await seedSale(customer.Id);
  const html = customerAccountHtml({ customer, summary: { BalanceMinor: 0, BalanceSide: 'Zero' }, ledger: { Entries: [] }, audit: { transactionId: null, entries: [] } });
  assert.match(html, new RegExp(`id="${AUDIT_REGION_ID}"`));
  assert.match(html, new RegExp(`id="${TRANSACTION_DIALOGS_ID}"`));
  assert.match(html, /id="dialog-edit-transaction"/);
  assert.match(html, /id="dialog-cancel-transaction"/);
  assert.match(html, /سجل التدقيق/);
  // The dialog forms exist once a movement has been selected for the action.
  const withForm = customerAccountHtml({ customer, summary: { BalanceMinor: 0, BalanceSide: 'Zero' }, ledger: { Entries: [] }, dialogs: { edit: { record } } });
  assert.match(withForm, new RegExp(`id="${EDIT_FORM_ID}"`));
});

// ---------------------------------------------------------------------------
// The controller: the whole loop through the real services.
// ---------------------------------------------------------------------------

test('editing from the statement updates the row, the balance and the audit panel', async () => {
  await freshDatabase('ui_controller_edit');
  const customer = await seedCustomer({ opening: 1000 });
  const record = await seedSale(customer.Id, { amount: 300 });
  const container = makeContainer({ values: { [EDIT_AMOUNT_ID]: '450', [EDIT_DATE_ID]: '2026-09-01', [EDIT_DESCRIPTION_ID]: 'بعد التعديل', [EDIT_REASON_ID]: 'تصحيح المبلغ' } });
  const view = initCustomerAccountView({ container, customerId: customer.Id, autoLoad: false });
  await view.reload();

  await view.openEdit(record.Id);
  assert.match(container.nodes.get(ACCOUNT_REGION_ID).innerHTML, new RegExp(EDIT_FORM_ID), 'the dialog opens with the stored values');

  const result = await view.submitEdit();
  assert.equal(result.ok, true);

  const accountHtml = container.nodes.get(ACCOUNT_REGION_ID).innerHTML;
  assert.match(accountHtml, /تم حفظ تعديل الحركة/);
  assert.match(accountHtml, /450\.00/);
  assert.match(accountHtml, /550\.00/, 'the running balance and the summary follow the edit');
  assert.match(accountHtml, /تصحيح المبلغ/);
  const stored = await transactionService.getTransaction(record.Id);
  assert.equal(stored.AmountMinor, 45000);
});

test('cancelling from the statement needs a reason and a confirmation, and the row stays visible', async () => {
  await freshDatabase('ui_controller_cancel');
  const customer = await seedCustomer({ opening: 1000 });
  const record = await seedSale(customer.Id, { amount: 300 });
  const container = makeContainer({ values: { [CANCEL_REASON_ID]: 'فاتورة مكررة' } });
  const view = initCustomerAccountView({ container, customerId: customer.Id, autoLoad: false });
  await view.reload();
  await view.openCancel(record.Id);

  const result = await view.submitCancel();
  assert.equal(result.ok, true);

  const html = container.nodes.get(ACCOUNT_REGION_ID).innerHTML;
  assert.match(html, /تم إلغاء الحركة/);
  assert.match(html, /ملغاة — فاتورة مكررة/);
  assert.match(html, /1,000\.00/, 'the cancelled movement no longer affects the balance');
  assert.match(html, /فاتورة مكررة/);
  const stored = await transactionService.getTransaction(record.Id);
  assert.equal(stored.Status, 'Cancelled');
  assert.equal(stored.CancellationReason, 'فاتورة مكررة');
});

test('a cancellation without a reason fails visibly and writes nothing', async () => {
  await freshDatabase('ui_controller_no_reason');
  const customer = await seedCustomer();
  const record = await seedSale(customer.Id, { amount: 300 });
  const container = makeContainer({ values: { [CANCEL_REASON_ID]: '' } });
  const view = initCustomerAccountView({ container, customerId: customer.Id, autoLoad: false });
  await view.reload();
  await view.openCancel(record.Id);

  const result = await view.submitCancel();
  assert.equal(result.ok, false);
  const html = container.nodes.get(ACCOUNT_REGION_ID).innerHTML;
  assert.equal(result.error.message, 'سبب إلغاء الحركة مطلوب.');
  assert.match(html, /role="alert"/, 'a visible failure state is rendered');
  assert.match(html, /سبب إلغاء الحركة مطلوب/, html.slice(-1600));
  const stored = await transactionService.getTransaction(record.Id);
  assert.notEqual(stored.Status, 'Cancelled');
  assert.equal((await transactionLifecycleService.listAuditTrail(record.Id)).length, 0);
});

test('a blocked movement is refused with an Arabic message instead of a form', async () => {
  await freshDatabase('ui_controller_blocked');
  const from = await customerService.createCustomer({ Code: 'C-810', Name: 'عميل دائن', OpeningBalance: 5000 });
  const to = await customerService.createCustomer({ Code: 'C-811', Name: 'عميل مدين', OpeningBalance: 0 });
  const transfer = await debtTransferService.createDebtTransfer({ FromCustomerId: from.Id, ToCustomerId: to.Id, Amount: 400, Date: '2026-09-05' });
  const container = makeContainer();
  const view = initCustomerAccountView({ container, customerId: from.Id, autoLoad: false });
  await view.reload();

  const editAttempt = await view.openEdit(transfer.CreditRow.Id);
  assert.equal(editAttempt.blocked, true);
  assert.match(container.nodes.get(ACCOUNT_REGION_ID).innerHTML, /مرتبطة بحركة أخرى/);
  assert.equal(container.nodes.get(ACCOUNT_REGION_ID).innerHTML.includes(EDIT_FORM_ID), false);

  const cancelAttempt = await view.openCancel(transfer.CreditRow.Id);
  assert.equal(cancelAttempt.blocked, true);
  assert.match(container.nodes.get(ACCOUNT_REGION_ID).innerHTML, /مرتبطة بحركة أخرى/);
});

test('the audit panel follows the row selection and reloads the history', async () => {
  await freshDatabase('ui_controller_audit');
  const customer = await seedCustomer();
  const record = await seedSale(customer.Id, { amount: 300 });
  const container = makeContainer({ values: { [EDIT_AMOUNT_ID]: '350', [EDIT_DATE_ID]: '2026-09-01', [EDIT_DESCRIPTION_ID]: 'تعديل', [EDIT_REASON_ID]: 'سبب أول' } });
  const view = initCustomerAccountView({ container, customerId: customer.Id, autoLoad: false });
  await view.reload();
  await view.openEdit(record.Id);
  await view.submitEdit();

  const shown = await view.refreshAudit(record.Id);
  assert.equal(shown.ok, true);
  assert.equal(shown.entries, 1);
  assert.match(container.nodes.get(ACCOUNT_REGION_ID).innerHTML, /سبب أول/);

  const other = await seedSale(customer.Id, { amount: 100, date: '2026-09-02' });
  const none = await view.refreshAudit(other.Id);
  assert.equal(none.entries, 0);
  assert.match(container.nodes.get(ACCOUNT_REGION_ID).innerHTML, /لا توجد تعديلات أو إلغاءات مسجلة/);
});

test('the statement actions are wired through the container events', async () => {
  await freshDatabase('ui_events');
  const customer = await seedCustomer({ opening: 1000 });
  const record = await seedSale(customer.Id, { amount: 300 });
  const container = makeContainer();
  const view = initCustomerAccountView({ container, customerId: customer.Id, autoLoad: false });
  await view.reload();

  const settle = async (marker) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (container.nodes.get(ACCOUNT_REGION_ID).innerHTML.includes(marker)) return true;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return false;
  };

  container.dispatch('click', clickTarget('edit-transaction', record.Id));
  assert.equal(await settle(EDIT_FORM_ID), true, 'clicking تعديل opens the edit dialog');
  assert.match(container.nodes.get(ACCOUNT_REGION_ID).innerHTML, /value="300"/, 'with the stored values');

  container.dispatch('click', clickTarget('close-dialog', record.Id));
  assert.equal(container.nodes.get(ACCOUNT_REGION_ID).innerHTML.includes(EDIT_FORM_ID), false, 'closing removes the dialog');

  container.dispatch('click', clickTarget('cancel-transaction', record.Id));
  assert.equal(await settle(CANCEL_FORM_ID), true, 'clicking إلغاء opens the confirmation dialog');

  container.dispatch('submit', formTarget(EDIT_FORM_ID));
});

test('the audit route target still renders and the account path is unchanged', async () => {
  assert.match(customerAccountPath('cus-1'), /customer\/cus-1/);
  assert.ok(matchCustomerSubroute('/customer/cus-1'), 'the customer account subroute still resolves');
  const rendered = renderDestinationView({ route: { id: 'customers' }, params: {} });
  assert.equal(typeof rendered, 'string');
  assert.match(renderAuditSection({ transactionId: 'trx-9', entries: [] }), /trx-9/);
});

// ---------------------------------------------------------------------------
// Architecture guards on the new UI files.
// ---------------------------------------------------------------------------

test('no UI file of this phase touches the data layer, a repository or a financial engine', () => {
  const files = ['ui/views/transactionActions.js', 'ui/views/customerAccount.js'];
  for (const relative of files) {
    const source = readFileSync(join(projectRoot, relative), 'utf8');
    assert.equal(/from '[^']*repositories/.test(source), false, `${relative} must not import a repository`);
    assert.equal(/from '[^']*storage/.test(source), false, `${relative} must not import the storage layer`);
    assert.equal(/indexedDB|IDBKeyRange/.test(source), false, `${relative} must not reach IndexedDB`);
    assert.equal(/deriveFinancials/.test(source), false, `${relative} must not call the financial engine`);
    assert.equal(/BalanceMinor\s*[-+*/]=|CreditMinor\s*=/.test(source), false, `${relative} must not compute a financial value`);
    assert.equal(/TODO|FIXME/.test(source), false, `${relative} must not carry a TODO/FIXME`);
  }
});

test('the new phase files carry no mock data and no silent catch', () => {
  const files = [
    'src/domain/transactionLifecycle.js', 'src/domain/auditTrail.js',
    'src/repositories/auditLogRepository.js', 'src/services/transactionLifecycleService.js',
    'ui/views/transactionActions.js'
  ];
  for (const relative of files) {
    const source = readFileSync(join(projectRoot, relative), 'utf8');
    assert.equal(/TODO|FIXME/.test(source), false, `${relative} must not carry a TODO/FIXME`);
    assert.equal(/catch\s*\([^)]*\)\s*\{\s*\}/.test(source), false, `${relative} must not swallow an error`);
    assert.equal(/sampleData|mockData|fakeRows/.test(source), false, `${relative} must not carry mock data`);
  }
});

test('the cancellation path of the UI never deletes a row', () => {
  const files = ['ui/views/customerAccount.js', 'ui/views/transactionActions.js'];
  for (const relative of files) {
    const source = readFileSync(join(projectRoot, relative), 'utf8');
    assert.equal(/\.delete\(|\.remove\(|deleteTransaction/.test(source), false, `${relative} must not contain a delete path`);
  }
});
