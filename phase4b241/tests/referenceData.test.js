// Phase 4B.11 — the two reference catalogues (receiving companies, carton types) and the
// carton-purchase movement that references them.
//
// The business meaning asserted here is the one the phase defines:
//   · the farmer is the EXISTING customer record (CustomerId);
//   · the receiving company is a SEPARATE record (it is not the farmer, not a supplier);
//   · the carton type is a SEPARATE record, not owned by one company;
//   · the quantity dimension of a carton purchase is the CARTON COUNT only — no weight.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, simulateReload, cartonRefs } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { balanceService } from '../src/services/balanceService.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { receivingCompanyService, cartonTypeService } from '../src/services/referenceDataService.js';
import { receivingCompanyRepository } from '../src/repositories/receivingCompanyRepository.js';
import { cartonTypeRepository } from '../src/repositories/cartonTypeRepository.js';
import { transactionFormService, listReferenceOptions, createReceivingCompany, createCartonType } from '../src/services/transactionFormService.js';
import { validateBackup } from '../src/services/restoreService.js';
import { backupService } from '../src/services/backupService.js';
import { TRANSACTION_TYPE, STATUS } from '../src/domain/transactionTypes.js';
import { deriveFinancials } from '../src/domain/financialDirection.js';
import { AppError, ERROR_CODE } from '../src/domain/errors.js';

async function seedFarmer(code = 'F-1') {
  return customerService.createCustomer({ Code: code, Name: `مزارع ${code}` });
}

// Phase 4B.11 FINAL — a carton purchase REQUIRES a receiving company and a carton type.
// The defaults below satisfy that requirement; `extra` is spread last so a test can
// deliberately blank a reference (`{ CartonTypeId: '' }`) to prove it is refused.
let DEFAULT_REFS = null;
// Every test starts from a fresh database, so a cached pair of ids becomes dangling as
// soon as the next test wipes the store. The pair is therefore re-created whenever the
// stored records are gone; the ids always point at rows that really exist.
async function ensureRefs() {
  if (DEFAULT_REFS) {
    const company = await receivingCompanyService.get(DEFAULT_REFS.ReceivingCompanyId);
    const type = await cartonTypeService.get(DEFAULT_REFS.CartonTypeId);
    if (company && type) return DEFAULT_REFS;
  }
  DEFAULT_REFS = await cartonRefs();
  return DEFAULT_REFS;
}
export async function cartonDraft(customerId, extra = {}) {
  const refs = await ensureRefs();
  return {
    CustomerId: customerId,
    Date: '2026-10-10',
    TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON,
    ...refs,
    crop: { CartonQuantityMilli: 10000, CartonDiscountMinor: 0, CartonUnitPriceMinor: 500 },
    ...extra
  };
}

// ---------------------------------------------------------------------------
// A — receiving companies
// ---------------------------------------------------------------------------

test('A1. A receiving company is stored with a stable id, a name, an active flag and audit fields', async () => {
  await freshDatabase('ref_company_create');
  const created = await receivingCompanyService.create('  شركة  الوادي  ');
  assert.match(created.Id, /^rcv_/);
  assert.equal(created.Name, 'شركة الوادي', 'inner whitespace collapses and the edges are trimmed');
  assert.equal(created.NormalizedName, 'شركة الوادي');
  assert.equal(created.IsActive, true);
  assert.equal(typeof created.CreatedAt, 'string');
  assert.equal(created.CreatedAt, created.UpdatedAt);
  assert.equal((await receivingCompanyRepository.count()), 1);
});

test('A2. An empty or whitespace-only company name is refused, and nothing is written', async () => {
  await freshDatabase('ref_company_empty');
  for (const bad of ['', '   ', null, undefined]) {
    await assert.rejects(
      () => receivingCompanyService.create(bad),
      (error) => error instanceof AppError && error.code === ERROR_CODE.VALIDATION_ERROR && error.field === 'Name'
    );
  }
  assert.equal(await receivingCompanyRepository.count(), 0);
});

test('A3. A duplicate name is refused after normalisation (case and extra spaces ignored)', async () => {
  await freshDatabase('ref_company_dup');
  await receivingCompanyService.create('Al-Wadi Company');
  await assert.rejects(() => receivingCompanyService.create('  al-wadi   company '), (error) => error instanceof AppError && error.code === ERROR_CODE.CONFLICT);
  await receivingCompanyService.create('شركة النيل');
  await assert.rejects(() => receivingCompanyService.create('شركة  النيل'), (error) => error.code === ERROR_CODE.CONFLICT);
  assert.equal(await receivingCompanyRepository.count(), 2, 'a refused duplicate creates no record');
});

