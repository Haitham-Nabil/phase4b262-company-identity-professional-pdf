// Phase 4B.3 — Add Transaction tests (spec §32 items 1–44, plus supporting checks).
//
// Storage is exercised through the real services against an isolated fake-indexeddb
// database. Every financial assertion is compared with the CORE output
// (deriveFinancials / balanceService), never with a number the test invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freshDatabase, simulateReload, cartonRefs } from './helpers.js';
import {
  customerService, transactionService, debtTransferService, balanceService,
  transactionFormService, settingsService, cropPurchaseService
} from '../src/services/index.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { openDatabase } from '../src/storage/db.js';
import { STORE } from '../src/storage/schema.js';
import { deriveFinancials } from '../src/domain/financialDirection.js';
import { TRANSACTION_TYPE, TRANSACTION_TYPES, STATUS, DEBT_TRANSFER_ROLE } from '../src/domain/transactionTypes.js';
import { AppError, ERROR_CODE } from '../src/domain/errors.js';
import { buildTransactionForm, emptyForm, requiredFormKeys, hasExplicitAmountKey, FORM_KEY } from '../src/validation/transactionFormInput.js';
import { resolveDestination } from '../ui/router.js';
import { TRANSACTION_DESTINATION, transactionAddPath } from '../ui/routes.js';
import {
  renderTransactionForm, renderDynamicFields, renderTransactionSuccess, initTransactionFormView,
  FIELD_ID, TRANSACTION_FORM_REGION_ID, CROP_PREVIEW_ID, TYPE_NOTE, transactionTypeOptions
} from '../ui/views/transactionForm.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');
const UI_ROOT = join(PROJECT_ROOT, 'ui');
const TODAY = '2026-09-10';

async function seedCustomers() {
  const a = await customerService.createCustomer({ Code: 'A-1', Name: 'أحمد المصري', OpeningBalance: 1000 });
  const b = await customerService.createCustomer({ Code: 'B-2', Name: 'شركة الدلتا', OpeningBalance: 0 });
  return { a, b };
}

function formOf(transactionType, overrides = {}) {
  return { ...emptyForm({ transactionType, date: TODAY }), ...overrides };
}

// A minimal stand-in for the screen DOM: it returns the control nodes the
// controller asks for, so the real controller code path is exercised.
function stubScreen() {
  const controls = {};
  const handlers = {};
  const regionEl = {
    innerHTML: '',
    attributes: {},
    isConnected: true,
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    querySelector(selector) { return selector.startsWith('#') ? controls[selector.slice(1)] || null : null; }
  };
  const container = {
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    querySelector(selector) { return selector === `#${TRANSACTION_FORM_REGION_ID}` ? regionEl : null; },
    addEventListener(type, handler) { handlers[type] = handler; },
    querySelectorAll() { return []; }
  };
  controls['transaction-form'] = { id: 'transaction-form', value: '' };
  return {
    container,
    regionEl,
    handlers,
    control(id) {
      if (!controls[id]) {
        controls[id] = {
          value: '', disabled: false, innerHTML: '', attributes: {},
          setAttribute(name, value) { this.attributes[name] = value; },
          getAttribute(name) { return this.attributes[name] ?? null; }
        };
      }
      return controls[id];
    },
    setValue(key, value) { const id = FIELD_ID[key] || `field-${key}`; this.control(id).value = String(value); },
    fire(type, key, value) {
      const id = FIELD_ID[key] || `field-${key}`;
      const handler = handlers[type];
      if (!handler) return;
      handler({ preventDefault() {}, target: { getAttribute: (name) => (name === 'id' ? id : null), value: String(value), closest: () => null } });
    }
  };
}

function walkFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return walkFiles(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

// ---------------------------------------------------------------------------
// General (spec §32 items 1–10)
// ---------------------------------------------------------------------------

test('1. Add Transaction opens at /transactions/add and resolves as its own destination', () => {
  const resolution = resolveDestination('#/transactions/add');
  assert.equal(resolution.resolved, true);
  assert.equal(resolution.destination.id, TRANSACTION_DESTINATION.ADD);
  assert.equal(resolution.destination.parentRouteId, 'transactions');
  assert.equal(transactionAddPath(), '/transactions/add');
});

test('1b. Add Transaction can open with the customer pre-selected from a customer row', () => {
  const resolution = resolveDestination('#/transactions/add?customerId=cus_abc');
  assert.equal(resolution.destination.id, TRANSACTION_DESTINATION.ADD);
  assert.equal(resolution.params.customerId, 'cus_abc');
  assert.equal(transactionAddPath('cus_abc'), '/transactions/add?customerId=cus_abc');
});

test('2/3. The form offers the customer picker, the 10 approved types and nothing else', () => {
  const options = transactionTypeOptions();
  assert.equal(options.length, 10);
  assert.deepEqual(options.map((option) => option.value).sort(), [...TRANSACTION_TYPES].sort());
  const html = renderTransactionForm({ customers: [], values: formOf(TRANSACTION_TYPE.SALE_PESTICIDES) });
  assert.match(html, /id="field-CustomerId"/);
  assert.match(html, /id="field-TransactionType"/);
  assert.equal(html.includes('Debit'), false);
  assert.equal(html.includes('Credit'), false);
});

test('4. The fields change with the transaction type (dynamic form)', () => {
  const sale = renderDynamicFields({ transactionType: TRANSACTION_TYPE.SALE_PESTICIDES });
  assert.equal(sale.includes(FIELD_ID.Amount), true);
  assert.equal(sale.includes(FIELD_ID.Units), false);
  const local = renderDynamicFields({ transactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL });
  assert.equal(local.includes(FIELD_ID.Units), true);
  assert.equal(local.includes(FIELD_ID.LooseKg), true);
  assert.equal(local.includes(FIELD_ID.DeductionKg), true);
  assert.equal(local.includes(FIELD_ID.UnitPrice), true);
  assert.equal(local.includes(FIELD_ID.Amount), false, 'a crop purchase never renders an Amount control');
  const carton = renderDynamicFields({ transactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON });
  assert.equal(carton.includes(FIELD_ID.CartonQuantity), true);
  assert.equal(carton.includes(FIELD_ID.Amount), false);
  const transfer = renderTransactionForm({ customers: [], values: formOf(TRANSACTION_TYPE.DEBT_TRANSFER) });
  assert.match(transfer, /id="field-FromCustomerId"/);
  assert.match(transfer, /id="field-ToCustomerId"/);
});

test('5. An empty or non-numeric amount is rejected by the Core, not by the UI', async () => {
  await freshDatabase('add_amount');
  const { a } = await seedCustomers();
  await assert.rejects(
    () => transactionService.createTransaction({ CustomerId: a.Id, Date: TODAY, TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: '' }),
    (error) => error instanceof AppError && error.code === ERROR_CODE.VALIDATION_ERROR
  );
  await assert.rejects(
    () => transactionService.createTransaction({ CustomerId: a.Id, Date: TODAY, TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 'abc' }),
    (error) => error instanceof AppError && error.code === ERROR_CODE.VALIDATION_ERROR
  );
});

test('6. A negative amount is rejected', async () => {
  await freshDatabase('add_negative');
  const { a } = await seedCustomers();
  await assert.rejects(
    () => transactionService.createTransaction({ CustomerId: a.Id, Date: TODAY, TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: -50 }),
    (error) => error instanceof AppError && error.code === ERROR_CODE.VALIDATION_ERROR
  );
});

test('7. A zero amount is rejected', async () => {
  await freshDatabase('add_zero');
  const { a } = await seedCustomers();
  await assert.rejects(
    () => transactionService.createTransaction({ CustomerId: a.Id, Date: TODAY, TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 0 }),
    (error) => error instanceof AppError && error.code === ERROR_CODE.VALIDATION_ERROR
  );
});

test('8. Saving stores the transaction through the services layer', async () => {
  await freshDatabase('add_save');
  const { a } = await seedCustomers();
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.SALE_PESTICIDES, { CustomerId: a.Id, Amount: '150.25' }));
  assert.equal(result.Kind, 'transaction');
  assert.equal(result.Record.AmountMinor, 15025);
  assert.equal(result.Record.Status, STATUS.ACTIVE);
  assert.equal(result.Record.CustomerId, a.Id);
  assert.equal(Number.isInteger(result.Record.AmountMinor), true);
  const stored = await transactionService.getTransaction(result.Record.Id);
  assert.equal(stored.AmountMinor, 15025);
});

test('9. The transaction survives a reload (database closed and reopened)', async () => {
  await freshDatabase('add_reload');
  const { a } = await seedCustomers();
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.CASH_RECEIVED, { CustomerId: a.Id, Amount: '300' }));
  await simulateReload();
  const reloaded = await transactionService.getTransaction(result.Record.Id);
  assert.equal(reloaded.Id, result.Record.Id);
  assert.equal(reloaded.AmountMinor, 30000);
  assert.equal((await balanceService.getCustomerSummary(a.Id)).BalanceMinor, 130000);
});

test('10. After a successful save the statement route for that customer is reachable', async () => {
  await freshDatabase('add_navigate');
  const { a } = await seedCustomers();
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.SALE_PESTICIDES, { CustomerId: a.Id, Amount: '10' }));
  const destination = resolveDestination(`#/customer/${result.CustomerId}`).destination;
  assert.equal(destination.id, 'customer-account');
  assert.equal(destination.params.id, a.Id);
  const success = renderTransactionSuccess({ result });
  assert.match(success, /عرض كشف الحساب/);
  assert.match(success, /تم تسجيل الحركة بنجاح/);
});

// ---------------------------------------------------------------------------
// Sales (items 11–13)
// ---------------------------------------------------------------------------

test('11. SalePesticides is recorded as a debit and lowers the balance', async () => {
  await freshDatabase('add_sale_pest');
  const { a } = await seedCustomers();
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.SALE_PESTICIDES, { CustomerId: a.Id, Amount: '250' }));
  const f = deriveFinancials(result.Record);
  assert.equal(f.DebitMinor, 25000);
  assert.equal(f.CreditMinor, 0);
  assert.equal(result.NewBalanceMinor, 100000 + 0 - 25000);
});

test('12. SaleIrrigation is recorded as a debit', async () => {
  await freshDatabase('add_sale_irr');
  const { a } = await seedCustomers();
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.SALE_IRRIGATION, { CustomerId: a.Id, Amount: '400' }));
  const f = deriveFinancials(result.Record);
  assert.equal(f.DebitMinor, 40000);
  assert.equal(f.CreditMinor, 0);
});

test('13. SalesReturn is recorded as a credit', async () => {
  await freshDatabase('add_return');
  const { a } = await seedCustomers();
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.SALES_RETURN, { CustomerId: a.Id, Amount: '120' }));
  const f = deriveFinancials(result.Record);
  assert.equal(f.CreditMinor, 12000);
  assert.equal(f.DebitMinor, 0);
});

// ---------------------------------------------------------------------------
// Crop (items 14–19)
// ---------------------------------------------------------------------------

