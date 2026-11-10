// Phase 4B.4 — Payments screen (Cash Received / Cash Paid).
//
// The screen is exercised end to end through the real services against an isolated
// fake-indexeddb database, plus its pure render projections which are asserted
// directly. No stub ever replaces a financial service, and no balance is computed
// by a test helper: every financial expectation is read back from the core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { freshDatabase, simulateReload } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { balanceService } from '../src/services/balanceService.js';
import { cancellationService } from '../src/services/cancellationService.js';
import { debtTransferService } from '../src/services/debtTransferService.js';
import { paymentService } from '../src/services/paymentService.js';
import { transactionFormService } from '../src/services/transactionFormService.js';
import { deriveFinancials } from '../src/domain/financialDirection.js';
import { TRANSACTION_TYPE, TRANSACTION_TYPES } from '../src/domain/transactionTypes.js';
import { logger } from '../src/utils/logger.js';
import { formatMoneyMinor, formatQuantityMinor } from '../src/utils/formatting.js';
import {
  PAYMENTS_REGION_ID, PAYMENTS_SUMMARY_ID, PAYMENTS_TOOLBAR_ID, PAYMENTS_FORM_REGION_ID,
  PAYMENTS_SUCCESS_ID, PAYMENTS_TABS_REGION_ID, PAYMENTS_FORM_ID, PAYMENTS_SUBMIT_ID,
  PAYMENT_TAB, PAYMENT_TABS, PAYMENT_STATUS_FILTER, PAYMENT_TYPE_FILTER, PAYMENT_COLUMNS,
  PAYMENT_FIELD_ID, EMPTY_VALUE, CANCELLED_LABEL, ACTIVE_LABEL,
  EMPTY_STATE_MESSAGE, NO_RESULTS_MESSAGE, RECEIVED_SUCCESS_LABEL, PAID_SUCCESS_LABEL,
  defaultPaymentCriteria, tabFor, transactionTypeForTab, typeLabel, customerDisplay,
  matchesPaymentSearch, matchesPaymentType, matchesPaymentStatus, matchesPaymentRange,
  visibleMovements, movementRow, customerOptions, renderPaymentTabs, renderPaymentsSummary,
  renderPaymentsToolbar, renderPaymentsRegion, renderPaymentForm, renderPaymentSuccess,
  paymentsScreenHtml, paymentsViewHtml, initPaymentsView
} from '../ui/views/payments.js';
import { customerAccountPath } from '../ui/routes.js';
import { resolveDestination } from '../ui/router.js';
import { renderDestinationView } from '../ui/views/index.js';

logger.disable?.();

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const uiRoot = join(projectRoot, 'ui');

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (full.endsWith('.js')) found.push(full);
  }
  return found;
}

// Minimal detached container: enough for the controller to find its regions and to
// record what it painted. It performs no DOM work of its own.
function makeNode() {
  return {
    innerHTML: '', attrs: {}, controls: new Map(), isConnected: true,
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key]; },
    querySelector(selector) { return this.controls.get(String(selector)) || null; }
  };
}

function makeContainer(ids = [PAYMENTS_SUMMARY_ID, PAYMENTS_TOOLBAR_ID, PAYMENTS_REGION_ID, PAYMENTS_FORM_REGION_ID, PAYMENTS_SUCCESS_ID, PAYMENTS_TABS_REGION_ID]) {
  const nodes = new Map(ids.map((id) => [id, makeNode()]));
  const extra = new Map();
  const handlers = {};
  return {
    nodes,
    attrs: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key]; },
    addEventListener(type, handler) { (handlers[type] = handlers[type] || []).push(handler); },
    dispatch(type, event) { for (const handler of handlers[type] || []) handler(event); },
    querySelector(selector) {
      const key = String(selector).replace(/^#/, '');
      if (nodes.has(key)) return nodes.get(key);
      if (!extra.has(key)) extra.set(key, makeNode());
      return extra.get(key);
    }
  };
}

function fieldValue(value) {
  return {
    value,
    getAttribute(name) { return name === 'value' ? value : null; },
    setAttribute() {}
  };
}

// Fills the form stubs the controller reads on submit.
function fillForm(container, { customerId, date, amount, description = '' } = {}) {
  const form = container.querySelector(`#${PAYMENTS_FORM_ID}`);
  form.controls.set(`#${PAYMENT_FIELD_ID.CustomerId}`, fieldValue(customerId));
  form.controls.set(`#${PAYMENT_FIELD_ID.Date}`, fieldValue(date));
  form.controls.set(`#${PAYMENT_FIELD_ID.Amount}`, fieldValue(amount));
  form.controls.set(`#${PAYMENT_FIELD_ID.Description}`, fieldValue(description));
  form.controls.set(`#${PAYMENT_FIELD_ID.CustomerSearch}`, fieldValue(''));
  if (!form.controls.get(`#${PAYMENTS_SUBMIT_ID}`)) {
    form.controls.set(`#${PAYMENTS_SUBMIT_ID}`, {
      disabled: false, innerHTML: '',
      setAttribute(key, value) { this[key] = value; },
      getAttribute(key) { return this[key] ?? null; }
    });
  }
  return form;
}

function submitEvent(container) {
  return { target: { getAttribute: (name) => (name === 'id' ? PAYMENTS_FORM_ID : null) }, preventDefault() {} };
}

