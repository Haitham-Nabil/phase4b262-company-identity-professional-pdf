// Phase 4B.11 — focused fix: the carton EDIT form must show the references stored on the
// row, and the carton STATEMENT line must show the stored carton count next to them.
//
// Group A — the edit form (open / save without change / change one / change both /
//           inactive reference / missing reference / no duplicate row).
// Group B — the statement line (company, type, count, unit, no weight, missing state).
// Group C — the balance is untouched by an unchanged save, and the rest of the suite
//           still passes (run by `npm test`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, simulateReload, cartonRefs } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { transactionLifecycleService } from '../src/services/transactionLifecycleService.js';
import { balanceService } from '../src/services/balanceService.js';
import { receivingCompanyService, cartonTypeService } from '../src/services/referenceDataService.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import * as form from '../src/services/transactionFormService.js';
import { renderEditDialog, renderEditFields, EDIT_FORM_ID } from '../ui/views/transactionActions.js';
import { ledgerReferenceNote } from '../ui/views/customerAccount.js';
import { cartonReferenceParts, cartonCountLabel, referencePartsFor } from '../src/services/movementNotes.js';

const CARTON = 'CropPurchaseCarton';

async function seedFarmer(code = 'F-1') {
  return customerService.createCustomer({ Code: code, Name: `مزارع ${code}` });
}

async function seedCarton(farmerId, refs, { quantity = 250, price = 5, discount = 0, date = '2026-10-01' } = {}) {
  return transactionService.createTransaction({
    CustomerId: farmerId,
    Date: date,
    TransactionType: CARTON,
    ReceivingCompanyId: refs.ReceivingCompanyId,
    CartonTypeId: refs.CartonTypeId,
    crop: {
      CartonQuantityMilli: quantity * 1000,
      CartonDiscountMinor: discount,
      CartonUnitPriceMinor: price * 100
    }
  });
}

// Exactly the shape the screen sends: every field of the dialog, keyed by the approved
// form keys (the carton quantity is a plain major-unit string).
function editValues(record, overrides = {}) {
  return {
    Date: record.Date,
    Description: record.Description ?? '',
    Amount: '',
    Direction: '',
    Units: '',
    LooseKg: '',
    DeductionKg: '',
    UnitPrice: '',
    CartonQuantity: String(record.CartonQuantityMilli / 1000),
    CartonDiscount: String(record.CartonDiscountMinor / 100),
    CartonPrice: String(record.CartonUnitPriceMinor / 100),
    ReceivingCompanyId: record.ReceivingCompanyId ?? '',
    CartonTypeId: record.CartonTypeId ?? '',
    EditReason: 'تعديل تجريبي',
    ...overrides
  };
}

const openOptions = () => form.listReferenceOptions();

// ---------------------------------------------------------------------------
// Group A — the edit form shows and preserves the stored references
// ---------------------------------------------------------------------------

test('A1. opening a carton movement shows the stored company and carton type as the current selection', async () => {
  await freshDatabase('fix_a1');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs);

  const options = await openOptions();
  const html = renderEditDialog({ record, referenceOptions: options });

  assert.match(html, new RegExp(`value="${refs.ReceivingCompanyId}" selected`), 'the stored receiving company is the selected option');
  assert.match(html, new RegExp(`value="${refs.CartonTypeId}" selected`), 'the stored carton type is the selected option');
  assert.match(html, /id="field-ReceivingCompanyId"/);
  assert.match(html, /id="field-CartonTypeId"/);
  assert.match(html, new RegExp(EDIT_FORM_ID));
});

test('A2. the same dialog shows the stored carton count, not an empty or recomputed value', async () => {
  await freshDatabase('fix_a2');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs, { quantity: 250 });

  const html = renderEditFields({ record, referenceOptions: await openOptions() });

  assert.match(html, /id="field-CartonQuantity"[^>]*value="250"/);
  assert.equal(record.CartonQuantityMilli, 250000, 'the count is stored as the quantity dimension');
});