test('A4. Renaming keeps the identity; the id and CreatedAt never change', async () => {
  await freshDatabase('ref_company_rename');
  const created = await receivingCompanyService.create('الشركة القديمة');
  const renamed = await receivingCompanyService.rename(created.Id, 'الشركة الجديدة');
  assert.equal(renamed.Id, created.Id);
  assert.equal(renamed.CreatedAt, created.CreatedAt);
  assert.equal(renamed.Name, 'الشركة الجديدة');
  assert.equal(renamed.NormalizedName, 'الشركة الجديدة');
  assert.notEqual(renamed.UpdatedAt, undefined);
  assert.equal((await receivingCompanyService.get(created.Id)).Name, 'الشركة الجديدة');
});

test('A5. Deactivation replaces deletion and keeps the record readable', async () => {
  await freshDatabase('ref_company_deactivate');
  const created = await receivingCompanyService.create('شركة مؤقتة');
  const off = await receivingCompanyService.deactivate(created.Id);
  assert.equal(off.Id, created.Id);
  assert.equal(off.IsActive, false);
  assert.equal((await receivingCompanyRepository.count()), 1, 'deactivation never deletes');
  assert.equal((await receivingCompanyService.list()).length, 1, 'it stays listed');
  assert.equal((await receivingCompanyService.listActive()).length, 0, 'it leaves the active list');
  // A record that does not exist is a NOT_FOUND, not a silent success.
  await assert.rejects(() => receivingCompanyService.deactivate('rcv_missing'), (error) => error.code === ERROR_CODE.NOT_FOUND);
});

test('A6. Adding, renaming or deactivating a company creates no movement and moves no balance', async () => {
  await freshDatabase('ref_company_no_finance');
  const farmer = await seedFarmer();
  const before = await balanceService.getCustomerSummary(farmer.Id);
  const created = await receivingCompanyService.create('شركة بلا أثر مالي');
  await receivingCompanyService.rename(created.Id, 'شركة بلا أثر مالي ٢');
  await receivingCompanyService.deactivate(created.Id);
  assert.equal(await transactionRepository.count(), 0, 'no transaction row was created');
  const after = await balanceService.getCustomerSummary(farmer.Id);
  assert.deepEqual(after, before, 'the balance, the cash totals and the non-cash total are unchanged');
});

// ---------------------------------------------------------------------------
// B — carton types
// ---------------------------------------------------------------------------

test('B1. A carton type is stored with its own identity and an active flag', async () => {
  await freshDatabase('ref_type_create');
  const created = await cartonTypeService.create('كرتونة 5 كجم');
  assert.match(created.Id, /^ctn_/);
  assert.equal(created.Name, 'كرتونة 5 كجم');
  assert.equal(created.IsActive, true);
  assert.equal(await cartonTypeRepository.count(), 1);
});

test('B2. An empty carton-type name is refused and a duplicate is refused', async () => {
  await freshDatabase('ref_type_rules');
  await assert.rejects(() => cartonTypeService.create('  '), (error) => error.code === ERROR_CODE.VALIDATION_ERROR);
  await cartonTypeService.create('كرتونة كبيرة');
  await assert.rejects(() => cartonTypeService.create('كرتونة  كبيرة'), (error) => error.code === ERROR_CODE.CONFLICT);
  assert.equal(await cartonTypeRepository.count(), 1);
});

test('B3. Renaming and deactivating a carton type keep its id and its record', async () => {
  await freshDatabase('ref_type_rename');
  const created = await cartonTypeService.create('نوع أ');
  const renamed = await cartonTypeService.rename(created.Id, 'نوع ب');
  assert.equal(renamed.Id, created.Id);
  assert.equal(renamed.Name, 'نوع ب');
  const off = await cartonTypeService.deactivate(created.Id);
  assert.equal(off.IsActive, false);
  assert.equal(await cartonTypeRepository.count(), 1);
});

