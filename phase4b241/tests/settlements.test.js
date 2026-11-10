// Phase 4B.5 — Settlements screen (Settlement / GoodsExchange, both non-cash credit).
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
import { settlementService } from '../src/services/settlementService.js';
import { paymentService } from '../src/services/paymentService.js';
import { transactionFormService } from '../src/services/transactionFormService.js';
import { deriveFinancials, FINANCIAL_RULES } from '../src/domain/financialDirection.js';
import { TRANSACTION_TYPE, TRANSACTION_TYPES, NON_CASH_TYPES } from '../src/domain/transactionTypes.js';
import { logger } from '../src/utils/logger.js';
import { formatMoneyMinor, formatQuantityMinor } from '../src/utils/formatting.js';
import {
  SETTLEMENTS_REGION_ID, SETTLEMENTS_SUMMARY_ID, SETTLEMENTS_TOOLBAR_ID, SETTLEMENTS_FORM_REGION_ID,
  SETTLEMENTS_SUCCESS_ID, SETTLEMENTS_TABS_REGION_ID, SETTLEMENTS_FORM_ID, SETTLEMENTS_SUBMIT_ID,
  SETTLEMENT_TAB, SETTLEMENT_TABS, SETTLEMENT_STATUS_FILTER, SETTLEMENT_TYPE_FILTER, SETTLEMENT_COLUMNS,
  SETTLEMENT_FIELD_ID, EMPTY_VALUE, CANCELLED_LABEL, ACTIVE_LABEL,
  EMPTY_STATE_MESSAGE, NO_RESULTS_MESSAGE, SETTLEMENT_SUCCESS_LABEL, GOODS_EXCHANGE_SUCCESS_LABEL,
  defaultSettlementCriteria, tabFor, transactionTypeForTab, typeLabel, customerDisplay,
  matchesSettlementSearch, matchesSettlementType, matchesSettlementStatus, matchesSettlementRange,
  visibleSettlements, movementRow, customerOptions, renderSettlementTabs, renderSettlementsSummary,
  renderSettlementsToolbar, renderSettlementsRegion, renderSettlementForm, renderSettlementSuccess,
  settlementsScreenHtml, settlementsViewHtml, initSettlementsView
} from '../ui/views/settlements.js';
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

function makeContainer(ids = [SETTLEMENTS_SUMMARY_ID, SETTLEMENTS_TOOLBAR_ID, SETTLEMENTS_REGION_ID, SETTLEMENTS_FORM_REGION_ID, SETTLEMENTS_SUCCESS_ID, SETTLEMENTS_TABS_REGION_ID]) {
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
  const form = container.querySelector(`#${SETTLEMENTS_FORM_ID}`);
  form.controls.set(`#${SETTLEMENT_FIELD_ID.CustomerId}`, fieldValue(customerId));
  form.controls.set(`#${SETTLEMENT_FIELD_ID.Date}`, fieldValue(date));
  form.controls.set(`#${SETTLEMENT_FIELD_ID.Amount}`, fieldValue(amount));
  form.controls.set(`#${SETTLEMENT_FIELD_ID.Description}`, fieldValue(description));
  form.controls.set(`#${SETTLEMENT_FIELD_ID.CustomerSearch}`, fieldValue(''));
  if (!form.controls.get(`#${SETTLEMENTS_SUBMIT_ID}`)) {
    form.controls.set(`#${SETTLEMENTS_SUBMIT_ID}`, {
      disabled: false, innerHTML: '',
      setAttribute(key, value) { this[key] = value; },
      getAttribute(key) { return this[key] ?? null; }
    });
  }
  return form;
}

async function seedCustomer({ code = 'C-900', name = 'مزارع التسويات', opening = 0, phone = '0100000000', region = 'المنوفية' } = {}) {
  return customerService.createCustomer({ Code: code, Name: name, Phone: phone, Region: region, OpeningBalance: opening });
}

// ---------------------------------------------------------------------------
// A, B, C, D, E, F, O — creation and the approved non-cash direction.
// ---------------------------------------------------------------------------

test('A. A Settlement is created through the approved service and persisted active', async () => {
  await freshDatabase('set_create');
  const customer = await seedCustomer();
  const result = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Amount: '200', Description: 'تسوية أولى'
  });
  assert.equal(result.Record.TransactionType, TRANSACTION_TYPE.SETTLEMENT);
  assert.equal(result.Record.Status, 'Active');
  assert.equal(result.Record.AmountMinor, 20000);
  assert.equal(result.Record.Description, 'تسوية أولى');
  assert.equal((await transactionService.getTransaction(result.Record.Id)).Id, result.Record.Id);
});

test('B. A GoodsExchange is created through the approved service and persisted active', async () => {
  await freshDatabase('set_create_ge');
  const customer = await seedCustomer();
  const result = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-02', Amount: '350'
  });
  assert.equal(result.Record.TransactionType, TRANSACTION_TYPE.GOODS_EXCHANGE);
  assert.equal(result.Record.Status, 'Active');
  assert.equal(result.Record.AmountMinor, 35000);
});

test('C. Settlement is a Credit with Debit = 0 (direction comes from the core)', async () => {
  await freshDatabase('set_credit');
  const customer = await seedCustomer();
  const created = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-03', Amount: '400'
  });
  const f = deriveFinancials(await transactionService.getTransaction(created.Record.Id));
  assert.equal(f.direction, 'Credit');
  assert.equal(f.CreditMinor, 40000);
  assert.equal(f.DebitMinor, 0);
  const [row] = await settlementService.listSettlementMovements();
  assert.equal(row.CreditMinor, 40000);
  assert.equal(row.DebitMinor, 0);
  assert.match(movementRow(row).cells[7], /400\.00/, 'the credit column carries the core value');
});

