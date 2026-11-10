// Phase 4B.13.1 — the strawberry variety of a LOCAL crop purchase.
//
// What is proven here:
//   · the variety is a REFERENCE record managed by the existing reference pattern
//     (unique normalised name, rename keeps the identity, deactivation instead of delete);
//   · a local movement stores the variety ID, never free text;
//   · an edit keeps the stored variety, and only an explicit choice replaces it;
//   · the statement names the variety next to the package count and the net weight;
//   · nothing financial moves: no balance, no amount, no cash figure, no net weight;
//   · the historical package weight is never recomputed from the current setting;
//   · a legacy movement without a variety stays readable and shows an explicit state;
//   · the catalogue travels through backup / restore, and an older file still restores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, configureDatabase, deleteDatabase } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { transactionLifecycleService } from '../src/services/transactionLifecycleService.js';
import { balanceService } from '../src/services/balanceService.js';
import { settingsService } from '../src/services/settingsService.js';
import { strawberryVarietyService } from '../src/services/referenceDataService.js';
import { backupService } from '../src/services/backupService.js';
import { restoreService } from '../src/services/restoreService.js';
import { listReferenceOptions, createStrawberryVariety } from '../src/services/transactionFormService.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { strawberryVarietyRepository } from '../src/repositories/strawberryVarietyRepository.js';
import { TRANSACTION_TYPE } from '../src/domain/transactionTypes.js';
import { STORE, DB_VERSION, STORE_NAMES } from '../src/storage/schema.js';
import { configureIndexedDB, openDatabase } from '../src/storage/db.js';
import { ledgerReferenceNote } from '../ui/views/customerAccount.js';
import { renderEditFields } from '../ui/views/transactionActions.js';
import { referenceOptionsFor, renderDynamicFields, FIELD_ID } from '../ui/views/transactionForm.js';
import { emptyForm } from '../src/validation/transactionFormInput.js';
import { logger } from '../src/utils/logger.js';
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from 'fake-indexeddb';

logger.disable?.();

let seq = 0;
async function seedFarmer(prefix = 'V') {
  seq += 1;
  return customerService.createCustomer({ Code: `${prefix}-${seq}`, Name: `مزارع ${seq}` });
}

// G = D x (W - F) + E ; amount = G x H   (unchanged by this phase)
async function seedLocal({ customer = null, units = 300, loose = 5, deduction = 1, price = 1, varietyId = null, date = '2026-10-01' } = {}) {
  const farmer = customer || await seedFarmer();
  const crop = {
    LocalUnitsMilli: units * 1000,
    LocalLooseKgMilli: loose * 1000,
    LocalDeductionKgMilli: deduction * 1000,
    LocalUnitPriceMinor: price * 100
  };
  if (varietyId) crop.StrawberryVarietyId = varietyId;
  const row = await transactionService.createTransaction({
    CustomerId: farmer.Id,
    Date: date,
    TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL,
    crop
  });
  return { customer: farmer, row };
}

// ---------------------------------------------------------------------------
// 1-2. the catalogue: creation and duplicate refusal
// ---------------------------------------------------------------------------
test('V1. a strawberry variety is created as its own reference record', async () => {
  await freshDatabase('var_create');
  const created = await strawberryVarietyService.create('فيرتونا');
  assert.equal(created.Name, 'فيرتونا');
  assert.equal(created.IsActive, true);
  assert.match(created.Id, /^var_/);
  assert.equal(created.NormalizedName, 'فيرتونا');
  assert.ok(created.CreatedAt && created.UpdatedAt);
  // Exactly one row in its own store: no movement and no amount was created.
  assert.equal((await strawberryVarietyRepository.getAll()).length, 1);
  assert.equal((await transactionRepository.getAll()).length, 0);
});