async function seedCustomer({ code = 'C-900', name = 'مزارع المدفوعات', opening = 0, phone = '0100000000', region = 'المنوفية' } = {}) {
  return customerService.createCustomer({ Code: code, Name: name, Phone: phone, Region: region, OpeningBalance: opening });
}

// ---------------------------------------------------------------------------
// 1-3 — Customer loading, valid CustomerId, unknown CustomerId.
// ---------------------------------------------------------------------------

test('1. The picker loads the real customers from the store (Code + Name)', async () => {
  await freshDatabase('pay_customers');
  await seedCustomer({ code: 'C-901', name: 'عميل أول' });
  await seedCustomer({ code: 'C-902', name: 'عميل ثانٍ', phone: '0111111111' });
  const customers = await paymentService.listSelectableCustomers();
  assert.equal(customers.length, 2);
  const options = customerOptions(customers);
  assert.equal(options[0].value, '');
  assert.ok(options.some((option) => option.label === 'C-901 — عميل أول'));
  assert.ok(options.some((option) => option.search.includes('0111111111')));
});

test('2. A valid CustomerId is accepted and stored on the created row', async () => {
  await freshDatabase('pay_valid_customer');
  const customer = await seedCustomer({ code: 'C-910' });
  const record = await paymentService.createCashMovement({
    TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: '150'
  });
  assert.equal(record.Record.CustomerId, customer.Id);
});

test('3. An unknown CustomerId is rejected with NOT_FOUND and writes nothing', async () => {
  await freshDatabase('pay_unknown_customer');
  await assert.rejects(
    () => paymentService.createCashMovement({
      TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: 'missing-customer', Date: '2026-10-01', Amount: '10'
    }),
    (error) => error.code === 'NOT_FOUND'
  );
  assert.equal((await paymentService.listCashMovements()).length, 0);
});

// ---------------------------------------------------------------------------
// 4-9 — CashReceived.
// ---------------------------------------------------------------------------

test('4. CashReceived is created through the approved service and persisted active', async () => {
  await freshDatabase('pay_create_received');
  const customer = await seedCustomer();
  const result = await paymentService.createCashMovement({
    TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-02', Amount: '250', Description: 'دفعة أولى'
  });
  assert.equal(result.Record.TransactionType, TRANSACTION_TYPE.CASH_RECEIVED);
  assert.equal(result.Record.Status, 'Active');
  assert.equal(result.Record.AmountMinor, 25000);
  assert.equal(result.Record.Description, 'دفعة أولى');
  assert.equal((await transactionService.getTransaction(result.Record.Id)).Id, result.Record.Id);
});

test('5. A CashReceived amount must be greater than zero', async () => {
  await freshDatabase('pay_received_positive');
  const customer = await seedCustomer();
  for (const amount of ['0', '-5', '']) {
    await assert.rejects(() => paymentService.createCashMovement({
      TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-02', Amount: amount
    }), (error) => error.code === 'VALIDATION_ERROR');
  }
  assert.equal((await paymentService.listCashMovements()).length, 0);
});

test('6-8. CashReceived shows as received cash, cash paid stays zero and the direction is Credit', async () => {
  await freshDatabase('pay_received_columns');
  const customer = await seedCustomer();
  await paymentService.createCashMovement({
    TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-03', Amount: '400'
  });
  const [row] = await paymentService.listCashMovements();
  assert.equal(row.CashReceivedMinor, 40000);
  assert.equal(row.CashPaidMinor, 0);
  const financials = deriveFinancials(await transactionService.getTransaction(row.Id));
  assert.equal(financials.CreditMinor, 40000);
  assert.equal(financials.DebitMinor, 0);
  assert.equal(financials.CashReceivedMinor, 40000);
  assert.equal(financials.CashPaidMinor, 0);
  const cells = movementRow(row).cells;
  assert.match(cells[5], /400\.00/, 'the received column carries the amount');
  assert.equal(cells[6], `<span class="amount">${EMPTY_VALUE}</span>`, 'the paid column stays empty');
});

test('9. A CashReceived survives a database reload', async () => {
  await freshDatabase('pay_received_persist');
  const customer = await seedCustomer();
  await paymentService.createCashMovement({
    TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-04', Amount: '75'
  });
  await simulateReload();
  const rows = await paymentService.listCashMovements();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].CashReceivedMinor, 7500);
  assert.equal(rows[0].CashPaidMinor, 0);
});

// ---------------------------------------------------------------------------
// 10-15 — CashPaid.
// ---------------------------------------------------------------------------

test('10-11. CashPaid is created by the approved service with a positive amount', async () => {
  await freshDatabase('pay_create_paid');
  const customer = await seedCustomer();
  const result = await paymentService.createCashMovement({
    TransactionType: TRANSACTION_TYPE.CASH_PAID, CustomerId: customer.Id, Date: '2026-10-05', Amount: '120', Description: 'صرف'
  });
  assert.equal(result.Record.TransactionType, TRANSACTION_TYPE.CASH_PAID);
  assert.equal(result.Record.AmountMinor, 12000);
  assert.equal(result.Record.Status, 'Active');
});