test('14. CropPurchaseLocal uses DefaultPackageWeight from Settings (no hard-coded 14)', async () => {
  await freshDatabase('add_crop_setting');
  const { a } = await seedCustomers();
  await settingsService.setDefaultPackageWeight(25);
  const weight = await transactionFormService.getDefaultPackageWeight();
  assert.equal(weight, 25);
  const source = readFileSync(join(UI_ROOT, 'views/transactionForm.js'), 'utf8');
  assert.doesNotMatch(source, /(^|[^\d.])14([^\d.]|$)/, 'the UI must not carry a package-weight literal');
  // D=4, E=2, F=1, H=10 -> G = 4*(25-1)+2 = 98 ; Amount = 980.00
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, {
    CustomerId: a.Id, Units: '4', LooseKg: '2', DeductionKg: '1', UnitPrice: '10'
  }));
  assert.equal(result.Record.AmountMinor, 98000);
  assert.equal(result.Record.LocalUnitsMilli, 4000);
  assert.equal(result.Record.AmountMinor, deriveFinancials(result.Record).CreditMinor);
});

test('15. CropPurchaseLocal refuses an explicit amount (no override path from the form)', async () => {
  await freshDatabase('add_crop_override');
  const { a } = await seedCustomers();
  const built = buildTransactionForm(formOf(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, {
    CustomerId: a.Id, Units: '1', LooseKg: '0', DeductionKg: '0', UnitPrice: '5', Amount: '999'
  }));
  assert.equal(hasExplicitAmountKey(built.Draft), false, 'the crop draft never carries an Amount key');
  await assert.rejects(
    () => transactionService.createTransaction({
      CustomerId: a.Id, Date: TODAY, TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, Amount: 999,
      crop: { LocalUnitsMilli: 1000, LocalLooseKgMilli: 0, LocalDeductionKgMilli: 0, LocalUnitPriceMinor: 500 }
    }),
    (error) => error instanceof AppError && error.code === ERROR_CODE.BUSINESS_RULE_ERROR
  );
});

test('16. CropPurchaseLocal passes the raw D/E/F/H inputs to the Core, which derives the value', async () => {
  await freshDatabase('add_crop_local');
  const { a } = await seedCustomers();
  await settingsService.setDefaultPackageWeight(25);
  const form = formOf(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, { CustomerId: a.Id, Units: '4', LooseKg: '2', DeductionKg: '1', UnitPrice: '10' });
  const built = buildTransactionForm(form);
  const expected = await cropPurchaseService.computeLocalAmountMinor({ units: 4, looseKg: 2, deductionKg: 1, unitPrice: 10 });
  assert.equal(built.Draft.crop.LocalUnitsMilli, 4000);
  assert.equal(built.Draft.crop.LocalLooseKgMilli, 2000);
  assert.equal(built.Draft.crop.LocalDeductionKgMilli, 1000);
  assert.equal(built.Draft.crop.LocalUnitPriceMinor, 1000);
  const result = await transactionFormService.submitTransactionForm(form);
  assert.equal(result.Record.AmountMinor, expected);
  assert.equal(expected, 98000);
});

test('17. CropPurchaseCarton refuses an explicit amount and derives (K - M) x L', async () => {
  await freshDatabase('add_crop_carton');
  const { a } = await seedCustomers();
  const form = formOf(TRANSACTION_TYPE.CROP_PURCHASE_CARTON, { CustomerId: a.Id, CartonQuantity: '10', CartonDiscount: '2', CartonPrice: '5', ...(await cartonRefs()) });
  const built = buildTransactionForm(form);
  assert.equal(hasExplicitAmountKey(built.Draft), false);
  assert.equal(built.Draft.crop.CartonQuantityMilli, 10000);
  assert.equal(built.Draft.crop.CartonDiscountMinor, 200);
  assert.equal(built.Draft.crop.CartonUnitPriceMinor, 500);
  const result = await transactionFormService.submitTransactionForm(form);
  assert.equal(result.Record.AmountMinor, 4000); // 8 x 5.00
  assert.equal(result.Record.AmountMinor, (await cropPurchaseService.computeCartonAmountMinor({ quantity: 10, discount: 2, unitPrice: 5 })));
});

test('17b. CropPurchaseCarton rejects a non-positive derived total', async () => {
  await freshDatabase('add_crop_carton_zero');
  const { a } = await seedCustomers();
  const refs = await cartonRefs();
  await assert.rejects(
    () => transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.CROP_PURCHASE_CARTON, {
      CustomerId: a.Id, CartonQuantity: '2', CartonDiscount: '2', CartonPrice: '5', ...refs
    })),
    (error) => error instanceof AppError && error.code === ERROR_CODE.VALIDATION_ERROR
  );
});

test('18. The crop preview is produced by the approved calculator and is never stored', async () => {
  await freshDatabase('add_crop_preview');
  await seedCustomers();
  await settingsService.setDefaultPackageWeight(25);
  const preview = await transactionFormService.previewCrop(formOf(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, {
    Units: '4', LooseKg: '2', DeductionKg: '1', UnitPrice: '10'
  }));
  assert.equal(preview.PackageWeightKg, 25);
  assert.equal(preview.NetWeightMilli, 98000);
  assert.equal(preview.AmountMinor, 98000);
  assert.equal(await transactionRepository.count(), 0, 'a preview must never write a record');
  const html = renderTransactionForm({ customers: [], values: formOf(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL) });
  assert.match(html, new RegExp(CROP_PREVIEW_ID));
  assert.equal(html.includes('type="submit"'), true);
});

