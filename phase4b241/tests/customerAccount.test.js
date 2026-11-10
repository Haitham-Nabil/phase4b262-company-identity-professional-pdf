// Phase 4B.2 — Customer Account / كشف حساب العميل.
// The screen is exercised end to end through the real services against an isolated
// fake-indexeddb database, plus its pure render projections which are asserted
// directly. No stub ever replaces a financial service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { freshDatabase, cartonRefs } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { balanceService } from '../src/services/balanceService.js';
import { cancellationService } from '../src/services/cancellationService.js';
import { openingBalanceService } from '../src/services/openingBalanceService.js';
import { debtTransferService } from '../src/services/debtTransferService.js';
import { TRANSACTION_TYPE } from '../src/domain/transactionTypes.js';
import { logger } from '../src/utils/logger.js';
import {
  ACCOUNT_REGION_ID, LEDGER_REGION_ID, EMPTY_VALUE, NEEDS_NAME_LABEL,
  FILTER_ALL, FILTER_ACTIVE, FILTER_CANCELLED, FILTER_CASH, FILTER_NON_CASH, FILTER_TYPE_PREFIX,
  DIRECTION_LABEL, LEDGER_COLUMNS,
  defaultLedgerCriteria, ledgerTypeLabel, ledgerTypeOptions, ledgerFilterOptions,
  isCashTransaction, isNonCashTransaction, matchesLedgerSearch, matchesLedgerFilter,
  matchesLedgerRange, visibleLedger, ledgerRow, statusCell, runningBalanceCell,
  renderLedgerToolbar, renderLedgerSection, renderAccountSummary, renderCashSplit,
  renderCustomerInfo, renderOpeningBalanceHistory, renderAccountError,
  balanceDirection, customerAccountHtml, customerAccountShellHtml,
  initCustomerAccountView
} from '../ui/views/customerAccount.js';
import { customerAccountPath } from '../ui/routes.js';
import { resolveDestination } from '../ui/router.js';
import { nameCell } from '../ui/views/customers.js';
import { renderDestinationView } from '../ui/views/index.js';

logger.disable?.();

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

// Minimal detached container: enough for the controller to find its regions and
// to record what it painted. It performs no DOM work of its own.
function makeContainer(ids = [ACCOUNT_REGION_ID, LEDGER_REGION_ID]) {
  const nodes = new Map(ids.map((id) => [id, { innerHTML: '', attrs: {}, isConnected: true, setAttribute(key, value) { this.attrs[key] = value; }, getAttribute(key) { return this.attrs[key]; } }]));
  return {
    attrs: {},
    nodes,
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key]; },
    addEventListener() {},
    querySelector(selector) { return nodes.get(String(selector).replace(/^#/, '')) || null; }
  };
}

async function seedCustomer({ code = 'C-700', name = 'مزارع كشف الحساب', opening = 1000, phone = '0123456789', region = 'المنوفية' } = {}) {
  return customerService.createCustomer({ Code: code, Name: name, Phone: phone, Region: region, OpeningBalance: opening });
}

// ---------------------------------------------------------------------------
// 1-4, 21 — opening the account by CustomerId, and the failure paths.
// ---------------------------------------------------------------------------

test('An existing customer account opens by CustomerId and paints the real data', async () => {
  await freshDatabase('account_open');
  const customer = await seedCustomer();
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 500 });

  const container = makeContainer();
  const view = initCustomerAccountView({ container, customerId: customer.Id });
  const result = await view.reload();

  assert.equal(result.ok, true);
  assert.equal(result.entries, 1);
  const html = container.nodes.get(ACCOUNT_REGION_ID).innerHTML;
  assert.match(html, /كود العميل/);
  assert.match(html, /C-700/);
  assert.match(html, /مزارع كشف الحساب/);
  assert.match(html, /0123456789/);
  assert.match(html, /المنوفية/);
  assert.match(html, /نشط/);
  assert.equal(container.nodes.get(ACCOUNT_REGION_ID).attrs['aria-busy'], 'false');
});