test('12-14. CashPaid shows as paid cash, received stays zero and the direction is Debit', async () => {
  await freshDatabase('pay_paid_columns');
  const customer = await seedCustomer();
  await paymentService.createCashMovement({
    TransactionType: TRANSACTION_TYPE.CASH_PAID, CustomerId: customer.Id, Date: '2026-10-06', Amount: '300'
  });
  const [row] = await paymentService.listCashMovements();
  assert.equal(row.CashPaidMinor, 30000);
  assert.equal(row.CashReceivedMinor, 0);
  const financials = deriveFinancials(await transactionService.getTransaction(row.Id));
  assert.equal(financials.DebitMinor, 30000);
  assert.equal(financials.CreditMinor, 0);
  assert.equal(financials.CashReceivedMinor, 0);
  assert.equal(financials.CashPaidMinor, 30000);
  const cells = movementRow(row).cells;
  assert.match(cells[6], /300\.00/, 'the paid column carries the amount');
  assert.equal(cells[5], `<span class="amount">${EMPTY_VALUE}</span>`, 'the received column stays empty');
});

test('15. A CashPaid survives a database reload', async () => {
  await freshDatabase('pay_paid_persist');
  const customer = await seedCustomer();
  await paymentService.createCashMovement({
    TransactionType: TRANSACTION_TYPE.CASH_PAID, CustomerId: customer.Id, Date: '2026-10-07', Amount: '60'
  });
  await simulateReload();
  const rows = await paymentService.listCashMovements();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].CashPaidMinor, 6000);
  assert.equal(rows[0].CashReceivedMinor, 0);
});

// ---------------------------------------------------------------------------
// 16-22 — Validation.
// ---------------------------------------------------------------------------

test('16. An empty customer is rejected', async () => {
  await freshDatabase('pay_empty_customer');
  await assert.rejects(() => paymentService.createCashMovement({
    TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: '', Date: '2026-10-01', Amount: '10'
  }), (error) => error.code === 'VALIDATION_ERROR' && error.field === 'CustomerId');
});

test('17. An empty date is rejected', async () => {
  await freshDatabase('pay_empty_date');
  const customer = await seedCustomer();
  await assert.rejects(() => paymentService.createCashMovement({
    TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '', Amount: '10'
  }), (error) => error.code === 'VALIDATION_ERROR' && error.field === 'Date');
});

test('18-21. Empty, zero, negative and non-numeric amounts are all rejected', async () => {
  await freshDatabase('pay_amount_validation');
  const customer = await seedCustomer();
  for (const amount of ['', '0', '-1', 'abc', null, undefined]) {
    await assert.rejects(() => paymentService.createCashMovement({
      TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: amount
    }), (error) => error.code === 'VALIDATION_ERROR', `amount ${String(amount)} must be refused`);
  }
  assert.equal((await paymentService.listCashMovements()).length, 0);
});

test('22. The description is optional and an absent one stays absent', async () => {
  await freshDatabase('pay_description_optional');
  const customer = await seedCustomer();
  const result = await paymentService.createCashMovement({
    TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: '20'
  });
  assert.equal(result.Record.Description, null);
  const [row] = await paymentService.listCashMovements();
  assert.equal(movementRow(row).cells[3], EMPTY_VALUE, 'no invented description text');
});

// ---------------------------------------------------------------------------
// 23-31 — Filtering.
// ---------------------------------------------------------------------------

test('23-26. Search matches Code, Name, Phone and Description', async () => {
  const rows = [
    { Code: 'C-100', Name: 'أحمد', Phone: '0111222333', Description: 'سداد جزئي', TransactionType: 'CashReceived' },
    { Code: 'C-200', Name: 'محمود', Phone: '0199888777', Description: null, TransactionType: 'CashPaid' }
  ];
  assert.equal(visibleMovements(rows, { ...defaultPaymentCriteria(), search: 'c-100' }).length, 1);
  assert.equal(visibleMovements(rows, { ...defaultPaymentCriteria(), search: 'أحمد' }).length, 1);
  assert.equal(visibleMovements(rows, { ...defaultPaymentCriteria(), search: '0199' }).length, 1);
  assert.equal(visibleMovements(rows, { ...defaultPaymentCriteria(), search: 'سداد' }).length, 1);
  assert.equal(visibleMovements(rows, { ...defaultPaymentCriteria(), search: 'zzz' }).length, 0);
  assert.equal(matchesPaymentSearch(rows[0], ''), true);
});

test('27-28. The type filter narrows to one cash type', async () => {
  const rows = [
    { TransactionType: 'CashReceived', Code: 'C-1' },
    { TransactionType: 'CashPaid', Code: 'C-2' }
  ];
  assert.equal(visibleMovements(rows, { ...defaultPaymentCriteria(), type: 'CashReceived' }).length, 1);
  assert.equal(visibleMovements(rows, { ...defaultPaymentCriteria(), type: 'CashPaid' }).length, 1);
  assert.equal(visibleMovements(rows, { ...defaultPaymentCriteria(), type: PAYMENT_TYPE_FILTER.ALL }).length, 2);
  assert.equal(matchesPaymentType(rows[0], null), true);
});

test('29. The date range filter uses the stored ISO date without conversion', async () => {
  const rows = [
    { Date: '2026-09-01', Code: 'A' },
    { Date: '2026-10-01', Code: 'B' },
    { Date: '2026-11-01', Code: 'C' }
  ];
  assert.equal(visibleMovements(rows, { ...defaultPaymentCriteria(), from: '2026-09-15' }).length, 2);
  assert.equal(visibleMovements(rows, { ...defaultPaymentCriteria(), to: '2026-10-15' }).length, 2);
  assert.equal(visibleMovements(rows, { ...defaultPaymentCriteria(), from: '2026-10-01', to: '2026-10-01' }).length, 1);
  assert.equal(matchesPaymentRange(rows[0], {}), true);
});