test('A3. saving without changing anything keeps both references, the count and the Id', async () => {
  await freshDatabase('fix_a3');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs);

  const before = await transactionRepository.listByCustomer(farmer.Id);
  const result = await transactionLifecycleService.editTransaction(record.Id, editValues(record));
  const after = await transactionRepository.listByCustomer(farmer.Id);

  assert.equal(result.Record.Id, record.Id, 'the original Id is kept');
  assert.equal(result.Record.ReceivingCompanyId, refs.ReceivingCompanyId);
  assert.equal(result.Record.CartonTypeId, refs.CartonTypeId);
  assert.equal(result.Record.CartonQuantityMilli, record.CartonQuantityMilli);
  assert.equal(after.length, before.length, 'no second row is created');
});

test('A4. editing another field keeps the two original references', async () => {
  await freshDatabase('fix_a4');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs);

  const result = await transactionLifecycleService.editTransaction(record.Id, editValues(record, {
    Description: 'بيان معدّل',
    CartonQuantity: '300'
  }));

  assert.equal(result.Record.Description, 'بيان معدّل');
  assert.equal(result.Record.CartonQuantityMilli, 300000);
  assert.equal(result.Record.ReceivingCompanyId, refs.ReceivingCompanyId);
  assert.equal(result.Record.CartonTypeId, refs.CartonTypeId);
});

test('A5. changing only the company keeps the original carton type', async () => {
  await freshDatabase('fix_a5');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs);
  const other = await receivingCompanyService.create('شركة بديلة');

  const result = await transactionLifecycleService.editTransaction(record.Id, editValues(record, {
    ReceivingCompanyId: other.Id
  }));

  assert.equal(result.Record.ReceivingCompanyId, other.Id);
  assert.equal(result.Record.CartonTypeId, refs.CartonTypeId, 'the carton type was not touched');
});

test('A6. changing only the carton type keeps the original company', async () => {
  await freshDatabase('fix_a6');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs);
  const otherType = await cartonTypeService.create('نوع بديل');

  const result = await transactionLifecycleService.editTransaction(record.Id, editValues(record, {
    CartonTypeId: otherType.Id
  }));

  assert.equal(result.Record.CartonTypeId, otherType.Id);
  assert.equal(result.Record.ReceivingCompanyId, refs.ReceivingCompanyId, 'the company was not touched');
});

test('A7. changing both saves both new ids, and only the new ids', async () => {
  await freshDatabase('fix_a7');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs);
  const newCompany = await receivingCompanyService.create('شركة ثانية');
  const newType = await cartonTypeService.create('نوع ثانٍ');

  const result = await transactionLifecycleService.editTransaction(record.Id, editValues(record, {
    ReceivingCompanyId: newCompany.Id,
    CartonTypeId: newType.Id
  }));

  assert.equal(result.Record.ReceivingCompanyId, newCompany.Id);
  assert.equal(result.Record.CartonTypeId, newType.Id);
  assert.equal((await transactionRepository.listByCustomer(farmer.Id)).length, 1, 'still exactly one row');
});

test('A8. reopening after every save shows the freshly stored selections, also after a reload', async () => {
  await freshDatabase('fix_a8');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs);
  const newCompany = await receivingCompanyService.create('شركة معاد فتحها');

  await transactionLifecycleService.editTransaction(record.Id, editValues(record, { ReceivingCompanyId: newCompany.Id }));
  await simulateReload();

  const reopened = await transactionLifecycleService.getEditableTransaction(record.Id);
  assert.equal(reopened.Record.ReceivingCompanyId, newCompany.Id);
  assert.equal(reopened.Record.CartonTypeId, refs.CartonTypeId);

  const html = renderEditDialog({ record: reopened.Record, referenceOptions: await openOptions() });
  assert.match(html, new RegExp(`value="${newCompany.Id}" selected`));
  assert.match(html, new RegExp(`value="${refs.CartonTypeId}" selected`));
});

test('A9. a row whose company was deactivated keeps it visible and keeps it on an unrelated edit', async () => {
  await freshDatabase('fix_a9');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs);
  const company = await receivingCompanyService.get(refs.ReceivingCompanyId);
  await receivingCompanyService.setActive(company.Id, false);

  const options = await openOptions();
  const html = renderEditDialog({ record, referenceOptions: options });
  assert.match(html, new RegExp(`value="${company.Id}" selected`), 'the historical reference stays selected');
  assert.match(html, new RegExp(`${company.Name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(غير نشطة\\)`), 'its inactive state is stated');

  const result = await transactionLifecycleService.editTransaction(record.Id, editValues(record, { Description: 'تعديل آخر' }));
  assert.equal(result.Record.ReceivingCompanyId, company.Id, 'an inactive historical reference is preserved');
});

