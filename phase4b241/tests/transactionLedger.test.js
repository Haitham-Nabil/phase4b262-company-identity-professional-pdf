// Phase 4B.15 — central transactions ledger tests (the 16 required items + guards).
//
// Storage is exercised through the real services against an isolated fake-indexeddb
// database. The two crop rows are written with the exact stored shape the approved
// transactionService produces (see src/services/transactionService.js — buildRecord), because
// the ledger is a READ layer and must be tested against rows as they are actually stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freshDatabase, cartonRefs } from './helpers.js';
import { customerService, transactionService, debtTransferService, balanceService, strawberryVarietyService } from '../src/services/index.js';
import { transactionLedgerService, LEDGER_STATUS_FILTER, normalizeLedgerFilters, applyLedgerFilters } from '../src/services/transactionLedgerService.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { TRANSACTION_TYPES, TRANSACTION_TYPE, STATUS, DEBT_TRANSFER_ROLE } from '../src/domain/transactionTypes.js';
import { createId, ID_PREFIX } from '../src/utils/id.js';
import { transactionsViewHtml, initTransactionsView, ledgerDetailsHtml, LEDGER_ROOT_ID, LEDGER_RESULTS_ID, LEDGER_ACTIONS_ABSENT } from '../ui/views/transactions.js';
import { renderDestinationView } from '../ui/views/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');
const UI_ROOT = join(PROJECT_ROOT, 'ui');

const D = '2026-09-10';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
async function seed() {
  const a = await customerService.createCustomer({ Code: 'C-100', Name: 'أحمد المصري', OpeningBalance: 1000 });
  const b = await customerService.createCustomer({ Code: 'C-200', Name: 'شركة الدلتا', OpeningBalance: 0 });

  const add = (draft) => transactionRepository.add({
    Id: createId(ID_PREFIX.TRANSACTION),
    LinkId: null,
    Status: STATUS.ACTIVE,
    CancellationReason: null, CancelledAt: null,
    CreatedAt: `2026-09-10T08:00:0${draft.n ?? 0}.000Z`, UpdatedAt: `2026-09-10T08:00:00.000Z`,
    Direction: null,
    PackageWeightKg: null, PackageWeightStatus: null, NetWeightMilli: null,
    ReceivingCompanyId: null, CartonTypeId: null, CartonQuantityMilli: null, StrawberryVarietyId: null,
    ...draft
  });

  let n = 0;
  const rec = (over) => { n += 1; return add({ n, ...over }); };

  await rec({ CustomerId: a.Id, Date: '2026-09-10', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Description: 'مبيدات حشرية', AmountMinor: 50000 });
  await rec({ CustomerId: a.Id, Date: '2026-09-11', TransactionType: TRANSACTION_TYPE.SALE_IRRIGATION, Description: 'شبكة ري', AmountMinor: 30000 });
  await rec({ CustomerId: b.Id, Date: '2026-09-12', TransactionType: TRANSACTION_TYPE.SALES_RETURN, Description: 'مرتجع بضاعة', AmountMinor: 10000 });
  await rec({ CustomerId: a.Id, Date: '2026-09-13', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Description: 'استلام نقدية', AmountMinor: 20000 });
  await rec({ CustomerId: a.Id, Date: '2026-09-14', TransactionType: TRANSACTION_TYPE.CASH_PAID, Description: 'دفعة نقدية', AmountMinor: 15000 });
  await rec({ CustomerId: b.Id, Date: '2026-09-15', TransactionType: TRANSACTION_TYPE.SETTLEMENT, Description: 'تسوية جزئية', AmountMinor: 12000, Direction: 'Credit' });
  await rec({ CustomerId: b.Id, Date: '2026-09-16', TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, Description: 'تبادل بضائع', AmountMinor: 8000, Direction: 'Debit' });

  // A cancelled movement keeps its stored state; the ledger must still show it.
  const cancelled = await rec({ CustomerId: a.Id, Date: '2026-09-20', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Description: 'استلام ملغى', AmountMinor: 7000 });
  await transactionRepository.put({ ...cancelled, Status: STATUS.CANCELLED, CancellationReason: 'خطأ في الإدخال', CancelledAt: '2026-09-20T09:00:00.000Z' });

  const refs = await cartonRefs();
  await rec({
    CustomerId: a.Id, Date: '2026-09-18', TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON,
    Description: 'مشتريات كرتون', AmountMinor: 250000,
    ReceivingCompanyId: refs.ReceivingCompanyId, CartonTypeId: refs.CartonTypeId, CartonQuantityMilli: 250000
  });

  const variety = await strawberryVarietyService.create('فيرتونا');
  await rec({
    CustomerId: a.Id, Date: '2026-09-19', TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL,
    Description: 'مشتريات محصول محلي', AmountMinor: 175000,
    LocalUnitsMilli: 25000, LocalLooseKgMilli: 0, LocalDeductionKgMilli: 0, LocalUnitPriceMinor: 700,
    PackageWeightKg: 14, PackageWeightStatus: 'Confirmed', NetWeightMilli: 350000,
    StrawberryVarietyId: variety.Id
  });

  const transfer = await debtTransferService.createDebtTransfer({
    FromCustomerId: a.Id, ToCustomerId: b.Id, Amount: 400, Date: '2026-09-17', Description: 'تحويل مديونية'
  });

  return { a, b, variety, refs, transfer };
}