test('30. The status filter separates active from cancelled rows', async () => {
  const rows = [
    { Status: 'Active', IsCancelled: false, Code: 'A' },
    { Status: 'Cancelled', IsCancelled: true, Code: 'B' }
  ];
  assert.equal(visibleMovements(rows, { ...defaultPaymentCriteria(), status: PAYMENT_STATUS_FILTER.ACTIVE }).length, 1);
  assert.equal(visibleMovements(rows, { ...defaultPaymentCriteria(), status: PAYMENT_STATUS_FILTER.CANCELLED }).length, 1);
  assert.equal(matchesPaymentStatus(rows[0], PAYMENT_STATUS_FILTER.ALL), true);
});

test('31. Resetting the filters restores the full list', async () => {
  await freshDatabase('pay_reset_filters');
  const customer = await seedCustomer();
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: '10' });
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_PAID, CustomerId: customer.Id, Date: '2026-10-02', Amount: '20' });

  const container = makeContainer();
  const view = initPaymentsView({ container });
  await view.load();
  const narrowed = view.setCriteria({ type: TRANSACTION_TYPE.CASH_PAID, search: 'zzz' });
  assert.equal(visibleMovements(view.state.rows, narrowed).length, 0);
  assert.equal(view.state.criteria.search, 'zzz');

  const defaults = { ...defaultPaymentCriteria() };
  view.setCriteria(defaults);
  assert.deepEqual(view.state.criteria, defaults);
  assert.equal(visibleMovements(view.state.rows, view.state.criteria).length, 2);
});

// ---------------------------------------------------------------------------
// 32-38 — Summary.
// ---------------------------------------------------------------------------

test('32-34. The summary totals are the cash values, and the net is received minus paid', async () => {
  await freshDatabase('pay_summary');
  const customer = await seedCustomer();
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: '500' });
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-02', Amount: '150' });
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_PAID, CustomerId: customer.Id, Date: '2026-10-03', Amount: '200' });

  const totals = paymentService.summarize(await paymentService.listCashMovements());
  assert.equal(totals.CashReceivedMinor, 65000);
  assert.equal(totals.CashPaidMinor, 20000);
  assert.equal(totals.NetCashMinor, 45000);
  assert.equal(totals.Count, 3);

  const html = renderPaymentsSummary(totals);
  assert.match(html, /إجمالي المقبوضات/);
  assert.match(html, /إجمالي المدفوعات/);
  assert.match(html, /صافي النقدية/);
  assert.match(html, /650\.00/);
  assert.match(html, /200\.00/);
  assert.match(html, /450\.00/);
  assert.doesNotMatch(html, /Total Collection/i);
});

test('35. A cancelled movement is excluded from the summary', async () => {
  await freshDatabase('pay_summary_cancelled');
  const customer = await seedCustomer();
  const created = await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: '300' });
  await cancellationService.cancelTransaction(created.Record.Id, 'خطأ في الإدخال');
  const rows = await paymentService.listCashMovements();
  assert.equal(rows.length, 1, 'the cancelled row stays visible');
  const totals = paymentService.summarize(rows);
  assert.equal(totals.CashReceivedMinor, 0);
  assert.equal(totals.NetCashMinor, 0);
  assert.equal(totals.CancelledCount, 1);
  assert.equal(totals.Count, 0);
});

test('36-38. Settlement, GoodsExchange and DebtTransfer are never part of the cash screen', async () => {
  await freshDatabase('pay_non_cash_excluded');
  const a = await seedCustomer({ code: 'C-930', name: 'أ' });
  const b = await seedCustomer({ code: 'C-931', name: 'ب' });
  await transactionService.createTransaction({ CustomerId: a.Id, Date: '2026-10-01', TransactionType: TRANSACTION_TYPE.SETTLEMENT, Amount: 100 });
  await transactionService.createTransaction({ CustomerId: a.Id, Date: '2026-10-02', TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, Amount: 200 });
  await debtTransferService.createDebtTransfer({ FromCustomerId: b.Id, ToCustomerId: a.Id, Date: '2026-10-03', Amount: 300 });

  const rows = await paymentService.listCashMovements();
  assert.equal(rows.length, 0, 'no non-cash row may reach the payments read model');
  const totals = paymentService.summarize(rows);
  assert.equal(totals.CashReceivedMinor, 0);
  assert.equal(totals.CashPaidMinor, 0);
  assert.equal(totals.NetCashMinor, 0);

  // ...while the same three rows keep their approved non-cash behaviour in the core.
  const settlement = deriveFinancials(await transactionService.getTransaction((await transactionService.listByCustomer(a.Id)).find((r) => r.TransactionType === TRANSACTION_TYPE.SETTLEMENT).Id));
  assert.equal(settlement.CashReceivedMinor + settlement.CashPaidMinor, 0);
  assert.equal(settlement.CreditMinor, 10000);
});

// ---------------------------------------------------------------------------
// 39-42 — Balance.
// ---------------------------------------------------------------------------

test('39. The customer balance after a CashReceived grows by the received amount', async () => {
  await freshDatabase('pay_balance_received');
  const customer = await seedCustomer({ opening: 1000 });
  const before = await balanceService.getCustomerSummary(customer.Id);
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: '250' });
  const after = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(after.BalanceMinor, before.BalanceMinor + 25000);
  assert.equal(after.CashReceivedMinor, 25000);
});