test('A10. a reference that truly does not exist is reported, never invented or silently replaced', async () => {
  await freshDatabase('fix_a10');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs);
  // A row pointing at an id that is not in either catalogue (data left by an old build).
  await transactionRepository.put({
    ...record,
    Id: 'trx_ghost_carton',
    ReceivingCompanyId: 'rcv_does_not_exist',
    CartonTypeId: 'ctn_does_not_exist'
  });

  const ghost = await transactionLifecycleService.getEditableTransaction('trx_ghost_carton');
  const html = renderEditDialog({ record: ghost.Record, referenceOptions: await openOptions() });

  assert.match(html, /value="rcv_does_not_exist" selected/);
  assert.match(html, /سجل غير متاح/);
  assert.doesNotMatch(html, /value="rcv_does_not_exist" selected>[^<]*غير محدد/, 'no invented name is attached');

  // Keeping it (the only honest choice) does not fabricate a reference.
  const result = await transactionLifecycleService.editTransaction('trx_ghost_carton', editValues(ghost.Record, { Description: 'لا تغيير' }));
  assert.equal(result.Record.ReceivingCompanyId, 'rcv_does_not_exist');
});

test('A11. repointing to a record that does not exist is refused and nothing is written', async () => {
  await freshDatabase('fix_a11');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs);

  await assert.rejects(
    () => transactionLifecycleService.editTransaction(record.Id, editValues(record, { ReceivingCompanyId: 'rcv_ghost' })),
    (error) => error.code === 'NOT_FOUND'
  );
  const stored = await transactionRepository.getById(record.Id);
  assert.equal(stored.ReceivingCompanyId, refs.ReceivingCompanyId, 'the stored row is untouched');
});

// ---------------------------------------------------------------------------
// Group B — the statement line: company, type and the stored carton count
// ---------------------------------------------------------------------------

test('B1/B2/B3. the statement line states the company, the type and the stored count with its unit', async () => {
  await freshDatabase('fix_b1');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs, { quantity: 250 });
  const company = await receivingCompanyService.get(refs.ReceivingCompanyId);
  const type = await cartonTypeService.get(refs.CartonTypeId);

  const ledger = await balanceService.getRunningBalance(farmer.Id);
  const entry = ledger.Entries.find((row) => row.Id === record.Id);

  assert.equal(entry.ReceivingCompanyName, company.Name);
  assert.equal(entry.CartonTypeName, type.Name);
  assert.equal(entry.CartonQuantityMilli, 250000, 'the count is exposed by the ledger service');

  const note = ledgerReferenceNote(entry);
  assert.match(note, new RegExp(`الشركة المستلمة: ${company.Name}`));
  assert.match(note, new RegExp(`نوع الكرتونة: ${type.Name}`));
  assert.match(note, /العدد: 250 كرتونة/);
  assert.doesNotMatch(note, /غير محدد/, 'a stored reference is never reported as unspecified');
});

test('B4. changing the count is reflected in the statement after saving', async () => {
  await freshDatabase('fix_b4');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs, { quantity: 250 });

  await transactionLifecycleService.editTransaction(record.Id, editValues(record, { CartonQuantity: '7' }));
  const ledger = await balanceService.getRunningBalance(farmer.Id);
  const note = ledgerReferenceNote(ledger.Entries.find((row) => row.Id === record.Id));

  assert.match(note, /العدد: 7 كراتين/);
});

test('B5. changing a reference is reflected in the statement after saving', async () => {
  await freshDatabase('fix_b5');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs);
  const newType = await cartonTypeService.create('كرتونة فراولة فريش');

  await transactionLifecycleService.editTransaction(record.Id, editValues(record, { CartonTypeId: newType.Id }));
  const ledger = await balanceService.getRunningBalance(farmer.Id);
  const note = ledgerReferenceNote(ledger.Entries.find((row) => row.Id === record.Id));

  assert.match(note, new RegExp(`نوع الكرتونة: ${newType.Name}`));
  assert.equal((await balanceService.getRunningBalance(farmer.Id)).Entries.length, 1);
});