test('B4. The two catalogues are independent: a carton type is never owned by one company', async () => {
  await freshDatabase('ref_independence');
  const companyA = await receivingCompanyService.create('شركة أ');
  const companyB = await receivingCompanyService.create('شركة ب');
  const type = await cartonTypeService.create('كرتونة مشتركة');
  const farmer = await seedFarmer();
  // The SAME carton type is used with two different receiving companies.
  const rowA = await transactionService.createTransaction(await cartonDraft(farmer.Id, { ReceivingCompanyId: companyA.Id, CartonTypeId: type.Id }));
  const rowB = await transactionService.createTransaction(await cartonDraft(farmer.Id, { ReceivingCompanyId: companyB.Id, CartonTypeId: type.Id }));
  assert.equal(rowA.CartonTypeId, type.Id);
  assert.equal(rowB.CartonTypeId, type.Id);
  assert.notEqual(rowA.ReceivingCompanyId, rowB.ReceivingCompanyId);
  assert.equal(Object.prototype.hasOwnProperty.call(type, 'ReceivingCompanyId'), false, 'the type carries no owner');

  // Deactivating the type does not damage either historical row.
  await cartonTypeService.deactivate(type.Id);
  assert.equal((await transactionRepository.getById(rowA.Id)).CartonTypeId, type.Id);
  assert.equal((await transactionRepository.getById(rowB.Id)).CartonTypeId, type.Id);
});

// ---------------------------------------------------------------------------
// C — the carton-purchase movement
// ---------------------------------------------------------------------------

test('C1. A carton purchase stores the farmer, the receiving company, the carton type and the carton count', async () => {
  await freshDatabase('ref_carton_save');
  const farmer = await seedFarmer('F-77');
  const company = await receivingCompanyService.create('شركة الاستلام');
  const type = await cartonTypeService.create('كرتونة 10 كجم');
  const row = await transactionService.createTransaction(await cartonDraft(farmer.Id, {
    ReceivingCompanyId: company.Id, CartonTypeId: type.Id
  }));
  assert.equal(row.CustomerId, farmer.Id, 'the farmer is the existing customer record');
  assert.equal(row.ReceivingCompanyId, company.Id);
  assert.equal(row.CartonTypeId, type.Id);
  assert.equal(row.CartonQuantityMilli, 10000, 'the carton count stays the quantity dimension');
  assert.equal(row.AmountMinor, 5000, '(K - M) x L = 10 x 5.00');
  // The type carries NO weight: no local-crop field and no weight field is written.
  for (const absent of ['LocalUnitsMilli', 'LocalLooseKgMilli', 'LocalDeductionKgMilli', 'LocalUnitPriceMinor']) {
    assert.equal(row[absent] ?? null, null, `${absent} must stay empty on a carton purchase`);
  }
  assert.equal(row.PackageWeightKg ?? null, null, 'a carton purchase never stores a package weight');
  assert.equal(row.NetWeightMilli ?? null, null, 'a carton purchase never stores a net weight');
});

test('C2. The carton amount and its debit/credit effect are unchanged by the reference ids', async () => {
  await freshDatabase('ref_carton_finance');
  const farmer = await seedFarmer();
  const company = await receivingCompanyService.create('شركة');
  const type = await cartonTypeService.create('نوع');
  const first = await transactionService.createTransaction(await cartonDraft(farmer.Id, { ReceivingCompanyId: company.Id, CartonTypeId: type.Id }));
  const second = await transactionService.createTransaction(await cartonDraft(farmer.Id, { ReceivingCompanyId: company.Id, CartonTypeId: type.Id }));
  assert.equal(second.AmountMinor, first.AmountMinor);
  // The debit / credit / cash figures are DERIVED by the approved engine, never stored.
  const f = deriveFinancials(second);
  const g = deriveFinancials(first);
  assert.deepEqual(
    { Credit: f.CreditMinor, Debit: f.DebitMinor, CashIn: f.CashReceivedMinor, CashOut: f.CashPaidMinor, Settlement: f.SettlementMinor },
    { Credit: g.CreditMinor, Debit: g.DebitMinor, CashIn: g.CashReceivedMinor, CashOut: g.CashPaidMinor, Settlement: g.SettlementMinor },
    'the reference ids change no financial figure of the movement'
  );
  assert.equal(f.CashReceivedMinor, 0, 'a carton purchase has no cash effect');
  assert.equal(f.CashPaidMinor, 0);
  const summary = await balanceService.getCustomerSummary(farmer.Id);
  assert.equal(summary.CashReceivedMinor, 0, 'no cash enters because of a reference record');
  assert.equal(summary.CashPaidMinor, 0);
  assert.equal(summary.BalanceMinor, first.AmountMinor * 2, 'both rows credit the farmer by their own amount');
});

