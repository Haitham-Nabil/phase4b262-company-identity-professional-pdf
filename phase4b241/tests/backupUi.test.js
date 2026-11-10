// Phase 4B.10 — Backup & Restore screen.
//
// Sections:
//   A — backup creation (real services, real database)
//   B — file inspection / validation (the same validateBackup the restore uses)
//   C — restore: replacement, rejection and atomicity (including an injected
//       failure inside the write transaction, proving the previous data survives)
//   D — the screen itself (controller against the real services, download hand-off,
//       confirmation gate, double-submit guard, architecture boundary)
//
// Nothing here is asserted from a mock of the financial path: every number comes from
// the approved services on a real (fake-indexeddb) database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { freshDatabase, simulateReload, configureDatabase, closeDatabase } from './helpers.js';
import { configureIndexedDB, openDatabase } from '../src/storage/db.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { balanceService } from '../src/services/balanceService.js';
import { openingBalanceService } from '../src/services/openingBalanceService.js';
import { databaseInit } from '../src/services/databaseInit.js';
import { deleteDatabase } from '../src/storage/db.js';
import { backupService, createBackupFile, backupFileName, backupCounts } from '../src/services/backupService.js';
import { restoreService, validateBackup, inspectBackupText, backupFileSummary } from '../src/services/restoreService.js';
import { customerRepository } from '../src/repositories/customerRepository.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { auditLogRepository } from '../src/repositories/auditLogRepository.js';
import { TRANSACTION_TYPE } from '../src/domain/transactionTypes.js';
import { deriveFinancials } from '../src/domain/financialDirection.js';
import { STORE, DB_VERSION } from '../src/storage/schema.js';
import { logger } from '../src/utils/logger.js';
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from 'fake-indexeddb';

import { findRouteById } from '../ui/routes.js';
import { renderDestinationView, initDestinationView, SHARED_NOTICE } from '../ui/views/index.js';
import {
  backupViewHtml, backupBodyHtml, initBackupView, downloadInBrowser,
  BACKUP_REGION_ID, BACKUP_CREATE_ID, RESTORE_FILE_ID, RESTORE_SUMMARY_ID,
  RESTORE_CONFIRM_ID, RESTORE_CANCEL_ID, BACKUP_BUSY, BACKUP_MESSAGE, RESTORE_BEHAVIOUR_NOTE
} from '../ui/views/backup.js';

logger.disable?.();

const PROJECT_ROOT = join(import.meta.dirname, '..');
const UI_ROOT = join(PROJECT_ROOT, 'ui');
const MONEY = 100;

function walkFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return walkFiles(full);
    return [full];
  });
}

async function waitFor(check, { timeoutMs = 1500 } = {}) {
  const started = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function seedScenario() {
  const customer = await customerService.createCustomer({ Code: 'BU-1', Name: 'عميل النسخة', Phone: '0100', Region: 'طنطا', OpeningBalance: 1000 });
  await openingBalanceService.setOpeningBalance(customer.Id, { newValue: 2000, reason: 'تصحيح افتتاحي' });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 350 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-02', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 800 });
  return customer;
}

async function storeCounts() {
  const [customers, transactions, auditLog] = await Promise.all([
    customerRepository.getAll(), transactionRepository.getAll(), auditLogRepository.getAll()
  ]);
  return { customers: customers.length, transactions: transactions.length, auditLog: auditLog.length };
}

async function fullSnapshot() {
  const [customers, transactions] = await Promise.all([customerRepository.getAll(), transactionRepository.getAll()]);
  const balances = await balanceService.listCustomerBalances();
  return {
    customers: customers.map((row) => `${row.Code}:${row.OpeningBalanceMinor}`).sort(),
    transactions: transactions.map((row) => `${row.Id}:${row.AmountMinor}:${row.TransactionType}`).sort(),
    balances: balances.map((row) => `${row.Customer.Code}:${row.BalanceMinor}`).sort(),
    portfolio: await balanceService.getPortfolioSummary()
  };
}

// ---------------------------------------------------------------------------
// An injected failure INSIDE the real write transaction.
//
// The restore clears every store and then writes, all inside ONE IndexedDB
// transaction. To prove the atomicity (and not a lucky ordering), the object store
// `put` used by the SECOND phase is made to throw while that transaction is open, so
// the failure happens after the clears have already run. The patch is removed in a
// finally block, so no other test is affected.
// ---------------------------------------------------------------------------
async function withFailingPut(storeName, run) {
  const db = await openDatabase();
  const probeTx = db.transaction(storeName, 'readonly');
  const proto = Object.getPrototypeOf(probeTx.objectStore(storeName));
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'put');
  const original = proto.put;
  const fallback = { configurable: true, enumerable: false, writable: true };
  const patched = function patchedPut(...args) {
    if (this && this.name === storeName) throw new Error('injected failure inside the write transaction');
    return original.apply(this, args);
  };
  Object.defineProperty(proto, 'put', { ...(descriptor || fallback), value: patched });
  try {
    return await run();
  } finally {
    Object.defineProperty(proto, 'put', { ...(descriptor || fallback), value: original });
  }
}

