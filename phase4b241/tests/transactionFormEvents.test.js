// Phase 4B.3.1 — controller / event-flow tests for the Add Transaction screen.
//
// These tests dispatch events the way a REAL browser does: changing a <select>
// fires `input` and THEN `change`. That ordering is exactly what broke the dynamic
// field rendering after Phase 4B.3, so every type-change assertion here goes
// through `fireSelect()`. Rendering `renderDynamicFields()` on its own is not
// evidence of the fix and is not used as such.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDatabase } from './helpers.js';
import { customerService, settingsService, transactionFormService } from '../src/services/index.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { TRANSACTION_TYPE, TRANSACTION_TYPES } from '../src/domain/transactionTypes.js';
import { emptyForm, FORM_KEY } from '../src/validation/transactionFormInput.js';
import { formatMoneyMinor, formatQuantityMinor } from '../src/utils/formatting.js';
import {
  initTransactionFormView, FIELD_ID, TRANSACTION_FORM_REGION_ID, CROP_PREVIEW_ID
} from '../ui/views/transactionForm.js';

const TODAY = '2026-09-10';

// A minimal stand-in for the screen DOM: the real controller code is exercised
// against it, including the browser's input-then-change ordering.
function stubScreen() {
  const controls = {};
  const handlers = {};
  const regionEl = {
    innerHTML: '',
    attributes: {},
    isConnected: true,
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    // Nodes are created on demand so a repaint into an inner region can be observed.
    querySelector(selector) {
      if (!selector.startsWith('#')) return null;
      const key = selector.slice(1);
      if (!controls[key]) controls[key] = { id: key, value: '', innerHTML: '', attributes: {}, setAttribute() {}, getAttribute() { return null; } };
      return controls[key];
    }
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
    nodes() { return controls; },
    setValue(key, value) { this.control(FIELD_ID[key] || `field-${key}`).value = String(value); },
    // The real browser sequence for a <select>: input, then change.
    fireSelect(value) {
      const id = FIELD_ID.TransactionType;
      const payload = () => ({ preventDefault() {}, target: { getAttribute: (name) => (name === 'id' ? id : null), value: String(value), closest: () => null } });
      if (handlers.input) handlers.input(payload());
      if (handlers.change) handlers.change(payload());
      this.control(id).value = String(value);
    },
    // A single change event, with no preceding input (keyboard/programmatic path).
    fireChangeOnly(value) {
      const id = FIELD_ID.TransactionType;
      if (handlers.change) handlers.change({ preventDefault() {}, target: { getAttribute: (name) => (name === 'id' ? id : null), value: String(value), closest: () => null } });
      this.control(id).value = String(value);
    },
    fire(type, key, value) {
      const id = FIELD_ID[key] || `field-${key}`;
      const handler = handlers[type];
      if (!handler) return;
      handler({ preventDefault() {}, target: { getAttribute: (name) => (name === 'id' ? id : null), value: String(value), closest: () => null } });
    }
  };
}

async function screenWith({ customers = [], submitSpy = null, lockedCustomerId = null, preview = null } = {}) {
  const screen = stubScreen();
  let submits = 0;
  const services = {
    ...transactionFormService,
    currentIsoDate: () => TODAY,
    listSelectableCustomers: async () => customers,
    getDefaultPackageWeight: async () => 25,
    previewCrop: async () => (preview || null),
    submitTransactionForm: async (form) => {
      submits += 1;
      if (submitSpy) return submitSpy(form);
      return transactionFormService.submitTransactionForm(form);
    }
  };
  const view = initTransactionFormView({ container: screen.container, lockedCustomerId, services, autoLoad: false });
  await view.reload();
  return {
    screen,
    view,
    submitCount: () => submits,
    html: () => screen.regionEl.innerHTML,
    fields: () => [...screen.regionEl.innerHTML.matchAll(/id="(field-[A-Za-z]+)"/g)].map((match) => match[1])
  };
}

// ---------------------------------------------------------------------------
// 1–10: every type renders its own fields immediately on change
// ---------------------------------------------------------------------------