test('A missing CustomerId resolves to a visible error state with a retry action', async () => {
  await freshDatabase('account_missing');
  const container = makeContainer();
  const view = initCustomerAccountView({ container, customerId: 'does-not-exist' });
  const result = await view.reload();
  assert.equal(result.ok, false);

  const html = container.nodes.get(ACCOUNT_REGION_ID).innerHTML;
  assert.match(html, /role="alert"/);
  assert.match(html, /تعذّر تحميل كشف حساب العميل/);
  assert.match(html, /data-action="retry-account"/);
  assert.match(html, /NOT_FOUND/);
  assert.equal(container.nodes.get(ACCOUNT_REGION_ID).attrs['aria-busy'], 'false');
  assert.doesNotMatch(html, /class="kpi__value"/, 'no financial value may be shown on failure');
});

test('No CustomerId at all fails fast and never leaves the screen busy', async () => {
  await freshDatabase('account_no_id');
  const container = makeContainer();
  const view = initCustomerAccountView({ container, customerId: null });
  const result = await view.reload();
  assert.equal(result.ok, false);
  assert.match(container.nodes.get(ACCOUNT_REGION_ID).innerHTML, /NOT_FOUND/);
  assert.equal(container.attrs['aria-busy'], 'false');
});

test('The retry action re-runs the read and recovers after a failure', async () => {
  await freshDatabase('account_retry');
  const customer = await seedCustomer({ opening: 0 });
  let attempt = 0;
  const services = {
    getCustomer: async (id) => { if (attempt === 0) throw { code: 'STORAGE_ERROR', message: 'تعذر القراءة.' }; return customerService.getCustomer(id); },
    getSummary: (id) => balanceService.getCustomerSummary(id),
    getLedger: (id) => balanceService.getRunningBalance(id),
    listOpeningHistory: (id) => customerService.listOpeningBalanceHistory(id)
  };
  const container = makeContainer();
  const view = initCustomerAccountView({ container, customerId: customer.Id, services });
  await view.reload();
  assert.match(container.nodes.get(ACCOUNT_REGION_ID).innerHTML, /STORAGE_ERROR/);

  attempt = 1;
  const retried = await view.reload();
  assert.equal(retried.ok, true);
  assert.match(container.nodes.get(ACCOUNT_REGION_ID).innerHTML, /C-700/);
  assert.doesNotMatch(container.nodes.get(ACCOUNT_REGION_ID).innerHTML, /STORAGE_ERROR/);
});

// ---------------------------------------------------------------------------
// 3 — customer data block, including the nameless imported customer.
// ---------------------------------------------------------------------------

test('The customer block shows the approved fields and never invents a missing one', async () => {
  await freshDatabase('account_info');
  const customer = await seedCustomer({ code: 'C-701', name: 'عميل كامل' });
  const html = renderCustomerInfo(customer);
  assert.match(html, /C-701/);
  assert.match(html, /عميل كامل/);
  assert.match(html, /نشط/);

  const imported = await customerService.createImportedCustomer({ Code: 'IMP-9' });
  const importedHtml = renderCustomerInfo(imported);
  assert.match(importedHtml, new RegExp(NEEDS_NAME_LABEL));
  assert.match(importedHtml, new RegExp(EMPTY_VALUE));
  assert.doesNotMatch(importedHtml, /undefined|null/);
});

// ---------------------------------------------------------------------------
// 4 — the account with no transactions at all.
// ---------------------------------------------------------------------------

test('An account with no transactions shows an explicit empty state plus the real opening balance', async () => {
  await freshDatabase('account_empty');
  const customer = await seedCustomer({ opening: 250 });

  const container = makeContainer();
  const view = initCustomerAccountView({ container, customerId: customer.Id });
  await view.reload();
  const html = container.nodes.get(ACCOUNT_REGION_ID).innerHTML;

  assert.match(html, /لا توجد حركات مسجلة على هذا الحساب/);
  assert.match(html, /250\.00/, 'the real opening balance is shown');
  assert.match(html, /الرصيد الافتتاحي/);
  assert.match(html, /الرصيد الحالي/);
  assert.doesNotMatch(html, /<td/, 'an empty ledger renders no data rows');
});