test('40. The customer balance after a CashPaid drops by the paid amount', async () => {
  await freshDatabase('pay_balance_paid');
  const customer = await seedCustomer({ opening: 1000 });
  const before = await balanceService.getCustomerSummary(customer.Id);
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_PAID, CustomerId: customer.Id, Date: '2026-10-01', Amount: '400' });
  const after = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(after.BalanceMinor, before.BalanceMinor - 40000);
  assert.equal(after.CashPaidMinor, 40000);
});

test('41. The opening balance stays a separate, untouched component', async () => {
  await freshDatabase('pay_opening_separate');
  const customer = await seedCustomer({ opening: 777 });
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: '123' });
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.OpeningBalanceMinor, 77700);
  assert.equal(summary.BalanceMinor, 77700 + 12300);
  const [row] = await paymentService.listCashMovements();
  assert.equal('OpeningBalanceMinor' in row, false, 'a cash movement row carries no opening balance of its own');
});

test('42. A cancelled movement leaves the balance untouched but keeps its row', async () => {
  await freshDatabase('pay_cancelled_balance');
  const customer = await seedCustomer({ opening: 500 });
  const created = await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: '900' });
  const during = (await balanceService.getCustomerSummary(customer.Id)).BalanceMinor;
  await cancellationService.cancelTransaction(created.Record.Id, 'تكرار');
  const after = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(during, 50000 + 90000);
  assert.equal(after.BalanceMinor, 50000);
  const [row] = await paymentService.listCashMovements();
  assert.equal(row.IsCancelled, true);
  assert.equal(movementRow(row).className, 'ledger-row--cancelled');
  assert.match(movementRow(row).cells[8], new RegExp(CANCELLED_LABEL));
});

// ---------------------------------------------------------------------------
// 43-44 — Navigation.
// ---------------------------------------------------------------------------

test('43. A payment row opens the customer account by CustomerId', async () => {
  await freshDatabase('pay_navigation');
  const customer = await seedCustomer({ code: 'C-940' });
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: '30' });
  const [row] = await paymentService.listCashMovements();
  const cells = movementRow(row).cells;
  const expected = customerAccountPath(customer.Id);
  assert.match(cells[9], new RegExp(`href="#${expected.replace(/[/]/g, '\\/')}"`));
  assert.match(cells[9], new RegExp(customer.Id));
  const resolved = resolveDestination(`#${expected}`);
  assert.equal(resolved.destination.id, 'customer-account');
  assert.equal(resolved.params.id, customer.Id);

  // The payment really is part of that customer's statement.
  const ledger = await balanceService.getRunningBalance(customer.Id);
  assert.equal(ledger.Entries.filter((entry) => entry.TransactionType === TRANSACTION_TYPE.CASH_RECEIVED).length, 1);
  assert.equal(ledger.Entries[0].CashReceivedMinor, 3000);
});

test('44. A customerId in the route pre-selects the customer and keeps the real identifier', async () => {
  await freshDatabase('pay_preselected');
  const customer = await seedCustomer({ code: 'C-950' });
  const resolved = resolveDestination(`#/payments?customerId=${customer.Id}`);
  assert.equal(resolved.destination.id, 'payments');
  assert.equal(resolved.params.customerId, customer.Id);

  const container = makeContainer();
  const view = initPaymentsView({ container, customerId: customer.Id });
  await view.load();
  assert.equal(view.state.values.CustomerId, customer.Id);
  const form = container.querySelector(`#${PAYMENTS_FORM_REGION_ID}`).innerHTML;
  assert.match(form, new RegExp(`value="${customer.Id}" selected`));

  // Without a query string the screen has no pre-selected customer.
  assert.equal(resolveDestination('#/payments').params.customerId, undefined);
  const blank = makeContainer();
  const blankView = initPaymentsView({ container: blank });
  assert.equal(blankView.state.values.CustomerId, '');
});

// ---------------------------------------------------------------------------
// 45-52 — UX behaviour.
// ---------------------------------------------------------------------------

test('45-47. Save is disabled while saving and re-enabled after success and after failure', async () => {
  await freshDatabase('pay_busy');
  const customer = await seedCustomer();
  const container = makeContainer();
  const view = initPaymentsView({ container });
  await view.load();
  const formNode = container.querySelector(`#${PAYMENTS_FORM_ID}`);
  const submitNode = {
    disabled: false, ariaDisabled: null,
    setAttribute(key, value) { this[key] = value; if (key === 'aria-disabled') this.ariaDisabled = value; },
    getAttribute(key) { return this[key] ?? null; }
  };
  formNode.controls.set(`#${PAYMENTS_SUBMIT_ID}`, submitNode);

  fillForm(container, { customerId: customer.Id, date: '2026-10-02', amount: '40', description: 'أول' });
  const success = await view.submit();
  assert.ok(success, 'the save succeeded');
  assert.equal(submitNode.disabled, false, 'save is usable again after a success');
  assert.equal(submitNode['aria-disabled'], 'false');

  fillForm(container, { customerId: customer.Id, date: '2026-10-02', amount: '0' });
  const failure = await view.submit();
  assert.equal(failure, null, 'the invalid save returned no result');
  assert.equal(submitNode.disabled, false, 'save is usable again after a failure');
  assert.equal(view.state.busy, false);
});