const AMOUNT_TYPES = [
  TRANSACTION_TYPE.SALE_PESTICIDES,
  TRANSACTION_TYPE.SALE_IRRIGATION,
  TRANSACTION_TYPE.SALES_RETURN,
  TRANSACTION_TYPE.CASH_RECEIVED,
  TRANSACTION_TYPE.CASH_PAID,
  TRANSACTION_TYPE.SETTLEMENT,
  TRANSACTION_TYPE.GOODS_EXCHANGE
];

for (const type of AMOUNT_TYPES) {
  test(`${type}: choosing the type renders its Amount field immediately (input -> change)`, async () => {
    const { screen, fields, view } = await screenWith();
    screen.fireSelect(type);
    assert.equal(view.state().values.TransactionType, type);
    assert.equal(screen.regionEl.attributes['aria-busy'], 'false');
    assert.equal(fields().includes(FIELD_ID.Amount), true, `${type} must show the Amount field right away`);
    assert.equal(fields().includes(FIELD_ID.Units), false);
    assert.equal(fields().includes(FIELD_ID.CartonQuantity), false);
    assert.equal(fields().includes(FIELD_ID.FromCustomerId), false);
    assert.equal(screen.regionEl.innerHTML.includes(FIELD_ID.CustomerId), true);
    assert.equal(screen.regionEl.innerHTML.includes(FIELD_ID.Date), true);
    assert.equal(screen.regionEl.innerHTML.includes(FIELD_ID.Description), true);
  });
}

test('CropPurchaseLocal: D/E/F/H appear immediately and no Amount field exists', async () => {
  const { screen, fields } = await screenWith();
  screen.fireSelect(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL);
  const ids = fields();
  for (const expected of [FIELD_ID.Units, FIELD_ID.LooseKg, FIELD_ID.DeductionKg, FIELD_ID.UnitPrice]) {
    assert.equal(ids.includes(expected), true, `CropPurchaseLocal must render ${expected} immediately`);
  }
  assert.equal(ids.includes(FIELD_ID.Amount), false, 'CropPurchaseLocal must never render an Amount field');
  assert.equal(screen.regionEl.innerHTML.includes(FIELD_ID.CartonQuantity), false);
});

test('CropPurchaseCarton: K/M/L appear immediately and no Amount field exists', async () => {
  const { screen, fields } = await screenWith();
  screen.fireSelect(TRANSACTION_TYPE.CROP_PURCHASE_CARTON);
  const ids = fields();
  for (const expected of [FIELD_ID.CartonQuantity, FIELD_ID.CartonDiscount, FIELD_ID.CartonPrice]) {
    assert.equal(ids.includes(expected), true, `CropPurchaseCarton must render ${expected} immediately`);
  }
  assert.equal(ids.includes(FIELD_ID.Amount), false, 'CropPurchaseCarton must never render an Amount field');
  assert.equal(screen.regionEl.innerHTML.includes(FIELD_ID.Units), false);
});

test('DebtTransfer: From / To / Amount appear immediately and the single customer picker is replaced', async () => {
  const { screen, fields } = await screenWith();
  screen.fireSelect(TRANSACTION_TYPE.DEBT_TRANSFER);
  const ids = fields();
  for (const expected of [FIELD_ID.FromCustomerId, FIELD_ID.ToCustomerId, FIELD_ID.Amount]) {
    assert.equal(ids.includes(expected), true, `DebtTransfer must render ${expected} immediately`);
  }
  assert.equal(screen.regionEl.innerHTML.includes(`id="${FIELD_ID.CustomerSearch}"`), false, 'the single customer picker is not shown for a transfer');
});

test('A single change event (no preceding input) also re-renders the dynamic fields', async () => {
  const { screen, fields } = await screenWith();
  screen.fireChangeOnly(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL);
  assert.equal(fields().includes(FIELD_ID.Units), true);
});

test('Re-selecting the type that is already rendered stays idempotent', async () => {
  const { screen, fields, submitCount } = await screenWith();
  screen.fireSelect(TRANSACTION_TYPE.CASH_RECEIVED);
  const after1 = fields().join(',');
  screen.fireSelect(TRANSACTION_TYPE.CASH_RECEIVED);
  assert.equal(fields().join(','), after1);
  assert.equal(submitCount(), 0);
});