// ---------------------------------------------------------------------------
// 5-7 — ordering, running balance from the service, and agreement with the summary.
// ---------------------------------------------------------------------------

test('Ledger rows follow the approved financial order and carry the service running balance', async () => {
  await freshDatabase('account_order');
  const customer = await seedCustomer({ opening: 1000 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-05', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 300 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 500 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-03', TransactionType: TRANSACTION_TYPE.SALES_RETURN, Amount: 200 });

  const container = makeContainer();
  const view = initCustomerAccountView({ container, customerId: customer.Id });
  await view.reload();
  const entries = view.entries();

  assert.deepEqual(entries.map((entry) => entry.Date), ['2026-09-01', '2026-09-03', '2026-09-05']);
  assert.deepEqual(entries.map((entry) => entry.RunningBalanceMinor), [150000, 170000, 140000]);

  // The screen prints the numbers the service returned, character for character.
  const html = container.nodes.get(ACCOUNT_REGION_ID).innerHTML;
  for (const entry of entries) {
    assert.ok(html.includes((entry.RunningBalanceMinor / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')), `running balance ${entry.RunningBalanceMinor} must be printed`);
  }

  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(entries[entries.length - 1].RunningBalanceMinor, summary.BalanceMinor);
  assert.equal(summary.BalanceMinor, 140000);
  assert.match(html, /1,400\.00/);
});

// ---------------------------------------------------------------------------
// 8-9 — cancelled transactions.
// ---------------------------------------------------------------------------

test('A cancelled transaction stays visible, marked cancelled, and stops affecting the balance', async () => {
  await freshDatabase('account_cancel');
  const customer = await seedCustomer({ opening: 1000 });
  const kept = await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-02', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 500 });
  const cancelled = await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-04', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 300 });
  await cancellationService.cancelTransaction(cancelled.Id, 'إلغاء لاختبار العرض');

  const container = makeContainer();
  const view = initCustomerAccountView({ container, customerId: customer.Id });
  await view.reload();
  const entries = view.entries();

  assert.equal(entries.length, 2, 'the cancelled row is still part of the ledger');
  const row = entries.find((entry) => entry.Id === cancelled.Id);
  assert.ok(row, 'the cancelled row is present');
  assert.equal(row.IsCancelled, true);
  assert.equal(row.CancellationReason, 'إلغاء لاختبار العرض');
  assert.equal(entries.find((entry) => entry.Id === kept.Id).IsCancelled, false);

  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.TotalDebitMinor, 0, 'the cancelled debit must not count');
  assert.equal(summary.BalanceMinor, 150000);

  const html = container.nodes.get(ACCOUNT_REGION_ID).innerHTML;
  assert.match(html, /ملغاة/);
  assert.match(html, /ledger-row--cancelled/);
  assert.match(html, /amount--cancelled/);
  assert.match(html, /إلغاء لاختبار العرض/);
  assert.match(html, /1,500\.00/);
  assert.doesNotMatch(html, /1,200\.00/, 'the cancelled amount must not reach the running balance');
});

// ---------------------------------------------------------------------------
// 10-11 — debit/credit from deriveFinancials, and cash vs non-cash separation.
// ---------------------------------------------------------------------------

test('Debit and credit columns mirror the derived direction, never the type name', async () => {
  await freshDatabase('account_direction');
  const customer = await seedCustomer({ opening: 0 });
  const debitRow = await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_IRRIGATION, Amount: 400 });
  const creditRow = await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-02', TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON, ...(await cartonRefs()), crop: { CartonQuantityMilli: 5000, CartonUnitPriceMinor: 5000, CartonDiscountMinor: 0 } });

  const ledger = await balanceService.getRunningBalance(customer.Id);
  const debitEntry = ledger.Entries.find((entry) => entry.Id === debitRow.Id);
  const creditEntry = ledger.Entries.find((entry) => entry.Id === creditRow.Id);

  const debitHtml = ledgerRow(debitEntry).cells.join('');
  assert.match(debitHtml, /amount--debit/);
  assert.match(debitHtml, /400\.00/);

  const creditHtml = ledgerRow(creditEntry).cells.join('');
  assert.match(creditHtml, /amount--credit/);
  assert.match(creditHtml, /250\.00/);

  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.TotalDebitMinor, 40000);
  assert.equal(summary.TotalCreditMinor, 25000);
  assert.equal(summary.BalanceMinor, -15000);
  assert.equal(summary.BalanceSide, 'Debit');
});