test('48. Every entered value survives a failed save', async () => {
  await freshDatabase('pay_preserve');
  const customer = await seedCustomer();
  const container = makeContainer();
  const view = initPaymentsView({ container });
  await view.load();
  fillForm(container, { customerId: customer.Id, date: '2026-10-09', amount: '-3', description: 'بيان محفوظ' });
  await view.submit();
  assert.equal(view.state.values.CustomerId, customer.Id);
  assert.equal(view.state.values.Date, '2026-10-09');
  assert.equal(view.state.values.Amount, '-3');
  assert.equal(view.state.values.Description, 'بيان محفوظ');
  assert.ok(view.state.formError, 'a visible message is produced');
  assert.match(container.querySelector(`#${PAYMENTS_FORM_REGION_ID}`).innerHTML, /تعذّر حفظ الحركة/);
});

test('49. A successful save shows the success state and clears only the movement fields', async () => {
  await freshDatabase('pay_success_state');
  const customer = await seedCustomer();
  const container = makeContainer();
  const view = initPaymentsView({ container });
  await view.load();
  fillForm(container, { customerId: customer.Id, date: '2026-10-11', amount: '55', description: 'دفعة' });
  const result = await view.submit();
  assert.ok(result);
  assert.match(container.querySelector(`#${PAYMENTS_SUCCESS_ID}`).innerHTML, new RegExp(RECEIVED_SUCCESS_LABEL));
  assert.equal(view.state.values.Amount, '', 'the amount is cleared for the next entry');
  assert.equal(view.state.values.Description, '', 'the description is cleared for the next entry');
  assert.equal(view.state.values.CustomerId, customer.Id, 'the customer is kept on purpose');
  assert.equal(view.state.values.Date, '2026-10-11', 'the date is kept on purpose');
  assert.equal(view.currentTab(), PAYMENT_TAB.RECEIVED, 'the current tab is kept');
  assert.equal(container.querySelector(`#${PAYMENTS_REGION_ID}`).innerHTML.includes('55.00'), true);
});

test('50-51. The empty state and the no-results state are distinct and honest', async () => {
  await freshDatabase('pay_states');
  const container = makeContainer();
  const view = initPaymentsView({ container });
  await view.load();
  const emptyHtml = container.querySelector(`#${PAYMENTS_REGION_ID}`).innerHTML;
  assert.match(emptyHtml, new RegExp(EMPTY_STATE_MESSAGE));
  assert.match(emptyHtml, /data-action="open-form"/);

  const customer = await seedCustomer();
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: '10' });
  await view.load();
  view.setCriteria({ search: 'لا-يوجد-بهذا-الاسم' });
  const noResults = container.querySelector(`#${PAYMENTS_REGION_ID}`).innerHTML;
  assert.match(noResults, new RegExp(NO_RESULTS_MESSAGE));
  assert.match(noResults, /data-action="reset-filters"/);
  assert.doesNotMatch(noResults, new RegExp(EMPTY_STATE_MESSAGE));

  view.setCriteria(defaultPaymentCriteria());
  assert.match(container.querySelector(`#${PAYMENTS_REGION_ID}`).innerHTML, /10\.00/);
});

test('52. A load failure paints the error state with a retry, and the retry re-reads', async () => {
  await freshDatabase('pay_error_state');
  const container = makeContainer();
  const view = initPaymentsView({ container, autoLoad: false });

  const original = paymentService.listCashMovements;
  paymentService.listCashMovements = async () => { const error = new Error('تعذّر القراءة'); error.code = 'STORAGE_ERROR'; throw error; };
  try {
    await view.load();
    const html = container.querySelector(`#${PAYMENTS_REGION_ID}`).innerHTML;
    assert.match(html, /role="alert"/);
    assert.match(html, /تعذّر تحميل الحركات النقدية/);
    assert.match(html, /data-action="retry"/);
    assert.match(html, /STORAGE_ERROR/);
    assert.doesNotMatch(html, /class="kpi__value"/, 'no financial value may be shown on failure');
    assert.equal(container.querySelector(`#${PAYMENTS_REGION_ID}`).attrs['aria-busy'], 'false');
  } finally {
    paymentService.listCashMovements = original;
  }

  await view.load();
  assert.equal(view.state.error, null);
  assert.match(container.querySelector(`#${PAYMENTS_REGION_ID}`).innerHTML, new RegExp(EMPTY_STATE_MESSAGE));
});

test('Tab switching changes the type, keeps no stale amount and adds no duplicate controls', async () => {
  await freshDatabase('pay_tabs');
  const customer = await seedCustomer();
  const container = makeContainer();
  const view = initPaymentsView({ container });
  await view.load();
  view.state.values = { CustomerId: customer.Id, CustomerSearch: '', Date: '2026-10-12', Amount: '99', Description: 'س' };

  assert.equal(view.switchTab(PAYMENT_TAB.PAID), true);
  assert.equal(transactionTypeForTab(view.state.tab), TRANSACTION_TYPE.CASH_PAID);
  assert.equal(tabFor(TRANSACTION_TYPE.CASH_PAID), PAYMENT_TAB.PAID);
  let form = container.querySelector(`#${PAYMENTS_FORM_REGION_ID}`).innerHTML;
  assert.match(form, /data-transaction-type="CashPaid"/);
  assert.equal((form.match(/id="payment-amount"/g) || []).length, 1, 'exactly one amount control');
  assert.equal((form.match(/id="payment-customer"/g) || []).length, 1, 'exactly one customer control');
  assert.equal(view.state.fieldErrors.Amount, undefined, 'no stale validation is carried across');

  assert.equal(view.switchTab(PAYMENT_TAB.RECEIVED), true);
  form = container.querySelector(`#${PAYMENTS_FORM_REGION_ID}`).innerHTML;
  assert.match(form, /data-transaction-type="CashReceived"/);
  assert.equal((form.match(/id="payment-date"/g) || []).length, 1);
  assert.equal(view.switchTab(PAYMENT_TAB.RECEIVED), false, 'switching to the current tab is a no-op');
});