test('C3. A reference id that does not exist is refused and nothing is written', async () => {
  await freshDatabase('ref_carton_missing');
  const farmer = await seedFarmer();
  await assert.rejects(
    async () => transactionService.createTransaction(await cartonDraft(farmer.Id, { ReceivingCompanyId: 'rcv_nope' })),
    (error) => error instanceof AppError && error.code === ERROR_CODE.NOT_FOUND && error.field === 'ReceivingCompanyId'
  );
  await assert.rejects(
    async () => transactionService.createTransaction(await cartonDraft(farmer.Id, { CartonTypeId: 'ctn_nope' })),
    (error) => error.code === ERROR_CODE.NOT_FOUND && error.field === 'CartonTypeId'
  );
  assert.equal(await transactionRepository.count(), 0, 'a refused reference leaves no row behind');
});

test('C4. An INACTIVE reference cannot enter a new movement, but it stays readable on old ones', async () => {
  await freshDatabase('ref_carton_inactive');
  const farmer = await seedFarmer();
  const company = await receivingCompanyService.create('شركة ستُعطَّل');
  const type = await cartonTypeService.create('نوع سيُعطَّل');
  const historical = await transactionService.createTransaction(await cartonDraft(farmer.Id, { ReceivingCompanyId: company.Id, CartonTypeId: type.Id }));
  await receivingCompanyService.deactivate(company.Id);
  await cartonTypeService.deactivate(type.Id);

  await assert.rejects(
    async () => transactionService.createTransaction(await cartonDraft(farmer.Id, { ReceivingCompanyId: company.Id })),
    (error) => error.code === ERROR_CODE.BUSINESS_RULE_ERROR && error.field === 'ReceivingCompanyId'
  );
  await assert.rejects(
    async () => transactionService.createTransaction(await cartonDraft(farmer.Id, { CartonTypeId: type.Id })),
    (error) => error.code === ERROR_CODE.BUSINESS_RULE_ERROR && error.field === 'CartonTypeId'
  );
  assert.equal(await transactionRepository.count(), 1, 'the refused attempts added nothing');

  // The historical row still resolves BOTH names, even though both records are inactive.
  const ledger = await balanceService.getRunningBalance(farmer.Id);
  const entry = ledger.Entries.find((row) => row.Id === historical.Id);
  assert.equal(entry.ReceivingCompanyName, 'شركة ستُعطَّل');
  assert.equal(entry.CartonTypeName, 'نوع سيُعطَّل');
  assert.equal(entry.ReceivingCompanyActive, false);
  assert.equal(entry.CartonTypeActive, false);
});

test('C5. A carton row recorded before this phase (no reference ids) still opens and reads as "unspecified"', async () => {
  await freshDatabase('ref_carton_legacy');
  const farmer = await seedFarmer();
  // A row with the pre-4B.11 shape: no ReceivingCompanyId and no CartonTypeId at all.
  const legacy = {
    Id: 'trx_legacy_carton', CustomerId: farmer.Id, Date: '2026-09-01',
    TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON, Description: 'قديمة',
    AmountMinor: 5000, Status: STATUS.ACTIVE, CancellationReason: null, CancelledAt: null,
    CreatedAt: '2026-09-01T00:00:00.000Z', UpdatedAt: '2026-09-01T00:00:00.000Z',
    CartonQuantityMilli: 10000, CartonUnitPriceMinor: 500, CartonDiscountMinor: 0
  };
  await transactionRepository.put(legacy);
  const ledger = await balanceService.getRunningBalance(farmer.Id);
  const entry = ledger.Entries.find((row) => row.Id === legacy.Id);
  assert.equal(entry.ReceivingCompanyId, null);
  assert.equal(entry.ReceivingCompanyName, null, 'a missing reference is never invented');
  assert.equal(entry.CartonTypeId, null);
  assert.equal(entry.AmountMinor === undefined ? 5000 : entry.AmountMinor, 5000);
  assert.equal(ledger.BalanceMinor, 5000);
  // An ordinary read of the row does not throw and does not rewrite it.
  const stored = await transactionRepository.getById(legacy.Id);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'ReceivingCompanyId'), false);
});