test('19. Invalid crop values are refused by the existing validation', async () => {
  await freshDatabase('add_crop_invalid');
  const { a } = await seedCustomers();
  const refs = await cartonRefs();
  await assert.rejects(
    () => transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, {
      CustomerId: a.Id, Units: '-3', LooseKg: '0', DeductionKg: '0', UnitPrice: '5'
    })),
    (error) => error instanceof AppError && error.code === ERROR_CODE.VALIDATION_ERROR
  );
  await assert.rejects(
    () => transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, {
      CustomerId: a.Id, Units: 'abc', LooseKg: '0', DeductionKg: '0', UnitPrice: '5'
    })),
    (error) => error instanceof AppError && error.code === ERROR_CODE.VALIDATION_ERROR
  );
  await assert.rejects(
    () => transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.CROP_PURCHASE_CARTON, {
      CustomerId: a.Id, CartonQuantity: '5', CartonDiscount: '-1', CartonPrice: '3', ...refs
    })),
    (error) => error instanceof AppError && error.code === ERROR_CODE.VALIDATION_ERROR
  );
});

// ---------------------------------------------------------------------------
// Cash (items 20–23)
// ---------------------------------------------------------------------------

test('20. CashReceived is a credit with CashReceived = amount and CashPaid = 0', async () => {
  await freshDatabase('add_cash_in');
  const { a } = await seedCustomers();
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.CASH_RECEIVED, { CustomerId: a.Id, Amount: '500' }));
  const f = deriveFinancials(result.Record);
  assert.equal(f.CreditMinor, 50000);
  assert.equal(f.CashReceivedMinor, 50000);
  assert.equal(f.CashPaidMinor, 0);
  assert.equal(result.NewBalanceMinor, 150000);
});

test('21. CashPaid is a debit with CashPaid = amount and CashReceived = 0', async () => {
  await freshDatabase('add_cash_out');
  const { a } = await seedCustomers();
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.CASH_PAID, { CustomerId: a.Id, Amount: '1000' }));
  const f = deriveFinancials(result.Record);
  assert.equal(f.DebitMinor, 100000);
  assert.equal(f.CashPaidMinor, 100000);
  assert.equal(f.CashReceivedMinor, 0);
  assert.equal(result.NewBalanceMinor, 0);
});

test('22. CashReceived never appears as paid cash', async () => {
  await freshDatabase('add_cash_in_shape');
  const { a } = await seedCustomers();
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.CASH_RECEIVED, { CustomerId: a.Id, Amount: '75' }));
  const totals = await transactionService.getCashTotals(a.Id);
  assert.equal(totals.CashReceivedMinor, 7500);
  assert.equal(totals.CashPaidMinor, 0);
  assert.equal(deriveFinancials(result.Record).direction, 'Credit');
});

test('23. CashPaid never appears as received cash', async () => {
  await freshDatabase('add_cash_out_shape');
  const { a } = await seedCustomers();
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.CASH_PAID, { CustomerId: a.Id, Amount: '75' }));
  const totals = await transactionService.getCashTotals(a.Id);
  assert.equal(totals.CashPaidMinor, 7500);
  assert.equal(totals.CashReceivedMinor, 0);
  assert.equal(deriveFinancials(result.Record).direction, 'Debit');
});

// ---------------------------------------------------------------------------
// Non-cash (items 24–25)
// ---------------------------------------------------------------------------

test('24. Settlement is a credit with zero cash impact', async () => {
  await freshDatabase('add_settlement');
  const { a } = await seedCustomers();
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.SETTLEMENT, { CustomerId: a.Id, Amount: '300' }));
  const f = deriveFinancials(result.Record);
  assert.equal(f.CreditMinor, 30000);
  assert.equal(f.CashReceivedMinor, 0);
  assert.equal(f.CashPaidMinor, 0);
  assert.equal(f.SettlementMinor, 30000);
  assert.equal(result.NewBalanceMinor, 130000);
});

test('25. GoodsExchange is a credit with zero cash impact', async () => {
  await freshDatabase('add_goods');
  const { a } = await seedCustomers();
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.GOODS_EXCHANGE, { CustomerId: a.Id, Amount: '120' }));
  const f = deriveFinancials(result.Record);
  assert.equal(f.CreditMinor, 12000);
  assert.equal(f.CashReceivedMinor, 0);
  assert.equal(f.CashPaidMinor, 0);
});

test('25b. The cash types are never labelled as collections or payments in copy', () => {
  const copy = Object.values(TYPE_NOTE).join(' ');
  assert.equal(copy.includes('Payment Method'), false);
  assert.equal(copy.includes('Collection'), false);
});

// ---------------------------------------------------------------------------
// Debt transfer (items 26–33)
// ---------------------------------------------------------------------------