test('V2. a duplicate name is refused after trimming, collapsing and case folding', async () => {
  await freshDatabase('var_dup');
  await strawberryVarietyService.create('فلوريدا');
  for (const duplicate of ['فلوريدا', '  فلوريدا  ', 'فلوريدا\t']) {
    await assert.rejects(
      () => strawberryVarietyService.create(duplicate),
      (error) => error.code === 'CONFLICT',
      `«${duplicate}» must be refused as a duplicate`
    );
  }
  // Latin names are case-insensitive; the stored display name is never rewritten.
  const latin = await strawberryVarietyService.create('Fortuna');
  await assert.rejects(() => strawberryVarietyService.create('fortuna'), (error) => error.code === 'CONFLICT');
  await assert.rejects(() => strawberryVarietyService.create('  FORTUNA '), (error) => error.code === 'CONFLICT');
  assert.equal((await strawberryVarietyRepository.getById(latin.Id)).Name, 'Fortuna');
  // An empty name is refused before any storage call.
  await assert.rejects(() => strawberryVarietyService.create('   '), (error) => error.code === 'VALIDATION_ERROR');
  assert.equal((await strawberryVarietyRepository.getAll()).length, 2);
});

test('V2b. the variety is saved from the local crop form and appears in the options', async () => {
  await freshDatabase('var_form');
  const before = await listReferenceOptions();
  assert.deepEqual(before.StrawberryVarieties, []);
  const created = await createStrawberryVariety('صنسيشن');
  const after = await listReferenceOptions();
  assert.equal(after.StrawberryVarieties.length, 1);
  assert.equal(after.StrawberryVarieties[0].Id, created.Id);
  // The local form renders the dropdown plus its own "add new" action.
  const html = renderDynamicFields({
    transactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL,
    values: emptyForm({ transactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL }),
    referenceOptions: after
  });
  assert.match(html, new RegExp(`id="${FIELD_ID.StrawberryVarietyId}"`));
  assert.match(html, /data-action="add-strawberry-variety"/);
  assert.match(html, /صنسيشن/);
  // The carton form is untouched by this phase: no variety field there.
  const carton = renderDynamicFields({
    transactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON,
    values: emptyForm({ transactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON }),
    referenceOptions: after
  });
  assert.equal(carton.includes(FIELD_ID.StrawberryVarietyId), false);
});

// ---------------------------------------------------------------------------
// 3-5. the movement: store, reopen, explicit change
// ---------------------------------------------------------------------------
test('V3. a local crop purchase stores the variety ID (never the name)', async () => {
  await freshDatabase('var_store');
  const variety = await strawberryVarietyService.create('فيرتونا');
  const { row } = await seedLocal({ varietyId: variety.Id });
  assert.equal(row.StrawberryVarietyId, variety.Id);
  assert.equal(row.StrawberryVarietyName, undefined, 'the row carries the id only');
  const stored = await transactionRepository.getById(row.Id);
  assert.equal(stored.StrawberryVarietyId, variety.Id);
  assert.equal(stored.AmountMinor, 390500, 'the amount formula is unchanged');
  assert.equal(stored.NetWeightMilli, 3905000);
  assert.equal(stored.PackageWeightKg, 14);
});

test('V3b. an inactive variety is refused for a NEW movement, an unknown one is not found', async () => {
  await freshDatabase('var_inactive_new');
  const variety = await strawberryVarietyService.create('فيرتونا');
  await strawberryVarietyService.deactivate(variety.Id);
  await assert.rejects(() => seedLocal({ varietyId: variety.Id }), (error) => error.code === 'BUSINESS_RULE_ERROR');
  await assert.rejects(() => seedLocal({ varietyId: 'var_does_not_exist' }), (error) => error.code === 'NOT_FOUND');
  assert.equal((await transactionRepository.getAll()).length, 0, 'no row was written by a refused movement');
  // A variety sent with a CARTON purchase is refused instead of stored against the wrong type.
  const otherFarmer = await seedFarmer();
  await assert.rejects(
    () => transactionService.createTransaction({
      CustomerId: otherFarmer.Id,
      Date: '2026-10-02',
      TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON,
      ReceivingCompanyId: 'x', CartonTypeId: 'y',
      crop: { CartonQuantityMilli: 1, CartonUnitPriceMinor: 100, CartonDiscountMinor: 0, StrawberryVarietyId: variety.Id }
    }),
    (error) => /صنف الفراولة/.test(error.message)
  );
});