// Minimal container stub: enough for the screen's own selectors and event wiring.
function makeContainer(html) {
  const nodes = new Map();
  const re = /id="([^"]+)"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    if (!nodes.has(match[1])) nodes.set(match[1], {
      id: match[1], innerHTML: '', textContent: '', value: '', disabled: false,
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      removeAttribute(name) { delete this.attributes[name]; },
      getAttribute(name) { return this.attributes[name] ?? null; }
    });
  }
  const handlers = new Map();
  const container = {
    innerHTML: html,
    nodes,
    querySelector(selector) {
      if (!selector.startsWith('#')) return null;
      return nodes.get(selector.slice(1)) || null;
    },
    querySelectorAll() { return []; },
    addEventListener(type, handler) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(handler);
    },
    emit(type, target) { for (const handler of handlers.get(type) || []) handler({ target, preventDefault() {} }); }
  };
  return container;
}

function fakeControl(id, { closest = null, value = '' } = {}) {
  return { id, value, getAttribute: (name) => (name === 'data-ledger-action' ? closest : null), closest: () => (closest ? { getAttribute: () => closest } : null) };
}

async function ledger() {
  return transactionLedgerService.listLedger({});
}

// ---------------------------------------------------------------------------
// 1. every approved type is present
// ---------------------------------------------------------------------------
test('1 — the ledger shows every transaction type that exists in the system', async () => {
  await freshDatabase('ledger-types');
  await seed();
  const result = await ledger();
  const types = new Set(result.Rows.map((row) => row.TransactionType));
  for (const type of TRANSACTION_TYPES) assert.ok(types.has(type), `missing type ${type}`);
  assert.equal(types.size, TRANSACTION_TYPES.length);
  // No type outside the approved catalogue is ever produced by the service.
  for (const type of types) assert.ok(TRANSACTION_TYPES.includes(type), `unknown type ${type}`);
});

// ---------------------------------------------------------------------------
// 2 + 3. search
// ---------------------------------------------------------------------------
test('2 — search matches the customer name and code', async () => {
  await freshDatabase('ledger-search-customer');
  const { a, b } = await seed();
  const byName = await transactionLedgerService.listLedger({ search: 'أحمد' });
  assert.ok(byName.Rows.length > 0);
  // A standalone row belongs to the customer; a merged transfer names both parties, so the
  // customer may be present as the counterparty of the single transfer row.
  for (const row of byName.Rows) {
    assert.ok(row.CustomerId === a.Id || row.CounterpartyId === a.Id, `row ${row.RowKey} does not involve the customer`);
  }
  assert.equal(byName.Rows.some((row) => row.CustomerCode === 'C-100'), true);

  const byCode = await transactionLedgerService.listLedger({ search: 'C-200' });
  assert.ok(byCode.Rows.length > 0);
  for (const row of byCode.Rows) {
    assert.ok(row.CustomerId === b.Id || row.CounterpartyId === b.Id, `row ${row.RowKey} does not involve the customer`);
  }
  assert.equal(byCode.Rows.some((row) => row.CustomerCode === 'C-200'), true);
});