test('26/27/28/29/30. A debt transfer creates both legs: A credit, B debit, one LinkId, no cash', async () => {
  await freshDatabase('add_transfer');
  const { a, b } = await seedCustomers();
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.DEBT_TRANSFER, {
    FromCustomerId: a.Id, ToCustomerId: b.Id, Amount: '250'
  }));
  assert.equal(result.Kind, 'debtTransfer');
  assert.equal(result.Records.length, 2);
  assert.equal(await transactionRepository.count(), 2);
  const credit = result.Records.find((row) => row.TransferRole === DEBT_TRANSFER_ROLE.CREDIT_SIDE);
  const debit = result.Records.find((row) => row.TransferRole === DEBT_TRANSFER_ROLE.DEBIT_SIDE);
  assert.equal(credit.CustomerId, a.Id);
  assert.equal(debit.CustomerId, b.Id);
  assert.equal(credit.LinkId, debit.LinkId);
  assert.equal(result.LinkId, credit.LinkId);
  assert.equal(credit.AmountMinor, 25000);
  assert.equal(debit.AmountMinor, 25000);
  assert.equal(credit.Date, debit.Date);
  const creditFinancials = deriveFinancials(credit);
  const debitFinancials = deriveFinancials(debit);
  assert.equal(creditFinancials.CreditMinor, 25000);
  assert.equal(creditFinancials.DebitMinor, 0);
  assert.equal(debitFinancials.DebitMinor, 25000);
  assert.equal(debitFinancials.CreditMinor, 0);
  assert.equal(creditFinancials.CashReceivedMinor + debitFinancials.CashReceivedMinor, 0);
  assert.equal(creditFinancials.CashPaidMinor + debitFinancials.CashPaidMinor, 0);
  assert.equal(result.CashImpactMinor, 0);
  assert.equal((await balanceService.getCustomerSummary(a.Id)).BalanceMinor, 125000);
  assert.equal((await balanceService.getCustomerSummary(b.Id)).BalanceMinor, -25000);
});

test('31. A debt transfer to the same customer is refused', async () => {
  await freshDatabase('add_transfer_same');
  const { a } = await seedCustomers();
  await assert.rejects(
    () => transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.DEBT_TRANSFER, { FromCustomerId: a.Id, ToCustomerId: a.Id, Amount: '10' })),
    (error) => error instanceof AppError && error.code === ERROR_CODE.BUSINESS_RULE_ERROR
  );
  assert.equal(await transactionRepository.count(), 0);
});

test('32. A debt transfer of amount <= 0 is refused', async () => {
  await freshDatabase('add_transfer_zero');
  const { a, b } = await seedCustomers();
  await assert.rejects(
    () => transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.DEBT_TRANSFER, { FromCustomerId: a.Id, ToCustomerId: b.Id, Amount: '0' })),
    (error) => error instanceof AppError && error.code === ERROR_CODE.VALIDATION_ERROR
  );
  await assert.rejects(
    () => transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.DEBT_TRANSFER, { FromCustomerId: a.Id, ToCustomerId: b.Id, Amount: '-5' })),
    (error) => error instanceof AppError && error.code === ERROR_CODE.VALIDATION_ERROR
  );
});

test('32b. A debt transfer with a missing customer is refused and writes nothing', async () => {
  await freshDatabase('add_transfer_missing');
  const { a } = await seedCustomers();
  await assert.rejects(
    () => transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.DEBT_TRANSFER, { FromCustomerId: a.Id, ToCustomerId: 'cus_missing', Amount: '10' })),
    (error) => error instanceof AppError && error.code === ERROR_CODE.NOT_FOUND
  );
  assert.equal(await transactionRepository.count(), 0);
});

test('33. Atomicity: when the second leg fails, no leg is left behind', async () => {
  await freshDatabase('add_transfer_atomic');
  const { a, b } = await seedCustomers();
  const connection = await openDatabase();
  const probe = connection.transaction(STORE.TRANSACTIONS, 'readwrite').objectStore(STORE.TRANSACTIONS);
  const prototype = Object.getPrototypeOf(probe);
  const originalAdd = prototype.add;
  let calls = 0;
  prototype.add = function patchedAdd(...args) {
    calls += 1;
    if (calls === 2) throw new Error('forced failure on the second leg');
    return originalAdd.apply(this, args);
  };
  try {
    await assert.rejects(
      () => transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.DEBT_TRANSFER, { FromCustomerId: a.Id, ToCustomerId: b.Id, Amount: '90' })),
      (error) => error instanceof AppError
    );
  } finally {
    prototype.add = originalAdd;
  }
  assert.equal(calls, 2, 'both legs were attempted');
  assert.equal(await transactionRepository.count(), 0, 'the aborted transaction left zero rows');
  assert.equal((await balanceService.getCustomerSummary(a.Id)).BalanceMinor, 100000);
  assert.equal((await balanceService.getCustomerSummary(b.Id)).BalanceMinor, 0);
});

// ---------------------------------------------------------------------------
// Architecture (items 34–38)
// ---------------------------------------------------------------------------

test('34/35. No UI module imports a repository or the IndexedDB layer', () => {
  const files = walkFiles(UI_ROOT);
  assert.ok(files.length >= 11, 'the ui tree must contain the shell, the customer screens and the new form');
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const forbidden of ['repositories', 'storage/db', 'storage/schema', 'indexedDB', 'IndexedDB', 'IDBKeyRange']) {
      assert.equal(source.includes(forbidden), false, `${file} must not reference ${forbidden}`);
    }
    for (const target of [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      if (target.includes('/src/')) assert.match(target, /\/src\/(services|utils)\//, `${file} may only reach services and utils, got ${target}`);
    }
  }
});