// ---------------------------------------------------------------------------
// A stand-in for the screen DOM: the REAL controller is driven against it.
// ---------------------------------------------------------------------------
function stubScreen() {
  const controls = {};
  const handlers = {};
  const makeControl = (key) => ({
    id: key, value: '', disabled: false, innerHTML: '', files: null, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; }
  });
  const regionEl = {
    innerHTML: '', attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    querySelector(selector) {
      if (!selector.startsWith('#')) return null;
      const key = selector.slice(1);
      if (!controls[key]) controls[key] = makeControl(key);
      return controls[key];
    }
  };
  const container = {
    querySelector(selector) { return selector === `#${BACKUP_REGION_ID}` ? regionEl : null; },
    addEventListener(type, handler) { handlers[type] = handler; },
    querySelectorAll() { return []; }
  };
  return {
    container, regionEl, handlers,
    control(id) { return regionEl.querySelector(`#${id}`); },
    html() { return regionEl.innerHTML; },
    click(action) {
      handlers.click({ preventDefault() {}, target: { closest: (selector) => (selector === `[data-action="${action}"]` ? {} : null) } });
    },
    pick(file) {
      handlers.change({ target: { getAttribute: (name) => (name === 'id' ? RESTORE_FILE_ID : null), files: file ? [file] : [] } });
    }
  };
}

function backupScreen({ services = null, download = null } = {}) {
  const screen = stubScreen();
  const view = initBackupView({ container: screen.container, services, download });
  return { screen, view };
}

const realServices = Object.freeze({
  createBackupFile: (...args) => createBackupFile(...args),
  inspectJson: (...args) => restoreService.inspectJson(...args),
  restoreFromJson: (...args) => restoreService.restoreFromJson(...args)
});

function fileStub(json, { name = 'customer-accounts-backup.json', size = null } = {}) {
  return { name, size: size ?? String(json).length, text: async () => json };
}

// ===========================================================================
// A — creating a backup
// ===========================================================================