test('D. Settlement carries no cash: CashReceived = 0 and CashPaid = 0', async () => {
  await freshDatabase('set_cash_zero');
  const customer = await seedCustomer();
  const created = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-04', Amount: '250'
  });
  const f = deriveFinancials(await transactionService.getTransaction(created.Record.Id));
  assert.equal(f.CashReceivedMinor, 0);
  assert.equal(f.CashPaidMinor, 0);
  assert.equal(f.isCash, false);
  assert.equal(f.isNonCash, true);
  assert.equal(f.SettlementMinor, 25000, 'the core puts it in the non-cash bucket');
  const [row] = await settlementService.listSettlementMovements();
  assert.equal(row.CashReceivedMinor, 0);
  assert.equal(row.CashPaidMinor, 0);
  assert.equal(row.SettlementMinor, 25000);
});

test('E. GoodsExchange is a Credit with Debit = 0', async () => {
  await freshDatabase('set_ge_credit');
  const customer = await seedCustomer();
  const created = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-05', Amount: '600'
  });
  const f = deriveFinancials(await transactionService.getTransaction(created.Record.Id));
  assert.equal(f.direction, 'Credit');
  assert.equal(f.CreditMinor, 60000);
  assert.equal(f.DebitMinor, 0);
});

test('F. GoodsExchange carries no cash: CashReceived = 0 and CashPaid = 0', async () => {
  await freshDatabase('set_ge_cash_zero');
  const customer = await seedCustomer();
  const created = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-06', Amount: '125'
  });
  const f = deriveFinancials(await transactionService.getTransaction(created.Record.Id));
  assert.equal(f.CashReceivedMinor, 0);
  assert.equal(f.CashPaidMinor, 0);
  assert.equal(f.isNonCash, true);
  assert.equal(f.SettlementMinor, 12500);
});

test('O. A valid CustomerId is accepted and stored on the created row', async () => {
  await freshDatabase('set_valid_customer');
  const customer = await seedCustomer({ code: 'C-910' });
  const record = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-07', Amount: '90'
  });
  assert.equal(record.Record.CustomerId, customer.Id);
  const [row] = await settlementService.listSettlementMovements();
  assert.equal(row.CustomerId, customer.Id);
});

test('P. An unknown CustomerId is rejected with NOT_FOUND and writes nothing', async () => {
  await freshDatabase('set_unknown_customer');
  await assert.rejects(
    () => settlementService.createSettlementMovement({
      TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: 'missing-customer', Date: '2026-10-01', Amount: '10'
    }),
    (error) => error.code === 'NOT_FOUND'
  );
  assert.equal((await settlementService.listSettlementMovements()).length, 0);
});

// ---------------------------------------------------------------------------
// G, H, I, J, K, L, M, N — validation.
// ---------------------------------------------------------------------------

test('G. A settlement amount must be greater than zero', async () => {
  await freshDatabase('set_amount_positive');
  const customer = await seedCustomer();
  const ok = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Amount: '1'
  });
  assert.equal(ok.Record.AmountMinor, 100);
});

test('H, I, J, K. Empty, zero, negative and non-numeric amounts are all rejected', async () => {
  await freshDatabase('set_amount_validation');
  const customer = await seedCustomer();
  for (const amount of ['', '0', '-1', 'abc', null, undefined]) {
    await assert.rejects(() => settlementService.createSettlementMovement({
      TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Amount: amount
    }), (error) => error.code === 'VALIDATION_ERROR', `amount ${String(amount)} must be refused`);
    await assert.rejects(() => settlementService.createSettlementMovement({
      TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-01', Amount: amount
    }), (error) => error.code === 'VALIDATION_ERROR', `goods exchange amount ${String(amount)} must be refused`);
  }
  assert.equal((await settlementService.listSettlementMovements()).length, 0);
});

test('L. An empty customer is rejected', async () => {
  await freshDatabase('set_empty_customer');
  await assert.rejects(() => settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: '', Date: '2026-10-01', Amount: '10'
  }), (error) => error.code === 'VALIDATION_ERROR' && error.field === 'CustomerId');
});

test('M. An empty or invalid date is rejected', async () => {
  await freshDatabase('set_empty_date');
  const customer = await seedCustomer();
  for (const date of ['', '2026-13-45', 'not-a-date']) {
    await assert.rejects(() => settlementService.createSettlementMovement({
      TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: date, Amount: '10'
    }), (error) => error.code === 'VALIDATION_ERROR' && error.field === 'Date');
  }
  assert.equal((await settlementService.listSettlementMovements()).length, 0);
});

test('N. The description is optional and an absent one stays absent', async () => {
  await freshDatabase('set_description_optional');
  const customer = await seedCustomer();
  const result = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-01', Amount: '20'
  });
  assert.equal(result.Record.Description, null);
  const [row] = await settlementService.listSettlementMovements();
  assert.equal(movementRow(row).cells[4], EMPTY_VALUE, 'no invented description text');
});

// ---------------------------------------------------------------------------
// Q — persistence.
// ---------------------------------------------------------------------------

test('Q. A settlement survives a database reload', async () => {
  await freshDatabase('set_persist');
  const customer = await seedCustomer({ opening: 1000 });
  await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-08', Amount: '200'
  });
  await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-09', Amount: '50'
  });
  await simulateReload();
  const rows = await settlementService.listSettlementMovements();
  assert.equal(rows.length, 2);
  const totals = settlementService.summarize(rows);
  assert.equal(totals.TotalSettlementMinor, 20000);
  assert.equal(totals.TotalGoodsExchangeMinor, 5000);
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.BalanceMinor, 100000 + 20000 + 5000);
});

// ---------------------------------------------------------------------------
// R, S, T, U — search.
// ---------------------------------------------------------------------------

