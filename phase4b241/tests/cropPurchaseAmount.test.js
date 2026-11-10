import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, cartonRefs } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { balanceService } from '../src/services/balanceService.js';
import { settingsService } from '../src/services/settingsService.js';
import { validateTransactionDraft } from '../src/validation/transactionValidation.js';
import { TRANSACTION_TYPE } from '../src/domain/transactionTypes.js';

test('CropPurchaseLocal value is DERIVED ONLY from D, F, E, H and DefaultPackageWeight', async () => {
  await freshDatabase('crop-local-derived');
  const customer = await customerService.createCustomer({ Code: 'CR1', Name: 'مشتريات محلي' });

  // G = D*(14-F)+E = 10*(14-2)+5 = 125 ; Amount = G*H = 125*5 = 625.00
  const row = await transactionService.createTransaction({
    CustomerId: customer.Id,
    Date: '2026-09-10',
    TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL,
    crop: { LocalUnitsMilli: 10000, LocalDeductionKgMilli: 2000, LocalLooseKgMilli: 5000, LocalUnitPriceMinor: 500 }
  });
  assert.equal(row.AmountMinor, 62500); // 625.00 exactly, from the formula
  assert.equal(row.LocalUnitsMilli, 10000);
  assert.equal(row.LocalDeductionKgMilli, 2000);
  assert.equal(row.LocalLooseKgMilli, 5000);
  assert.equal(row.LocalUnitPriceMinor, 500);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'NetWeight'), false, 'G is never stored or entered');

  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.TotalCreditMinor, 62500);
  assert.equal(summary.CashReceivedMinor, 0);
  assert.equal(summary.CashPaidMinor, 0);
});

test('CropPurchaseLocal uses the configured DefaultPackageWeight, not a hard-coded 14', async () => {
  await freshDatabase('crop-local-setting');
  const customer = await customerService.createCustomer({ Code: 'CR2', Name: 'إعداد الوزن' });
  await settingsService.setDefaultPackageWeight(20);

  // G = 4*(20-0)+0 = 80 ; Amount = 80*10 = 800.00
  const row = await transactionService.createTransaction({
    CustomerId: customer.Id,
    Date: '2026-09-11',
    TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL,
    crop: { LocalUnitsMilli: 4000, LocalDeductionKgMilli: 0, LocalLooseKgMilli: 0, LocalUnitPriceMinor: 1000 }
  });
  assert.equal(await settingsService.getDefaultPackageWeight(), 20);
  assert.equal(row.AmountMinor, 80000);
});

test('CropPurchaseCarton value is DERIVED ONLY from K, M and L', async () => {
  await freshDatabase('crop-carton-derived');
  const customer = await customerService.createCustomer({ Code: 'CR3', Name: 'مشتريات كرتون' });

  // Amount = (K - M) * L = (20 - 2) * 15 = 270.00
  const row = await transactionService.createTransaction({
    CustomerId: customer.Id,
    Date: '2026-09-12',
    TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON,
    ...(await cartonRefs()),
    crop: { CartonQuantityMilli: 20000, CartonDiscountMinor: 200, CartonUnitPriceMinor: 1500 }
  });
  assert.equal(row.AmountMinor, 27000);
  assert.equal(row.CartonQuantityMilli, 20000);
  assert.equal(row.CartonDiscountMinor, 200);
  assert.equal(row.CartonUnitPriceMinor, 1500);

  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.TotalCreditMinor, 27000);
});

test('An explicit AmountMinor is rejected for CropPurchaseLocal (no override)', () => {
  const base = {
    CustomerId: 'cus_1',
    Date: '2026-09-01',
    TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL,
    crop: { LocalUnitsMilli: 10000, LocalDeductionKgMilli: 0, LocalLooseKgMilli: 0, LocalUnitPriceMinor: 500 }
  };
  const withMinor = validateTransactionDraft({ ...base, AmountMinor: 999999 }, { customerExists: true });
  assert.equal(withMinor.ok, false);
  assert.equal(withMinor.errors[0].code, 'BUSINESS_RULE_ERROR');
  assert.match(withMinor.errors[0].message, /مبلغ صريح/);

  const withMajor = validateTransactionDraft({ ...base, Amount: 9999 }, { customerExists: true });
  assert.equal(withMajor.ok, false);
  assert.equal(withMajor.errors[0].code, 'BUSINESS_RULE_ERROR');

  // Key presence is what is checked, so an explicit zero is refused too.
  const withZero = validateTransactionDraft({ ...base, AmountMinor: 0 }, { customerExists: true });
  assert.equal(withZero.ok, false);
  assert.equal(withZero.errors[0].code, 'BUSINESS_RULE_ERROR');

  // Without an explicit amount the crop data itself is the only source.
  const clean = validateTransactionDraft({ ...base }, { customerExists: true });
  assert.equal(clean.ok, true);
  assert.equal(clean.data.AmountMinor, null);
});