// ---------------------------------------------------------------------------
// 11–12: changing the type is a UI-only act
// ---------------------------------------------------------------------------

test('11. Changing the type never shows a validation error and never marks a field invalid', async () => {
  const { screen } = await screenWith();
  const sequence = [TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, TRANSACTION_TYPE.CASH_PAID, TRANSACTION_TYPE.DEBT_TRANSFER, TRANSACTION_TYPE.SALE_PESTICIDES];
  for (const type of sequence) {
    screen.fireSelect(type);
    assert.equal(screen.regionEl.attributes['aria-busy'], 'false');
    assert.equal(screen.regionEl.innerHTML.includes('تعذّر تسجيل الحركة'), false, `${type}: no error banner on type change`);
    assert.equal(screen.regionEl.innerHTML.includes('aria-invalid="true"'), false, `${type}: no field is marked invalid on type change`);
    assert.equal(screen.regionEl.innerHTML.includes('field__error'), false, `${type}: no field error text on type change`);
  }
});

test('12. Changing the type never submits: the service write is not called once', async () => {
  const { screen, submitCount } = await screenWith();
  for (const type of TRANSACTION_TYPES) screen.fireSelect(type);
  assert.equal(submitCount(), 0, 'no write may happen while only the type changes');
});

test('16. The previous type fields disappear when the type changes', async () => {
  const { screen, fields } = await screenWith();
  screen.fireSelect(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL);
  assert.equal(fields().includes(FIELD_ID.Units), true);
  screen.fireSelect(TRANSACTION_TYPE.CASH_RECEIVED);
  const ids = fields();
  assert.equal(ids.includes(FIELD_ID.Units), false);
  assert.equal(ids.includes(FIELD_ID.LooseKg), false);
  assert.equal(ids.includes(FIELD_ID.DeductionKg), false);
  assert.equal(ids.includes(FIELD_ID.UnitPrice), false);
  assert.equal(ids.includes(FIELD_ID.Amount), true);
  assert.equal(screen.regionEl.innerHTML.includes(FIELD_ID.CartonQuantity), false);
});

// ---------------------------------------------------------------------------
// 13–15, 17–18: state carried across the change
// ---------------------------------------------------------------------------

test('13/14/15. Customer, Date and Description survive the type change; Amount is dropped', async () => {
  const customer = { Id: 'cus_1', Code: 'C-1', Name: 'أحمد المصري' };
  const { screen, view, fields } = await screenWith({ customers: [customer] });
  screen.fireSelect(TRANSACTION_TYPE.SALE_PESTICIDES);
  screen.setValue('CustomerId', 'cus_1');
  screen.setValue('Date', TODAY);
  screen.setValue('Description', 'بيان محفوظ');
  screen.setValue('Amount', '500');
  screen.fire('change', 'CustomerId', 'cus_1');
  screen.fire('input', 'Description', 'بيان محفوظ');
  screen.fire('change', 'Amount', '500');

  screen.fireSelect(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL);
  const state = view.state();
  assert.equal(state.values.CustomerId, 'cus_1');
  assert.equal(state.values.Date, TODAY);
  assert.equal(state.values.Description, 'بيان محفوظ');
  assert.equal(state.values.Amount === '' || state.values.Amount === null || state.values.Amount === undefined, true, 'the sales amount is not carried over');
  assert.equal(fields().includes(FIELD_ID.Units), true, 'the new type fields are rendered immediately');
  assert.equal(screen.regionEl.innerHTML.includes('value="500"'), false, 'the old amount value is not written into any field');
  assert.equal(screen.regionEl.innerHTML.includes('value="بيان محفوظ"'), true, 'the description is re-rendered');
  assert.equal(screen.regionEl.innerHTML.includes(`value="${TODAY}"`), true, 'the date is re-rendered');
});

