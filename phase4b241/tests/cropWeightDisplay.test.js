// Phase 4B.11 FINAL — the statement line of a local crop purchase.
//
// What is proven here:
//   · the line shows the PACKAGE COUNT and the FINAL NET WEIGHT;
//   · the net weight is the result of the approved formula computed from the package
//     weight STORED on the row (never the current default, never the unit weight);
//   · a row that carries no weight reports an explicit unresolved state, no number;
//   · the display changes no balance, no debit and no cash figure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { balanceService } from '../src/services/balanceService.js';
import { settingsService } from '../src/services/settingsService.js';
import { cropPurchaseService } from '../src/services/cropPurchaseService.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { TRANSACTION_TYPE } from '../src/domain/transactionTypes.js';
import { deriveFinancials } from '../src/domain/financialDirection.js';
import { ledgerReferenceNote, ledgerRow } from '../ui/views/customerAccount.js';
import { logger } from '../src/utils/logger.js';

logger.disable?.();

// G = D x (W - F) + E ; amount = G x H
async function seedLocal({ units = 300, loose = 5, deduction = 1, price = 1, weight = 14, code = 'W-1' } = {}) {
  const customer = await customerService.createCustomer({ Code: code, Name: `مزارع ${code}` });
  await settingsService.setDefaultPackageWeight(weight);
  const row = await transactionService.createTransaction({
    CustomerId: customer.Id,
    Date: '2026-10-01',
    TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL,
    crop: {
      LocalUnitsMilli: units * 1000,
      LocalLooseKgMilli: loose * 1000,
      LocalDeductionKgMilli: deduction * 1000,
      LocalUnitPriceMinor: price * 100
    }
  });
  return { customer, row };
}

test('1. the statement line shows the package count and the final net weight', async () => {
  await freshDatabase('disp_count_net');
  const { customer, row } = await seedLocal();
  // 300 x (14 - 1) + 5 = 3905 kg, price 1.00 -> 3905.00
  assert.equal(row.PackageWeightKg, 14);
  assert.equal(row.PackageWeightStatus, 'Confirmed');
  assert.equal(row.NetWeightMilli, 3905000);
  assert.equal(row.AmountMinor, 390500);

  const ledger = await balanceService.getRunningBalance(customer.Id);
  const entry = ledger.Entries.find((item) => item.Id === row.Id);
  assert.equal(entry.PackageCountMilli, 300000, 'the package count is the stored D value');
  assert.equal(entry.CropNetWeightMilli, 3905000, 'the net weight is G of this row');
  assert.equal(entry.CropWeightResolved, true);

  const html = ledgerReferenceNote(entry);
  assert.match(html, /عدد العبوات:\s*300/);
  assert.match(html, /الوزن الصافي:\s*3,905 كجم/);
});

test('2. the package-unit weight is never presented as the movement net weight', async () => {
  await freshDatabase('disp_not_unit');
  const { customer, row } = await seedLocal();
  const ledger = await balanceService.getRunningBalance(customer.Id);
  const entry = ledger.Entries.find((item) => item.Id === row.Id);
  const html = ledgerReferenceNote(entry);
  assert.equal(/وزن العبوة المحفوظ/.test(html), false, 'the old unit-weight wording is gone');
  assert.equal(html.includes(`>${row.PackageWeightKg} كجم`), false);
  // Showing 14 kg where the movement weighs 3905 kg would be a false statement.
  assert.notEqual(entry.CropNetWeightMilli, row.PackageWeightKg);
});

test('3. the displayed net weight equals the approved formula applied to the stored weight', async () => {
  await freshDatabase('disp_formula');
  const { customer, row } = await seedLocal({ units: 12, loose: 0.5, deduction: 2.25, price: 3.25, weight: 14 });
  const expectedNet = ((12 * (14 - 2.25)) + 0.5) * 1000;
  const preview = await cropPurchaseService.previewLocal({
    units: 12, looseKg: 0.5, deductionKg: 2.25, unitPrice: 3.25, packageWeightKg: 14
  });
  const ledger = await balanceService.getRunningBalance(customer.Id);
  const entry = ledger.Entries.find((item) => item.Id === row.Id);
  assert.equal(entry.CropNetWeightMilli, expectedNet);
  assert.equal(entry.CropNetWeightMilli, preview.NetWeightMilli);
  assert.equal(row.AmountMinor, preview.LocalTotalMinor);
  assert.equal(Number.isInteger(entry.CropNetWeightMilli), true, 'milli units stay integers');
});