test('Cash and non-cash settlements are separated and never merged into one collected figure', async () => {
  await freshDatabase('account_cash_split');
  const customer = await seedCustomer({ opening: 0 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 500 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-02', TransactionType: TRANSACTION_TYPE.CASH_PAID, Amount: 200 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-03', TransactionType: TRANSACTION_TYPE.SETTLEMENT, Amount: 300 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-04', TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, Amount: 100 });

  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.CashReceivedMinor, 50000);
  assert.equal(summary.CashPaidMinor, 20000);
  assert.equal(summary.NonCashSettlementMinor, 40000);

  const html = renderCashSplit(summary);
  assert.match(html, /نقدية واردة/);
  assert.match(html, /نقدية منصرفة/);
  assert.match(html, /تسويات غير نقدية/);
  assert.match(html, /500\.00/);
  assert.match(html, /400\.00/, 'the non-cash figure is reported on its own');
  assert.match(html, /لا تُجمع في رقم واحد|مفصولة/);
  assert.doesNotMatch(html, /إجمالي التحصيل/);
});

test('A debt transfer row carries the direction of its own side and no cash impact', async () => {
  await freshDatabase('account_debt_transfer');
  const from = await seedCustomer({ code: 'C-710', name: 'دائن', opening: 0 });
  const to = await seedCustomer({ code: 'C-711', name: 'مدين', opening: 0 });
  await debtTransferService.createDebtTransfer({ FromCustomerId: from.Id, ToCustomerId: to.Id, Amount: 500, Date: '2026-09-08', Description: 'تحويل مديونية' });

  const creditLedger = await balanceService.getRunningBalance(from.Id);
  const debitLedger = await balanceService.getRunningBalance(to.Id);

  const creditEntry = creditLedger.Entries[0];
  const debitEntry = debitLedger.Entries[0];
  assert.equal(creditEntry.TransactionType, TRANSACTION_TYPE.DEBT_TRANSFER);
  assert.equal(creditEntry.CreditMinor, 50000);
  assert.equal(creditEntry.DebitMinor, 0);
  assert.equal(debitEntry.DebitMinor, 50000);
  assert.equal(debitEntry.CreditMinor, 0);
  assert.equal(creditEntry.CashReceivedMinor, 0);
  assert.equal(debitEntry.CashPaidMinor, 0);
  assert.equal(creditEntry.SettlementMinor, 50000);

  const summary = await balanceService.getCustomerSummary(from.Id);
  assert.equal(summary.NonCashSettlementMinor, 50000);
  assert.equal(summary.CashReceivedMinor, 0);
  assert.equal(summary.BalanceMinor, 50000);
});

// ---------------------------------------------------------------------------
// 12-13 — filtering must never touch the running balance.
// ---------------------------------------------------------------------------

async function ledgerFixture() {
  await freshDatabase('account_filters');
  const customer = await seedCustomer({ opening: 1000 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 500, Description: 'دفعة نقدية من العميل' });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-02', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 300, Description: 'فاتورة مبيدات' });
  const settled = await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-03', TransactionType: TRANSACTION_TYPE.SETTLEMENT, Amount: 200, Description: 'تسوية غير نقدية' });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-04', TransactionType: TRANSACTION_TYPE.CASH_PAID, Amount: 100, Description: 'صرف نقدي للعميل' });
  await cancellationService.cancelTransaction(settled.Id, 'ملغاة للعرض');
  const ledger = await balanceService.getRunningBalance(customer.Id);
  return { customer, ledger };
}