test('A1. createBackupFile produces a valid JSON file with the approved meta and counts', async () => {
  await freshDatabase('b10_a1');
  const customer = await seedScenario();

  const result = await createBackupFile();
  const parsed = JSON.parse(result.Json);

  assert.equal(parsed.Meta.App, 'CustomerAccountsDB');
  assert.equal(parsed.Meta.FormatVersion, 1);
  assert.equal(parsed.Meta.SchemaVersion, DB_VERSION);
  assert.equal(typeof parsed.Meta.ExportedAt, 'string');
  assert.match(result.FileName, /^customer-accounts-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  assert.equal(backupFileName('2026-10-21T09:15:30.123Z'), 'customer-accounts-backup-2026-10-21-0915.json');
  assert.equal(backupFileName(null), 'customer-accounts-backup.json');
  assert.equal(result.Counts.customers, 1);
  assert.equal(result.Counts.transactions, 2);
  assert.equal(result.Counts.openingBalanceHistory, 1);
  assert.deepEqual(result.Counts, backupCounts(parsed));
  assert.equal(customer.Code, 'BU-1');
});

test('A2. the backup carries the real stored rows of every backed-up store', async () => {
  await freshDatabase('b10_a2');
  const customer = await seedScenario();

  const parsed = JSON.parse((await createBackupFile()).Json);
  const storedCustomer = parsed.Customers.find((row) => row.Code === 'BU-1');
  assert.ok(storedCustomer, 'the customer is in the file');
  assert.equal(storedCustomer.OpeningBalanceMinor, 200000);
  assert.equal(storedCustomer.Name, 'عميل النسخة');
  const storedTransaction = parsed.Transactions.find((row) => row.TransactionType === TRANSACTION_TYPE.CASH_RECEIVED);
  assert.equal(storedTransaction.AmountMinor, 80000);
  assert.equal(storedTransaction.CustomerId, customer.Id);
  assert.equal(parsed.OpeningBalanceHistory[0].Reason, 'تصحيح افتتاحي');
  assert.ok(Array.isArray(parsed.Settings) && parsed.Settings.length > 0, 'settings travel with the backup');
  assert.ok(Array.isArray(parsed.Metadata), 'metadata travels with the backup');
  assert.ok(Array.isArray(parsed.AuditLog), 'the audit trail travels with the backup');
  // No credentials or secrets are added by the screen-level helper.
  assert.equal(Object.keys(parsed).some((key) => /secret|token|password/i.test(key)), false);
});

test('A3. an empty database still yields a valid, complete file', async () => {
  await freshDatabase('b10_a3');
  const result = await createBackupFile();
  const parsed = JSON.parse(result.Json);
  assert.equal(result.Counts.customers, 0);
  assert.equal(result.Counts.transactions, 0);
  assert.equal(result.Counts.openingBalanceHistory, 0);
  assert.equal(parsed.Meta.SchemaVersion, DB_VERSION);
  assert.equal(validateBackup(parsed).ok, true, 'the empty file is still a valid backup');
});

test('A4. creating a backup never changes the stored data', async () => {
  await freshDatabase('b10_a4');
  await seedScenario();
  const before = await fullSnapshot();
  await createBackupFile();
  await createBackupFile();
  const after = await fullSnapshot();
  assert.deepEqual(after.customers, before.customers);
  assert.deepEqual(after.transactions, before.transactions);
  assert.deepEqual(after.balances, before.balances);
  assert.equal(after.portfolio.TotalBalanceMinor, before.portfolio.TotalBalanceMinor);
});

test('A5. a real read failure surfaces as an error and leaves the data intact', async () => {
  await freshDatabase('b10_a5');
  const customer = await seedScenario();
  const before = await fullSnapshot();

  // A genuinely broken storage engine: opening the database fails.
  await closeDatabase();
  configureIndexedDB({
    indexedDB: {
      open() { throw new Error('storage engine unavailable'); },
      deleteDatabase() { throw new Error('storage engine unavailable'); }
    },
    IDBKeyRange: fakeIDBKeyRange
  });

  await assert.rejects(() => createBackupFile(), (error) => {
    assert.ok(error, 'the failure is propagated, never swallowed');
    assert.ok(error.message.length > 0);
    return true;
  });

  // The engine is restored and the very same data is still there.
  configureIndexedDB({ indexedDB: fakeIndexedDB, IDBKeyRange: fakeIDBKeyRange });
  await simulateReload();
  const after = await fullSnapshot();
  assert.deepEqual(after.customers, before.customers);
  assert.equal(await balanceService.getCurrentBalanceMinor(customer.Id), before.portfolio.TotalBalanceMinor);
});

// ===========================================================================
// B — inspecting / validating a file before any write
// ===========================================================================

test('B1. a valid file is accepted and summarised', async () => {
  await freshDatabase('b10_b1');
  await seedScenario();
  const json = (await createBackupFile()).Json;

  const inspection = inspectBackupText(json);
  assert.equal(inspection.Ok, true);
  assert.deepEqual(inspection.Errors, []);
  assert.equal(inspection.ReplacesAllData, true, 'the screen is told the restore replaces everything');
  assert.equal(inspection.Meta.App, 'CustomerAccountsDB');
  assert.equal(inspection.Meta.SchemaVersion, DB_VERSION);
  assert.equal(inspection.Counts.customers, 1);
  assert.equal(inspection.Counts.transactions, 2);
  assert.deepEqual(inspection.Counts, backupFileSummary(JSON.parse(json)));
});

test('B2. syntactically invalid JSON is rejected with a readable reason', async () => {
  const inspection = inspectBackupText('{ not json');
  assert.equal(inspection.Ok, false);
  assert.equal(inspection.Counts, null);
  assert.match(inspection.Errors[0].message, /JSON غير صالح/);
});

test('B3. an empty file is rejected', async () => {
  for (const empty of ['', '   ', '\n\t']) {
    const inspection = inspectBackupText(empty);
    assert.equal(inspection.Ok, false);
    assert.match(inspection.Errors[0].message, /فارغ/);
  }
});

test('B4. valid JSON with a foreign structure is rejected', async () => {
  const inspection = inspectBackupText(JSON.stringify({ Hello: 'world' }));
  assert.equal(inspection.Ok, false);
  assert.ok(inspection.Errors.length > 0);
});

test('B5. missing required sections are rejected', async () => {
  const inspection = inspectBackupText(JSON.stringify({
    Meta: { App: 'CustomerAccountsDB', FormatVersion: 1, SchemaVersion: 1 }, Customers: []
  }));
  assert.equal(inspection.Ok, false);
  assert.ok(inspection.Errors.length > 0);
});

test('B6. wrong field types are rejected', async () => {
  const inspection = inspectBackupText(JSON.stringify({
    Meta: { App: 'CustomerAccountsDB', FormatVersion: 1, SchemaVersion: 1 },
    Customers: [{ Id: 'cus_1', Code: 'A', Name: 'أ', OpeningBalanceMinor: 'كثير', IsActive: true }],
    Transactions: [], OpeningBalanceHistory: [],
    Settings: [{ Key: 'DefaultPackageWeight', Value: 14 }], Metadata: [{ Key: 'SchemaVersion', Value: 1 }]
  }));
  assert.equal(inspection.Ok, false);
  assert.ok(inspection.Errors.length > 0);
});

test('B7. an unsupported schema version is rejected', async () => {
  const unsupported = inspectBackupText(JSON.stringify({
    Meta: { App: 'CustomerAccountsDB', FormatVersion: 1, SchemaVersion: 999 },
    Customers: [], Transactions: [], OpeningBalanceHistory: [], Settings: [], Metadata: []
  }));
  assert.equal(unsupported.Ok, false);
  assert.ok(unsupported.Errors.length > 0);

  const foreignApp = inspectBackupText(JSON.stringify({
    Meta: { App: 'OtherApp', FormatVersion: 1, SchemaVersion: 1 },
    Customers: [], Transactions: [], OpeningBalanceHistory: [], Settings: [], Metadata: []
  }));
  assert.equal(foreignApp.Ok, false);
});

test('B8. a hand-built file in the current format is accepted', async () => {
  const inspection = inspectBackupText(JSON.stringify({
    Meta: { App: 'CustomerAccountsDB', FormatVersion: 1, SchemaVersion: DB_VERSION, ExportedAt: '2026-10-01T10:00:00.000Z' },
    Customers: [{ Id: 'cus_1', Code: 'X1', Name: 'اسم', OpeningBalanceMinor: 0, IsActive: true }],
    Transactions: [], OpeningBalanceHistory: [],
    Settings: [{ Key: 'DefaultPackageWeight', Value: 14 }], Metadata: [{ Key: 'SchemaVersion', Value: DB_VERSION }]
  }));
  assert.equal(inspection.Ok, true);
  assert.equal(inspection.Meta.ExportedAt, '2026-10-01T10:00:00.000Z');
  assert.equal(inspection.Counts.customers, 1);
});

test('B9. the file check is the SAME validation the restore runs (no parallel rule set)', async () => {
  await freshDatabase('b10_b9');
  const broken = {
    Meta: { App: 'CustomerAccountsDB', FormatVersion: 1, SchemaVersion: 1 },
    Customers: [{ Id: 'cus_1', Code: 'X', Name: 'اسم', OpeningBalanceMinor: 0, IsActive: true }],
    Transactions: [{ Id: 'trx_1', CustomerId: 'missing-customer', Date: '2026-09-01', TransactionType: 'SalePesticides', AmountMinor: 100, Status: 'Active' }],
    OpeningBalanceHistory: [], Settings: [], Metadata: []
  };
  const direct = validateBackup(broken);
  const viaScreen = inspectBackupText(JSON.stringify(broken));
  assert.equal(direct.ok, false);
  assert.equal(viaScreen.Ok, false);
  assert.deepEqual(viaScreen.Errors.map((error) => error.message), direct.errors.map((error) => error.message));
  assert.equal(restoreService.inspectJson(JSON.stringify(broken)).Ok, false);
});

test('B10. inspecting a file never writes to the database', async () => {
  await freshDatabase('b10_b10');
  await seedScenario();
  const before = await fullSnapshot();

  inspectBackupText('{ not json');
  inspectBackupText(JSON.stringify({
    Meta: { App: 'CustomerAccountsDB', FormatVersion: 1, SchemaVersion: 999 },
    Customers: [], Transactions: [], OpeningBalanceHistory: [], Settings: [], Metadata: []
  }));
  inspectBackupText((await createBackupFile()).Json);

  const after = await fullSnapshot();
  assert.deepEqual(after.customers, before.customers);
  assert.deepEqual(after.transactions, before.transactions);
  assert.deepEqual(after.balances, before.balances);
});

// ===========================================================================
// C — restoring
// ===========================================================================

test('C1. a valid restore replaces the current data completely (no merge)', async () => {
  await freshDatabase('b10_c1');
  await seedScenario();
  const json = (await createBackupFile()).Json;

  await customerService.createCustomer({ Code: 'LATER-1', Name: 'عميل لاحق', OpeningBalance: 50 });
  assert.equal((await customerService.listCustomers()).length, 2);

  const result = await restoreService.restoreFromJson(json);
  assert.equal(result.restored, true);
  assert.equal(result.counts.customers, 1);
  const codes = (await customerService.listCustomers()).map((row) => row.Code);
  assert.deepEqual(codes, ['BU-1'], 'the later customer is gone: the restore replaced, it did not merge');
});

test('C2. the restored customers and transactions are the ones from the file', async () => {
  await freshDatabase('b10_c2');
  await seedScenario();
  const json = (await createBackupFile()).Json;

  await databaseInit.drop();
  configureDatabase({ name: 'ca_b10_c2_target' });
  await deleteDatabase();
  await databaseInit.initialize();

  await restoreService.restoreFromJson(json);
  const customer = await customerService.getByCode('BU-1');
  assert.ok(customer, 'the customer came back');
  assert.equal(customer.OpeningBalanceMinor, 200000);
  const rows = await transactionRepository.listByCustomer(customer.Id);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.TransactionType === TRANSACTION_TYPE.CASH_RECEIVED).length, 1);
  const history = await openingBalanceService.listHistory(customer.Id);
  assert.equal(history.length, 1);
  assert.equal(history[0].Reason, 'تصحيح افتتاحي');
});