test('R, S, T, U. Search matches Code, Name, Phone and Description', () => {
  const rows = [
    { Code: 'C-100', Name: 'أحمد', Phone: '0111222333', Description: 'تسوية مخزون', TransactionType: 'Settlement' },
    { Code: 'C-200', Name: 'محمود', Phone: '0199888777', Description: null, TransactionType: 'GoodsExchange' }
  ];
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), search: 'c-100' }).length, 1);
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), search: 'أحمد' }).length, 1);
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), search: '0199' }).length, 1);
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), search: 'مخزون' }).length, 1);
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), search: 'zzz' }).length, 0);
  assert.equal(matchesSettlementSearch(rows[0], ''), true);
});

// ---------------------------------------------------------------------------
// V, W, X, Y, Z, AA, AB — filters.
// ---------------------------------------------------------------------------

test('V, W. The type filter narrows to one non-cash type', () => {
  const rows = [
    { TransactionType: 'Settlement', Code: 'C-1' },
    { TransactionType: 'GoodsExchange', Code: 'C-2' }
  ];
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), type: 'Settlement' }).length, 1);
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), type: 'GoodsExchange' }).length, 1);
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), type: SETTLEMENT_TYPE_FILTER.ALL }).length, 2);
  assert.equal(matchesSettlementType(rows[0], null), true);
});

test('X, Y. The date range filter uses the stored ISO date without conversion', () => {
  const rows = [
    { Date: '2026-09-01', Code: 'A' },
    { Date: '2026-10-01', Code: 'B' },
    { Date: '2026-11-01', Code: 'C' }
  ];
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), from: '2026-09-15' }).length, 2);
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), to: '2026-10-15' }).length, 2);
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), from: '2026-10-01', to: '2026-10-01' }).length, 1);
  assert.equal(matchesSettlementRange(rows[0], {}), true);
});

test('Z, AA. The status filter separates active from cancelled rows', () => {
  const rows = [
    { Status: 'Active', IsCancelled: false, Code: 'A' },
    { Status: 'Cancelled', IsCancelled: true, Code: 'B' }
  ];
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), status: SETTLEMENT_STATUS_FILTER.ACTIVE }).length, 1);
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), status: SETTLEMENT_STATUS_FILTER.CANCELLED }).length, 1);
  assert.equal(matchesSettlementStatus(rows[0], SETTLEMENT_STATUS_FILTER.ALL), true);
});

test('AB. Resetting the filters restores the full list', async () => {
  await freshDatabase('set_reset_filters');
  const customer = await seedCustomer();
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Amount: '10' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-02', Amount: '20' });

  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  view.setCriteria({ type: TRANSACTION_TYPE.GOODS_EXCHANGE, search: 'zzz' });
  assert.equal(visibleSettlements(view.state.rows, view.state.criteria).length, 0);

  const defaults = { ...defaultSettlementCriteria() };
  view.setCriteria(defaults);
  assert.deepEqual(view.state.criteria, defaults);
  assert.equal(visibleSettlements(view.state.rows, view.state.criteria).length, 2);
});

// ---------------------------------------------------------------------------
// AC, AD — cancelled rows.
// ---------------------------------------------------------------------------

test('AC. A cancelled settlement is excluded from the totals but stays visible', async () => {
  await freshDatabase('set_summary_cancelled');
  const customer = await seedCustomer();
  const created = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Amount: '300'
  });
  await cancellationService.cancelTransaction(created.Record.Id, 'خطأ في الإدخال');
  const rows = await settlementService.listSettlementMovements();
  assert.equal(rows.length, 1, 'the cancelled row stays visible');
  const totals = settlementService.summarize(rows);
  assert.equal(totals.TotalSettlementMinor, 0);
  assert.equal(totals.TotalNonCashMinor, 0);
  assert.equal(totals.CancelledCount, 1);
  assert.equal(totals.Count, 0);
});

test('AD. A cancelled settlement changes neither the running balance nor the customer balance', async () => {
  await freshDatabase('set_cancelled_balance');
  const customer = await seedCustomer({ opening: 1000 });
  const created = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Amount: '500'
  });
  const during = (await balanceService.getCustomerSummary(customer.Id)).BalanceMinor;
  await cancellationService.cancelTransaction(created.Record.Id, 'تكرار');
  const after = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(during, 100000 + 50000);
  assert.equal(after.BalanceMinor, 100000);
  const [row] = await settlementService.listSettlementMovements();
  assert.equal(row.IsCancelled, true);
  assert.equal(row.RunningBalanceMinor, 100000, 'the running balance is the unchanged opening balance');
  assert.equal(movementRow(row).className, 'ledger-row--cancelled');
  assert.match(movementRow(row).cells[10], new RegExp(CANCELLED_LABEL));
});

// ---------------------------------------------------------------------------
// AE, AF, AG, AH — non-cash isolation, both directions.
// ---------------------------------------------------------------------------

test('AE, AF. CashReceived and CashPaid never appear in the settlements read model', async () => {
  await freshDatabase('set_no_cash');
  const customer = await seedCustomer();
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: '100' });
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_PAID, CustomerId: customer.Id, Date: '2026-10-02', Amount: '70' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-03', Amount: '40' });

  const rows = await settlementService.listSettlementMovements();
  assert.equal(rows.length, 1, 'only the settlement may appear');
  assert.equal(rows[0].TransactionType, TRANSACTION_TYPE.SETTLEMENT);
  assert.equal(rows.some((row) => row.TransactionType === TRANSACTION_TYPE.CASH_RECEIVED), false);
  assert.equal(rows.some((row) => row.TransactionType === TRANSACTION_TYPE.CASH_PAID), false);
  const totals = settlementService.summarize(rows);
  assert.equal(totals.TotalNonCashMinor, 4000);
  assert.equal(totals.TotalSettlementMinor, 4000);
});