test('Searching never changes the running balance of any visible row', async () => {
  const { ledger } = await ledgerFixture();
  const before = ledger.Entries.map((entry) => entry.RunningBalanceMinor);
  const visible = visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), search: 'مبيدات' });

  assert.equal(visible.length, 1);
  assert.equal(visible[0].RunningBalanceMinor, ledger.Entries[1].RunningBalanceMinor);
  assert.deepEqual(ledger.Entries.map((entry) => entry.RunningBalanceMinor), before, 'the source ledger is untouched');
  assert.equal(ledger.BalanceMinor, 110000, 'the account balance is unaffected by a search');
});

test('Every filter leaves each row running balance equal to the unfiltered one', async () => {
  const { ledger } = await ledgerFixture();
  const reference = new Map(ledger.Entries.map((entry) => [entry.Id, entry.RunningBalanceMinor]));
  const filters = [FILTER_ALL, FILTER_CASH, FILTER_NON_CASH, FILTER_CANCELLED, FILTER_ACTIVE, `${FILTER_TYPE_PREFIX}Settlement`];

  for (const filter of filters) {
    const visible = visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), filter });
    assert.ok(visible.length > 0, `filter ${filter} must return rows`);
    for (const entry of visible) assert.equal(entry.RunningBalanceMinor, reference.get(entry.Id), `filter ${filter} altered a running balance`);
    assert.equal(ledger.Entries.length, 4, `filter ${filter} must not drop rows from the ledger itself`);
  }
  const dateOnly = visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), from: '2026-09-02', to: '2026-09-03' });
  assert.equal(dateOnly.length, 2);
  for (const entry of dateOnly) assert.equal(entry.RunningBalanceMinor, reference.get(entry.Id));
});

// ---------------------------------------------------------------------------
// 14-18 — search and the filter set.
// ---------------------------------------------------------------------------

test('Search covers the description, the displayed type label and the date', async () => {
  const { ledger } = await ledgerFixture();
  assert.equal(visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), search: 'فاتورة' }).length, 1);
  assert.equal(visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), search: 'استلام نقدية' }).length, 1);
  assert.equal(visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), search: '2026-09-03' }).length, 1);
  assert.equal(visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), search: 'لا يوجد' }).length, 0);
  assert.equal(matchesLedgerSearch(ledger.Entries[0], ''), true);
});

test('The type filter narrows to exactly one approved transaction type', async () => {
  const { ledger } = await ledgerFixture();
  const cashReceived = visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), filter: `${FILTER_TYPE_PREFIX}CashReceived` });
  assert.equal(cashReceived.length, 1);
  assert.equal(cashReceived[0].TransactionType, TRANSACTION_TYPE.CASH_RECEIVED);
  assert.equal(ledgerFilterOptions().length, ledgerTypeOptions().length + 5);
  assert.equal(ledgerTypeOptions().length, 10);
  assert.equal(ledgerTypeLabel('SalePesticides'), 'بيع مبيدات');
  assert.equal(LEDGER_COLUMNS.length, 10);
});