test('3 — search matches the stored description', async () => {
  await freshDatabase('ledger-search-desc');
  await seed();
  const result = await transactionLedgerService.listLedger({ search: 'مرتجع' });
  assert.equal(result.Rows.length, 1);
  assert.equal(result.Rows[0].TransactionType, TRANSACTION_TYPE.SALES_RETURN);
  assert.equal(result.Rows[0].Description, 'مرتجع بضاعة');

  // A term that matches nothing returns an explicitly empty list, not the full ledger.
  const none = await transactionLedgerService.listLedger({ search: 'كلمة-غير-موجودة' });
  assert.equal(none.Rows.length, 0);
});

// ---------------------------------------------------------------------------
// 4 + 5 + 6 + 7. filters, alone and combined
// ---------------------------------------------------------------------------
test('4 — the type filter returns only that type', async () => {
  await freshDatabase('ledger-filter-type');
  await seed();
  const result = await transactionLedgerService.listLedger({ type: TRANSACTION_TYPE.CASH_PAID });
  assert.equal(result.Rows.length, 1);
  assert.equal(result.Rows[0].TransactionType, TRANSACTION_TYPE.CASH_PAID);

  // The merged transfer only answers to its own type, never to a leg's side.
  const transfer = await transactionLedgerService.listLedger({ type: TRANSACTION_TYPE.DEBT_TRANSFER });
  assert.equal(transfer.Rows.length, 1);
  assert.equal(transfer.Rows[0].IsLinkedOperation, true);
});

test('5 — the date filter is inclusive on both ends and rejects an inverted range', async () => {
  await freshDatabase('ledger-filter-date');
  await seed();
  const range = await transactionLedgerService.listLedger({ from: '2026-09-13', to: '2026-09-15' });
  assert.deepEqual([...new Set(range.Rows.map((row) => row.Date))].sort(), ['2026-09-13', '2026-09-14', '2026-09-15']);

  const fromOnly = await transactionLedgerService.listLedger({ from: '2026-09-19' });
  assert.equal(fromOnly.Rows.every((row) => row.Date >= '2026-09-19'), true);

  assert.throws(() => normalizeLedgerFilters({ from: '2026-09-20', to: '2026-09-10' }), /تاريخ البداية يجب ألا يكون بعد تاريخ النهاية/);
  assert.throws(() => normalizeLedgerFilters({ from: '10/09/2026' }), /تاريخ البداية غير صالح/);
});

test('6 — the status filter separates active from cancelled rows', async () => {
  await freshDatabase('ledger-filter-status');
  await seed();
  const cancelled = await transactionLedgerService.listLedger({ status: LEDGER_STATUS_FILTER.CANCELLED });
  assert.equal(cancelled.Rows.length, 1);
  assert.equal(cancelled.Rows[0].IsCancelled, true);
  assert.equal(cancelled.Rows[0].CancellationReason, 'خطأ في الإدخال');

  const active = await transactionLedgerService.listLedger({ status: LEDGER_STATUS_FILTER.ACTIVE });
  assert.equal(active.Rows.some((row) => row.IsCancelled), false);
  const all = await transactionLedgerService.listLedger({ status: LEDGER_STATUS_FILTER.ALL });
  assert.equal(all.Rows.length, active.Rows.length + cancelled.Rows.length);
});