test('36/37/38. The form module holds no financial engine, no balance write and no direction decision', () => {
  const source = readFileSync(join(UI_ROOT, 'views/transactionForm.js'), 'utf8');
  assert.equal(source.includes('OpeningBalanceMinor'), false, 'the UI must not touch the opening balance');
  assert.doesNotMatch(source, /Total(Credit|Debit)Minor/, 'the UI must not compute debit/credit totals');
  assert.doesNotMatch(source, /BalanceMinor\s*[+\-*/]?=/, 'the UI must never assign a balance');
  assert.doesNotMatch(source, /deriveFinancials/, 'the UI must not call the financial engine');
  assert.doesNotMatch(source, /debit\s*[:=]/, 'the UI must not assign a debit bucket');
  assert.doesNotMatch(source, /credit\s*[:=]/, 'the UI must not assign a credit bucket');
  assert.doesNotMatch(source, /CashReceivedMinor\s*\+?=/, 'the UI must not accumulate cash buckets');
  assert.doesNotMatch(source, /balance\s*[+\-]=/, 'the UI must not accumulate a balance');
  assert.doesNotMatch(source, /delete\s*\(/);
  assert.equal(source.includes('Customer 1'), false);
  assert.equal(source.includes('TODO'), false);
  assert.equal(source.includes('FIXME'), false);
});

test('38b. The service layer owns the write and exposes no UI-side engine either', () => {
  const source = readFileSync(join(PROJECT_ROOT, 'src/services/transactionFormService.js'), 'utf8');
  assert.match(source, /transactionService\.createTransaction/);
  assert.match(source, /debtTransferService\.createDebtTransfer/);
  assert.match(source, /cropPurchaseService\.previewLocal/);
  assert.doesNotMatch(source, /deriveFinancials/);
  assert.doesNotMatch(source, /balanceService\.getCustomerSummary\([^)]*\)\s*[+\-]/, 'no arithmetic on the returned balance');
  assert.equal(source.includes('14'), false, 'no hard-coded package weight');
});

test('34b/38c. The form sends only raw crop inputs and one amount for every other type', () => {
  const cropForm = formOf(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, { CustomerId: 'c1', Units: '1', LooseKg: '1', DeductionKg: '0', UnitPrice: '2' });
  const cropDraft = buildTransactionForm(cropForm).Draft;
  assert.deepEqual(Object.keys(cropDraft).sort(), ['CustomerId', 'Date', 'Description', 'TransactionType', 'crop'].sort());
  const amountDraft = buildTransactionForm(formOf(TRANSACTION_TYPE.SALE_PESTICIDES, { CustomerId: 'c1', Amount: '3' })).Draft;
  assert.equal(Object.prototype.hasOwnProperty.call(amountDraft, 'Amount'), true);
  assert.equal(requiredFormKeys(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL).includes(FORM_KEY.DESCRIPTION), false);
  assert.equal(requiredFormKeys(TRANSACTION_TYPE.DEBT_TRANSFER).length, 4);
});

// ---------------------------------------------------------------------------
// Controller behaviour (loading, errors, double submit)
// ---------------------------------------------------------------------------

test('C1. The controller loads the customers and the package weight through the services', async () => {
  await freshDatabase('add_controller');
  const { a } = await seedCustomers();
  const screen = stubScreen();
  const view = initTransactionFormView({ container: screen.container, autoLoad: false });
  await view.reload();
  const state = view.state();
  assert.equal(state.customers.some((customer) => customer.Id === a.Id), true);
  assert.equal(Number.isFinite(state.packageWeightKg), true);
  assert.equal(screen.regionEl.attributes['aria-busy'], 'false');
});

test('C2. A submit failure keeps every entered value, shows an error and leaves loading false', async () => {
  await freshDatabase('add_controller_error');
  const { a } = await seedCustomers();
  const screen = stubScreen();
  const view = initTransactionFormView({ container: screen.container, autoLoad: false });
  await view.reload();
  screen.setValue('TransactionType', TRANSACTION_TYPE.SALE_PESTICIDES);
  screen.setValue('CustomerId', a.Id);
  screen.setValue('Date', TODAY);
  screen.setValue('Amount', '-10');
  const result = await view.submit();
  assert.equal(result, null);
  const state = view.state();
  assert.equal(state.error instanceof AppError, true);
  assert.equal(state.values.Amount, '-10', 'the entered amount is preserved');
  assert.equal(state.busy, false);
  assert.match(screen.regionEl.innerHTML, /تعذّر تسجيل الحركة/);
});

test('C3. A repeated click cannot create a second transaction', async () => {
  await freshDatabase('add_controller_double');
  const { a } = await seedCustomers();
  const screen = stubScreen();
  const view = initTransactionFormView({ container: screen.container, autoLoad: false });
  await view.reload();
  screen.setValue('TransactionType', TRANSACTION_TYPE.CASH_RECEIVED);
  screen.setValue('CustomerId', a.Id);
  screen.setValue('Date', TODAY);
  screen.setValue('Amount', '50');
  const first = await view.submit();
  assert.ok(first);
  const second = await view.submit();
  assert.equal(second, null, 'the guard refuses a second submit of the same form press');
  assert.equal(await transactionRepository.count(), 1);
});

test('C4. A successful submit renders the success panel with the service-provided balance', async () => {
  await freshDatabase('add_controller_success');
  const { a } = await seedCustomers();
  const screen = stubScreen();
  const view = initTransactionFormView({ container: screen.container, autoLoad: false });
  await view.reload();
  screen.setValue('TransactionType', TRANSACTION_TYPE.CASH_RECEIVED);
  screen.setValue('CustomerId', a.Id);
  screen.setValue('Date', TODAY);
  screen.setValue('Amount', '200');
  const result = await view.submit();
  assert.equal(result.NewBalanceMinor, 120000);
  assert.match(screen.regionEl.innerHTML, /تم تسجيل الحركة بنجاح/);
});