test('C3. relations survive the restore and the balance is recomputed from the engine', async () => {
  await freshDatabase('b10_c3');
  const customer = await seedScenario();
  const balanceBefore = await balanceService.getCurrentBalanceMinor(customer.Id);
  const summaryBefore = await balanceService.getCustomerSummary(customer.Id);
  const json = (await createBackupFile()).Json;

  await databaseInit.drop();
  configureDatabase({ name: 'ca_b10_c3_target' });
  await deleteDatabase();
  await databaseInit.initialize();
  await restoreService.restoreFromJson(json);

  const restored = await customerService.getByCode('BU-1');
  assert.equal(await balanceService.getCurrentBalanceMinor(restored.Id), balanceBefore);
  const summaryAfter = await balanceService.getCustomerSummary(restored.Id);
  assert.equal(summaryAfter.BalanceMinor, summaryBefore.BalanceMinor);
  assert.equal(summaryAfter.CashReceivedMinor, summaryBefore.CashReceivedMinor);
  assert.equal(summaryAfter.CashPaidMinor, summaryBefore.CashPaidMinor);
  assert.equal(summaryAfter.TotalDebitMinor, summaryBefore.TotalDebitMinor);
  assert.equal(summaryAfter.TotalCreditMinor, summaryBefore.TotalCreditMinor);
  // The opening-balance history is still attached to the same customer.
  const history = await openingBalanceService.listHistory(restored.Id);
  assert.equal(history[0].CustomerId, restored.Id);
});