test('V4. reopening the edit dialog shows the stored variety and the edit keeps it', async () => {
  await freshDatabase('var_edit_keep');
  const variety = await strawberryVarietyService.create('فيرتونا');
  const { row } = await seedLocal({ varietyId: variety.Id });

  const opened = await transactionLifecycleService.getEditableTransaction(row.Id);
  assert.equal(opened.Record.StrawberryVarietyId, variety.Id);
  const options = await listReferenceOptions();
  const html = renderEditFields({ record: opened.Record, referenceOptions: options });
  assert.match(html, new RegExp(`<option value="${variety.Id}" selected>`), 'the stored variety is the current choice');
  assert.match(html, /فيرتونا/);

  // An ordinary edit that mentions no variety keeps exactly the stored one.
  const edited = await transactionLifecycleService.editTransaction(row.Id, {
    Date: '2026-10-05',
    Units: '300', LooseKg: '5', DeductionKg: '1', UnitPrice: '1',
    Description: 'تعديل الوصف',
    EditReason: 'مراجعة البيانات'
  });
  assert.equal(edited.Record.Id, row.Id, 'the identity is preserved');
  assert.equal(edited.Record.StrawberryVarietyId, variety.Id, 'the variety is never cleared by an edit');
  const reread = await transactionRepository.getById(row.Id);
  assert.equal(reread.StrawberryVarietyId, variety.Id);
  assert.equal((await transactionRepository.getAll()).length, 1, 'no second row was created');
});

test('V5. an explicit change of variety is stored, and an inactive target is refused', async () => {
  await freshDatabase('var_edit_change');
  const fortuna = await strawberryVarietyService.create('فيرتونا');
  const florida = await strawberryVarietyService.create('فلوريدا');
  const retired = await strawberryVarietyService.create('صنف قديم');
  await strawberryVarietyService.deactivate(retired.Id);
  const { row } = await seedLocal({ varietyId: fortuna.Id });

  const changed = await transactionLifecycleService.editTransaction(row.Id, {
    Date: '2026-10-01',
    Units: '300', LooseKg: '5', DeductionKg: '1', UnitPrice: '1',
    StrawberryVarietyId: florida.Id,
    EditReason: 'تصحيح الصنف'
  });
  assert.equal(changed.Record.StrawberryVarietyId, florida.Id);
  assert.equal(changed.Record.Id, row.Id);
  assert.equal(changed.Record.AmountMinor, 390500, 'an explicit change moves no money');

  await assert.rejects(
    () => transactionLifecycleService.editTransaction(row.Id, {
      Date: '2026-10-01',
      Units: '300', LooseKg: '5', DeductionKg: '1', UnitPrice: '1',
      StrawberryVarietyId: retired.Id,
      EditReason: 'محاولة اختيار صنف معطل'
    }),
    (error) => error.code === 'BUSINESS_RULE_ERROR'
  );
  assert.equal((await transactionRepository.getById(row.Id)).StrawberryVarietyId, florida.Id, 'the refusal wrote nothing');
});

// ---------------------------------------------------------------------------
// 6-7. the statement line and the balance
// ---------------------------------------------------------------------------
test('V6. the statement names the variety, the package count and the net weight', async () => {
  await freshDatabase('var_ledger');
  const variety = await strawberryVarietyService.create('فيرتونا');
  const { customer, row } = await seedLocal({ varietyId: variety.Id });
  const ledger = await balanceService.getRunningBalance(customer.Id);
  const entry = ledger.Entries.find((item) => item.Id === row.Id);
  assert.equal(entry.StrawberryVarietyId, variety.Id);
  assert.equal(entry.StrawberryVarietyName, 'فيرتونا');
  assert.equal(entry.StrawberryVarietyActive, true);
  assert.equal(entry.PackageCountMilli, 300000);
  assert.equal(entry.CropNetWeightMilli, 3905000);

  const html = ledgerReferenceNote(entry);
  assert.match(html, /صنف الفراولة:\s*فيرتونا/);
  assert.match(html, /عدد العبوات:\s*300/);
  assert.match(html, /الوزن الصافي:\s*3,905 كجم/);
  // The parts arrive as one contract list from the services layer.
  assert.deepEqual(entry.ReferenceParts, [
    'صنف الفراولة: فيرتونا',
    'عدد العبوات: 300',
    'الوزن الصافي: 3,905 كجم',
    'سعر الكيلو: 1.00 ج'
  ]);
});