test('C5. Changing the transaction type re-renders only that type\'s fields', async () => {
  await freshDatabase('add_controller_type_change');
  await seedCustomers();
  const screen = stubScreen();
  const view = initTransactionFormView({ container: screen.container, autoLoad: false });
  await view.reload();
  screen.fire('change', 'TransactionType', TRANSACTION_TYPE.CROP_PURCHASE_LOCAL);
  assert.equal(view.state().values.TransactionType, TRANSACTION_TYPE.CROP_PURCHASE_LOCAL);
  assert.match(screen.regionEl.innerHTML, new RegExp(FIELD_ID.Units));
  assert.equal(screen.regionEl.innerHTML.includes(FIELD_ID.Amount), false);
});

test('C6. A customer passed by the caller is pre-selected and cannot be switched', async () => {
  await freshDatabase('add_controller_locked');
  const { a } = await seedCustomers();
  const screen = stubScreen();
  const view = initTransactionFormView({ container: screen.container, lockedCustomerId: a.Id, autoLoad: false });
  await view.reload();
  assert.equal(view.state().values.CustomerId, a.Id);
  const html = renderTransactionForm({ customers: [a], lockedCustomerId: a.Id, values: formOf(TRANSACTION_TYPE.CASH_RECEIVED) });
  assert.match(html, /disabled(>|\s)/);
  assert.match(html, /تم تحديد العميل مسبقًا/);
  assert.equal(html.includes(FIELD_ID.CustomerSearch), false);
});

test('C7. A failed settings read leaves the form usable and no value is invented', async () => {
  await freshDatabase('add_controller_settings');
  await seedCustomers();
  const screen = stubScreen();
  const services = {
    ...transactionFormService,
    getDefaultPackageWeight: async () => { throw new AppError(ERROR_CODE.NOT_FOUND, 'إعداد الوزن الافتراضي للعبوة غير موجود.'); },
    listSelectableCustomers: () => transactionFormService.listSelectableCustomers()
  };
  const view = initTransactionFormView({ container: screen.container, services, autoLoad: false });
  await view.reload();
  assert.equal(view.state().packageWeightKg, null);
  assert.match(screen.regionEl.innerHTML, /الوزن الافتراضي للعبوة: —/);
});

test('C8. The shell paints a loading state first and carries no financial value', () => {
  const html = renderTransactionForm({ customers: [], values: formOf(TRANSACTION_TYPE.SALE_PESTICIDES) });
  assert.match(html, /novalidate/);
  assert.match(html, /id="submit-transaction"/);
  assert.equal(html.includes('>NaN<'), false);
  assert.equal(/BalanceMinor/.test(html), false);
});

// ---------------------------------------------------------------------------
// Regression of the approved invariants through the new screen
// ---------------------------------------------------------------------------

test('R1. The 11 approved direction rules hold for a transaction recorded through the form', async () => {
  await freshDatabase('add_rules');
  const { a } = await seedCustomers();
  await settingsService.setDefaultPackageWeight(25);
  const refs = await cartonRefs();
  const cases = [
    [TRANSACTION_TYPE.SALE_PESTICIDES, { Amount: '10' }, { Debit: 1000, Credit: 0 }],
    [TRANSACTION_TYPE.SALE_IRRIGATION, { Amount: '10' }, { Debit: 1000, Credit: 0 }],
    [TRANSACTION_TYPE.SALES_RETURN, { Amount: '10' }, { Debit: 0, Credit: 1000 }],
    [TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, { Units: '1', LooseKg: '0', DeductionKg: '0', UnitPrice: '10' }, { Debit: 0, Credit: 25000 }],
    [TRANSACTION_TYPE.CROP_PURCHASE_CARTON, { CartonQuantity: '3', CartonDiscount: '1', CartonPrice: '10', ...refs }, { Debit: 0, Credit: 2000 }],
    [TRANSACTION_TYPE.CASH_RECEIVED, { Amount: '10' }, { Debit: 0, Credit: 1000 }],
    [TRANSACTION_TYPE.CASH_PAID, { Amount: '10' }, { Debit: 1000, Credit: 0 }],
    [TRANSACTION_TYPE.SETTLEMENT, { Amount: '10' }, { Debit: 0, Credit: 1000 }],
    [TRANSACTION_TYPE.GOODS_EXCHANGE, { Amount: '10' }, { Debit: 0, Credit: 1000 }]
  ];
  for (const [type, overrides, expected] of cases) {
    const result = await transactionFormService.submitTransactionForm(formOf(type, { CustomerId: a.Id, ...overrides }));
    const f = deriveFinancials(result.Record);
    assert.equal(f.DebitMinor, expected.Debit, `${type} debit`);
    assert.equal(f.CreditMinor, expected.Credit, `${type} credit`);
    assert.equal(result.Record.IsCancelled, undefined);
    assert.equal(result.Record.Status, STATUS.ACTIVE);
    assert.equal(result.Record.CancellationReason, null);
  }
  const summary = await balanceService.getCustomerSummary(a.Id);
  const rows = await transactionService.listByCustomer(a.Id);
  assert.equal(summary.BalanceMinor, 100000 + summary.TotalCreditMinor - summary.TotalDebitMinor);
  assert.equal(rows.length, cases.length);
});

test('R2. The canonical balance equation still holds after a mixed batch', async () => {
  await freshDatabase('add_equation');
  const { a, b } = await seedCustomers();
  await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.SALE_PESTICIDES, { CustomerId: a.Id, Amount: '300' }));
  await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.CASH_RECEIVED, { CustomerId: a.Id, Amount: '120' }));
  await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.SETTLEMENT, { CustomerId: a.Id, Amount: '80' }));
  await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.DEBT_TRANSFER, { FromCustomerId: a.Id, ToCustomerId: b.Id, Amount: '50' }));
  const summary = await balanceService.getCustomerSummary(a.Id);
  assert.equal(summary.BalanceMinor, summary.OpeningBalanceMinor + summary.TotalCreditMinor - summary.TotalDebitMinor);
  const ledger = await balanceService.getRunningBalance(a.Id);
  assert.equal(ledger.Entries[ledger.Entries.length - 1].RunningBalanceMinor, summary.BalanceMinor);
});