test('Cash, non-cash, cancelled and active filters each select the right rows', async () => {
  const { ledger } = await ledgerFixture();
  const cash = visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), filter: FILTER_CASH });
  assert.equal(cash.length, 2);
  assert.ok(cash.every((entry) => entry.TransactionType === TRANSACTION_TYPE.CASH_RECEIVED || entry.TransactionType === TRANSACTION_TYPE.CASH_PAID));

  const nonCash = visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), filter: FILTER_NON_CASH });
  assert.equal(nonCash.length, 1);
  assert.equal(nonCash[0].TransactionType, TRANSACTION_TYPE.SETTLEMENT);

  const cancelled = visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), filter: FILTER_CANCELLED });
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].IsCancelled, true);

  const active = visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), filter: FILTER_ACTIVE });
  assert.equal(active.length, 3);
  assert.ok(active.every((entry) => entry.IsCancelled !== true));

  assert.equal(isCashTransaction('Settlement'), false);
  assert.equal(isNonCashTransaction('Settlement'), true);
  assert.equal(matchesLedgerFilter(ledger.Entries[0], 'unknown-filter'), true);
});

test('The date range narrows the display only, and a reversed range simply yields nothing', async () => {
  const { ledger } = await ledgerFixture();
  assert.equal(visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), from: '2026-09-03' }).length, 2);
  assert.equal(visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), to: '2026-09-02' }).length, 2);
  assert.equal(visibleLedger(ledger.Entries, { ...defaultLedgerCriteria(), from: '2026-10-01' }).length, 0);
  assert.equal(matchesLedgerRange({ Date: '2026-09-01' }, { from: '2026-09-01' }), true);
  assert.equal(matchesLedgerRange({ Date: '2026-09-01' }, { to: '2026-08-31' }), false);
});

test('The toolbar renders the search, filter and both date controls with the current criteria', async () => {
  const html = renderLedgerToolbar({ criteria: { search: 'مبيدات', filter: `${FILTER_TYPE_PREFIX}SalePesticides`, from: '2026-09-01', to: '2026-09-30' } });
  assert.match(html, /id="ledger-search"/);
  assert.match(html, /value="مبيدات"/);
  assert.match(html, /id="ledger-filter"/);
  assert.match(html, /value="type:SalePesticides" selected/);
  assert.match(html, /id="ledger-from"[^>]*value="2026-09-01"/);
  assert.match(html, /id="ledger-to"[^>]*value="2026-09-30"/);
  assert.match(html, /التسلسل المالي الكامل/);
});

// ---------------------------------------------------------------------------
// 19 — opening balance history.
// ---------------------------------------------------------------------------

test('The opening balance history renders the stored changes and stays a separate field', async () => {
  await freshDatabase('account_opening_history');
  const customer = await seedCustomer({ opening: 1000 });
  await openingBalanceService.setOpeningBalance(customer.Id, { newValue: 1500, reason: 'تصحيح رصيد افتتاحي' });

  const rows = await customerService.listOpeningBalanceHistory(customer.Id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].OldValueMinor, 100000);
  assert.equal(rows[0].NewValueMinor, 150000);
  assert.equal(rows[0].Reason, 'تصحيح رصيد افتتاحي');

  const html = renderOpeningBalanceHistory(rows);
  assert.match(html, /1,000\.00/);
  assert.match(html, /1,500\.00/);
  assert.match(html, /تصحيح رصيد افتتاحي/);
  assert.match(html, /سجل تعديلات الرصيد الافتتاحي/);
  assert.match(html, /حقل مستقل/);

  const summary = await balanceService.getCustomerSummary(customer.Id);
  const ledger = await balanceService.getRunningBalance(customer.Id);
  assert.equal(summary.OpeningBalanceMinor, 150000);
  assert.equal(ledger.Entries.length, 0, 'an opening balance change is never a transaction');
  assert.match(renderOpeningBalanceHistory([]), /لا توجد تعديلات مسجلة/);
});

// ---------------------------------------------------------------------------
// 20 — the four states.
// ---------------------------------------------------------------------------

test('The shell renders a busy loading state with no financial value at all', () => {
  const html = customerAccountShellHtml({ customerId: 'C-1' });
  assert.match(html, /class="spinner"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /جارٍ تحميل كشف حساب العميل/);
  assert.doesNotMatch(html, /class="kpi__value"/);
  assert.doesNotMatch(html, /[0-9]\.[0-9]{2}/, 'no amount may be pre-rendered');
  assert.match(html, /العودة إلى العملاء/);
});