test('V7. adding or changing a variety moves no balance, no amount and no cash figure', async () => {
  await freshDatabase('var_balance');
  const fortuna = await strawberryVarietyService.create('فيرتونا');
  const florida = await strawberryVarietyService.create('فلوريدا');

  const without = await seedLocal({ date: '2026-10-01' });
  const withVariety = await seedLocal({ customer: without.customer, date: '2026-10-02', varietyId: fortuna.Id });
  const before = await balanceService.getRunningBalance(without.customer.Id);
  assert.equal(before.BalanceMinor, 781000);

  await transactionLifecycleService.editTransaction(withVariety.row.Id, {
    Date: '2026-10-02',
    Units: '300', LooseKg: '5', DeductionKg: '1', UnitPrice: '1',
    StrawberryVarietyId: florida.Id,
    EditReason: 'تغيير الصنف'
  });
  const after = await balanceService.getRunningBalance(without.customer.Id);
  assert.equal(after.BalanceMinor, before.BalanceMinor, 'the balance is identical');
  assert.equal(after.Entries.length, before.Entries.length);
  const summary = await balanceService.getCustomerSummary(without.customer.Id);
  assert.equal(summary.BalanceMinor, 781000);
  assert.equal(summary.CashReceivedMinor, 0);
  assert.equal(summary.CashPaidMinor, 0);
});

// ---------------------------------------------------------------------------
// 8-11. history: deactivation, legacy rows, weight
// ---------------------------------------------------------------------------
test('V8. a deactivated variety stays named in history and is not offered for a new choice', async () => {
  await freshDatabase('var_history_inactive');
  const variety = await strawberryVarietyService.create('فيرتونا');
  const { customer, row } = await seedLocal({ varietyId: variety.Id });
  await strawberryVarietyService.deactivate(variety.Id);

  const entry = (await balanceService.getRunningBalance(customer.Id)).Entries.find((item) => item.Id === row.Id);
  assert.equal(entry.StrawberryVarietyName, 'فيرتونا', 'the historical name is still resolved');
  assert.equal(entry.StrawberryVarietyActive, false);
  assert.match(ledgerReferenceNote(entry), /فيرتونا \(غير نشطة\)/);
  // The stored id on the row was not touched by the deactivation.
  assert.equal((await transactionRepository.getById(row.Id)).StrawberryVarietyId, variety.Id);

  const options = await listReferenceOptions();
  assert.equal(referenceOptionsFor('StrawberryVariety', { referenceOptions: options, selected: '' }).some((o) => o.value === variety.Id), false);
  assert.equal(referenceOptionsFor('StrawberryVariety', { referenceOptions: options, selected: variety.Id }).some((o) => o.value === variety.Id), true);
});

test('V9. a movement recorded before this phase has no variety and is reported as undetermined', async () => {
  await freshDatabase('var_legacy');
  const { customer, row } = await seedLocal();
  // The row is created WITHOUT a variety: the field is present and null, never a name and
  // never an id borrowed from the catalogue.
  assert.equal(row.StrawberryVarietyId, null, 'nothing is invented at creation');
  const entry = (await balanceService.getRunningBalance(customer.Id)).Entries.find((item) => item.Id === row.Id);
  assert.equal(entry.StrawberryVarietyId, null);
  assert.equal(entry.StrawberryVarietyName, null);
  const html = ledgerReferenceNote(entry);
  assert.match(html, /صنف الفراولة:\s*غير محدد/);
  // The rest of the line is untouched, and reading the row never rewrites it.
  assert.match(html, /عدد العبوات:\s*300/);
  assert.equal((await transactionRepository.getById(row.Id)).StrawberryVarietyId, null);
  assert.equal((await strawberryVarietyRepository.getAll()).length, 0, 'no variety was created as a side effect');
  // A dangling id is reported as unavailable, never replaced by another name.
  const ghost = { TransactionType: 'CropPurchaseLocal', StrawberryVarietyId: 'var_gone', PackageCountMilli: 1000, CropNetWeightMilli: 1000, CropWeightResolved: true };
  assert.match(ledgerReferenceNote(ghost), /صنف الفراولة:\s*سجل غير متاح/);
});