test('B6. an inactive historical reference is still printed, with its state', async () => {
  await freshDatabase('fix_b6');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs);
  const company = await receivingCompanyService.get(refs.ReceivingCompanyId);
  await receivingCompanyService.setActive(company.Id, false);

  const ledger = await balanceService.getRunningBalance(farmer.Id);
  const note = ledgerReferenceNote(ledger.Entries.find((row) => row.Id === record.Id));

  assert.match(note, new RegExp(`${company.Name} \\(غير نشطة\\)`));
});

test('B7. a row with no reference at all says «غير محدد»; an unresolvable one says «سجل غير متاح»', async () => {
  await freshDatabase('fix_b7');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs);

  const noRefs = { ...record, Id: 'trx_no_refs', ReceivingCompanyId: undefined, CartonTypeId: undefined };
  delete noRefs.ReceivingCompanyId;
  delete noRefs.CartonTypeId;
  await transactionRepository.put(noRefs);
  await transactionRepository.put({ ...record, Id: 'trx_ghost_refs', ReceivingCompanyId: 'rcv_ghost', CartonTypeId: 'ctn_ghost' });

  const ledger = await balanceService.getRunningBalance(farmer.Id);
  const plain = ledgerReferenceNote(ledger.Entries.find((row) => row.Id === 'trx_no_refs'));
  const ghost = ledgerReferenceNote(ledger.Entries.find((row) => row.Id === 'trx_ghost_refs'));

  assert.match(plain, /الشركة المستلمة: غير محدد/);
  assert.match(plain, /نوع الكرتونة: غير محدد/);
  assert.match(ghost, /الشركة المستلمة: سجل غير متاح/);
  assert.match(ghost, /نوع الكرتونة: سجل غير متاح/);
});

test('B8. the carton line never mentions a product weight or a package weight', async () => {
  await freshDatabase('fix_b8');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs);

  const ledger = await balanceService.getRunningBalance(farmer.Id);
  const entry = ledger.Entries.find((row) => row.Id === record.Id);
  const note = ledgerReferenceNote(entry);

  assert.doesNotMatch(note, /الوزن|كجم|وزن العبوة/);
  assert.equal(entry.PackageWeightKg, null, 'a carton movement stores no package weight');
  assert.equal(record.NetWeightMilli, null, 'and no net weight');
});

test('B9. an old carton row without a stored count reports an explicit state instead of zero', async () => {
  const parts = cartonReferenceParts({
    TransactionType: CARTON,
    ReceivingCompanyName: 'الكابتن',
    CartonTypeName: 'كرتونة فراولة فريش',
    CartonQuantityMilli: null
  });

  assert.equal(parts[2], 'عدد الكراتين غير محدد');
  assert.equal(cartonCountLabel(null), null);
  assert.equal(cartonCountLabel(1000), 'كرتونة واحدة');
  assert.equal(cartonCountLabel(2000), 'كرتونتان');
  assert.equal(referencePartsFor({ TransactionType: 'CashReceived' }).length, 0);
});

// ---------------------------------------------------------------------------
// Group C — an unchanged save moves no financial value
// ---------------------------------------------------------------------------

test('C1. an unchanged save leaves the summary and the cash figures identical', async () => {
  await freshDatabase('fix_c1');
  const farmer = await seedFarmer();
  const refs = await cartonRefs();
  const record = await seedCarton(farmer.Id, refs, { quantity: 250, price: 5 });

  const before = await balanceService.getCustomerSummary(farmer.Id);
  const ledgerBefore = await balanceService.getRunningBalance(farmer.Id);
  await transactionLifecycleService.editTransaction(record.Id, editValues(record));
  const after = await balanceService.getCustomerSummary(farmer.Id);
  const ledgerAfter = await balanceService.getRunningBalance(farmer.Id);

  assert.deepEqual(after, before, 'no balance, credit, debit or cash figure changed');
  assert.deepEqual(ledgerAfter.Entries.map((row) => [row.CreditMinor, row.DebitMinor, row.RunningBalanceMinor]),
    ledgerBefore.Entries.map((row) => [row.CreditMinor, row.DebitMinor, row.RunningBalanceMinor]));
});