test('C4. an invalid file is refused and the live data is untouched', async () => {
  await freshDatabase('b10_c4');
  await seedScenario();
  const before = await fullSnapshot();

  await assert.rejects(() => restoreService.restoreFromJson('{ not json'), /JSON غير صالح/);
  await assert.rejects(() => restoreService.restoreFromJson(''));

  const after = await fullSnapshot();
  assert.deepEqual(after.customers, before.customers);
  assert.deepEqual(after.transactions, before.transactions);
  assert.deepEqual(after.balances, before.balances);
  assert.equal(after.portfolio.TotalBalanceMinor, before.portfolio.TotalBalanceMinor);
});

test('C5. an unsupported version is refused and the live data is untouched', async () => {
  await freshDatabase('b10_c5');
  await seedScenario();
  const before = await fullSnapshot();

  await assert.rejects(() => restoreService.restoreFromJson(JSON.stringify({
    Meta: { App: 'CustomerAccountsDB', FormatVersion: 1, SchemaVersion: 999 },
    Customers: [], Transactions: [], OpeningBalanceHistory: [], Settings: [], Metadata: []
  })));

  const after = await fullSnapshot();
  assert.deepEqual(after.customers, before.customers);
  assert.deepEqual(after.transactions, before.transactions);
  assert.deepEqual(after.balances, before.balances);
});

test('C6. a failure INSIDE the write transaction leaves the previous data intact (rollback)', async () => {
  await freshDatabase('b10_c6');
  const customer = await seedScenario();
  const before = await fullSnapshot();
  const countsBefore = await storeCounts();
  assert.equal(countsBefore.customers, 1);

  // A different backup that WOULD replace the data if it were applied.
  const incoming = {
    Meta: { App: 'CustomerAccountsDB', FormatVersion: 1, SchemaVersion: DB_VERSION, ExportedAt: '2026-10-20T08:00:00.000Z' },
    Customers: [{ Id: 'cus_new', Code: 'NEW-1', Name: 'عميل النسخة الجديدة', OpeningBalanceMinor: 0, IsActive: true }],
    Transactions: [],
    OpeningBalanceHistory: [],
    Settings: [{ Key: 'DefaultPackageWeight', Value: 25 }],
    Metadata: [{ Key: 'SchemaVersion', Value: DB_VERSION }]
  };
  assert.equal(validateBackup(incoming).ok, true, 'the incoming file itself is valid');

  await assert.rejects(() => withFailingPut(STORE.SETTINGS, () => restoreService.restore(incoming)), (error) => {
    assert.ok(error, 'the injected storage failure is propagated');
    return true;
  });

  await simulateReload();

  const countsAfter = await storeCounts();
  assert.equal(countsAfter.customers, countsBefore.customers, 'the clear of the customers store was rolled back');
  assert.equal(countsAfter.transactions, countsBefore.transactions);
  assert.equal(countsAfter.auditLog, countsBefore.auditLog);
  const after = await fullSnapshot();
  assert.deepEqual(after.customers, before.customers);
  assert.deepEqual(after.transactions, before.transactions);
  assert.deepEqual(after.balances, before.balances);
  assert.equal(after.portfolio.TotalBalanceMinor, before.portfolio.TotalBalanceMinor);
  assert.equal(Boolean(await customerService.getByCode('NEW-1')), false, 'the half-written new customer is not in the database');
  assert.equal(await balanceService.getCurrentBalanceMinor(customer.Id), before.portfolio.TotalBalanceMinor);
});