test('AG, AH. Settlement and GoodsExchange never appear in the payments read model', async () => {
  await freshDatabase('set_not_in_payments');
  const customer = await seedCustomer();
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Amount: '100' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-02', Amount: '200' });

  const cashRows = await paymentService.listCashMovements();
  assert.equal(cashRows.length, 0, 'no non-cash row may reach the payments read model');
  const cashTotals = paymentService.summarize(cashRows);
  assert.equal(cashTotals.CashReceivedMinor, 0);
  assert.equal(cashTotals.CashPaidMinor, 0);
  assert.equal(cashTotals.NetCashMinor, 0);
});

test('Isolation is symmetric: each screen sees only its own group', async () => {
  await freshDatabase('set_isolation_both');
  const customer = await seedCustomer();
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: '100' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-02', Amount: '200' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-03', Amount: '300' });

  const cashRows = await paymentService.listCashMovements();
  const setRows = await settlementService.listSettlementMovements();
  assert.deepEqual(cashRows.map((row) => row.TransactionType), [TRANSACTION_TYPE.CASH_RECEIVED]);
  assert.deepEqual(setRows.map((row) => row.TransactionType), [TRANSACTION_TYPE.SETTLEMENT, TRANSACTION_TYPE.GOODS_EXCHANGE]);
  // The core totals keep cash and non-cash strictly apart.
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.CashReceivedMinor, 10000);
  assert.equal(summary.CashPaidMinor, 0);
  assert.equal(summary.NonCashSettlementMinor, 50000);
  assert.equal(summary.BalanceMinor, 10000 + 20000 + 30000);
});

test('DebtTransfer is non-cash in the core but deliberately NOT part of this screen', async () => {
  await freshDatabase('set_no_debt_transfer');
  const a = await seedCustomer({ code: 'C-970', name: 'أ' });
  const b = await seedCustomer({ code: 'C-971', name: 'ب' });
  await debtTransferService.createDebtTransfer({ FromCustomerId: b.Id, ToCustomerId: a.Id, Date: '2026-10-01', Amount: 500 });
  assert.equal(NON_CASH_TYPES.includes(TRANSACTION_TYPE.DEBT_TRANSFER), true, 'the core still classifies it non-cash');
  const rows = await settlementService.listSettlementMovements();
  assert.equal(rows.length, 0, 'the settlements screen must not show a debt transfer');
  assert.equal(settlementService.isSettlementType(TRANSACTION_TYPE.DEBT_TRANSFER), false);
  assert.deepEqual(settlementService.movementTypes(), [TRANSACTION_TYPE.SETTLEMENT, TRANSACTION_TYPE.GOODS_EXCHANGE]);
});

// ---------------------------------------------------------------------------
// AI, AJ — customer account navigation and pre-selection.
// ---------------------------------------------------------------------------

test('AI. A settlement row opens the customer account by CustomerId and shows the movement', async () => {
  await freshDatabase('set_navigation');
  const customer = await seedCustomer({ code: 'C-940' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Amount: '30' });
  const [row] = await settlementService.listSettlementMovements();
  const cells = movementRow(row).cells;
  const expected = customerAccountPath(customer.Id);
  assert.match(cells[11], new RegExp(`href="#${expected.replace(/[/]/g, '\\/')}"`));
  assert.match(cells[11], new RegExp(customer.Id));
  const resolved = resolveDestination(`#${expected}`);
  assert.equal(resolved.destination.id, 'customer-account');
  assert.equal(resolved.params.id, customer.Id);

  const ledger = await balanceService.getRunningBalance(customer.Id);
  assert.equal(ledger.Entries.filter((entry) => entry.TransactionType === TRANSACTION_TYPE.SETTLEMENT).length, 1);
  assert.equal(ledger.Entries[0].SettlementMinor, 3000);
  assert.equal(ledger.Entries[0].CashReceivedMinor + ledger.Entries[0].CashPaidMinor, 0);
});

test('AJ. A customerId in the route pre-selects the customer and keeps the real identifier', async () => {
  await freshDatabase('set_preselected');
  const customer = await seedCustomer({ code: 'C-950' });
  const resolved = resolveDestination(`#/settlements?customerId=${customer.Id}`);
  assert.equal(resolved.destination.id, 'settlements');
  assert.equal(resolved.params.customerId, customer.Id);

  const container = makeContainer();
  const view = initSettlementsView({ container, customerId: customer.Id, autoLoad: false });
  assert.equal(view.state.values.CustomerId, customer.Id);
  view.state.customers = await settlementService.listSelectableCustomers();
  const form = container.querySelector(`#${SETTLEMENTS_FORM_REGION_ID}`);
  assert.equal(form.innerHTML, '');
  assert.match(renderSettlementForm({ customers: view.state.customers, values: view.state.values }), new RegExp(`value="${customer.Id}" selected`));

  assert.equal(resolveDestination('#/settlements').params.customerId, undefined);
  const blank = initSettlementsView({ container: makeContainer(), autoLoad: false });
  assert.equal(blank.state.values.CustomerId, '');
});

// ---------------------------------------------------------------------------
// AK, AL, AM, AN, AO, AP — UX behaviour.
// ---------------------------------------------------------------------------