test('V10. a legacy row whose weight cannot be settled shows no invented number', async () => {
  await freshDatabase('var_legacy_weight');
  const variety = await strawberryVarietyService.create('فيرتونا');
  const { customer, row } = await seedLocal({ varietyId: variety.Id });
  // Simulate a row written before the package weight was stored.
  await transactionRepository.put({
    ...(await transactionRepository.getById(row.Id)),
    PackageWeightKg: null,
    PackageWeightStatus: 'Unknown',
    NetWeightMilli: null
  });
  const entry = (await balanceService.getRunningBalance(customer.Id)).Entries.find((item) => item.Id === row.Id);
  assert.equal(entry.StrawberryVarietyName, 'فيرتونا', 'the variety is still named');
  assert.equal(entry.CropWeightResolved, false);
  assert.equal(entry.CropNetWeightMilli, null);
  const html = ledgerReferenceNote(entry);
  assert.match(html, /صنف الفراولة:\s*فيرتونا/);
  assert.match(html, /الوزن الصافي غير محسوم/);
  assert.equal(/0 كجم/.test(html), false, 'no zero is printed as if it were the weight');
});

test('V11. changing the default package weight never rewrites a historical variety movement', async () => {
  await freshDatabase('var_weight_frozen');
  const variety = await strawberryVarietyService.create('فيرتونا');
  await settingsService.setDefaultPackageWeight(14);
  const { customer, row } = await seedLocal({ varietyId: variety.Id });
  assert.equal(row.PackageWeightKg, 14);
  assert.equal(row.NetWeightMilli, 3905000);

  await settingsService.setDefaultPackageWeight(18);
  const stored = await transactionRepository.getById(row.Id);
  assert.equal(stored.PackageWeightKg, 14, 'the stored package weight is frozen');
  assert.equal(stored.NetWeightMilli, 3905000);
  const entry = (await balanceService.getRunningBalance(customer.Id)).Entries.find((item) => item.Id === row.Id);
  assert.equal(entry.CropNetWeightMilli, 3905000);
  assert.match(ledgerReferenceNote(entry), /الوزن الصافي:\s*3,905 كجم/);

  // An edit of that row still uses the STORED weight, not the new default.
  const edited = await transactionLifecycleService.editTransaction(row.Id, {
    Date: '2026-10-01',
    Units: '300', LooseKg: '5', DeductionKg: '1', UnitPrice: '1',
    StrawberryVarietyId: variety.Id,
    EditReason: 'تصحيح بيانات'
  });
  assert.equal(edited.Record.PackageWeightKg, 14);
  assert.equal(edited.Record.NetWeightMilli, 3905000);
  // A NEW movement uses the current setting.
  const fresh = await seedLocal({ customer, date: '2026-10-09' });
  assert.equal(fresh.row.PackageWeightKg, 18);
});

// ---------------------------------------------------------------------------
// 12-13. backup and restore
// ---------------------------------------------------------------------------
test('V12. the catalogue and its relations travel through backup and restore', async () => {
  await freshDatabase('var_backup');
  const variety = await strawberryVarietyService.create('فيرتونا');
  const retired = await strawberryVarietyService.create('صنف قديم');
  await strawberryVarietyService.deactivate(retired.Id);
  const { customer, row } = await seedLocal({ varietyId: variety.Id });

  const backup = await backupService.createBackup();
  assert.equal(Array.isArray(backup.StrawberryVarieties), true);
  assert.equal(backup.StrawberryVarieties.length, 2, 'active and inactive records both travel');
  assert.equal(backup.Transactions.find((item) => item.Id === row.Id).StrawberryVarietyId, variety.Id);
  assert.equal(backupService.createBackup && (await import('../src/services/backupService.js')).backupCounts(backup).strawberryVarieties, 2);
  const validated = restoreService.validate(backup);
  assert.equal(validated.ok, true, JSON.stringify(validated.errors));

  // Wipe everything, then restore: the variety, its state and the movement's link come back.
  await deleteDatabase();
  await freshDatabase('var_backup_target');
  const restored = await restoreService.restore(JSON.parse(JSON.stringify(backup)));
  assert.equal(restored.counts.strawberryVarieties, 2);
  const reread = await strawberryVarietyRepository.getById(variety.Id);
  assert.equal(reread.Name, 'فيرتونا');
  assert.equal(reread.IsActive, true);
  assert.equal((await strawberryVarietyRepository.getById(retired.Id)).IsActive, false);
  const movedRow = await transactionRepository.getById(row.Id);
  assert.equal(movedRow.StrawberryVarietyId, variety.Id);
  const entry = (await balanceService.getRunningBalance(customer.Id)).Entries.find((item) => item.Id === row.Id);
  assert.match(ledgerReferenceNote(entry), /صنف الفراولة:\s*فيرتونا/);
});