test('C7. restoring over existing data replaces it without duplicating anything', async () => {
  await freshDatabase('b10_c7');
  await seedScenario();
  const json = (await createBackupFile()).Json;

  await restoreService.restoreFromJson(json);
  await restoreService.restoreFromJson(json);

  assert.equal((await customerService.listCustomers()).length, 1);
  assert.equal((await transactionRepository.getAll()).length, 2);
  const customer = await customerService.getByCode('BU-1');
  assert.equal((await openingBalanceService.listHistory(customer.Id)).length, 1);
  assert.equal(await balanceService.getCurrentBalanceMinor(customer.Id), 200000 - 35000 + 80000);
});

test('C8. the financial meaning of a restored movement is unchanged', async () => {
  await freshDatabase('b10_c8');
  await seedScenario();
  const json = (await createBackupFile()).Json;

  await databaseInit.drop();
  configureDatabase({ name: 'ca_b10_c8_target' });
  await deleteDatabase();
  await databaseInit.initialize();
  await restoreService.restoreFromJson(json);

  const rows = await transactionRepository.getAll();
  const cash = rows.find((row) => row.TransactionType === TRANSACTION_TYPE.CASH_RECEIVED);
  const sale = rows.find((row) => row.TransactionType === TRANSACTION_TYPE.SALE_PESTICIDES);
  const cashFinancials = deriveFinancials(cash);
  const saleFinancials = deriveFinancials(sale);
  assert.equal(cashFinancials.CashReceivedMinor, 80000);
  assert.equal(cashFinancials.CashPaidMinor, 0);
  assert.equal(cashFinancials.CreditMinor, 80000);
  assert.equal(saleFinancials.DebitMinor, 35000);
  assert.equal(saleFinancials.CashReceivedMinor, 0);
  assert.equal(saleFinancials.isCash, false);
});

test('C9. a valid restore keeps the settings used by the financial rules', async () => {
  await freshDatabase('b10_c9');
  await seedScenario();
  const json = (await createBackupFile()).Json;

  await databaseInit.drop();
  configureDatabase({ name: 'ca_b10_c9_target' });
  await deleteDatabase();
  await databaseInit.initialize();
  await restoreService.restoreFromJson(json);

  const { settingsService } = await import('../src/services/settingsService.js');
  assert.equal(await settingsService.getDefaultPackageWeight(), 14, 'the seeded default weight comes back with the file');
});

test('C10. the restore result reports the real number of restored records', async () => {
  await freshDatabase('b10_c10');
  await seedScenario();
  const backup = JSON.parse((await createBackupFile()).Json);
  const result = await restoreService.restore(backup);
  assert.equal(result.restored, true);
  assert.equal(result.counts.customers, backup.Customers.length);
  assert.equal(result.counts.transactions, backup.Transactions.length);
  assert.equal(result.counts.openingBalanceHistory, backup.OpeningBalanceHistory.length);
  assert.equal(result.counts.settings, backup.Settings.length);
  assert.equal(result.counts.metadata, backup.Metadata.length);
  assert.equal(result.counts.auditLog, (backup.AuditLog || []).length);
});

// ===========================================================================
// D — the screen
// ===========================================================================

test('D1. the Backup route renders the real screen, not the phase placeholder', async () => {
  const route = findRouteById('backup');
  assert.ok(route, 'the navigation item exists');
  const html = renderDestinationView({ route });
  assert.equal(html.includes(BACKUP_REGION_ID), true);
  assert.equal(html.includes('النسخ الاحتياطي والاستعادة'), true);
  assert.equal(html.includes(SHARED_NOTICE), false, 'the placeholder notice is gone');
  assert.equal(backupViewHtml().includes(SHARED_NOTICE), false);
});

test('D2. the screen renders both sections and never touches a service before the user acts', async () => {
  await freshDatabase('b10_d2');
  const calls = [];
  const { screen, view } = backupScreen({
    services: {
      createBackupFile: async () => { calls.push('create'); return { FileName: 'x.json', Json: '{}', Counts: {} }; },
      inspectJson: async () => { calls.push('inspect'); return { Ok: true, Errors: [], Counts: {}, Meta: {} }; },
      restoreFromJson: async () => { calls.push('restore'); return { restored: true, counts: {} }; }
    }
  });

  const html = screen.html();
  assert.equal(html.includes(BACKUP_CREATE_ID), true);
  assert.equal(html.includes(RESTORE_FILE_ID), true);
  assert.equal(html.includes('إنشاء نسخة احتياطية'), true);
  assert.equal(html.includes('استعادة نسخة احتياطية'), true);
  assert.equal(html.includes(RESTORE_BEHAVIOUR_NOTE), true, 'the replacement behaviour is stated before any action');
  assert.deepEqual(calls, [], 'no service runs just by opening the screen');
  assert.equal(typeof view.createBackup, 'function');
  assert.equal(typeof view.confirmRestore, 'function');
});