test('AK. Save is disabled while saving, re-enabled after success and after failure, and a double press writes once', async () => {
  await freshDatabase('set_busy');
  const customer = await seedCustomer();
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  const formNode = container.querySelector(`#${SETTLEMENTS_FORM_ID}`);
  const submitNode = {
    disabled: false,
    setAttribute(key, value) { this[key] = value; },
    getAttribute(key) { return this[key] ?? null; }
  };
  formNode.controls.set(`#${SETTLEMENTS_SUBMIT_ID}`, submitNode);

  fillForm(container, { customerId: customer.Id, date: '2026-10-02', amount: '40', description: 'أول' });
  const first = view.submit();
  const second = view.submit(); // fired while the first save is still in flight
  const [a, b] = await Promise.all([first, second]);
  assert.ok(a, 'the first save succeeded');
  assert.equal(b, null, 'the repeated press was refused');
  assert.equal((await settlementService.listSettlementMovements()).length, 1, 'exactly one row was written');
  assert.equal(submitNode.disabled, false, 'save is usable again after a success');

  fillForm(container, { customerId: customer.Id, date: '2026-10-02', amount: '0' });
  const failure = await view.submit();
  assert.equal(failure, null, 'the invalid save returned no result');
  assert.equal(submitNode.disabled, false, 'save is usable again after a failure');
  assert.equal(view.state.busy, false);
  assert.equal((await settlementService.listSettlementMovements()).length, 1, 'the failed save wrote nothing');
});

test('AL. Every entered value survives a failed save', async () => {
  await freshDatabase('set_preserve');
  const customer = await seedCustomer();
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  fillForm(container, { customerId: customer.Id, date: '2026-10-09', amount: '-3', description: 'بيان محفوظ' });
  await view.submit();
  assert.equal(view.state.values.CustomerId, customer.Id);
  assert.equal(view.state.values.Date, '2026-10-09');
  assert.equal(view.state.values.Amount, '-3');
  assert.equal(view.state.values.Description, 'بيان محفوظ');
  assert.ok(view.state.formError, 'a visible message is produced');
  assert.match(container.querySelector(`#${SETTLEMENTS_FORM_REGION_ID}`).innerHTML, /تعذّر حفظ التسوية/);
});

test('AM. A successful save shows the success state and clears only the movement fields', async () => {
  await freshDatabase('set_success_state');
  const customer = await seedCustomer();
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  fillForm(container, { customerId: customer.Id, date: '2026-10-11', amount: '55', description: 'تسوية' });
  const result = await view.submit();
  assert.ok(result);
  assert.match(container.querySelector(`#${SETTLEMENTS_SUCCESS_ID}`).innerHTML, new RegExp(SETTLEMENT_SUCCESS_LABEL));
  assert.equal(view.state.values.Amount, '', 'the amount is cleared for the next entry');
  assert.equal(view.state.values.Description, '', 'the description is cleared for the next entry');
  assert.equal(view.state.values.CustomerId, customer.Id, 'the customer is kept on purpose');
  assert.equal(view.state.values.Date, '2026-10-11', 'the date is kept on purpose');
  assert.equal(view.currentTab(), SETTLEMENT_TAB.SETTLEMENT, 'the current tab is kept');
  assert.equal(container.querySelector(`#${SETTLEMENTS_REGION_ID}`).innerHTML.includes('55.00'), true);
});

test('AN, AO, AP. Tab switching changes the type, keeps no stale amount and adds no duplicate controls', async () => {
  await freshDatabase('set_tabs');
  const customer = await seedCustomer();
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  view.state.values = { CustomerId: customer.Id, CustomerSearch: '', Date: '2026-10-12', Amount: '99', Description: 'س' };

  assert.equal(view.switchTab(SETTLEMENT_TAB.GOODS_EXCHANGE), true);
  assert.equal(transactionTypeForTab(view.state.tab), TRANSACTION_TYPE.GOODS_EXCHANGE);
  assert.equal(tabFor(TRANSACTION_TYPE.GOODS_EXCHANGE), SETTLEMENT_TAB.GOODS_EXCHANGE);
  let form = container.querySelector(`#${SETTLEMENTS_FORM_REGION_ID}`).innerHTML;
  assert.match(form, /data-transaction-type="GoodsExchange"/);
  assert.match(form, /حفظ تبادل البضائع/);
  assert.equal((form.match(/id="settlement-amount"/g) || []).length, 1, 'exactly one amount control');
  assert.equal((form.match(/id="settlement-customer"/g) || []).length, 1, 'exactly one customer control');
  assert.equal((form.match(/id="settlement-date"/g) || []).length, 1, 'exactly one date control');
  assert.equal(view.state.fieldErrors.Amount, undefined, 'no stale validation is carried across');

  assert.equal(view.switchTab(SETTLEMENT_TAB.SETTLEMENT), true);
  form = container.querySelector(`#${SETTLEMENTS_FORM_REGION_ID}`).innerHTML;
  assert.match(form, /data-transaction-type="Settlement"/);
  assert.match(form, /حفظ التسوية/);
  assert.equal((form.match(/id="settlement-amount"/g) || []).length, 1);
  assert.equal(view.switchTab(SETTLEMENT_TAB.SETTLEMENT), false, 'switching to the current tab is a no-op');
});

// ---------------------------------------------------------------------------
// AQ, AR, AS, AT — the four states.
// ---------------------------------------------------------------------------

test('AQ. The loading state is painted before the data arrives', async () => {
  await freshDatabase('set_loading');
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  const pending = view.load();
  const html = container.querySelector(`#${SETTLEMENTS_REGION_ID}`).innerHTML;
  assert.match(html, /جارٍ تحميل التسويات/);
  assert.match(html, /spinner/);
  await pending;
  assert.equal(container.querySelector(`#${SETTLEMENTS_REGION_ID}`).attrs['aria-busy'], 'false');
});

test('AR. The empty state is honest and offers the first entry', async () => {
  await freshDatabase('set_empty_state');
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  const html = container.querySelector(`#${SETTLEMENTS_REGION_ID}`).innerHTML;
  assert.match(html, new RegExp(EMPTY_STATE_MESSAGE));
  assert.match(html, /data-action="open-form"/);
});