test('13b. A caller-provided customer stays selected while the type changes', async () => {
  const customer = { Id: 'cus_locked', Code: 'C-9', Name: 'عميل محدد' };
  const { screen, view } = await screenWith({ customers: [customer], lockedCustomerId: 'cus_locked' });
  assert.equal(view.state().values.CustomerId, 'cus_locked');
  screen.fireSelect(TRANSACTION_TYPE.CASH_RECEIVED);
  assert.equal(view.state().values.CustomerId, 'cus_locked');
  assert.equal(screen.regionEl.innerHTML.includes('id="field-CustomerId"'), true);
  assert.equal(screen.regionEl.innerHTML.includes(FIELD_ID.CustomerSearch), false, 'a pre-selected customer cannot be switched');
});

test('17/18. No crop type ever renders an editable amount, at any point in a long sequence', async () => {
  const { screen } = await screenWith();
  for (const type of TRANSACTION_TYPES) {
    screen.fireSelect(type);
    const isCrop = type === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL || type === TRANSACTION_TYPE.CROP_PURCHASE_CARTON;
    const hasAmount = screen.regionEl.innerHTML.includes(FIELD_ID.Amount);
    assert.equal(hasAmount, !isCrop, `${type}: crop types must not offer an Amount field`);
  }
});

// ---------------------------------------------------------------------------
// 19–20: preview and the real save
// ---------------------------------------------------------------------------

test('19. The crop preview appears after the fields are rendered and updates from the service', async () => {
  let previewCalls = 0;
  const preview = { PackageWeightKg: 25, NetWeightMilli: 98000, AmountMinor: 98000 };
  const screen = stubScreen();
  const services = {
    ...transactionFormService,
    currentIsoDate: () => TODAY,
    listSelectableCustomers: async () => [],
    getDefaultPackageWeight: async () => 25,
    previewCrop: async (form) => {
      previewCalls += 1;
      return form.Units === '4' ? preview : null;
    }
  };
  const view = initTransactionFormView({ container: screen.container, services, autoLoad: false });
  await view.reload();
  screen.fireSelect(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL);
  assert.equal(screen.regionEl.innerHTML.includes(CROP_PREVIEW_ID), true, 'the preview region exists as soon as the type is rendered');
  screen.setValue('Units', '4');
  screen.fire('input', 'Units', '4');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(previewCalls >= 1, 'the preview asks the service after a value is entered');
  const previewBox = screen.nodes()['crop-preview'];
  assert.ok(previewBox && previewBox.innerHTML.length > 0, 'the preview region is repainted once values exist');
  assert.equal(previewBox.innerHTML.includes(formatQuantityMinor(preview.NetWeightMilli)), true, 'the net weight is shown with the weight formatter');
  assert.equal(previewBox.innerHTML.includes(formatMoneyMinor(preview.AmountMinor)), true, 'the computed value is shown with the money formatter');
  assert.equal(previewBox.innerHTML.includes('كجم'), true);
  assert.equal(view.state().preview.AmountMinor, 98000);
});

test('19b. The real crop preview comes from the Core calculator, not from the UI', async () => {
  await freshDatabase('form_events_preview');
  await settingsService.setDefaultPackageWeight(25);
  const preview = await transactionFormService.previewCrop({
    ...emptyForm({ transactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, date: TODAY }),
    Units: '4', LooseKg: '2', DeductionKg: '1', UnitPrice: '10'
  });
  assert.equal(preview.PackageWeightKg, 25);
  assert.equal(preview.NetWeightMilli, 98000);
  assert.equal(preview.AmountMinor, 98000);
  assert.equal(await transactionRepository.count(), 0, 'a preview never writes a record');
});

test('20. The real submit still works after a run of type changes', async () => {
  await freshDatabase('form_events_submit');
  const customer = await customerService.createCustomer({ Code: 'E-1', Name: 'عميل الاختبار', OpeningBalance: 1000 });
  const screen = stubScreen();
  const view = initTransactionFormView({ container: screen.container, services: { ...transactionFormService, currentIsoDate: () => TODAY }, autoLoad: false });
  await view.reload();
  for (const type of [TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, TRANSACTION_TYPE.CASH_PAID, TRANSACTION_TYPE.SETTLEMENT, TRANSACTION_TYPE.SALE_PESTICIDES]) {
    screen.fireSelect(type);
  }
  screen.setValue('CustomerId', customer.Id);
  screen.fire('change', 'CustomerId', customer.Id);
  screen.setValue('Date', TODAY);
  screen.setValue('Amount', '250');
  screen.fire('change', 'Amount', '250');
  const result = await view.submit();
  assert.ok(result, 'the save must succeed');
  assert.equal(result.Record.AmountMinor, 25000);
  assert.equal(result.NewBalanceMinor, 75000);
  assert.equal(await transactionRepository.count(), 1);
  assert.match(screen.regionEl.innerHTML, /تم تسجيل الحركة بنجاح/);
});