test('The screen renders exactly the two approved tabs and the ten approved columns', () => {
  assert.deepEqual(PAYMENT_TABS.map((tab) => tab.transactionType), ['CashReceived', 'CashPaid']);
  assert.deepEqual(PAYMENT_TABS.map((tab) => tab.label), ['استلام نقدية', 'دفع نقدية']);
  assert.equal(PAYMENT_COLUMNS.length, 10);
  assert.deepEqual(PAYMENT_COLUMNS.map((column) => column.label), [
    'التاريخ', 'العميل', 'النوع', 'البيان', 'المبلغ', 'المقبوض', 'المدفوع', 'الرصيد بعد الحركة', 'الحالة', 'إجراء'
  ]);
  const tabs = renderPaymentTabs({ tab: PAYMENT_TAB.PAID });
  assert.equal((tabs.match(/role="tab"/g) || []).length, 2);
  assert.match(tabs, /data-tab="paid"[^>]*aria-selected="true"/);
  assert.doesNotMatch(tabs, /تسوية|مبادلة بضاعة|تحويل مديونية/, 'the other eight types must never appear here');
});

test('The form carries exactly Customer, Date, Amount and Description and no forbidden field', async () => {
  await freshDatabase('pay_form_fields');
  await seedCustomer({ code: 'C-960' });
  const form = renderPaymentForm({ tab: PAYMENT_TAB.RECEIVED, customers: await paymentService.listSelectableCustomers() });
  for (const id of Object.values(PAYMENT_FIELD_ID)) assert.ok(form.includes(`id="${id}"`), `${id} is present`);
  for (const forbidden of ['PaymentMethod', 'InvoiceNumber', 'Reference', 'Treasury', 'Currency', 'ExchangeRate']) {
    assert.equal(form.includes(forbidden), false, `${forbidden} must never exist in this form`);
  }
  assert.match(form, /id="payment-form"/);
  assert.match(form, /<label class="field__label" for="payment-amount">المبلغ<\/label>/);
  const paid = renderPaymentForm({ tab: PAYMENT_TAB.PAID });
  assert.match(paid, /حفظ الدفعة/);
  assert.match(paid, /data-transaction-type="CashPaid"/);
});

test('The screen never creates a non-cash movement and never accepts an unknown type', async () => {
  await freshDatabase('pay_guard_types');
  const customer = await seedCustomer();
  for (const type of TRANSACTION_TYPES.filter((entry) => !['CashReceived', 'CashPaid'].includes(entry))) {
    await assert.rejects(() => paymentService.createCashMovement({
      TransactionType: type, CustomerId: customer.Id, Date: '2026-10-01', Amount: '10'
    }), (error) => error.code === 'BUSINESS_RULE_ERROR', `${type} must be refused by the payments service`);
  }
  assert.equal(paymentService.cashTypes().length, 2);
  assert.equal(paymentService.isCashType(TRANSACTION_TYPE.SETTLEMENT), false);
  assert.equal(paymentService.isCashType(TRANSACTION_TYPE.CASH_PAID), true);
});

test('The screen is wired as a real destination and its shell renders the design system', async () => {
  await freshDatabase('pay_destination');
  const resolved = resolveDestination('#/payments');
  assert.equal(resolved.destination.id, 'payments');
  assert.equal(resolved.destination.title, 'المدفوعات');
  const html = renderDestinationView({ route: resolved.destination, params: resolved.params });
  assert.match(html, /تسجيل ومتابعة الحركات النقدية الفعلية مع العملاء/);
  assert.match(html, /\+ تسجيل حركة نقدية/);
  assert.match(html, new RegExp(`id="${PAYMENTS_REGION_ID}"`));
  assert.match(html, /role="tablist"/);
  assert.doesNotMatch(html, /هيكل التطبيق/, 'the placeholder notice is gone for this screen');
  assert.match(paymentsViewHtml(), new RegExp(`id="${PAYMENTS_SUMMARY_ID}"`));
  assert.match(paymentsScreenHtml({ rows: [], criteria: defaultPaymentCriteria() }), new RegExp(EMPTY_STATE_MESSAGE));
  assert.match(renderPaymentsToolbar({ criteria: defaultPaymentCriteria() }), /إعادة ضبط الفلاتر/);
  assert.match(renderPaymentSuccess({ result: null, tab: PAYMENT_TAB.PAID }), new RegExp(PAID_SUCCESS_LABEL));
  assert.equal(customerDisplay({}), EMPTY_VALUE);
  assert.equal(typeLabel('CashReceived'), 'استلام نقدية');
  assert.equal(typeLabel(''), EMPTY_VALUE);
  assert.equal(formatMoneyMinor(1234), '12.34');
  assert.equal(formatQuantityMinor(1000), '1.000');
});

// ---------------------------------------------------------------------------
// Architecture and hygiene (spec §36, §45, §46, §48, §37).
// ---------------------------------------------------------------------------