test('V12b. a dangling variety reference is refused before anything is written', async () => {
  await freshDatabase('var_backup_dangling');
  const variety = await strawberryVarietyService.create('فيرتونا');
  const { row } = await seedLocal({ varietyId: variety.Id });
  const backup = await backupService.createBackup();
  // Drop the catalogue but keep the movement pointing at it.
  const broken = { ...backup, StrawberryVarieties: [] };
  const validated = restoreService.validate(broken);
  assert.equal(validated.ok, false);
  assert.equal(validated.errors.some((error) => /صنف فراولة غير موجود/.test(error.message)), true);
  await assert.rejects(() => restoreService.restore(broken), (error) => error.code === 'RESTORE_ERROR');
  // The current data is untouched by the refused restore.
  assert.equal((await strawberryVarietyRepository.getAll()).length, 1);
  assert.equal((await transactionRepository.getById(row.Id)).StrawberryVarietyId, variety.Id);
});

test('V13. an older backup without the variety section still restores, with nothing invented', async () => {
  await freshDatabase('var_backup_legacy');
  const variety = await strawberryVarietyService.create('فيرتونا');
  const { customer, row } = await seedLocal({ varietyId: variety.Id });
  const backup = await backupService.createBackup();
  // An earlier file: no StrawberryVarieties key and no variety id on the rows.
  const legacy = JSON.parse(JSON.stringify(backup));
  delete legacy.StrawberryVarieties;
  legacy.Meta.SchemaVersion = 3;
  legacy.Transactions = legacy.Transactions.map((item) => {
    const copy = { ...item };
    delete copy.StrawberryVarietyId;
    return copy;
  });
  const validated = restoreService.validate(legacy);
  assert.equal(validated.ok, true, JSON.stringify(validated.errors));

  await deleteDatabase();
  await freshDatabase('var_backup_legacy_target');
  const restored = await restoreService.restore(legacy);
  assert.equal(restored.counts.strawberryVarieties, 0, 'no variety was invented');
  assert.equal((await strawberryVarietyRepository.getAll()).length, 0);
  const movedRow = await transactionRepository.getById(row.Id);
  assert.equal(movedRow.AmountMinor, 390500, 'the financial content is intact');
  const entry = (await balanceService.getRunningBalance(customer.Id)).Entries.find((item) => item.Id === row.Id);
  assert.equal(/صنف الفراولة:\s*غير محدد/.test(ledgerReferenceNote(entry)), true);
});

// ---------------------------------------------------------------------------
// 14. cancelled movements
// ---------------------------------------------------------------------------
test('V14. a cancelled local purchase stays excluded from the balance, variety and all', async () => {
  await freshDatabase('var_cancel');
  const variety = await strawberryVarietyService.create('فيرتونا');
  const { customer, row } = await seedLocal({ varietyId: variety.Id });
  const before = await balanceService.getCurrentBalanceMinor(customer.Id);
  assert.equal(before, 390500);
  await transactionLifecycleService.cancelTransaction(row.Id, 'خطأ في الإدخال', { confirmed: true });
  const after = await balanceService.getRunningBalance(customer.Id);
  assert.equal(after.BalanceMinor, 0, 'the cancelled movement leaves the balance');
  const entry = after.Entries.find((item) => item.Id === row.Id);
  assert.equal(entry.IsCancelled, true);
  assert.equal(entry.StrawberryVarietyName, 'فيرتونا', 'the cancelled row keeps its description');
  assert.equal((await transactionRepository.getById(row.Id)).StrawberryVarietyId, variety.Id);
});

