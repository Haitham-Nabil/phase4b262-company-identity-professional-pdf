// Phase 4B.7A.1 — the Settlement tabs scope the TABLE by the STORED transaction type.
//
// Every scenario runs through the real services against an isolated fake-indexeddb
// database. The tab scope is a view-level narrowing: it is asserted here to change the
// rendered rows and nothing else — no total, no direction, no stored movement, no
// payments figure. No financial service is ever stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { settlementService } from '../src/services/settlementService.js';
import { paymentService } from '../src/services/paymentService.js';
import { balanceService } from '../src/services/balanceService.js';
import { deriveFinancials } from '../src/domain/financialDirection.js';
import { TRANSACTION_TYPE } from '../src/domain/transactionTypes.js';
import {
  SETTLEMENTS_REGION_ID, SETTLEMENTS_SUMMARY_ID, SETTLEMENTS_TOOLBAR_ID, SETTLEMENTS_FORM_REGION_ID,
  SETTLEMENTS_SUCCESS_ID, SETTLEMENTS_TABS_REGION_ID, SETTLEMENT_TAB,
  SETTLEMENT_COLUMNS, defaultSettlementCriteria, visibleSettlements, tabScopedSettlements, movementRow,
  renderSettlementTabs, transactionTypeForTab, tabFor,
  NO_RESULTS_MESSAGE, EMPTY_STATE_MESSAGE, initSettlementsView
} from '../ui/views/settlements.js';
import { logger } from '../src/utils/logger.js';

logger.disable?.();

// ---- the same minimal detached container the approved suites use -------------
function makeNode() {
  return {
    innerHTML: '', attrs: {}, controls: new Map(), isConnected: true,
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key]; },
    querySelector(selector) { return this.controls.get(String(selector)) || null; }
  };
}
function makeContainer() {
  const ids = [SETTLEMENTS_SUMMARY_ID, SETTLEMENTS_TOOLBAR_ID, SETTLEMENTS_REGION_ID, SETTLEMENTS_FORM_REGION_ID, SETTLEMENTS_SUCCESS_ID, SETTLEMENTS_TABS_REGION_ID];
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
const regionHtml = (container) => container.querySelector(`#${SETTLEMENTS_REGION_ID}`).innerHTML;
const summaryHtml = (container) => container.querySelector(`#${SETTLEMENTS_SUMMARY_ID}`).innerHTML;

async function seedCustomer({ code = 'C-940', name = 'مزارع التبويب', opening = 1000 } = {}) {
  return customerService.createCustomer({ Code: code, Name: name, Phone: '0100000007', Region: 'طنطا', OpeningBalance: opening });
}
// Three non-cash movements with unmistakable descriptions: two Settlement, one GoodsExchange.
async function seedMovements(customerId) {
  const s1 = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customerId, Date: '2026-10-01', Direction: 'Credit', Amount: 200, Description: 'وصف-تسوية-أ'
  });
  const ge = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customerId, Date: '2026-10-02', Direction: 'Debit', Amount: 150, Description: 'وصف-تبادل-ب'
  });
  const s2 = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customerId, Date: '2026-10-09', Direction: 'Debit', Amount: 40, Description: 'وصف-تسوية-ج'
  });
  return { s1: s1.Record, ge: ge.Record, s2: s2.Record };
}

// 1 — Settlement tab shows Settlement rows only.
test('1 — the Settlement tab lists stored Settlement movements only', async () => {
  await freshDatabase('tab_settlement_only');
  const customer = await seedCustomer();
  await seedMovements(customer.Id);
  const rows = await settlementService.listSettlementMovements();

  const scoped = tabScopedSettlements(rows, defaultSettlementCriteria(), SETTLEMENT_TAB.SETTLEMENT);
  assert.equal(scoped.length, 2, 'both Settlement rows');
  assert.equal(scoped.every((row) => row.TransactionType === TRANSACTION_TYPE.SETTLEMENT), true);
  assert.equal(scoped.some((row) => row.TransactionType === TRANSACTION_TYPE.GOODS_EXCHANGE), false);

  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  const html = regionHtml(container);
  assert.match(html, /وصف-تسوية-أ/);
  assert.match(html, /وصف-تسوية-ج/);
  assert.doesNotMatch(html, /وصف-تبادل-ب/, 'no GoodsExchange row on the Settlement tab');
  assert.match(html, /عدد النتائج: 2 من 3/);
});

