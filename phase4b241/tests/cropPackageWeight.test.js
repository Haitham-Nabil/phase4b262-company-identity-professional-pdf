// Phase 4B.11 — the HISTORICAL package weight of a local crop purchase.
//
// The rule: a new local movement stores the package weight that was in effect when it was
// recorded, and always computes its net weight with THAT stored value. Changing the
// default in Settings afterwards must never rewrite an existing movement. A movement
// recorded before this phase never stored a weight, so it is marked UNKNOWN — it is never
// back-filled with 14 or with the current setting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, simulateReload } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { transactionLifecycleService } from '../src/services/transactionLifecycleService.js';
import { settingsService } from '../src/services/settingsService.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { balanceService } from '../src/services/balanceService.js';
import { validateBackup } from '../src/services/restoreService.js';
import { backupService } from '../src/services/backupService.js';
import { restoreService } from '../src/services/restoreService.js';
import { PACKAGE_WEIGHT_STATUS } from '../src/storage/schema.js';
import { TRANSACTION_TYPE, STATUS } from '../src/domain/transactionTypes.js';

// D = 4 packages, F = 1 kg deduction, E = 2 kg loose, H = 10.00 / kg.
// Net = 4 x (W - 1) + 2   ->  W=14 -> 54 kg -> 540.00 ; W=20 -> 78 kg -> 780.00
const LOCAL = {
  CustomerId: null,
  Date: '2026-10-05',
  TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL,
  crop: { LocalUnitsMilli: 4000, LocalLooseKgMilli: 2000, LocalDeductionKgMilli: 1000, LocalUnitPriceMinor: 1000 }
};

async function seed() {
  await freshDatabase('weight');
  return customerService.createCustomer({ Code: 'W-1', Name: 'مزارع الوزن' });
}

function localDraft(customerId) {
  return { ...LOCAL, CustomerId: customerId };
}

test('W1. A new local purchase stores 14 kg when that is the setting, and derives 54 kg / 540.00', async () => {
  const customer = await seed();
  await settingsService.setDefaultPackageWeight(14);
  const row = await transactionService.createTransaction(localDraft(customer.Id));
  assert.equal(row.PackageWeightKg, 14);
  assert.equal(row.PackageWeightStatus, PACKAGE_WEIGHT_STATUS.CONFIRMED);
  assert.equal(row.NetWeightMilli, 54000, '4 x (14 - 1) + 2 = 54 kg');
  assert.equal(row.AmountMinor, 54000, '54 kg x 10.00');
});

test('W2. After the setting changes to 20, a second movement stores 20 and keeps its own 78 kg', async () => {
  const customer = await seed();
  await settingsService.setDefaultPackageWeight(14);
  const first = await transactionService.createTransaction(localDraft(customer.Id));
  await settingsService.setDefaultPackageWeight(20);
  const second = await transactionService.createTransaction(localDraft(customer.Id));
  assert.equal(first.PackageWeightKg, 14);
  assert.equal(second.PackageWeightKg, 20);
  assert.equal(first.NetWeightMilli, 54000);
  assert.equal(second.NetWeightMilli, 78000, '4 x (20 - 1) + 2 = 78 kg');
  assert.equal(second.AmountMinor, 78000);
  // The FIRST row was not recomputed by the setting change.
  const storedFirst = await transactionRepository.getById(first.Id);
  assert.equal(storedFirst.PackageWeightKg, 14);
  assert.equal(storedFirst.NetWeightMilli, 54000);
  assert.equal(storedFirst.AmountMinor, 54000);
});