test('AS. The no-results state is distinct from the empty state', async () => {
  await freshDatabase('set_no_results');
  const customer = await seedCustomer();
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Amount: '10' });
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  view.setCriteria({ search: 'لا-يوجد-بهذا-الاسم' });
  const html = container.querySelector(`#${SETTLEMENTS_REGION_ID}`).innerHTML;
  assert.match(html, new RegExp(NO_RESULTS_MESSAGE));
  assert.match(html, /data-action="reset-filters"/);
  assert.doesNotMatch(html, new RegExp(EMPTY_STATE_MESSAGE));
});

test('AT. A load failure paints the error state with a retry, and the retry re-reads', async () => {
  await freshDatabase('set_error_state');
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });

  const original = settlementService.listSettlementMovements;
  settlementService.listSettlementMovements = async () => { const error = new Error('تعذّر القراءة'); error.code = 'STORAGE_ERROR'; throw error; };
  try {
    await view.load();
    const html = container.querySelector(`#${SETTLEMENTS_REGION_ID}`).innerHTML;
    assert.match(html, /role="alert"/);
    assert.match(html, /تعذّر تحميل التسويات/);
    assert.match(html, /data-action="retry"/);
    assert.match(html, /STORAGE_ERROR/);
    assert.doesNotMatch(html, /class="kpi__value"/, 'no financial value may be shown on failure');
    assert.equal(container.querySelector(`#${SETTLEMENTS_REGION_ID}`).attrs['aria-busy'], 'false');
  } finally {
    settlementService.listSettlementMovements = original;
  }

  await view.load();
  assert.equal(view.state.error, null);
  assert.match(container.querySelector(`#${SETTLEMENTS_REGION_ID}`).innerHTML, new RegExp(EMPTY_STATE_MESSAGE));
});

// ---------------------------------------------------------------------------
// Render projections.
// ---------------------------------------------------------------------------

test('The screen renders exactly the two approved tabs and the ten approved columns', () => {
  assert.deepEqual(SETTLEMENT_TABS.map((tab) => tab.transactionType), ['Settlement', 'GoodsExchange']);
  assert.deepEqual(SETTLEMENT_TABS.map((tab) => tab.label), ['تسوية', 'تبادل بضائع']);
  assert.equal(SETTLEMENT_COLUMNS.length, 12);
  assert.deepEqual(SETTLEMENT_COLUMNS.map((column) => column.label), [
    'التاريخ', 'العميل', 'النوع', 'الاتجاه', 'البيان', 'المبلغ', 'مدين', 'دائن', 'قيمة غير نقدية', 'الرصيد بعد الحركة', 'الحالة', 'إجراء'
  ]);
  const tabs = renderSettlementTabs({ tab: SETTLEMENT_TAB.GOODS_EXCHANGE });
  assert.equal((tabs.match(/role="tab"/g) || []).length, 2);
  assert.match(tabs, /data-tab="goods-exchange"[^>]*aria-selected="true"/);
  assert.doesNotMatch(tabs, /استلام نقدية|دفعة نقدية|تحويل مديونية/, 'cash types and debt transfer must never appear here');
});

test('The summary is non-cash only and never claims to be cash or a collection', async () => {
  await freshDatabase('set_summary_labels');
  const customer = await seedCustomer();
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Amount: '500' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-02', Amount: '150' });
  const totals = settlementService.summarize(await settlementService.listSettlementMovements());
  assert.equal(totals.TotalSettlementMinor, 50000);
  assert.equal(totals.TotalGoodsExchangeMinor, 15000);
  assert.equal(totals.TotalNonCashMinor, 65000);

  const html = renderSettlementsSummary(totals);
  assert.match(html, /إجمالي التسويات/);
  assert.match(html, /إجمالي تبادل البضائع/);
  assert.match(html, /إجمالي التسويات غير النقدية/);
  assert.match(html, /500\.00/);
  assert.match(html, /150\.00/);
  assert.match(html, /650\.00/);
  for (const forbidden of ['إجمالي المقبوضات', 'إجمالي النقدية', 'صافي النقدية', 'إجمالي المدفوعات']) {
    assert.equal(html.includes(forbidden), false, `the summary must never use "${forbidden}"`);
  }
});

test('The form carries exactly Customer, Date, Amount and Description and no forbidden field', async () => {
  await freshDatabase('set_form_fields');
  await seedCustomer({ code: 'C-960' });
  const form = renderSettlementForm({ tab: SETTLEMENT_TAB.SETTLEMENT, customers: await settlementService.listSelectableCustomers() });
  for (const id of Object.values(SETTLEMENT_FIELD_ID)) assert.ok(form.includes(`id="${id}"`), `${id} is present`);
  for (const forbidden of ['PaymentMethod', 'InvoiceNumber', 'Reference', 'Treasury', 'Currency', 'ExchangeRate', 'Debit', 'Credit']) {
    assert.equal(form.includes(`id="${forbidden}`), false, `${forbidden} must never exist in this form`);
  }
  assert.match(form, /id="settlement-form"/);
  assert.match(form, /<label class="field__label" for="settlement-amount">المبلغ<\/label>/);
  assert.match(form, /badge--noncash/);
  const ge = renderSettlementForm({ tab: SETTLEMENT_TAB.GOODS_EXCHANGE });
  assert.match(ge, /حفظ تبادل البضائع/);
  assert.match(ge, /data-transaction-type="GoodsExchange"/);
});