test('20b. A rejected save keeps the entered values on the re-rendered form', async () => {
  await freshDatabase('form_events_reject');
  const customer = await customerService.createCustomer({ Code: 'E-2', Name: 'عميل الرفض', OpeningBalance: 0 });
  const screen = stubScreen();
  const view = initTransactionFormView({ container: screen.container, services: { ...transactionFormService, currentIsoDate: () => TODAY }, autoLoad: false });
  await view.reload();
  screen.fireSelect(TRANSACTION_TYPE.SALE_PESTICIDES);
  screen.setValue('CustomerId', customer.Id);
  screen.fire('change', 'CustomerId', customer.Id);
  screen.setValue('Date', TODAY);
  screen.setValue('Amount', '-25');
  screen.fire('change', 'Amount', '-25');
  const result = await view.submit();
  assert.equal(result, null);
  assert.equal(view.state().values.Amount, '-25', 'the entered amount survives the refusal');
  assert.match(screen.regionEl.innerHTML, /تعذّر تسجيل الحركة/);
  assert.equal(await transactionRepository.count(), 0);
});

// ---------------------------------------------------------------------------
// Regression of the Phase 4B.3 screen contract
// ---------------------------------------------------------------------------

test('R. The screen still renders the loading state, keeps the 10 types and never validates on load', async () => {
  const screen = stubScreen();
  const view = initTransactionFormView({
    container: screen.container,
    services: {
      ...transactionFormService,
      currentIsoDate: () => TODAY,
      getDefaultPackageWeight: async () => { throw new Error('settings read failed'); },
      listSelectableCustomers: async () => []
    },
    autoLoad: false
  });
  await view.reload();
  assert.equal(screen.regionEl.attributes['aria-busy'], 'false');
  assert.equal(view.state().packageWeightKg, null);
  assert.match(screen.regionEl.innerHTML, /الوزن الافتراضي للعبوة: —/);
  for (const type of TRANSACTION_TYPES) assert.equal(screen.regionEl.innerHTML.includes(`value="${type}"`), true);
  // The settings read failed here, so the screen must show that failure and still
  // invent no weight and mark no field invalid.
  assert.equal(screen.regionEl.innerHTML.includes('تعذّر تسجيل الحركة'), true);
  assert.equal(screen.regionEl.innerHTML.includes('14 كجم'), false, 'no weight is invented when the read fails');
  assert.equal(screen.regionEl.innerHTML.includes('field-CartonPrice'), false, 'no type-specific field leaks before a type is chosen');
});

test('R2. A clean load shows no error at all, and no type-specific field before a type is chosen', async () => {
  const screen = stubScreen();
  const view = initTransactionFormView({
    container: screen.container,
    services: {
      ...transactionFormService,
      currentIsoDate: () => TODAY,
      listSelectableCustomers: async () => [],
      getDefaultPackageWeight: async () => 25
    },
    autoLoad: false
  });
  await view.reload();
  assert.equal(view.state().customerLoadError, null);
  assert.equal(view.state().packageWeightKg, 25);
  assert.equal(screen.regionEl.attributes['aria-busy'], 'false');
  assert.equal(screen.regionEl.innerHTML.includes('field__error'), false, 'a clean load shows no field error');
  assert.equal(screen.regionEl.innerHTML.includes('تعذّر تسجيل الحركة'), false);
  assert.equal(screen.regionEl.innerHTML.includes('الوزن الافتراضي للعبوة: 25 كجم'), true);
  assert.equal(screen.regionEl.innerHTML.includes('field-CartonPrice'), false);
  assert.equal(screen.regionEl.innerHTML.includes('field-Units'), false);
});