test('D3. creating a backup from the screen downloads the file and reports success afterwards', async () => {
  await freshDatabase('b10_d3');
  await seedScenario();
  const downloads = [];
  const { screen, view } = backupScreen({
    services: realServices,
    download: (payload) => { downloads.push(payload); return true; }
  });

  await view.createBackup();

  assert.equal(downloads.length, 1, 'the file was handed to the download mechanism exactly once');
  assert.match(downloads[0].fileName, /^customer-accounts-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  const parsed = JSON.parse(downloads[0].content);
  assert.equal(parsed.Meta.App, 'CustomerAccountsDB');
  assert.equal(parsed.Customers.length, 1);

  const html = screen.html();
  assert.equal(html.includes(BACKUP_MESSAGE.createDone), true);
  assert.equal(html.includes('عميل النسخة') || html.includes('العملاء'), true, 'the count summary is shown');
  assert.equal(html.includes(BACKUP_MESSAGE.createFailed), false);
});

test('D4. the download helper builds a blob from the JSON and names the file', async () => {
  const realBlob = globalThis.Blob;
  const realDocument = globalThis.document;
  const realURL = globalThis.URL;
  const created = [];
  const clicked = [];
  const revoked = [];
  try {
    globalThis.Blob = class { constructor(parts, options) { this.parts = parts; this.type = options && options.type; } };
    globalThis.document = {
      createElement() {
        return {
          set href(value) { this._href = value; },
          get href() { return this._href; },
          download: null,
          rel: null,
          click() { clicked.push(this.download); },
          remove() { this.removed = true; }
        };
      },
      body: { appendChild() {} }
    };
    globalThis.URL = {
      createObjectURL(blob) { created.push(blob); return 'blob:mock/1'; },
      revokeObjectURL(url) { revoked.push(url); }
    };

    const ok = downloadInBrowser({ fileName: 'customer-accounts-backup-2026-10-21-0915.json', content: '{"a":1}' });
    assert.equal(ok, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].parts[0], '{"a":1}');
    assert.match(created[0].type, /application\/json/);
    assert.deepEqual(clicked, ['customer-accounts-backup-2026-10-21-0915.json']);
  } finally {
    globalThis.Blob = realBlob;
    globalThis.document = realDocument;
    globalThis.URL = realURL;
  }
});

test('D5. choosing a valid file shows the summary but does NOT restore anything', async () => {
  await freshDatabase('b10_d5');
  await seedScenario();
  const json = (await createBackupFile()).Json;
  const calls = [];
  const { screen, view } = backupScreen({
    services: { ...realServices, restoreFromJson: async (...args) => { calls.push(args); return restoreService.restoreFromJson(...args); } },
    download: () => true
  });

  await view.pickFile(fileStub(json));

  const html = screen.html();
  assert.equal(html.includes(RESTORE_CONFIRM_ID), true, 'the explicit confirmation step appears');
  assert.equal(html.includes('الملف صالح'), true);
  assert.equal(html.includes('عدد السجلات في النسخة'), true);
  assert.deepEqual(calls, [], 'the restore did not run on file selection alone');
  assert.equal((await customerService.listCustomers()).length, 1);
});

test('D6. cancelling the confirmation removes the summary and never restores', async () => {
  await freshDatabase('b10_d6');
  await seedScenario();
  const json = (await createBackupFile()).Json;
  const calls = [];
  const { screen, view } = backupScreen({
    services: { ...realServices, restoreFromJson: async (...args) => { calls.push(args); return restoreService.restoreFromJson(...args); } },
    download: () => true
  });

  await view.pickFile(fileStub(json));
  assert.equal(screen.html().includes(RESTORE_CONFIRM_ID), true);

  screen.click('cancel-restore');
  const html = screen.html();
  assert.equal(html.includes(RESTORE_CONFIRM_ID), false, 'the confirmation is gone');
  assert.deepEqual(calls, [], 'nothing was restored after cancelling');
  assert.equal(view.state().inspection, null);
});

test('D7. an invalid file is refused with a clear message and no confirmation', async () => {
  await freshDatabase('b10_d7');
  await seedScenario();
  const { screen, view } = backupScreen({ services: realServices, download: () => true });

  await view.pickFile(fileStub('{ not json'));
  let html = screen.html();
  assert.equal(html.includes(BACKUP_MESSAGE.inspectInvalid), true);
  assert.equal(html.includes(RESTORE_CONFIRM_ID), false);
  assert.equal(html.includes('JSON غير صالح'), true, 'the technical reason is not hidden');

  await view.pickFile(fileStub('   '));
  html = screen.html();
  assert.equal(html.includes('فارغ'), true);
  assert.equal(html.includes(RESTORE_CONFIRM_ID), false);

  // Even if the confirm action were triggered, nothing can be restored without a validated file.
  screen.click('confirm-restore');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await customerService.listCustomers()).length, 1);
});