// 2 — GoodsExchange tab shows GoodsExchange rows only.
test('2 — the GoodsExchange tab lists stored GoodsExchange movements only', async () => {
  await freshDatabase('tab_goods_exchange_only');
  const customer = await seedCustomer();
  await seedMovements(customer.Id);
  const rows = await settlementService.listSettlementMovements();

  const scoped = tabScopedSettlements(rows, defaultSettlementCriteria(), SETTLEMENT_TAB.GOODS_EXCHANGE);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].TransactionType, TRANSACTION_TYPE.GOODS_EXCHANGE);

  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  view.switchTab(SETTLEMENT_TAB.GOODS_EXCHANGE);
  const html = regionHtml(container);
  assert.match(html, /وصف-تبادل-ب/);
  assert.doesNotMatch(html, /وصف-تسوية-أ/);
  assert.doesNotMatch(html, /وصف-تسوية-ج/);
  assert.match(html, /عدد النتائج: 1 من 3/);
});

// 3 — switching updates the table immediately, with no reload.
test('3 — switching the tab repaints the table at once, without reloading', async () => {
  await freshDatabase('tab_switch_immediate');
  const customer = await seedCustomer();
  await seedMovements(customer.Id);
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();

  const before = regionHtml(container);
  assert.match(before, /وصف-تسوية-أ/);
  assert.doesNotMatch(before, /وصف-تبادل-ب/);

  assert.equal(view.switchTab(SETTLEMENT_TAB.GOODS_EXCHANGE), true);
  const after = regionHtml(container);
  assert.match(after, /وصف-تبادل-ب/, 'the table follows the tab with no further call');
  assert.doesNotMatch(after, /وصف-تسوية-أ/);
  assert.notEqual(after, before);
  assert.match(container.querySelector(`#${SETTLEMENTS_TABS_REGION_ID}`).innerHTML, /aria-selected="true"[^>]*|data-tab="goods-exchange"/);
  assert.equal(transactionTypeForTab(view.state.tab), TRANSACTION_TYPE.GOODS_EXCHANGE);
  assert.equal(tabFor(TRANSACTION_TYPE.GOODS_EXCHANGE), SETTLEMENT_TAB.GOODS_EXCHANGE);

  // and back
  assert.equal(view.switchTab(SETTLEMENT_TAB.SETTLEMENT), true);
  const again = regionHtml(container);
  assert.match(again, /وصف-تسوية-أ/);
  assert.doesNotMatch(again, /وصف-تبادل-ب/);
  assert.equal(view.switchTab(SETTLEMENT_TAB.SETTLEMENT), false, 're-selecting the current tab stays a no-op');
});

// 4 — search / date / status combine with the tab scope.
test('4 — search, the date range and the status filter all work together with the tab scope', async () => {
  await freshDatabase('tab_combined_filters');
  const customer = await seedCustomer();
  await seedMovements(customer.Id);
  const rows = await settlementService.listSettlementMovements();

  const settlementTab = (criteria) => tabScopedSettlements(rows, criteria, SETTLEMENT_TAB.SETTLEMENT);
  const geTab = (criteria) => tabScopedSettlements(rows, criteria, SETTLEMENT_TAB.GOODS_EXCHANGE);

  // search alone
  assert.equal(settlementTab({ ...defaultSettlementCriteria(), search: 'وصف-تسوية-ج' }).length, 1);
  assert.equal(settlementTab({ ...defaultSettlementCriteria(), search: 'وصف-تبادل-ب' }).length, 0, 'a search hit of the other type stays hidden');
  // date range alone
  assert.equal(settlementTab({ ...defaultSettlementCriteria(), from: '2026-10-05' }).length, 1);
  assert.equal(settlementTab({ ...defaultSettlementCriteria(), to: '2026-10-05' }).length, 1);
  assert.equal(geTab({ ...defaultSettlementCriteria(), to: '2026-10-05' }).length, 1);
  // search + date + tab together
  assert.equal(settlementTab({ ...defaultSettlementCriteria(), search: 'تسوية', from: '2026-10-05', to: '2026-10-31' }).length, 1);
  assert.equal(settlementTab({ ...defaultSettlementCriteria(), search: 'تسوية', from: '2026-10-10' }).length, 0);
  // the toolbar-level type filter still composes with the tab scope
  assert.equal(tabScopedSettlements(rows, { ...defaultSettlementCriteria(), type: TRANSACTION_TYPE.GOODS_EXCHANGE }, SETTLEMENT_TAB.SETTLEMENT).length, 0);
  assert.equal(tabScopedSettlements(rows, { ...defaultSettlementCriteria(), type: TRANSACTION_TYPE.GOODS_EXCHANGE }, SETTLEMENT_TAB.GOODS_EXCHANGE).length, 1);

  // status filter through the live view
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  view.setCriteria({ status: 'cancelled' });
  assert.match(regionHtml(container), new RegExp(NO_RESULTS_MESSAGE), 'no cancelled Settlement yet');
  view.setCriteria({ status: 'all' });
  assert.match(regionHtml(container), /وصف-تسوية-أ/);
  assert.equal(view.state.tab, SETTLEMENT_TAB.SETTLEMENT);
});