test('4. a later change of the default weight never rewrites a past movement', async () => {
  await freshDatabase('disp_historic');
  const { customer, row } = await seedLocal({ weight: 14 });
  await settingsService.setDefaultPackageWeight(20);
  await settingsService.setDefaultPackageWeight(9);

  const stored = await transactionRepository.getById(row.Id);
  assert.equal(stored.PackageWeightKg, 14, 'the frozen weight is untouched');
  assert.equal(stored.NetWeightMilli, 3905000);

  const ledger = await balanceService.getRunningBalance(customer.Id);
  const entry = ledger.Entries.find((item) => item.Id === row.Id);
  assert.equal(entry.CropNetWeightMilli, 3905000, 'the display still reads the stored weight');
  assert.match(ledgerReferenceNote(entry), /3,905/);
});

test('5. a row without a stored weight reads as unresolved and no number is invented', async () => {
  await freshDatabase('disp_legacy');
  const { customer, row } = await seedLocal();
  // The pre-4B.11 shape: the weight fields simply do not exist on the row.
  const legacy = { ...row, Id: 'trx_legacy_local' };
  delete legacy.PackageWeightKg;
  delete legacy.PackageWeightStatus;
  delete legacy.NetWeightMilli;
  await transactionRepository.add(legacy);

  const ledger = await balanceService.getRunningBalance(customer.Id);
  const entry = ledger.Entries.find((item) => item.Id === 'trx_legacy_local');
  assert.equal(entry.CropWeightResolved, false);
  assert.equal(entry.CropNetWeightMilli, null);
  const html = ledgerReferenceNote(entry);
  assert.match(html, /الوزن الصافي غير محسوم/);
  assert.equal(/\d+ كجم/.test(html), false, 'no weight figure at all');
  assert.match(html, /عدد العبوات:\s*300/, 'the count is still shown');
});

test('6. the statement line changes no balance, no debit and no cash figure', async () => {
  await freshDatabase('disp_finance');
  const { customer, row } = await seedLocal();
  const before = await balanceService.getCustomerSummary(customer.Id);
  const ledger = await balanceService.getRunningBalance(customer.Id);
  const entry = ledger.Entries.find((item) => item.Id === row.Id);
  ledgerReferenceNote(entry);
  ledgerRow(entry).cells.join('');
  const after = await balanceService.getCustomerSummary(customer.Id);

  assert.deepEqual(after, before, 'reading the statement wrote nothing');
  const f = deriveFinancials(await transactionRepository.getById(row.Id));
  assert.equal(before.TotalCreditMinor, row.AmountMinor);
  assert.equal(before.TotalDebitMinor, 0);
  assert.equal(f.CreditMinor, row.AmountMinor);
  assert.equal(f.CashReceivedMinor, 0);
  assert.equal(f.CashPaidMinor, 0);
  assert.equal(before.BalanceMinor, row.AmountMinor);
});

test('7. a carton purchase carries no weight facts at all', async () => {
  await freshDatabase('disp_carton_none');
  const customer = await customerService.createCustomer({ Code: 'W-9', Name: 'مزارع' });
  const ref = await import('../src/services/referenceDataService.js');
  const company = await ref.receivingCompanyService.create('شركة');
  const type = await ref.cartonTypeService.create('نوع');
  const row = await transactionService.createTransaction({
    CustomerId: customer.Id, Date: '2026-10-02', TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON,
    ReceivingCompanyId: company.Id, CartonTypeId: type.Id,
    crop: { CartonQuantityMilli: 10000, CartonDiscountMinor: 0, CartonUnitPriceMinor: 500 }
  });
  const ledger = await balanceService.getRunningBalance(customer.Id);
  const entry = ledger.Entries.find((item) => item.Id === row.Id);
  assert.equal(entry.PackageCountMilli, null);
  assert.equal(entry.CropNetWeightMilli, null);
  assert.equal(entry.PackageWeightKg ?? null, null);
  assert.equal(/الوزن الصافي/.test(ledgerReferenceNote(entry)), false, 'a carton count is not a crop weight');
  assert.match(ledgerReferenceNote(entry), /الشركة المستلمة: شركة/);
});