test('C6. The carton screen offers both dropdowns plus an "add new" action, and creating one selects it', async () => {
  await freshDatabase('ref_carton_screen');
  const farmer = await seedFarmer();
  const options = await listReferenceOptions();
  assert.deepEqual(options.ReceivingCompanies, []);
  assert.deepEqual(options.CartonTypes, []);

  const company = await createReceivingCompany('شركة من الشاشة');
  const type = await createCartonType('نوع من الشاشة');
  const after = await listReferenceOptions();
  assert.equal(after.ReceivingCompanies.length, 1);
  assert.equal(after.ReceivingCompanies[0].Id, company.Id);
  assert.equal(after.CartonTypes[0].Id, type.Id);

  const html = (await import('../ui/views/transactionForm.js')).renderDynamicFields({
    transactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON,
    values: { ...(await import('../src/services/transactionFormService.js')).emptyForm({ transactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON }) },
    referenceOptions: after
  });
  assert.match(html, /id="field-ReceivingCompanyId"/);
  assert.match(html, /id="field-CartonTypeId"/);
  assert.match(html, /data-action="add-receiving-company"/);
  assert.match(html, /data-action="add-carton-type"/);
  assert.match(html, /شركة من الشاشة/);
  assert.match(html, /نوع من الشاشة/);
  assert.equal(html.includes('field-Amount'), false, 'a carton purchase never renders an amount field');
});

test('C7. The screen never offers an inactive record for a NEW choice, but keeps a stored one visible', async () => {
  await freshDatabase('ref_carton_screen_inactive');
  const on = await receivingCompanyService.create('نشطة');
  const off = await receivingCompanyService.create('غير نشطة');
  await receivingCompanyService.deactivate(off.Id);
  const { renderDynamicFields, referenceOptionsFor } = await import('../ui/views/transactionForm.js');
  const options = await listReferenceOptions();
  const values = { ...(await import('../src/services/transactionFormService.js')).emptyForm({ transactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON }) };
  const fresh = referenceOptionsFor('ReceivingCompany', { referenceOptions: options, selected: '' });
  assert.equal(fresh.some((option) => option.value === off.Id), false, 'the inactive record is not offered');
  assert.equal(fresh.some((option) => option.value === on.Id), true);
  // But a movement that already carries it still shows it (marked), never silently drops it.
  const kept = referenceOptionsFor('ReceivingCompany', { referenceOptions: options, selected: off.Id });
  assert.equal(kept.some((option) => option.value === off.Id), true);
  const html = renderDynamicFields({ transactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON, values, referenceOptions: options });
  assert.equal(html.includes(`value="${off.Id}"`), false);
});

test('C8. Submitting the carton form through the services layer stores both ids', async () => {
  await freshDatabase('ref_carton_submit');
  const farmer = await seedFarmer();
  const company = await receivingCompanyService.create('شركة النموذج');
  const type = await cartonTypeService.create('نوع النموذج');
  const { emptyForm, FORM_KEY } = await import('../src/services/transactionFormService.js');
  const form = {
    ...emptyForm({ transactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON, date: '2026-10-12' }),
    [FORM_KEY.CUSTOMER]: farmer.Id,
    [FORM_KEY.RECEIVING_COMPANY]: company.Id,
    [FORM_KEY.CARTON_TYPE]: type.Id,
    [FORM_KEY.CARTON_QUANTITY]: '4',
    [FORM_KEY.CARTON_DISCOUNT]: '0',
    [FORM_KEY.CARTON_PRICE]: '7.5'
  };
  const result = await transactionFormService.submitTransactionForm(form);
  assert.equal(result.Record.ReceivingCompanyId, company.Id);
  assert.equal(result.Record.CartonTypeId, type.Id);
  assert.equal(result.Record.AmountMinor, 3000, '4 x 7.50');
  assert.equal(result.Record.PackageWeightKg ?? null, null);
});

test('C9. A carton purchase with an invalid reference is refused through the form as well', async () => {
  await freshDatabase('ref_carton_submit_bad');
  const farmer = await seedFarmer();
  const { emptyForm, FORM_KEY } = await import('../src/services/transactionFormService.js');
  const type = await cartonTypeService.create('نوع للاختبار');
  const form = {
    ...emptyForm({ transactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON, date: '2026-10-12' }),
    [FORM_KEY.CUSTOMER]: farmer.Id,
    [FORM_KEY.RECEIVING_COMPANY]: 'rcv_ghost',
    [FORM_KEY.CARTON_TYPE]: type.Id,
    [FORM_KEY.CARTON_QUANTITY]: '4',
    [FORM_KEY.CARTON_PRICE]: '7.5'
  };
  await assert.rejects(() => transactionFormService.submitTransactionForm(form), (error) => error.code === ERROR_CODE.NOT_FOUND);
  assert.equal(await transactionRepository.count(), 0);
});