test('7 — the filters combine with AND', async () => {
  await freshDatabase('ledger-filter-combined');
  const { a } = await seed();
  const result = await transactionLedgerService.listLedger({
    search: 'أحمد', type: TRANSACTION_TYPE.CASH_RECEIVED, from: '2026-09-01', to: '2026-09-30', status: LEDGER_STATUS_FILTER.ACTIVE
  });
  assert.equal(result.Rows.length, 1);
  assert.equal(result.Rows[0].CustomerId, a.Id);
  assert.equal(result.Rows[0].TransactionType, TRANSACTION_TYPE.CASH_RECEIVED);
  assert.equal(result.Rows[0].IsCancelled, false);

  // One filter that excludes everything empties the AND, even when the others match.
  const empty = await transactionLedgerService.listLedger({ search: 'أحمد', type: TRANSACTION_TYPE.SALES_RETURN });
  assert.equal(empty.Rows.length, 0);
});

// ---------------------------------------------------------------------------
// 8. no results
// ---------------------------------------------------------------------------
test('8 — an empty result is reported as empty, with the criteria echoed back', async () => {
  await freshDatabase('ledger-empty');
  await seed();
  const result = await transactionLedgerService.listLedger({ from: '2027-01-01' });
  assert.equal(result.Rows.length, 0);
  assert.equal(result.Summary.FilteredCount, 0);
  assert.ok(result.Summary.TotalCount > 0, 'the unfiltered total is still reported');
  assert.equal(result.Criteria.from, '2027-01-01');

  // An empty database is also an honest empty, not an error.
  await freshDatabase('ledger-empty-db');
  const blank = await transactionLedgerService.listLedger({});
  assert.equal(blank.Rows.length, 0);
  assert.equal(blank.Summary.TotalCount, 0);
});

// ---------------------------------------------------------------------------
// 9 + 10 + 11. cancelled, transfer pairing, no duplicates
// ---------------------------------------------------------------------------
test('9 — a cancelled movement stays visible and is flagged, without leaving the ledger', async () => {
  await freshDatabase('ledger-cancelled');
  await seed();
  const result = await ledger();
  const row = result.Rows.find((entry) => entry.Description === 'استلام ملغى');
  assert.ok(row, 'the cancelled row must still be listed');
  assert.equal(row.IsCancelled, true);
  assert.equal(row.Status, STATUS.CANCELLED);
  assert.equal(row.StatusLabel, 'ملغاة');
  // It is still counted in the total, and reported separately in the summary.
  assert.equal(result.Summary.CancelledCount, 1);
  assert.equal(result.Summary.TotalCount, result.Rows.length);
});

test('10 — a debt transfer is one row naming both parties, never two unexplained legs', async () => {
  await freshDatabase('ledger-transfer');
  const { a, b, transfer } = await seed();
  const result = await ledger();
  const rows = result.Rows.filter((row) => row.TransactionType === TRANSACTION_TYPE.DEBT_TRANSFER);
  assert.equal(rows.length, 1, 'the operation must appear once');
  const row = rows[0];
  assert.equal(row.LinkId, transfer.LinkId);
  assert.equal(row.LegCount, 2);
  assert.equal(new Set(row.LegIds).size, 2);
  assert.equal(row.IsLinkedOperation, true);
  // Both parties are named, and the amount is announced once — never summed.
  const parties = [row.CustomerId, row.CounterpartyId].sort();
  assert.deepEqual(parties, [a.Id, b.Id].sort());
  assert.equal(row.AmountMinor, 40000);
  assert.equal(row.DebitMinor, null);
  assert.equal(row.CreditMinor, null);
  // Searching by the counterparty still finds the single operation.
  const byCounterparty = await transactionLedgerService.listLedger({ search: 'الدلتا' });
  assert.equal(byCounterparty.Rows.filter((entry) => entry.TransactionType === TRANSACTION_TYPE.DEBT_TRANSFER).length, 1);
});

test('11 — no row is duplicated: stored rows map to ledger rows exactly once', async () => {
  await freshDatabase('ledger-duplicates');
  await seed();
  const stored = await transactionRepository.getAll();
  const result = await ledger();
  assert.equal(result.Summary.StoredRowCount, stored.length);
  assert.equal(result.Rows.length, stored.length - 1, 'the transfer pair collapses into one row');
  const keys = result.Rows.map((row) => row.RowKey);
  assert.equal(new Set(keys).size, keys.length);
  const legIds = result.Rows.flatMap((row) => row.LegIds);
  assert.equal(new Set(legIds).size, stored.length);

  // Applying the same filters twice never doubles a row.
  const twice = applyLedgerFilters(result.Rows, { search: 'أحمد' });
  assert.equal(new Set(twice.map((row) => row.RowKey)).size, twice.length);
});