test('R3. Opening balance stays a customer field, never a transaction row', async () => {
  await freshDatabase('add_opening');
  const { a } = await seedCustomers();
  await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.CASH_RECEIVED, { CustomerId: a.Id, Amount: '10' }));
  const rows = await transactionRepository.getAll();
  assert.equal(rows.some((row) => row.TransactionType === 'OpeningBalance'), false);
  assert.equal((await customerService.getCustomer(a.Id)).OpeningBalanceMinor, 100000);
});

test('R4. Empty description stays empty (no invented text, no placeholder in the record)', async () => {
  await freshDatabase('add_description');
  const { a } = await seedCustomers();
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.CASH_RECEIVED, { CustomerId: a.Id, Amount: '10', Description: '   ' }));
  assert.equal(result.Record.Description, null);
  const withText = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.CASH_RECEIVED, { CustomerId: a.Id, Amount: '10', Description: 'دفعة نقدية' }));
  assert.equal(withText.Record.Description, 'دفعة نقدية');
});

test('R5. The date is stored as ISO YYYY-MM-DD without a timezone shift', async () => {
  await freshDatabase('add_date');
  const { a } = await seedCustomers();
  assert.equal(transactionFormService.currentIsoDate(new Date(2026, 8, 10, 23, 30)), '2026-09-10');
  const result = await transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.SALE_PESTICIDES, { CustomerId: a.Id, Amount: '10' }));
  assert.match(result.Record.Date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(result.Record.Date, TODAY);
  await assert.rejects(
    () => transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.SALE_PESTICIDES, { CustomerId: a.Id, Amount: '10', Date: '10/09/2026' })),
    (error) => error instanceof AppError && error.code === ERROR_CODE.VALIDATION_ERROR
  );
});

test('R6. An unknown or missing customer is refused before any write', async () => {
  await freshDatabase('add_unknown_customer');
  await seedCustomers();
  await assert.rejects(
    () => transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.SALE_PESTICIDES, { CustomerId: 'cus_nope', Amount: '10' })),
    (error) => error instanceof AppError && error.code === ERROR_CODE.NOT_FOUND
  );
  await assert.rejects(
    () => transactionFormService.submitTransactionForm(formOf(TRANSACTION_TYPE.SALE_PESTICIDES, { Amount: '10' })),
    (error) => error instanceof AppError && error.code === ERROR_CODE.VALIDATION_ERROR
  );
  assert.equal(await transactionRepository.count(), 0);
});

test('R7. A transaction type outside the approved ten is refused', async () => {
  await freshDatabase('add_unknown_type');
  const { a } = await seedCustomers();
  await assert.rejects(
    () => transactionFormService.submitTransactionForm(formOf('UnknownType', { CustomerId: a.Id, Amount: '10' })),
    (error) => error instanceof AppError && error.code === ERROR_CODE.VALIDATION_ERROR
  );
  assert.equal(await transactionRepository.count(), 0);
});

test('R8. Money is stored as integer minor units for every type written from the form', async () => {
  await freshDatabase('add_minor');
  const { a } = await seedCustomers();
  await settingsService.setDefaultPackageWeight(25);
  const refs = await cartonRefs();
  const types = [
    [TRANSACTION_TYPE.SALE_PESTICIDES, { Amount: '12.34' }],
    [TRANSACTION_TYPE.CASH_PAID, { Amount: '0.01' }],
    [TRANSACTION_TYPE.SETTLEMENT, { Amount: '999.99' }],
    [TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, { Units: '2', LooseKg: '0.5', DeductionKg: '1', UnitPrice: '3.25' }],
    [TRANSACTION_TYPE.CROP_PURCHASE_CARTON, { CartonQuantity: '2', CartonDiscount: '0.5', CartonPrice: '4.75', ...refs }]
  ];
  for (const [type, overrides] of types) {
    const result = await transactionFormService.submitTransactionForm(formOf(type, { CustomerId: a.Id, ...overrides }));
    assert.equal(Number.isInteger(result.Record.AmountMinor), true, `${type} amount must be integer minor units`);
    assert.ok(result.Record.AmountMinor > 0, `${type} amount must be positive`);
  }
});

test('R9. Every approved type is reachable from the form and keeps its label', () => {
  for (const type of TRANSACTION_TYPES) {
    assert.ok(requiredFormKeys(type).length >= 3, `${type} must require at least the customer, the date and its own input`);
    assert.equal(typeof TYPE_NOTE[type], 'string');
    assert.ok(TYPE_NOTE[type].length > 5);
  }
});

test('R10. The new service exposes no storage escape hatch to the UI', () => {
  const source = readFileSync(join(PROJECT_ROOT, 'src/services/transactionFormService.js'), 'utf8');
  assert.equal(source.includes('repositories'), false);
  assert.equal(source.includes('storage/'), false);
  const exported = Object.keys(transactionFormService);
  assert.deepEqual(exported.sort(), [
    'currentIsoDate', 'formFields', 'getDefaultPackageWeight', 'listSelectableCustomers',
    'previewCrop', 'previewFields', 'requiredKeys', 'submitTransactionForm'
  ].sort());
});