// ---------------------------------------------------------------------------
// D — the reference sections of a backup file
// ---------------------------------------------------------------------------

test('D1. A backup carries both catalogues and the reference ids of the movements', async () => {
  await freshDatabase('ref_backup');
  const farmer = await seedFarmer();
  const company = await receivingCompanyService.create('شركة النسخة');
  const type = await cartonTypeService.create('نوع النسخة');
  await transactionService.createTransaction(await cartonDraft(farmer.Id, { ReceivingCompanyId: company.Id, CartonTypeId: type.Id }));
  const backup = await backupService.createBackup();
  // Phase 4B.11 FINAL: the row must reference records that are present in the same file.
  assert.equal(backup.ReceivingCompanies.some((row) => row.Id === company.Id), true);
  assert.equal(backup.CartonTypes.some((row) => row.Id === type.Id), true);
  const cartonRows = backup.Transactions.filter((row) => row.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_CARTON);
  assert.equal(cartonRows.length, 1);
  for (const row of cartonRows) {
    assert.equal(backup.ReceivingCompanies.some((entry) => entry.Id === row.ReceivingCompanyId), true, 'the file carries the company it references');
    assert.equal(backup.CartonTypes.some((entry) => entry.Id === row.CartonTypeId), true, 'the file carries the type it references');
  }
  assert.equal(backup.Transactions[0].ReceivingCompanyId, cartonRows[0].ReceivingCompanyId);
  assert.equal(validateBackup(backup).ok, true);
});

test('D2. A dangling reference inside a backup file is refused before any write', async () => {
  await freshDatabase('ref_backup_bad');
  const farmer = await seedFarmer();
  const company = await receivingCompanyService.create('شركة');
  await transactionService.createTransaction(await cartonDraft(farmer.Id, { ReceivingCompanyId: company.Id }));
  const backup = await backupService.createBackup();
  backup.Transactions[0].ReceivingCompanyId = 'rcv_not_in_file';
  const result = validateBackup(backup);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.field === 'Transactions.ReceivingCompanyId'), true);
});

test('D3. A duplicate reference name inside a backup file is refused', async () => {
  await freshDatabase('ref_backup_dup');
  await receivingCompanyService.create('اسم مكرر');
  const backup = await backupService.createBackup();
  backup.ReceivingCompanies.push({ ...backup.ReceivingCompanies[0], Id: 'rcv_other', Name: '  اسم   مكرر ' });
  const result = validateBackup(backup);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.field === 'ReceivingCompanies.Name'), true);
});

test('D4. A backup written before this phase (no reference sections) is still valid', async () => {
  await freshDatabase('ref_backup_old');
  const farmer = await seedFarmer();
  await transactionService.createTransaction(await cartonDraft(farmer.Id));
  const backup = await backupService.createBackup();
  delete backup.ReceivingCompanies;
  delete backup.CartonTypes;
  for (const row of backup.Transactions) {
    delete row.ReceivingCompanyId;
    delete row.CartonTypeId;
  }
  assert.equal(validateBackup(backup).ok, true, 'an older file must still validate');
});

test('D5. The reload keeps both catalogues and the movement references intact', async () => {
  await freshDatabase('ref_reload');
  const farmer = await seedFarmer();
  const company = await receivingCompanyService.create('شركة البقاء');
  const type = await cartonTypeService.create('نوع البقاء');
  const row = await transactionService.createTransaction(await cartonDraft(farmer.Id, { ReceivingCompanyId: company.Id, CartonTypeId: type.Id }));
  await simulateReload();
  assert.equal((await receivingCompanyService.get(company.Id)).Name, 'شركة البقاء');
  assert.equal((await cartonTypeService.get(type.Id)).Name, 'نوع البقاء');
  const stored = await transactionRepository.getById(row.Id);
  assert.equal(stored.ReceivingCompanyId, company.Id);
  assert.equal(stored.CartonTypeId, type.Id);
  assert.equal(stored.AmountMinor, 5000);
});