test('An explicit AmountMinor is rejected for CropPurchaseCarton (no override)', () => {
  const base = {
    CustomerId: 'cus_1',
    Date: '2026-09-01',
    TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON,
    crop: { CartonQuantityMilli: 20000, CartonDiscountMinor: 0, CartonUnitPriceMinor: 1500 }
  };
  const withMinor = validateTransactionDraft({ ...base, AmountMinor: 1 }, { customerExists: true });
  assert.equal(withMinor.ok, false);
  assert.equal(withMinor.errors[0].code, 'BUSINESS_RULE_ERROR');

  const withMajor = validateTransactionDraft({ ...base, Amount: 1 }, { customerExists: true });
  assert.equal(withMajor.ok, false);
  assert.equal(withMajor.errors[0].code, 'BUSINESS_RULE_ERROR');

  const clean = validateTransactionDraft({ ...base }, { customerExists: true });
  assert.equal(clean.ok, true);
  assert.equal(clean.data.AmountMinor, null);
});

test('A crop purchase cannot be stored with an explicit amount even through the service', async () => {
  await freshDatabase('crop-service-override');
  const refs = await cartonRefs();
  const customer = await customerService.createCustomer({ Code: 'CR4', Name: 'منع التجاوز' });

  await assert.rejects(
    () => transactionService.createTransaction({
      CustomerId: customer.Id,
      Date: '2026-09-13',
      TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL,
      AmountMinor: 500000,
      crop: { LocalUnitsMilli: 10000, LocalDeductionKgMilli: 0, LocalLooseKgMilli: 0, LocalUnitPriceMinor: 500 }
    }),
    /مبلغ صريح/
  );

  await assert.rejects(
    () => transactionService.createTransaction({
      CustomerId: customer.Id,
      Date: '2026-09-13',
      TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON,
      Amount: 7777,
      ...refs,
      crop: { CartonQuantityMilli: 20000, CartonDiscountMinor: 0, CartonUnitPriceMinor: 1500 }
    }),
    /مبلغ صريح/
  );

  // Nothing was written by the rejected attempts.
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.TotalCreditMinor, 0);
  assert.equal(summary.BalanceMinor, 0);
});

test('A crop purchase without crop data is rejected instead of falling back to an amount', async () => {
  await freshDatabase('crop-missing-data');
  const customer = await customerService.createCustomer({ Code: 'CR5', Name: 'بيانات ناقصة' });
  await assert.rejects(
    () => transactionService.createTransaction({
      CustomerId: customer.Id,
      Date: '2026-09-14',
      TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL
    }),
    /بيانات مشتريات المحصول مطلوبة/
  );
});

test('Other transaction types still take their amount from the single entered value', async () => {
  await freshDatabase('crop-no-side-effects');
  const customer = await customerService.createCustomer({ Code: 'CR6', Name: 'أنواع أخرى' });

  const sale = await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-15', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 400 });
  assert.equal(sale.AmountMinor, 40000);

  const cash = await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-16', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 150 });
  assert.equal(cash.AmountMinor, 15000);

  const transfer = await transactionService.createTransaction({
    CustomerId: customer.Id, Date: '2026-09-17', TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER,
    Amount: 50, LinkId: 'lnk_crop_test', TransferRole: 'CreditSide'
  });
  assert.equal(transfer.AmountMinor, 5000);

  // Negative / zero explicit amounts stay rejected for non-crop types.
  const negative = validateTransactionDraft({ CustomerId: 'c', Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: -10 }, { customerExists: true });
  assert.equal(negative.ok, false);
  assert.equal(negative.errors[0].field, 'Amount');

  // And a missing amount is still an error for them.
  const missing = validateTransactionDraft({ CustomerId: 'c', Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES }, { customerExists: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].field, 'Amount');
});