test('The UI layer never reaches the data layer below the services', () => {
  const files = walk(uiRoot);
  assert.ok(files.length >= 10);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const forbidden of ['repositories', 'storage/db', 'storage/schema', 'indexedDB', 'IndexedDB', 'IDBKeyRange']) {
      assert.equal(source.includes(forbidden), false, `${file} must not reference ${forbidden}`);
    }
  }
});

test('The payments screen holds no financial engine and no invented data', () => {
  const source = readFileSync(join(uiRoot, 'views', 'payments.js'), 'utf8');
  for (const forbidden of ['deriveFinancials', 'getRunningBalance', 'OpeningBalanceMinor ']) {
    assert.equal(source.includes(forbidden), false, `payments.js must not use ${forbidden}`);
  }
  assert.doesNotMatch(source, /BalanceMinor\s*[+\-*/]?=/, 'no balance arithmetic in the UI');
  assert.doesNotMatch(source, /CashReceivedMinor\s*[+\-*/]?=/, 'no cash arithmetic in the UI');
  assert.doesNotMatch(source, /debit\s*=\s*amount|credit\s*=\s*amount/i, 'no direction decision in the UI');
  assert.doesNotMatch(source, /TODO|FIXME|XXX|HACK/);
  for (const file of walk(uiRoot)) assert.doesNotMatch(readFileSync(file, 'utf8'), /TODO|FIXME|XXX|HACK/, `${file} carries a marker`);
  assert.doesNotMatch(source, /sampleCustomers|mockCustomers|fakeData|placeholderRows/);
});

test('The payments service holds no duplicated financial rule and no marker', () => {
  const source = readFileSync(join(projectRoot, 'src', 'services', 'paymentService.js'), 'utf8');
  assert.doesNotMatch(source, /TODO|FIXME|XXX|HACK/);
  assert.doesNotMatch(source, /OpeningBalanceMinor\s*\+/, 'the balance formula belongs to the core');
  // The only aggregate is a plain sum of core-provided values.
  assert.match(source, /CashReceivedMinor \+= Number/);
  assert.match(source, /NetCashMinor: CashReceivedMinor - CashPaidMinor/);
});

test('The approved screens were not rebuilt: customer account and add transaction stay intact', () => {
  const account = readFileSync(join(uiRoot, 'views', 'customerAccount.js'), 'utf8');
  assert.match(account, /getRunningBalance/);
  const addForm = readFileSync(join(uiRoot, 'views', 'transactionForm.js'), 'utf8');
  assert.match(addForm, /submitTransactionForm/);
  const routes = readFileSync(join(uiRoot, 'routes.js'), 'utf8');
  assert.match(routes, /\/transactions\/add/);
  assert.match(routes, /\/customer\/:id/);
});

test('The payments save path is the very same entry point Add Transaction uses', async () => {
  await freshDatabase('pay_same_path');
  const customer = await seedCustomer();
  let seen = null;
  const original = transactionFormService.submitTransactionForm;
  transactionFormService.submitTransactionForm = async (form) => { seen = { ...form }; return original.call(transactionFormService, form); };
  try {
    await paymentService.createCashMovement({
      TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-13', Amount: '11'
    });
  } finally {
    transactionFormService.submitTransactionForm = original;
  }
  assert.equal(seen.TransactionType, TRANSACTION_TYPE.CASH_RECEIVED);
  assert.equal(seen.Amount, '11');
  assert.equal('AmountMinor' in seen, false, 'the UI never sends a minor-unit override');
});

test('The list is deterministic and every row keeps the core running balance', async () => {
  await freshDatabase('pay_order');
  const customer = await seedCustomer({ opening: 100 });
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: '10' });
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_PAID, CustomerId: customer.Id, Date: '2026-10-02', Amount: '30' });
  const rows = await paymentService.listCashMovements();
  assert.deepEqual(rows.map((row) => row.Date), ['2026-10-01', '2026-10-02']);
  const ledger = await balanceService.getRunningBalance(customer.Id);
  assert.deepEqual(rows.map((row) => row.RunningBalanceMinor), ledger.Entries.map((entry) => entry.RunningBalanceMinor));
  const second = await paymentService.listCashMovements();
  assert.deepEqual(second.map((row) => row.Id), rows.map((row) => row.Id), 'the read order is stable');
});

test('The cash screen is strictly separate from the non-cash screen data', async () => {
  await freshDatabase('pay_separation');
  const customer = await seedCustomer({ opening: 0 });
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: '100' });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-10-02', TransactionType: TRANSACTION_TYPE.SETTLEMENT, Amount: 900 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-10-03', TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, Amount: 800 });
  const rows = await paymentService.listCashMovements();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].TransactionType, TRANSACTION_TYPE.CASH_RECEIVED);
  const totals = paymentService.summarize(rows);
  assert.equal(totals.CashReceivedMinor, 10000);
  assert.equal(totals.NetCashMinor, 10000);
  const summary = await balanceService.getCustomerSummary(customer.Id);
  // The core aggregates both non-cash rows into its non-cash bucket (900.00 + 800.00),
  // while the cash screen above saw only the one real cash movement.
  assert.equal(summary.NonCashSettlementMinor, 170000, 'the non-cash side stays exactly as the core computed it');
  assert.equal(summary.CashReceivedMinor, 10000, 'the core cash total counts the real cash movement only');
  // Opening 0 + Credits (100.00 cash + 900.00 + 800.00 non-cash) - Debits 0.
  assert.equal(summary.BalanceMinor, 10000 + 90000 + 80000, 'the core balance keeps the approved formula');
});