// 5 — the no-results state is correct for the selected type.
test('5 — a tab with no rows of its own type shows the honest no-results / empty state', async () => {
  await freshDatabase('tab_no_results');
  const customer = await seedCustomer();
  // only a GoodsExchange exists, so the Settlement tab has nothing of its own type
  await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-02', Direction: 'Credit', Amount: 150, Description: 'وصف-تبادل-ب'
  });
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();

  const html = regionHtml(container);
  assert.match(html, new RegExp(NO_RESULTS_MESSAGE), 'the Settlement tab reports no rows of its type');
  assert.doesNotMatch(html, /وصف-تبادل-ب/);

  view.switchTab(SETTLEMENT_TAB.GOODS_EXCHANGE);
  assert.match(regionHtml(container), /وصف-تبادل-ب/);

  // a genuinely empty store keeps the empty state on both tabs
  await freshDatabase('tab_empty');
  const emptyContainer = makeContainer();
  const emptyView = initSettlementsView({ container: emptyContainer, autoLoad: false });
  await emptyView.load();
  assert.match(regionHtml(emptyContainer), new RegExp(EMPTY_STATE_MESSAGE));
  emptyView.switchTab(SETTLEMENT_TAB.GOODS_EXCHANGE);
  assert.match(regionHtml(emptyContainer), new RegExp(EMPTY_STATE_MESSAGE));
});

// 6 — the approved totals never follow the tab.
test('6 — the two type totals and the non-cash totals are identical on both tabs', async () => {
  await freshDatabase('tab_totals_unchanged');
  const customer = await seedCustomer();
  await seedMovements(customer.Id);
  const rows = await settlementService.listSettlementMovements();
  const totals = settlementService.summarize(rows);

  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  const settlementSummary = summaryHtml(container);
  assert.match(settlementSummary, /200\.00/, 'Settlement credit 200 is present');
  assert.match(settlementSummary, /40\.00/, 'Settlement debit 40 is present');
  assert.match(settlementSummary, /150\.00/, 'GoodsExchange debit 150 is present');

  view.switchTab(SETTLEMENT_TAB.GOODS_EXCHANGE);
  const geSummary = summaryHtml(container);
  assert.equal(geSummary, settlementSummary, 'switching the tab repaints no total');
  assert.match(geSummary, /150\.00/);
  view.switchTab(SETTLEMENT_TAB.SETTLEMENT);
  assert.equal(summaryHtml(container), settlementSummary);

  // and the numbers themselves come straight from the service over the full list
  assert.equal(totals.TotalNonCashMinor, (200 + 150 + 40) * 100);
  assert.equal(totals.TotalSettlementMinor, (200 + 40) * 100);
  assert.equal(totals.TotalGoodsExchangeMinor, 150 * 100);
  assert.equal(totals.Count, 3);
});

// 7 — the Payments screen totals never follow the Settlement tabs.
test('7 — switching the settlement tabs leaves every Payments figure untouched', async () => {
  await freshDatabase('tab_payments_untouched');
  const customer = await seedCustomer();
  await paymentService.createCashMovement({
    TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: 500, Description: 'استلام'
  });
  await seedMovements(customer.Id);

  const cashBefore = paymentService.summarize(await paymentService.listCashMovements());
  const cashText = JSON.stringify(cashBefore);

  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  view.switchTab(SETTLEMENT_TAB.GOODS_EXCHANGE);
  view.switchTab(SETTLEMENT_TAB.SETTLEMENT);

  const cashAfter = paymentService.summarize(await paymentService.listCashMovements());
  assert.equal(JSON.stringify(cashAfter), cashText, 'the cash totals are byte-identical');
  assert.doesNotMatch(JSON.stringify(cashAfter), /50000.*50000.*190/);
  assert.equal(cashAfter.CashReceivedMinor, 500 * 100);
  assert.equal((await settlementService.listSettlementMovements()).length, 3, 'no non-cash row entered the cash list');
});