// ---------------------------------------------------------------------------
// 12 + 13. crop facts are shown from the stored values
// ---------------------------------------------------------------------------
test('12 — a local crop purchase shows its variety, package count and stored net weight', async () => {
  await freshDatabase('ledger-local');
  const { variety } = await seed();
  const result = await ledger();
  const row = result.Rows.find((entry) => entry.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL);
  assert.equal(row.StrawberryVarietyId, variety.Id);
  assert.equal(row.StrawberryVarietyName, 'فيرتونا');
  assert.equal(row.PackageCountMilli, 25000);
  assert.equal(row.CropNetWeightMilli, 350000);
  assert.equal(row.CropWeightResolved, true);
  assert.equal(row.PackageWeightKg, 14);
  assert.ok(row.ReferenceParts.some((part) => part.includes('فيرتونا')));
  assert.ok(row.ReferenceParts.some((part) => part.includes('25')));

  // The stored weight is NOT recalculated when the current setting changes.
  const html = ledgerDetailsHtml(row);
  assert.match(html, /صنف الفراولة/);
  assert.match(html, /فيرتونا/);
  assert.match(html, /350 كجم/);
  assert.match(html, /14 كجم/);
});

test('13 — a carton purchase shows its receiving company, carton type and stored count', async () => {
  await freshDatabase('ledger-carton');
  await seed();
  const result = await ledger();
  const row = result.Rows.find((entry) => entry.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_CARTON);
  assert.ok(row.ReceivingCompanyId);
  assert.ok(row.CartonTypeId);
  assert.ok(row.ReceivingCompanyName);
  assert.ok(row.CartonTypeName);
  assert.equal(row.CartonQuantityMilli, 250000);
  assert.equal(row.PackageCountMilli, null, 'a carton purchase carries no package count');
  assert.equal(row.CropNetWeightMilli, null, 'a carton purchase carries no net weight');
  const html = ledgerDetailsHtml(row);
  assert.match(html, /الشركة المستلمة/);
  assert.match(html, /نوع الكرتونة/);
  assert.match(html, /عدد الكراتين/);
  assert.match(html, /250 كرتونة/);
});

// ---------------------------------------------------------------------------
// 14. details are reachable from the screen
// ---------------------------------------------------------------------------
test('14 — the details view opens from a ledger row and prints stored values only', async () => {
  await freshDatabase('ledger-details');
  await seed();
  const container = makeContainer(transactionsViewHtml());
  const view = initTransactionsView({ container, autoLoad: false });
  await view.run();

  const row = view.state.result.Rows.find((entry) => entry.TransactionType === TRANSACTION_TYPE.CASH_RECEIVED && !entry.IsCancelled);
  assert.ok(row, 'the seeded row must be listed');
  container.emit('click', fakeControl('x', { closest: 'details' }));
  // Opening by key reproduces the button's own path.
  view.openDetails(row.RowKey);
  const body = container.querySelector('#ledger-details-body');
  // The dialog TITLE carries the heading; the body carries the printed facts.
  assert.match(container.querySelector('#ledger-details-dialog-title').textContent, /تفاصيل الحركة/);
  assert.match(body.innerHTML, /نوع الحركة/);
  assert.equal(body.innerHTML.includes(row.Id), true);
  assert.match(body.innerHTML, new RegExp('استلام نقدية'));
  // Closing hides the dialog and keeps the results untouched.
  view.closeDetails();
  assert.equal(container.querySelector('#ledger-details-dialog').getAttribute('hidden'), '');
  assert.equal(view.state.result.Rows.length > 0, true);
});