// ---------------------------------------------------------------------------
// 15. schema: additive upgrade from a database written before this phase
// ---------------------------------------------------------------------------
test('V15. the upgrade is additive: a database written at version 3 keeps its rows', async () => {
  const name = `ca_var_upgrade_${Date.now()}`;
  configureIndexedDB({ indexedDB: fakeIndexedDB, IDBKeyRange: fakeIDBKeyRange });
  configureDatabase({ name, version: 3 });
  await deleteDatabase();

  // Seed a version-3 database by hand: the stores and rows a previous release left behind.
  const seeded = await new Promise((resolve, reject) => {
    const request = fakeIndexedDB.open(name, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      const customers = db.createObjectStore('customers', { keyPath: 'Id' });
      customers.createIndex('code', 'Code', { unique: true });
      customers.createIndex('name', 'Name');
      customers.createIndex('phone', 'Phone');
      const transactions = db.createObjectStore('transactions', { keyPath: 'Id' });
      transactions.createIndex('customerId', 'CustomerId');
      transactions.createIndex('date', 'Date');
      transactions.createIndex('transactionType', 'TransactionType');
      transactions.createIndex('status', 'Status');
      transactions.createIndex('linkId', 'LinkId');
      transactions.createIndex('customerId_date', ['CustomerId', 'Date']);
      const opening = db.createObjectStore('openingBalanceHistory', { keyPath: 'Id' });
      opening.createIndex('customerId', 'CustomerId');
      opening.createIndex('changedAt', 'ChangedAt');
      db.createObjectStore('settings', { keyPath: 'Key' });
      db.createObjectStore('metadata', { keyPath: 'Key' });
      const audit = db.createObjectStore('auditLog', { keyPath: 'Id' });
      audit.createIndex('transactionId', 'TransactionId');
      audit.createIndex('occurredAt', 'OccurredAt');
      audit.createIndex('eventType', 'EventType');
      const companies = db.createObjectStore('receivingCompanies', { keyPath: 'Id' });
      companies.createIndex('NormalizedName', 'NormalizedName', { unique: true });
      const cartonTypes = db.createObjectStore('cartonTypes', { keyPath: 'Id' });
      cartonTypes.createIndex('NormalizedName', 'NormalizedName', { unique: true });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['customers', 'transactions'], 'readwrite');
      tx.objectStore('customers').put({
        Id: 'cus-old', Code: 'OLD-1', Name: 'مزارع قديم', Phone: null, IsActive: true,
        OpeningBalanceMinor: 0, CreatedAt: '2026-08-01T00:00:00.000Z', UpdatedAt: '2026-08-01T00:00:00.000Z'
      });
      tx.objectStore('transactions').put({
        Id: 'trx-old-local', CustomerId: 'cus-old', Date: '2026-08-02',
        TransactionType: 'CropPurchaseLocal', Description: 'قديمة', AmountMinor: 390500, Status: 'Active',
        CancellationReason: null, CancelledAt: null,
        CreatedAt: '2026-08-02T00:00:00.000Z', UpdatedAt: '2026-08-02T00:00:00.000Z',
        LocalUnitsMilli: 300000, LocalLooseKgMilli: 5000, LocalDeductionKgMilli: 1000,
        LocalUnitPriceMinor: 100, PackageWeightKg: 14, PackageWeightStatus: 'Confirmed', NetWeightMilli: 3905000
      });
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
  assert.equal(seeded, true);

  // Reopen through the APPLICATION's own opener, so the real onupgradeneeded handler
  // (createSchema + migrateSchema inside one version-change transaction) performs the
  // upgrade — not a hand-written schema in this test.
  configureDatabase({ name, version: DB_VERSION });
  const upgraded = await openDatabase();
  const stores = Array.from(upgraded.objectStoreNames);
  assert.equal(DB_VERSION, 4);
  assert.equal(stores.includes('strawberryVarieties'), true, 'the new store is created');
  for (const existing of ['customers', 'transactions', 'openingBalanceHistory', 'settings', 'metadata', 'auditLog', 'receivingCompanies', 'cartonTypes']) {
    assert.equal(stores.includes(existing), true, `${existing} is preserved`);
  }
  assert.deepEqual([...STORE_NAMES].sort(), stores.slice().sort(), 'no store is missing and none is extra');
  const rows = await new Promise((resolve, reject) => {
    const tx = upgraded.transaction(['transactions'], 'readonly');
    const request = tx.objectStore('transactions').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const legacy = rows.find((item) => item.Id === 'trx-old-local');
  assert.equal(legacy.AmountMinor, 390500, 'the amount is untouched by the upgrade');
  assert.equal(legacy.PackageWeightKg, 14, 'the stored package weight is untouched');
  assert.equal(legacy.StrawberryVarietyId, undefined, 'no variety is back-filled');
  assert.equal(STORE.STRAWBERRY_VARIETIES, 'strawberryVarieties');
  upgraded.close();
});