test('The four ledger states are distinguishable and content-correct', () => {
  const loading = customerAccountShellHtml({ customerId: null });
  assert.match(loading, /class="state"/);

  const empty = renderLedgerSection({ entries: [] });
  assert.match(empty, /لا توجد حركات مسجلة على هذا الحساب/);

  const entry = { Id: 'x', Date: '2026-09-01', TransactionType: 'CashReceived', Description: 'دفعة', DebitMinor: 0, CreditMinor: 50000, CashReceivedMinor: 50000, CashPaidMinor: 0, SettlementMinor: 0, RunningBalanceMinor: 50000, IsCancelled: false, CancellationReason: null };
  const noResults = renderLedgerSection({ entries: [entry], criteria: { ...defaultLedgerCriteria(), search: 'لا يوجد' } });
  assert.match(noResults, /لا نتائج مطابقة/);
  assert.match(noResults, /data-action="clear-ledger-filters"/);
  assert.doesNotMatch(noResults, /<td/, 'a no-results state renders no rows');

  const error = renderAccountError({ code: 'STORAGE_ERROR' });
  assert.match(error, /role="alert"/);
  assert.match(error, /STORAGE_ERROR/);
  assert.match(error, /data-action="retry-account"/);

  const populated = renderLedgerSection({ entries: [entry] });
  assert.match(populated, /عدد الحركات المعروضة: 1 من 1/);
  assert.match(populated, /دفعة/);
});

test('A screen that fails shows no rows and no zero-filled table', async () => {
  await freshDatabase('account_error_state');
  const container = makeContainer();
  const view = initCustomerAccountView({ container, customerId: 'missing', services: {
    getCustomer: async () => null,
    getSummary: async () => { throw new Error('must not be called'); },
    getLedger: async () => { throw new Error('must not be called'); },
    listOpeningHistory: async () => { throw new Error('must not be called'); }
  } });
  await view.reload();
  const html = container.nodes.get(ACCOUNT_REGION_ID).innerHTML;
  assert.doesNotMatch(html, /<td/);
  assert.doesNotMatch(html, /0\.00/);
  assert.match(html, /NOT_FOUND/);
});

// ---------------------------------------------------------------------------
// Balance direction wording and the summary cards.
// ---------------------------------------------------------------------------

test('The balance direction is stated in words, so colour is never the only signal', () => {
  const credit = balanceDirection({ BalanceMinor: 130000, BalanceSide: 'Credit' });
  assert.equal(credit.label, DIRECTION_LABEL.Credit);
  assert.equal(credit.text, '1,300.00');
  assert.equal(credit.className, 'amount amount--positive');

  const debit = balanceDirection({ BalanceMinor: -150000, BalanceSide: 'Debit' });
  assert.equal(debit.label, DIRECTION_LABEL.Debit);
  assert.equal(debit.text, '-1,500.00', 'the negative sign is preserved, never hidden');
  assert.equal(debit.className, 'amount amount--negative');

  const zero = balanceDirection({ BalanceMinor: 0, BalanceSide: 'Zero' });
  assert.equal(zero.label, DIRECTION_LABEL.Zero);
  assert.equal(zero.text, '0.00');

  const html = renderAccountSummary({ OpeningBalanceMinor: 100000, TotalDebitMinor: 40000, TotalCreditMinor: 70000, BalanceMinor: 130000, BalanceSide: 'Credit' });
  assert.match(html, /الرصيد الافتتاحي/);
  assert.match(html, /إجمالي المدين/);
  assert.match(html, /إجمالي الدائن/);
  assert.match(html, /الرصيد الحالي/);
  assert.match(html, /الرصيد لصالح العميل/);
  assert.match(html, /المعادلة المعتمدة/);
  assert.match(html, /1,300\.00/);
});