test('The screen never creates a cash movement and never accepts an unknown type', async () => {
  await freshDatabase('set_guard_types');
  const customer = await seedCustomer();
  for (const type of TRANSACTION_TYPES.filter((entry) => !['Settlement', 'GoodsExchange'].includes(entry))) {
    await assert.rejects(() => settlementService.createSettlementMovement({
      TransactionType: type, CustomerId: customer.Id, Date: '2026-10-01', Amount: '10'
    }), (error) => error.code === 'BUSINESS_RULE_ERROR', `${type} must be refused by the settlements service`);
  }
  assert.equal(settlementService.movementTypes().length, 2);
  assert.equal(settlementService.isSettlementType(TRANSACTION_TYPE.CASH_RECEIVED), false);
  assert.equal(settlementService.isSettlementType(TRANSACTION_TYPE.GOODS_EXCHANGE), true);
});

test('The screen is wired as a real destination and its shell renders the design system', async () => {
  await freshDatabase('set_destination');
  const resolved = resolveDestination('#/settlements');
  assert.equal(resolved.destination.id, 'settlements');
  assert.equal(resolved.destination.title, 'التسويات');
  const html = renderDestinationView({ route: resolved.destination, params: resolved.params });
  assert.match(html, /تسجيل ومتابعة التسويات وتبادل البضائع غير النقدية مع العملاء/);
  assert.match(html, /\+ تسجيل تسوية/);
  assert.match(html, new RegExp(`id="${SETTLEMENTS_REGION_ID}"`));
  assert.match(html, /role="tablist"/);
  assert.doesNotMatch(html, /هيكل التطبيق/, 'the placeholder notice is gone for this screen');
  assert.match(settlementsViewHtml(), new RegExp(`id="${SETTLEMENTS_SUMMARY_ID}"`));
  assert.match(settlementsScreenHtml({ rows: [], criteria: defaultSettlementCriteria() }), new RegExp(EMPTY_STATE_MESSAGE));
  assert.match(renderSettlementsToolbar({ criteria: defaultSettlementCriteria() }), /إعادة ضبط الفلاتر/);
  assert.match(renderSettlementSuccess({ result: null, tab: SETTLEMENT_TAB.GOODS_EXCHANGE }), new RegExp(GOODS_EXCHANGE_SUCCESS_LABEL));
  assert.equal(customerDisplay({}), EMPTY_VALUE);
  assert.equal(typeLabel('Settlement'), 'تسوية');
  assert.equal(typeLabel('GoodsExchange'), 'تبادل بضائع');
  assert.equal(typeLabel(''), EMPTY_VALUE);
  assert.equal(formatMoneyMinor(1234), '12.34');
  assert.equal(formatQuantityMinor(1000), '1.000');
});

test('The picker offers Code + Name and searches by Code, Name and Phone', async () => {
  await freshDatabase('set_picker');
  await seedCustomer({ code: 'C-901', name: 'عميل أول' });
  await seedCustomer({ code: 'C-902', name: 'عميل ثانٍ', phone: '0111111111' });
  const customers = await settlementService.listSelectableCustomers();
  assert.equal(customers.length, 2);
  const options = customerOptions(customers);
  assert.equal(options[0].value, '');
  assert.ok(options.some((option) => option.label === 'C-901 — عميل أول'));
  assert.ok(options.some((option) => option.search.includes('0111111111')));
});

// ---------------------------------------------------------------------------
// Running balance — the real sequence, not a repeated current balance.
// ---------------------------------------------------------------------------

test('Running balance walks the real sequence: 1000 -> 1200 -> 1350 -> 1450', async () => {
  await freshDatabase('set_running_balance');
  const customer = await seedCustomer({ opening: 1000 });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Amount: '200' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-02', Amount: '150' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-03', Amount: '100' });

  const rows = await settlementService.listSettlementMovements();
  assert.deepEqual(rows.map((row) => row.RunningBalanceMinor), [120000, 135000, 145000]);
  const rendered = rows.map((row) => movementRow(row).cells[9]);
  assert.match(rendered[0], /1,200\.00/);
  assert.match(rendered[1], /1,350\.00/);
  assert.match(rendered[2], /1,450\.00/);
  assert.notEqual(rendered[0], rendered[2], 'the current balance must not be repeated on every row');

  // The core ledger agrees, and the closing figure equals the customer balance.
  const ledger = await balanceService.getRunningBalance(customer.Id);
  assert.deepEqual(rows.map((row) => row.RunningBalanceMinor), ledger.Entries.map((entry) => entry.RunningBalanceMinor));
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 145000);
});

test('Filtering never recomputes the running balance: it stays the full-sequence value', async () => {
  await freshDatabase('set_running_balance_filter');
  const customer = await seedCustomer({ opening: 500 });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Amount: '100' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-02', Amount: '200' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-03', Amount: '300' });

  const rows = await settlementService.listSettlementMovements();
  const narrowed = visibleSettlements(rows, { ...defaultSettlementCriteria(), to: '2026-10-01' });
  assert.equal(narrowed.length, 1);
  assert.equal(narrowed[0].RunningBalanceMinor, 60000, 'the first row keeps its own sequence value');
  assert.equal(rows[2].RunningBalanceMinor, 110000, 'the full sequence is untouched by the narrowing');
});

test('The list is deterministic and stable across reads', async () => {
  await freshDatabase('set_order');
  const customer = await seedCustomer({ opening: 100 });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-02', Amount: '30' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Amount: '10' });
  const rows = await settlementService.listSettlementMovements();
  assert.deepEqual(rows.map((row) => row.Date), ['2026-10-01', '2026-10-02']);
  const second = await settlementService.listSettlementMovements();
  assert.deepEqual(second.map((row) => row.Id), rows.map((row) => row.Id));
});

// ---------------------------------------------------------------------------
// AU, AV, AW — architecture and hygiene.
// ---------------------------------------------------------------------------