test('W3. Both weights survive an application reload', async () => {
  const customer = await seed();
  await settingsService.setDefaultPackageWeight(14);
  const first = await transactionService.createTransaction(localDraft(customer.Id));
  await settingsService.setDefaultPackageWeight(20);
  const second = await transactionService.createTransaction(localDraft(customer.Id));
  await simulateReload();
  const a = await transactionRepository.getById(first.Id);
  const b = await transactionRepository.getById(second.Id);
  assert.equal(a.PackageWeightKg, 14);
  assert.equal(a.NetWeightMilli, 54000);
  assert.equal(b.PackageWeightKg, 20);
  assert.equal(b.NetWeightMilli, 78000);
  // And the statement shows the stored weight, not the current setting.
  const ledger = await balanceService.getRunningBalance(customer.Id);
  const rowA = ledger.Entries.find((row) => row.Id === first.Id);
  const rowB = ledger.Entries.find((row) => row.Id === second.Id);
  assert.equal(rowA.PackageWeightKg, 14);
  assert.equal(rowB.PackageWeightKg, 20);
  assert.equal(ledger.BalanceMinor, 54000 + 78000);
});

test('W4. Editing another field does not change the stored package weight', async () => {
  const customer = await seed();
  await settingsService.setDefaultPackageWeight(14);
  const row = await transactionService.createTransaction(localDraft(customer.Id));
  await settingsService.setDefaultPackageWeight(20); // the setting moves AFTER recording

  const edited = await transactionLifecycleService.editTransaction(row.Id, {
    Date: '2026-10-06',
    Description: 'تعديل البيان فقط',
    Units: '4', LooseKg: '2', DeductionKg: '1', UnitPrice: '10',
    EditReason: 'تصحيح البيان'
  });
  assert.equal(edited.Record.PackageWeightKg, 14, 'the historical weight is preserved');
  assert.equal(edited.Record.PackageWeightStatus, PACKAGE_WEIGHT_STATUS.CONFIRMED);
  assert.equal(edited.Record.NetWeightMilli, 54000, 'the net weight is still derived from 14 kg');
  assert.equal(edited.Record.AmountMinor, 54000, 'so the amount is unchanged');
  assert.equal(edited.Record.Description, 'تعديل البيان فقط');
});

test('W5. An edit that changes the quantity re-derives the amount with the STORED weight, not the new setting', async () => {
  const customer = await seed();
  await settingsService.setDefaultPackageWeight(14);
  const row = await transactionService.createTransaction(localDraft(customer.Id));
  await settingsService.setDefaultPackageWeight(20);
  // 2 packages x (14 - 1) + 2 = 28 kg -> 280.00   (with 20 it would be 400.00)
  const edited = await transactionLifecycleService.editTransaction(row.Id, {
    Date: '2026-10-05', Units: '2', LooseKg: '2', DeductionKg: '1', UnitPrice: '10',
    EditReason: 'تغيير عدد العبوات'
  });
  assert.equal(edited.Record.PackageWeightKg, 14);
  assert.equal(edited.Record.NetWeightMilli, 28000);
  assert.equal(edited.Record.AmountMinor, 28000);
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.BalanceMinor, 28000, 'the balance follows the re-derived amount only');
});

test('W6. A legacy local row with no stored weight is marked Unknown, and its weight is never invented', async () => {
  const customer = await seed();
  const legacy = {
    Id: 'trx_legacy_local', CustomerId: customer.Id, Date: '2026-08-01',
    TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, Description: 'قديمة بلا وزن محفوظ',
    AmountMinor: 54000, Status: STATUS.ACTIVE, CancellationReason: null, CancelledAt: null,
    CreatedAt: '2026-08-01T00:00:00.000Z', UpdatedAt: '2026-08-01T00:00:00.000Z',
    LocalUnitsMilli: 4000, LocalLooseKgMilli: 2000, LocalDeductionKgMilli: 1000, LocalUnitPriceMinor: 1000
  };
  await transactionRepository.put(legacy);
  const ledger = await balanceService.getRunningBalance(customer.Id);
  const entry = ledger.Entries.find((row) => row.Id === legacy.Id);
  assert.equal(entry.PackageWeightKg, null, 'no weight is fabricated');
  assert.notEqual(entry.PackageWeightStatus, PACKAGE_WEIGHT_STATUS.CONFIRMED, 'the row is NOT presented as confirmed');
  assert.equal(ledger.BalanceMinor, 54000, 'the stored amount still counts exactly as before');
});