test('D8. repeated clicks cannot start a second operation and the buttons are disabled while one runs', async () => {
  await freshDatabase('b10_d8');
  await seedScenario();
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { screen, view } = backupScreen({
    services: {
      ...realServices,
      createBackupFile: async () => { started += 1; await gate; return createBackupFile(); }
    },
    download: () => true
  });

  const first = view.createBackup();
  await waitFor(() => screen.html().includes(BACKUP_MESSAGE.createBusy));
  const busyHtml = screen.html();
  assert.match(busyHtml, /id="backup-create"[^>]*disabled/, 'the create button is disabled while it runs');
  assert.equal(busyHtml.includes(BACKUP_MESSAGE.createDone), false, 'no success message before the file exists');

  const second = await view.createBackup();
  assert.equal(second, null, 'the second click is refused');
  assert.equal(started, 1, 'the service ran exactly once');

  release();
  await first;
  assert.equal(started, 1);
  assert.equal(screen.html().includes(BACKUP_MESSAGE.createDone), true);
  assert.doesNotMatch(screen.html(), /id="backup-create"[^>]*disabled/, 'the button is usable again');
});

test('D9. a failing restore from the screen reports the reason and changes nothing', async () => {
  await freshDatabase('b10_d9');
  await seedScenario();
  const before = await fullSnapshot();
  const { screen, view } = backupScreen({ services: realServices, download: () => true });

  await view.pickFile(fileStub(JSON.stringify({
    Meta: { App: 'CustomerAccountsDB', FormatVersion: 1, SchemaVersion: DB_VERSION, ExportedAt: '2026-10-20T08:00:00.000Z' },
    Customers: [{ Id: 'cus_new', Code: 'NEW-1', Name: 'جديد', OpeningBalanceMinor: 0, IsActive: true }],
    Transactions: [], OpeningBalanceHistory: [],
    Settings: [{ Key: 'DefaultPackageWeight', Value: 14 }], Metadata: [{ Key: 'SchemaVersion', Value: DB_VERSION }]
  })));
  assert.equal(screen.html().includes(RESTORE_CONFIRM_ID), true);

  // The storage engine fails during the write, exactly like a real mid-restore failure.
  await withFailingPut(STORE.SETTINGS, async () => { await view.confirmRestore(); });

  const html = screen.html();
  assert.equal(html.includes(BACKUP_MESSAGE.restoreFailed), true);
  assert.equal(html.includes(BACKUP_MESSAGE.restoreDone), false, 'no success message is ever shown for a failed restore');

  await simulateReload();
  const after = await fullSnapshot();
  assert.deepEqual(after.customers, before.customers);
  assert.deepEqual(after.transactions, before.transactions);
  assert.deepEqual(after.balances, before.balances);
  assert.equal(Boolean(await customerService.getByCode('NEW-1')), false, 'the half-written new customer is not in the database');
});

test('D10. a successful restore from the screen reports the restored counts', async () => {
  await freshDatabase('b10_d10');
  await seedScenario();
  const json = (await createBackupFile()).Json;
  const { screen, view } = backupScreen({ services: realServices, download: () => true });

  await view.pickFile(fileStub(json));
  await view.confirmRestore();

  const html = screen.html();
  assert.equal(html.includes(BACKUP_MESSAGE.restoreDone), true);
  assert.equal(html.includes(BACKUP_MESSAGE.restoreFailed), false);
  assert.equal((await customerService.listCustomers()).length, 1);
});

test('D11. the screen goes through the destination dispatcher of the app shell', async () => {
  await freshDatabase('b10_d11');
  const route = findRouteById('backup');
  const screen = stubScreen();
  screen.regionEl.innerHTML = renderDestinationView({ route });
  const view = initDestinationView({ container: screen.container, route, params: {}, navigate: () => true });
  assert.ok(view, 'the dispatcher returns the backup controller');
  assert.equal(typeof view.createBackup, 'function');
  assert.equal(screen.html().includes(BACKUP_CREATE_ID), true);
  assert.equal(screen.html().includes(RESTORE_BEHAVIOUR_NOTE), true);
});

test('D12. the UI layer keeps its architectural boundary', async () => {
  const files = walkFiles(UI_ROOT);
  const forbidden = [/from\s+['"][^'"]*\/repositories\//, /from\s+['"][^'"]*\/storage\//, /\bindexedDB\b/, /\bIndexedDB\b/, /\bderiveFinancials\b/, /\brunTransaction\b/, /\bIDBKeyRange\b/];
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(source)) offenders.push(`${file} :: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], 'no UI file may reach the data layer, the storage engine or the financial engine');

  const backupSource = readFileSync(join(UI_ROOT, 'views', 'backup.js'), 'utf8');
  assert.match(backupSource, /from '\.\.\/\.\.\/src\/services\/backupService\.js'/);
  assert.match(backupSource, /from '\.\.\/\.\.\/src\/services\/restoreService\.js'/);
  assert.equal(/new\s+Blob|createObjectURL/.test(backupSource), true, 'the download uses a blob URL');
  assert.equal(/\bTODO\b|\bFIXME\b/.test(backupSource), false, 'no placeholder markers in the delivered screen');
  assert.equal(/catch\s*\(\s*[^)]*\)\s*\{\s*\}/.test(backupSource), false, 'no silent catch');
});