test('AU, AV. The UI layer never reaches the data layer below the services', () => {
  const files = walk(uiRoot);
  assert.ok(files.length >= 10);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const forbidden of ['repositories', 'storage/db', 'storage/schema', 'indexedDB', 'IndexedDB', 'IDBKeyRange']) {
      assert.equal(source.includes(forbidden), false, `${file} must not reference ${forbidden}`);
    }
  }
});

test('AW. The settlements screen holds no financial engine and no invented data', () => {
  const source = readFileSync(join(uiRoot, 'views', 'settlements.js'), 'utf8');
  for (const forbidden of ['deriveFinancials', 'getRunningBalance', 'FINANCIAL_RULES']) {
    assert.equal(source.includes(forbidden), false, `settlements.js must not use ${forbidden}`);
  }
  assert.doesNotMatch(source, /BalanceMinor\s*[+\-*/]?=/, 'no balance arithmetic in the UI');
  assert.doesNotMatch(source, /CreditMinor\s*[+\-*/]?=/, 'no credit arithmetic in the UI');
  assert.doesNotMatch(source, /CashReceivedMinor\s*[+\-*/]?=/, 'no cash arithmetic in the UI');
  assert.doesNotMatch(source, /credit\s*=\s*amount|debit\s*=\s*amount/i, 'no direction decision in the UI');
  assert.doesNotMatch(source, /TODO|FIXME|XXX|HACK/);
  for (const file of walk(uiRoot)) assert.doesNotMatch(readFileSync(file, 'utf8'), /TODO|FIXME|XXX|HACK/, `${file} carries a marker`);
  assert.doesNotMatch(source, /sampleSettlements|mockSettlements|fakeData|placeholderRows/);
  // The design-system alert component is the approved notification system; only a
  // native browser alert would be forbidden.
  assert.doesNotMatch(source, /window\.alert\(|globalThis\.alert\(|document\.alert\(/, 'no native browser alert() anywhere');
  assert.match(source, /import \{[^}]*alert[^}]*\} from '\.\.\/components\/index\.js'/, 'notifications use the design-system alert component');
});

test('The settlements service holds no duplicated financial rule and no marker', () => {
  const source = readFileSync(join(projectRoot, 'src', 'services', 'settlementService.js'), 'utf8');
  assert.doesNotMatch(source, /TODO|FIXME|XXX|HACK/);
  assert.doesNotMatch(source, /OpeningBalanceMinor\s*\+/, 'the balance formula belongs to the core');
  assert.doesNotMatch(source, /FINANCIAL_RULES/, 'the direction matrix belongs to the core');
  // The only aggregates are plain sums of core-provided values.
  assert.match(source, /SettlementCreditMinor \+= credit/);
  assert.match(source, /SettlementDebitMinor \+= debit/);
  assert.match(source, /GoodsExchangeCreditMinor \+= credit/);
  assert.match(source, /GoodsExchangeDebitMinor \+= debit/);
  assert.match(source, /TotalNonCashMinor: TotalSettlementMinor \+ TotalGoodsExchangeMinor/);
});

test('The core matrix keeps both types side-dependent, non-cash and zero-cash', () => {
  for (const type of [TRANSACTION_TYPE.SETTLEMENT, TRANSACTION_TYPE.GOODS_EXCHANGE]) {
    const rule = FINANCIAL_RULES[type];
    assert.equal(rule.direction, 'SideDependent', `${type} takes its direction from the record`);
    assert.equal(rule.bucket, 'NonCash', `${type} must sit in the non-cash bucket`);
    // A row stored before the direction field existed keeps the approved Credit behaviour.
    const legacy = deriveFinancials({ TransactionType: type, AmountMinor: 100, Status: 'Active' });
    assert.equal(legacy.CreditMinor, 100);
    assert.equal(legacy.DebitMinor, 0);
    const debit = deriveFinancials({ TransactionType: type, AmountMinor: 100, Status: 'Active', Direction: 'Debit' });
    assert.equal(debit.DebitMinor, 100);
    assert.equal(debit.CreditMinor, 0);
    for (const f of [legacy, debit]) {
      assert.equal(f.CashReceivedMinor, 0);
      assert.equal(f.CashPaidMinor, 0);
    }
  }
});

test('The settlements save path is the very same entry point Add Transaction uses', async () => {
  await freshDatabase('set_same_path');
  const customer = await seedCustomer();
  let seen = null;
  const original = transactionFormService.submitTransactionForm;
  transactionFormService.submitTransactionForm = async (form) => { seen = { ...form }; return original.call(transactionFormService, form); };
  try {
    await settlementService.createSettlementMovement({
      TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-13', Amount: '11'
    });
  } finally {
    transactionFormService.submitTransactionForm = original;
  }
  assert.equal(seen.TransactionType, TRANSACTION_TYPE.GOODS_EXCHANGE);
  assert.equal(seen.Amount, '11');
  assert.equal('AmountMinor' in seen, false, 'the UI never sends a minor-unit override');
  assert.equal('CreditMinor' in seen, false, 'the UI never sends a direction');
});

test('The approved screens were not rebuilt: customer account, add transaction and payments stay intact', () => {
  const account = readFileSync(join(uiRoot, 'views', 'customerAccount.js'), 'utf8');
  assert.match(account, /getRunningBalance/);
  const addForm = readFileSync(join(uiRoot, 'views', 'transactionForm.js'), 'utf8');
  assert.match(addForm, /submitTransactionForm/);
  const payments = readFileSync(join(uiRoot, 'views', 'payments.js'), 'utf8');
  assert.match(payments, /paymentService/);
  const routes = readFileSync(join(uiRoot, 'routes.js'), 'utf8');
  assert.match(routes, /\/transactions\/add/);
  assert.match(routes, /\/customer\/:id/);
  assert.match(routes, /paymentsPath/);
});