test('W7. The upgrade marks a pre-4B.11 local row as Unknown and leaves its amount untouched', async () => {
  // A database written by the previous release (version 2), then opened by this one.
  const { configureDatabase, openDatabase, deleteDatabase, closeDatabase } = await import('../src/storage/db.js');
  const { configureIndexedDB } = await import('../src/storage/db.js');
  const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
  configureIndexedDB({ indexedDB, IDBKeyRange });
  const name = 'ca_weight_upgrade';
  configureDatabase({ name, version: 2 });
  await deleteDatabase();

  const v2 = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('customers', { keyPath: 'Id' });
      const trx = db.createObjectStore('transactions', { keyPath: 'Id' });
      trx.createIndex('customerId', 'CustomerId');
      trx.createIndex('date', 'Date');
      trx.createIndex('transactionType', 'TransactionType');
      trx.createIndex('status', 'Status');
      trx.createIndex('linkId', 'LinkId');
      trx.createIndex('customerId_date', ['CustomerId', 'Date']);
      db.createObjectStore('openingBalanceHistory', { keyPath: 'Id' });
      db.createObjectStore('settings', { keyPath: 'Key' });
      db.createObjectStore('metadata', { keyPath: 'Key' });
      db.createObjectStore('auditLog', { keyPath: 'Id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = v2.transaction(['customers', 'transactions'], 'readwrite');
    tx.objectStore('customers').put({ Id: 'cus-old', Code: 'O-1', Name: 'قديم', OpeningBalanceMinor: 0, IsActive: true, CreatedAt: '2026-08-01T00:00:00.000Z', UpdatedAt: '2026-08-01T00:00:00.000Z' });
    tx.objectStore('transactions').put({
      Id: 'trx-old-local', CustomerId: 'cus-old', Date: '2026-08-02', TransactionType: 'CropPurchaseLocal',
      Description: 'قديمة', AmountMinor: 54000, Status: 'Active', CancellationReason: null, CancelledAt: null,
      CreatedAt: '2026-08-02T00:00:00.000Z', UpdatedAt: '2026-08-02T00:00:00.000Z',
      LocalUnitsMilli: 4000, LocalLooseKgMilli: 2000, LocalDeductionKgMilli: 1000, LocalUnitPriceMinor: 1000
    });
    tx.objectStore('transactions').put({
      Id: 'trx-old-sale', CustomerId: 'cus-old', Date: '2026-08-03', TransactionType: 'SalePesticides',
      Description: 'بيع', AmountMinor: 1000, Status: 'Active', CancellationReason: null, CancelledAt: null,
      CreatedAt: '2026-08-03T00:00:00.000Z', UpdatedAt: '2026-08-03T00:00:00.000Z'
    });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
  v2.close();

  const { DB_VERSION } = await import('../src/storage/schema.js');
  configureDatabase({ name, version: DB_VERSION });
  const upgraded = await openDatabase();
  assert.equal(upgraded.version, DB_VERSION);
  assert.equal(Array.from(upgraded.objectStoreNames).includes('receivingCompanies'), true);
  assert.equal(Array.from(upgraded.objectStoreNames).includes('cartonTypes'), true);

  const rows = await new Promise((resolve, reject) => {
    const tx = upgraded.transaction(['transactions'], 'readonly');
    const request = tx.objectStore('transactions').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const local = rows.find((row) => row.Id === 'trx-old-local');
  const sale = rows.find((row) => row.Id === 'trx-old-sale');
  assert.equal(local.PackageWeightKg, null, 'the weight stays null: it was never recorded');
  assert.equal(local.PackageWeightStatus, PACKAGE_WEIGHT_STATUS.UNKNOWN);
  assert.equal(local.AmountMinor, 54000, 'the amount is untouched by the migration');
  assert.equal(local.Date, '2026-08-02');
  assert.equal(Object.prototype.hasOwnProperty.call(sale, 'PackageWeightKg'), false, 'a non-crop row is not touched');
  assert.equal(sale.AmountMinor, 1000);
  await closeDatabase();
});

test('W8. A backup keeps the stored weight and its status; a legacy row keeps its Unknown marker', async () => {
  const customer = await seed();
  await settingsService.setDefaultPackageWeight(14);
  const confirmed = await transactionService.createTransaction(localDraft(customer.Id));
  await transactionRepository.put({
    Id: 'trx_legacy_w8', CustomerId: customer.Id, Date: '2026-08-05',
    TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, Description: null, AmountMinor: 54000,
    Status: STATUS.ACTIVE, CancellationReason: null, CancelledAt: null,
    CreatedAt: '2026-08-05T00:00:00.000Z', UpdatedAt: '2026-08-05T00:00:00.000Z',
    LocalUnitsMilli: 4000, LocalLooseKgMilli: 2000, LocalDeductionKgMilli: 1000, LocalUnitPriceMinor: 1000,
    PackageWeightKg: null, PackageWeightStatus: PACKAGE_WEIGHT_STATUS.UNKNOWN, NetWeightMilli: null
  });
  const backup = await backupService.createBackup();
  assert.equal(validateBackup(backup).ok, true);
  const inFile = backup.Transactions.find((row) => row.Id === confirmed.Id);
  assert.equal(inFile.PackageWeightKg, 14);
  assert.equal(inFile.PackageWeightStatus, PACKAGE_WEIGHT_STATUS.CONFIRMED);
  assert.equal(inFile.NetWeightMilli, 54000);
  const legacyFile = backup.Transactions.find((row) => row.Id === 'trx_legacy_w8');
  assert.equal(legacyFile.PackageWeightKg, null);
  assert.equal(legacyFile.PackageWeightStatus, PACKAGE_WEIGHT_STATUS.UNKNOWN);
});

test('W9. A backup claiming a Confirmed weight without a value is refused', async () => {
 const seedCustomer = await seed();
  await settingsService.setDefaultPackageWeight(14);
  await transactionService.createTransaction(localDraft(seedCustomer.Id));
  const backup = await backupService.createBackup();
  backup.Transactions[0].PackageWeightKg = null;
  backup.Transactions[0].PackageWeightStatus = PACKAGE_WEIGHT_STATUS.CONFIRMED;
  const result = validateBackup(backup);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.field === 'Transactions.PackageWeightKg'), true);
});

test('W10. Restoring an older file (no weight fields at all) keeps every movement and its amount', async () => {
  const customer = await seed();
  await settingsService.setDefaultPackageWeight(14);
  await transactionService.createTransaction(localDraft(customer.Id));
  const backup = await backupService.createBackup();
  // Rewrite it as a pre-4B.11 file: the weight fields do not exist, the amount does.
  for (const row of backup.Transactions) {
    delete row.PackageWeightKg;
    delete row.PackageWeightStatus;
    delete row.NetWeightMilli;
  }
  delete backup.ReceivingCompanies;
  delete backup.CartonTypes;
  backup.Meta.SchemaVersion = 2;
  assert.equal(validateBackup(backup).ok, true);
  await restoreService.restore(backup);
  const rows = await transactionRepository.getAll();
  assert.equal(rows.length, 1, 'no movement is lost by an older file');
  assert.equal(rows[0].AmountMinor, 54000);
  assert.equal(rows[0].PackageWeightKg ?? null, null, 'no weight is invented on restore');
  assert.equal(rows[0].PackageWeightStatus ?? null, null);
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.BalanceMinor, 54000);
});