test('Empty cells, cancelled badges and running balance cells carry an explicit meaning', () => {
  assert.match(runningBalanceCell(150000), /amount--positive/);
  assert.match(runningBalanceCell(-150000), /amount--negative/);
  assert.match(runningBalanceCell(0), /amount--zero/);
  assert.match(runningBalanceCell(-150000), /على العميل/);
  assert.match(runningBalanceCell(undefined), /—/);
  assert.match(statusCell({ IsCancelled: false }), /نشطة/);
  assert.match(statusCell({ IsCancelled: true, CancellationReason: 'سبب' }), /ملغاة — سبب/);
  assert.match(statusCell({ IsCancelled: true }), /badge--cancelled/);

  const cancelledRow = ledgerRow({ Id: 'c', Date: '2026-09-01', TransactionType: 'SalePesticides', Description: null, DebitMinor: 30000, CreditMinor: 0, CashReceivedMinor: 0, CashPaidMinor: 0, SettlementMinor: 0, RunningBalanceMinor: 100000, IsCancelled: true, CancellationReason: 'سبب' });
  assert.equal(cancelledRow.className, 'ledger-row--cancelled');
  const text = cancelledRow.cells.join('');
  assert.match(text, /amount--cancelled/);
  assert.match(text, /—/, 'a missing description is shown as an explicit empty value');
  assert.equal(cancelledRow.cells.length, 10, 'the row must fill every approved column');
});

// ---------------------------------------------------------------------------
// Navigation and layering.
// ---------------------------------------------------------------------------

test('The account destination resolves from the Customers screen route and back', () => {
  const resolved = resolveDestination('#/customer/C-700');
  assert.equal(resolved.destination.id, 'customer-account');
  assert.equal(resolved.params.id, 'C-700');
  assert.equal(resolved.destination.parentRouteId, 'customers');
  assert.equal(customerAccountPath('C 7'), '/customer/C%207');
  assert.match(renderDestinationView({ route: { id: 'customers' } }), /جارٍ تحميل العملاء|id="customers-region"/);
  assert.match(nameCell({ Id: 'C-700', Name: 'عميل' }), /href="#\/customer\/C-700"/, 'the row action links to the account route');

  const shell = renderDestinationView({ route: { id: 'customer-account', title: 'حساب العميل' }, params: { id: 'C-700' } });
  assert.match(shell, /جارٍ تحميل كشف حساب العميل/);
  assert.match(shell, /href="#\/customers"/, 'a way back to Customers always exists');
});

test('The account module reaches the services layer only and computes nothing financially', () => {
  const source = readFileSync(join(projectRoot, 'ui/views/customerAccount.js'), 'utf8');
  for (const forbidden of ['repositories', 'storage/db', 'storage/schema', 'indexedDB', 'IndexedDB', 'IDBKeyRange']) {
    assert.equal(source.includes(forbidden), false, `the account screen must not reference ${forbidden}`);
  }
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  for (const target of imports) {
    if (target.includes('/src/')) assert.match(target, /\/src\/(services|utils)\//, `unexpected import target ${target}`);
  }
  assert.doesNotMatch(source, /deriveFinancials/, 'the ledger direction comes from the service, never from the screen');
  assert.doesNotMatch(source, /BalanceMinor\s*[-+*/]?=/, 'the screen must not compute a balance');
  assert.doesNotMatch(source, /TODO|FIXME|XXX|HACK/);
  assert.match(source, /balanceService\.getRunningBalance/, 'the running balance comes from the approved service');
});

test('The screen holds no sample data and the project ships no mock entities', () => {
  const source = readFileSync(join(projectRoot, 'ui/views/customerAccount.js'), 'utf8');
  for (const fake of ['mockData', 'fakeData', 'sampleCustomers', 'Customer 1', 'lorem']) {
    assert.equal(source.includes(fake), false);
  }
  assert.doesNotMatch(source, /delete\s*\(/);
});