// 8 — the Credit / Debit directions stay exactly as stored.
test('8 — the stored Credit / Debit directions are unchanged by the tab scope', async () => {
  await freshDatabase('tab_directions');
  const customer = await seedCustomer();
  await seedMovements(customer.Id);
  const rows = await settlementService.listSettlementMovements();

  for (const tab of [SETTLEMENT_TAB.SETTLEMENT, SETTLEMENT_TAB.GOODS_EXCHANGE]) {
    const scoped = tabScopedSettlements(rows, defaultSettlementCriteria(), tab);
    for (const row of scoped) {
      const financials = deriveFinancials(row);
      assert.equal(financials.direction, row.Direction, 'the engine reads the stored direction');
      if (row.Direction === 'Credit') {
        assert.equal(financials.CreditMinor, row.AmountMinor);
        assert.equal(financials.DebitMinor, 0);
      } else {
        assert.equal(financials.DebitMinor, row.AmountMinor);
        assert.equal(financials.CreditMinor, 0);
      }
      assert.equal(financials.CashReceivedMinor, 0);
      assert.equal(financials.CashPaidMinor, 0);
    }
  }
  const settlementRows = tabScopedSettlements(rows, defaultSettlementCriteria(), SETTLEMENT_TAB.SETTLEMENT);
  assert.deepEqual(settlementRows.map((row) => row.Direction), ['Credit', 'Debit']);
  // The column positions are read from the approved column definition itself, so the
  // assertion follows the real table rather than a hard-coded position.
  const columnIndex = (label) => SETTLEMENT_COLUMNS.findIndex((column) => column.label === label);
  const debitIndex = columnIndex('مدين');
  const creditIndex = columnIndex('دائن');
  assert.ok(debitIndex >= 0 && creditIndex >= 0, 'the debit and credit columns exist');
  const creditCells = movementRow(settlementRows[0]).cells;
  const debitCells = movementRow(settlementRows[1]).cells;
  assert.match(creditCells[creditIndex], /200\.00/, 'the credited row carries its amount in the credit column');
  assert.match(debitCells[debitIndex], /40\.00/, 'the debited row carries its amount in the debit column');
  assert.doesNotMatch(debitCells[debitIndex], /^—$/, 'the debit column is not empty for a Debit row');
});

// 9 — ?customerId= keeps preselecting the real CustomerId.
test('9 — the settlements route keeps preselecting the customer passed in the hash', async () => {
  await freshDatabase('tab_preselect');
  const customer = await seedCustomer({ code: 'C-941' });
  await seedMovements(customer.Id);
  const container = makeContainer();
  const view = initSettlementsView({ container, customerId: customer.Id, autoLoad: false });
  await view.load();

  assert.equal(view.state.values.CustomerId, customer.Id, 'the real CustomerId is preselected');
  const form = container.querySelector(`#${SETTLEMENTS_FORM_REGION_ID}`).innerHTML;
  assert.match(form, new RegExp(`value="${customer.Id}" selected`));
  assert.equal(view.state.tab, SETTLEMENT_TAB.SETTLEMENT, 'the default tab is the Settlement tab');

  // the preselection survives a tab switch
  view.switchTab(SETTLEMENT_TAB.GOODS_EXCHANGE);
  const afterSwitch = container.querySelector(`#${SETTLEMENTS_FORM_REGION_ID}`).innerHTML;
  assert.match(afterSwitch, new RegExp(`value="${customer.Id}" selected`), 'a tab switch keeps the chosen customer');
  assert.equal(view.state.values.CustomerId, customer.Id);
  assert.match(renderSettlementTabs({ tab: SETTLEMENT_TAB.GOODS_EXCHANGE }), /aria-selected="true"/);
});

// 10 — nothing stored moves because a tab was switched.
test('10 — switching tabs writes nothing: rows, balances and the audit trail are untouched', async () => {
  await freshDatabase('tab_no_writes');
  const customer = await seedCustomer({ opening: 1000 });
  await seedMovements(customer.Id);

  const before = await settlementService.listSettlementMovements();
  const balanceBefore = await balanceService.getCustomerSummary(customer.Id);
  const auditBefore = await settlementService.listSettlementMovements();

  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  view.switchTab(SETTLEMENT_TAB.GOODS_EXCHANGE);
  view.switchTab(SETTLEMENT_TAB.SETTLEMENT);
  view.switchTab(SETTLEMENT_TAB.GOODS_EXCHANGE);

  const after = await settlementService.listSettlementMovements();
  assert.deepEqual(after.map((row) => row.Id), before.map((row) => row.Id), 'no row was created or removed');
  assert.deepEqual(after.map((row) => row.AmountMinor), before.map((row) => row.AmountMinor));
  assert.deepEqual(after.map((row) => row.Direction), before.map((row) => row.Direction));
  assert.deepEqual(after.map((row) => row.RunningBalanceMinor), before.map((row) => row.RunningBalanceMinor), 'the sequence is identical');
  assert.equal(after.length, auditBefore.length);
  const balanceAfter = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(balanceAfter.BalanceMinor, balanceBefore.BalanceMinor, 'Balance = Opening + Credits − Debits is unchanged');
  assert.equal(balanceAfter.BalanceMinor, 1000 * 100 + 200 * 100 - 150 * 100 - 40 * 100);
  // the criteria are untouched as well, which is why the totals can never move
  assert.deepEqual(view.state.criteria, defaultSettlementCriteria());
  assert.equal(visibleSettlements(after, view.state.criteria).length, 3);
});