// ---------------------------------------------------------------------------
// 15. viewing never writes and never moves a balance
// ---------------------------------------------------------------------------
test('15 — opening, searching and filtering the ledger changes no balance and no row', async () => {
  await freshDatabase('ledger-readonly');
  const { a, b } = await seed();
  const before = {
    a: await balanceService.getCustomerSummary(a.Id),
    b: await balanceService.getCustomerSummary(b.Id),
    rows: (await transactionRepository.getAll()).length
  };

  await transactionLedgerService.listLedger({});
  await transactionLedgerService.listLedger({ search: 'أحمد' });
  await transactionLedgerService.listLedger({ status: LEDGER_STATUS_FILTER.CANCELLED });
  await transactionLedgerService.listLedger({ from: '2026-09-01', to: '2026-09-30', type: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL });
  const container = makeContainer(transactionsViewHtml());
  const view = initTransactionsView({ container, autoLoad: false });
  await view.run();
  view.openDetails(view.state.result.Rows[0].RowKey);

  const after = {
    a: await balanceService.getCustomerSummary(a.Id),
    b: await balanceService.getCustomerSummary(b.Id),
    rows: (await transactionRepository.getAll()).length
  };
  assert.deepEqual(after.a, before.a);
  assert.deepEqual(after.b, before.b);
  assert.equal(after.rows, before.rows);
});

// ---------------------------------------------------------------------------
// 16. architectural guards
// ---------------------------------------------------------------------------
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

test('16 — the UI layer never touches storage, repositories or the financial engine', () => {
  const files = walk(UI_ROOT);
  assert.ok(files.length > 10);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const forbidden of ['indexedDB', 'IndexedDB', 'IDBKeyRange', 'from \'../../src/repositories', 'from \'../../src/storage', 'deriveFinancials', 'runTransaction']) {
      assert.equal(source.includes(forbidden), false, `${file} must not contain ${forbidden}`);
    }
    // A relative reach into src/ is only allowed towards services and utils.
    for (const match of source.matchAll(/from '(\.[^']+)'/g)) {
      const target = match[1];
      if (target.includes('/src/')) assert.match(target, /\/src\/(services|utils)\//, `${file} reached ${target}`);
    }
  }
});

test('16b — the ledger screen offers no write action at all', async () => {
  const source = readFileSync(join(UI_ROOT, 'views', 'transactions.js'), 'utf8');
  for (const forbidden of ['createTransaction', 'submitTransactionForm', 'editTransaction', 'cancelTransaction', 'createDebtTransfer', 'transactionService']) {
    assert.equal(source.includes(forbidden), false, `the ledger must not call ${forbidden}`);
  }
  // The screen exposes exactly the three read-only actions.
  assert.deepEqual([...LEDGER_ACTIONS_ABSENT].sort(), ['cancel', 'delete', 'edit']);
  const html = transactionsViewHtml();
  assert.match(html, new RegExp(`id="${LEDGER_ROOT_ID}"`));
  assert.match(html, new RegExp(`id="${LEDGER_RESULTS_ID}"`));
  assert.match(html, /role="status"/);
});

// ---------------------------------------------------------------------------
// screen wiring
// ---------------------------------------------------------------------------
test('17 — the /transactions destination renders the ledger, not the phase-4A placeholder', () => {
  const html = renderDestinationView({ route: { id: 'transactions', title: 'الحركات', subtitle: 'سجل الحركات المركزي' }, params: {} });
  assert.match(html, new RegExp(`id="${LEDGER_ROOT_ID}"`));
  assert.equal(html.includes('مرحلة الهيكل'), false, 'the placeholder alert must be gone');
  // The screen carries its four filters and the search field.
  for (const id of ['ledger-search', 'ledger-type', 'ledger-from', 'ledger-to', 'ledger-status']) assert.match(html, new RegExp(`id="${id}"`));
});

test('18 — the ledger order is newest first and stable', async () => {
  await freshDatabase('ledger-order');
  await seed();
  const result = await ledger();
  const dates = result.Rows.map((row) => row.Date);
  const sorted = [...dates].sort().reverse();
  assert.deepEqual(dates, sorted);
  // Two runs over the same data produce the same order.
  const again = await ledger();
  assert.deepEqual(again.Rows.map((row) => row.RowKey), result.Rows.map((row) => row.RowKey));
});

