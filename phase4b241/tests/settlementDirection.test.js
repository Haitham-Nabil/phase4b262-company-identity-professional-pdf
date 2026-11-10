// Phase 4B.5.1 — Settlement & GoodsExchange direction support.
//
// 36 required cases: direction (1-6), cash isolation (7-10), balances (11-19),
// legacy data & persistence (20-25), UI (26-36). Every financial expectation is read
// back from the core; no test helper computes a balance of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { freshDatabase, simulateReload, closeDatabase, configureDatabase } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { balanceService, projectBalanceMinor } from '../src/services/balanceService.js';
import { cancellationService } from '../src/services/cancellationService.js';
import { settlementService } from '../src/services/settlementService.js';
import { paymentService } from '../src/services/paymentService.js';
import { transactionFormService } from '../src/services/transactionFormService.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { deriveFinancials, DIRECTION, LEGACY_DIRECTION, isDirection, normalizeDirection, usesExplicitDirection } from '../src/domain/financialDirection.js';
import { TRANSACTION_TYPE, TRANSACTION_TYPES, DIRECTIONAL_TYPES } from '../src/domain/transactionTypes.js';
import { logger } from '../src/utils/logger.js';
import {
  SETTLEMENTS_REGION_ID, SETTLEMENTS_PREVIEW_ID, SETTLEMENTS_CONFIRM_ID, SETTLEMENTS_FORM_REGION_ID,
  SETTLEMENTS_SUCCESS_ID, SETTLEMENTS_TABS_REGION_ID, SETTLEMENTS_FORM_ID, SETTLEMENTS_SUBMIT_ID,
  SETTLEMENTS_CONFIRM_SUBMIT_ID, SETTLEMENT_FIELD_ID, SETTLEMENT_DIRECTION, DIRECTION_OPTIONS,
  DIRECTION_LABEL_AR, DIRECTION_BADGE_LABEL, SETTLEMENT_TAB, SETTLEMENT_TABS, SETTLEMENT_COLUMNS,
  EMPTY_VALUE, CANCELLED_LABEL, EMPTY_STATE_MESSAGE, NO_RESULTS_MESSAGE, PREVIEW_EMPTY_MESSAGE, CONFIRM_MESSAGE,
  defaultSettlementCriteria, visibleSettlements, movementRow, renderSettlementForm, renderSettlementPreview,
  renderSettlementsSummary, typeLabel, initSettlementsView, directionLabel
} from '../ui/views/settlements.js';
import { LEDGER_COLUMNS, ledgerRow, ledgerTypeLabel } from '../ui/views/customerAccount.js';

logger.disable?.();

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const uiRoot = join(projectRoot, 'ui');

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (full.endsWith('.js')) found.push(full);
  }
  return found;
}

// Minimal detached container, same shape as the approved Phase 4B.5 harness.
function makeNode() {
  return {
    innerHTML: '', attrs: {}, controls: new Map(), isConnected: true,
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key]; },
    querySelector(selector) { return this.controls.get(String(selector)) || null; }
  };
}

function makeContainer() {
  const ids = [SETTLEMENTS_REGION_ID, SETTLEMENTS_FORM_REGION_ID, SETTLEMENTS_PREVIEW_ID, SETTLEMENTS_SUCCESS_ID, SETTLEMENTS_TABS_REGION_ID, 'settlements-summary', 'settlements-toolbar'];
  const nodes = new Map(ids.map((id) => [id, makeNode()]));
  const extra = new Map();
  const handlers = {};
  return {
    nodes,
    attrs: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key]; },
    addEventListener(type, handler) { (handlers[type] = handlers[type] || []).push(handler); },
    dispatch(type, event) { for (const handler of handlers[type] || []) handler(event); },
    querySelector(selector) {
      const key = String(selector).replace(/^#/, '');
      if (nodes.has(key)) return nodes.get(key);
      if (!extra.has(key)) extra.set(key, makeNode());
      return extra.get(key);
    }
  };
}

function fieldValue(value) {
  return { value, getAttribute(name) { return name === 'value' ? value : null; }, setAttribute() {} };
}

function fillForm(container, { customerId, date, direction = SETTLEMENT_DIRECTION.CREDIT, amount, description = '' } = {}) {
  const form = container.querySelector(`#${SETTLEMENTS_FORM_ID}`);
  form.controls.set(`#${SETTLEMENT_FIELD_ID.CustomerId}`, fieldValue(customerId));
  form.controls.set(`#${SETTLEMENT_FIELD_ID.Date}`, fieldValue(date));
  form.controls.set(`#${SETTLEMENT_FIELD_ID.Direction}`, fieldValue(direction));
  form.controls.set(`#${SETTLEMENT_FIELD_ID.Amount}`, fieldValue(amount));
  form.controls.set(`#${SETTLEMENT_FIELD_ID.Description}`, fieldValue(description));
  form.controls.set(`#${SETTLEMENT_FIELD_ID.CustomerSearch}`, fieldValue(''));
  if (!form.controls.get(`#${SETTLEMENTS_SUBMIT_ID}`)) {
    form.controls.set(`#${SETTLEMENTS_SUBMIT_ID}`, {
      disabled: false, innerHTML: '',
      setAttribute(key, value) { this[key] = value; },
      getAttribute(key) { return this[key] ?? null; }
    });
  }
  return form;
}

async function seedCustomer({ code = 'C-800', name = 'مزارع الاتجاه', opening = 0 } = {}) {
  return customerService.createCustomer({ Code: code, Name: name, Phone: '0100000000', Region: 'المنوفية', OpeningBalance: opening });
}

// A record written the way the approved pre-4B.5.1 release wrote it: NO Direction key
// at all. It goes in through the real repository, i.e. the real IndexedDB path.
async function seedLegacyRow({ customerId, transactionType, date, amountMinor, id }) {
  const now = new Date().toISOString();
  const row = {
    Id: id,
    CustomerId: customerId,
    Date: date,
    TransactionType: transactionType,
    Description: null,
    AmountMinor: amountMinor,
    LinkId: null,
    TransferRole: null,
    Status: 'Active',
    CancellationReason: null,
    CancelledAt: null,
    CreatedAt: now,
    UpdatedAt: now,
    LocalUnitsMilli: null, LocalLooseKgMilli: null, LocalDeductionKgMilli: null, LocalUnitPriceMinor: null,
    CartonQuantityMilli: null, CartonUnitPriceMinor: null, CartonDiscountMinor: null
  };
  await transactionRepository.add(row);
  return row;
}

const DIRECTIONS = [DIRECTION.CREDIT, DIRECTION.DEBIT];
const TYPES = [TRANSACTION_TYPE.SETTLEMENT, TRANSACTION_TYPE.GOODS_EXCHANGE];

// ---------------------------------------------------------------------------
// 1-6 — direction.
// ---------------------------------------------------------------------------

test('1. A Settlement Credit increases the balance by the amount', async () => {
  await freshDatabase('d1');
  const customer = await seedCustomer({ opening: 1000 });
  const result = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Credit', Amount: '200'
  });
  assert.equal(result.Record.Direction, 'Credit');
  const f = deriveFinancials(await transactionService.getTransaction(result.Record.Id));
  assert.equal(f.direction, 'Credit');
  assert.equal(f.CreditMinor, 20000);
  assert.equal(f.DebitMinor, 0);
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 100000 + 20000);
});

test('2. A Settlement Debit decreases the balance by the amount', async () => {
  await freshDatabase('d2');
  const customer = await seedCustomer({ opening: 1000 });
  const result = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Debit', Amount: '150'
  });
  assert.equal(result.Record.Direction, 'Debit');
  const f = deriveFinancials(await transactionService.getTransaction(result.Record.Id));
  assert.equal(f.direction, 'Debit');
  assert.equal(f.DebitMinor, 15000);
  assert.equal(f.CreditMinor, 0);
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 100000 - 15000);
});

test('3. A GoodsExchange Credit increases the balance by the amount', async () => {
  await freshDatabase('d3');
  const customer = await seedCustomer({ opening: 500 });
  const result = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Credit', Amount: '300'
  });
  assert.equal(result.Record.Direction, 'Credit');
  const f = deriveFinancials(await transactionService.getTransaction(result.Record.Id));
  assert.equal(f.CreditMinor, 30000);
  assert.equal(f.DebitMinor, 0);
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 50000 + 30000);
});

test('4. A GoodsExchange Debit decreases the balance by the amount', async () => {
  await freshDatabase('d4');
  const customer = await seedCustomer({ opening: 500 });
  const result = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Debit', Amount: '120'
  });
  assert.equal(result.Record.Direction, 'Debit');
  const f = deriveFinancials(await transactionService.getTransaction(result.Record.Id));
  assert.equal(f.DebitMinor, 12000);
  assert.equal(f.CreditMinor, 0);
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 50000 - 12000);
});

test('5. An invalid direction value is refused and writes nothing', async () => {
  await freshDatabase('d5');
  const customer = await seedCustomer();
  for (const direction of ['credit', 'DEBIT', 'Up', 'Down', 'x', 0, 1, true, {}]) {
    await assert.rejects(() => settlementService.createSettlementMovement({
      TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: direction, Amount: '10'
    }), (error) => error.code === 'VALIDATION_ERROR' && error.field === 'Direction', `direction ${JSON.stringify(direction)} must be refused`);
  }
  assert.equal((await settlementService.listSettlementMovements()).length, 0);
  // A blank direction carries no value at all, so it keeps the approved legacy Credit.
  const blank = await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: '', Amount: '10' });
  assert.equal(blank.Record.Direction, 'Credit');
  // The core refuses it too, not just the validator.
  assert.throws(() => deriveFinancials({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, AmountMinor: 100, Status: 'Active', Direction: 'Up' }), /اتجاه الحركة غير صالح/);
});

test('6. Direction is refused on a type whose approved rules do not use it', async () => {
  await freshDatabase('d6');
  const customer = await seedCustomer();
  for (const type of TRANSACTION_TYPES.filter((entry) => !DIRECTIONAL_TYPES.includes(entry))) {
    const draft = { CustomerId: customer.Id, Date: '2026-10-01', TransactionType: type, Direction: 'Debit' };
    if (type === TRANSACTION_TYPE.DEBT_TRANSFER) {
      draft.FromCustomerId = customer.Id; draft.ToCustomerId = customer.Id; draft.LinkId = 'L1'; draft.TransferRole = 'CreditSide';
    } else if (type === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL) {
      draft.crop = { LocalUnitsMilli: 1000, LocalLooseKgMilli: 0, LocalDeductionKgMilli: 0, LocalUnitPriceMinor: 100 };
    } else if (type === TRANSACTION_TYPE.CROP_PURCHASE_CARTON) {
      draft.crop = { CartonQuantityMilli: 1000, CartonDiscountMinor: 0, CartonUnitPriceMinor: 100 };
    } else {
      draft.Amount = 10;
    }
    await assert.rejects(() => transactionService.createTransaction(draft),
      (error) => error.code === 'BUSINESS_RULE_ERROR'
        || (error.details && Array.isArray(error.details.errors)
          && error.details.errors.some((item) => item.field === 'Direction' && item.code === 'BUSINESS_RULE_ERROR')),
      `${type} must refuse a Direction`);
  }
  assert.equal((await transactionService.listByCustomer(customer.Id)).length, 0);
  // The core refuses a stray direction on another type as well.
  assert.throws(() => deriveFinancials({ TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, AmountMinor: 100, Status: 'Active', Direction: 'Debit' }), /حقل الاتجاه مسموح فقط/);
});

// ---------------------------------------------------------------------------
// 7-10 — cash isolation.
// ---------------------------------------------------------------------------

test('7, 8, 9. All four direction cases carry zero cash and are non-cash', async () => {
  await freshDatabase('d789');
  const customer = await seedCustomer({ opening: 1000 });
  for (const type of TYPES) {
    for (const direction of DIRECTIONS) {
      const result = await settlementService.createSettlementMovement({
        TransactionType: type, CustomerId: customer.Id, Date: '2026-10-01', Direction: direction, Amount: '40'
      });
      const f = deriveFinancials(await transactionService.getTransaction(result.Record.Id));
      assert.equal(f.CashReceivedMinor, 0, `${type}/${direction} cash received`);
      assert.equal(f.CashPaidMinor, 0, `${type}/${direction} cash paid`);
      assert.equal(f.isCash, false, `${type}/${direction} isCash`);
      assert.equal(f.isNonCash, true, `${type}/${direction} isNonCash`);
      assert.equal(f.SettlementMinor, 4000, `${type}/${direction} keeps its non-cash value`);
    }
  }
  const rows = await settlementService.listSettlementMovements();
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.CashReceivedMinor, 0);
    assert.equal(row.CashPaidMinor, 0);
    assert.equal(row.SettlementMinor, 4000);
  }
});

test('10. The Payments totals are untouched by any of the four direction cases', async () => {
  await freshDatabase('d10');
  const customer = await seedCustomer({ opening: 1000 });
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Date: '2026-10-01', Amount: '100' });
  await paymentService.createCashMovement({ TransactionType: TRANSACTION_TYPE.CASH_PAID, CustomerId: customer.Id, Date: '2026-10-02', Amount: '30' });
  const before = paymentService.summarize(await paymentService.listCashMovements());
  for (const type of TYPES) {
    for (const direction of DIRECTIONS) {
      await settlementService.createSettlementMovement({ TransactionType: type, CustomerId: customer.Id, Date: '2026-10-03', Direction: direction, Amount: '500' });
    }
  }
  const after = paymentService.summarize(await paymentService.listCashMovements());
  assert.deepEqual(after, before, 'the cash screen is completely unaffected');
  assert.equal(after.CashReceivedMinor, 10000);
  assert.equal(after.CashPaidMinor, 3000);
  assert.equal(after.NetCashMinor, 7000);
  assert.equal((await paymentService.listCashMovements()).length, 2, 'no non-cash row leaked into Payments');
});

// ---------------------------------------------------------------------------
// 11-19 — balances.
// ---------------------------------------------------------------------------

test('11, 12, 13, 14. Credit raises and Debit lowers the balance for both types', async () => {
  await freshDatabase('d1112');
  const customer = await seedCustomer({ opening: 1000 });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Credit', Amount: '200' });
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 120000);
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-02', Direction: 'Debit', Amount: '50' });
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 115000);
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-03', Direction: 'Credit', Amount: '300' });
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 145000);
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-04', Direction: 'Debit', Amount: '100' });
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.BalanceMinor, 135000);
  // The single approved formula still holds, with the derived sides.
  assert.equal(summary.BalanceMinor, summary.OpeningBalanceMinor + summary.TotalCreditMinor - summary.TotalDebitMinor);
  assert.equal(summary.TotalCreditMinor, 50000);
  assert.equal(summary.TotalDebitMinor, 15000);
});

test('15. A Debit that exceeds the credit balance is allowed and turns the balance negative', async () => {
  await freshDatabase('d15');
  const customer = await seedCustomer({ opening: 100 });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Debit', Amount: '250' });
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.BalanceMinor, -15000);
  assert.equal(summary.BalanceSide, 'Debit');
});

test('16. The projected balance shown before saving equals the balance after saving', async () => {
  await freshDatabase('d16');
  const customer = await seedCustomer({ opening: 1000 });
  const preview = await settlementService.previewMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Direction: 'Debit', Amount: '300'
  });
  assert.equal(preview.CurrentBalanceMinor, 100000);
  assert.equal(preview.ProjectedBalanceMinor, 70000);
  assert.equal(preview.Insufficient, false);
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Debit', Amount: '300' });
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, preview.ProjectedBalanceMinor);
  // And it agrees with the core projection helper used by the service.
  assert.equal(preview.ProjectedBalanceMinor, projectBalanceMinor(100000, deriveFinancials({ TransactionType: 'Settlement', AmountMinor: 30000, Status: 'Active', Direction: 'Debit' })));
});

test('17. The running balance walks the full sequence, both directions mixed', async () => {
  await freshDatabase('d17');
  const customer = await seedCustomer({ opening: 1000 });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Credit', Amount: '200' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-02', Direction: 'Debit', Amount: '50' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-03', Direction: 'Debit', Amount: '400' });
  const rows = await settlementService.listSettlementMovements();
  assert.deepEqual(rows.map((row) => row.RunningBalanceMinor), [120000, 115000, 75000]);
  const ledger = await balanceService.getRunningBalance(customer.Id);
  assert.deepEqual(rows.map((row) => row.RunningBalanceMinor), ledger.Entries.map((entry) => entry.RunningBalanceMinor));
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 75000);
});

test('18. Applying display filters never changes a running balance', async () => {
  await freshDatabase('d18');
  const customer = await seedCustomer({ opening: 1000 });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Credit', Amount: '100' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-02', Direction: 'Debit', Amount: '200' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-03', Direction: 'Credit', Amount: '300' });
  const rows = await settlementService.listSettlementMovements();
  const all = rows.map((row) => row.RunningBalanceMinor);
  const narrowed = visibleSettlements(rows, { ...defaultSettlementCriteria(), type: TRANSACTION_TYPE.SETTLEMENT });
  assert.equal(narrowed.length, 2);
  assert.deepEqual(narrowed.map((row) => row.RunningBalanceMinor), [all[0], all[1]], 'the narrowed rows keep their own sequence values');
  assert.deepEqual((await settlementService.listSettlementMovements()).map((row) => row.RunningBalanceMinor), all, 'the full sequence is untouched');
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 120000);
});

test('19. A cancelled movement is excluded from balances and totals but stays visible', async () => {
  await freshDatabase('d19');
  const customer = await seedCustomer({ opening: 1000 });
  const credit = await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Credit', Amount: '300' });
  const debit = await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-02', Direction: 'Debit', Amount: '100' });
  await cancellationService.cancelTransaction(debit.Record.Id, 'تكرار');
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.BalanceMinor, 100000 + 30000, 'the cancelled debit no longer reduces the balance');
  const rows = await settlementService.listSettlementMovements();
  assert.equal(rows.length, 2, 'both rows stay visible');
  const totals = settlementService.summarize(rows);
  assert.equal(totals.SettlementCreditMinor, 30000);
  assert.equal(totals.SettlementDebitMinor, 0, 'the cancelled debit is not summed');
  assert.equal(totals.NetSettlementMinor, 30000);
  assert.equal(totals.CancelledCount, 1);
  const cancelledRow = rows.find((row) => row.Id === debit.Record.Id);
  assert.equal(cancelledRow.IsCancelled, true);
  assert.equal(movementRow(cancelledRow).className, 'ledger-row--cancelled');
  assert.match(movementRow(cancelledRow).cells[10], new RegExp(CANCELLED_LABEL));
  assert.ok(credit);
});

// ---------------------------------------------------------------------------
// 20-25 — legacy data and persistence.
// ---------------------------------------------------------------------------

test('20. A legacy Settlement row with no Direction is read as a Credit', async () => {
  await freshDatabase('d20');
  const customer = await seedCustomer({ opening: 1000 });
  await seedLegacyRow({ customerId: customer.Id, transactionType: TRANSACTION_TYPE.SETTLEMENT, date: '2026-09-01', amountMinor: 25000, id: 'legacy_set_1' });
  const stored = await transactionService.getTransaction('legacy_set_1');
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'Direction') && stored.Direction !== null, false, 'the stored row really has no direction');
  const f = deriveFinancials(stored);
  assert.equal(f.direction, 'Credit');
  assert.equal(f.CreditMinor, 25000);
  assert.equal(f.DebitMinor, 0);
  const [row] = await settlementService.listSettlementMovements();
  assert.equal(row.Direction, null, 'the read model reports no stored direction');
  assert.equal(row.CreditMinor, 25000);
  assert.equal(row.DebitMinor, 0);
  assert.match(movementRow(row).cells[7], /250\.00/, 'the statement shows it as a credit');
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 125000);
});

test('21. A legacy GoodsExchange row with no Direction is read as a Credit', async () => {
  await freshDatabase('d21');
  const customer = await seedCustomer({ opening: 0 });
  await seedLegacyRow({ customerId: customer.Id, transactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, date: '2026-09-02', amountMinor: 40000, id: 'legacy_ge_1' });
  const f = deriveFinancials(await transactionService.getTransaction('legacy_ge_1'));
  assert.equal(f.direction, 'Credit');
  assert.equal(f.CreditMinor, 40000);
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 40000);
  const totals = settlementService.summarize(await settlementService.listSettlementMovements());
  assert.equal(totals.GoodsExchangeCreditMinor, 40000);
  assert.equal(totals.GoodsExchangeDebitMinor, 0);
});

test('22. Existing movement values are retained across the database upgrade', async () => {
  await freshDatabase('d22');
  const customer = await seedCustomer({ opening: 1000 });
  await seedLegacyRow({ customerId: customer.Id, transactionType: TRANSACTION_TYPE.SETTLEMENT, date: '2026-09-01', amountMinor: 12345, id: 'legacy_keep_1' });
  await seedLegacyRow({ customerId: customer.Id, transactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, date: '2026-09-02', amountMinor: 54321, id: 'legacy_keep_2' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-09-03', Direction: 'Debit', Amount: '77' });
  await simulateReload();
  const rows = await settlementService.listSettlementMovements();
  assert.equal(rows.length, 3);
  const byId = new Map(rows.map((row) => [row.Id, row]));
  assert.equal(byId.get('legacy_keep_1').AmountMinor, 12345, 'the old amount is untouched');
  assert.equal(byId.get('legacy_keep_1').Direction, null, 'no migration rewrote the old row');
  assert.equal(byId.get('legacy_keep_1').CreditMinor, 12345);
  assert.equal(byId.get('legacy_keep_2').AmountMinor, 54321);
  assert.equal(byId.get('legacy_keep_2').CreditMinor, 54321);
  assert.equal(byId.get('legacy_keep_2').DebitMinor, 0);
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 100000 + 12345 + 54321 - 7700);
});

test('23. A new direction survives an application reload', async () => {
  await freshDatabase('d23');
  const customer = await seedCustomer({ opening: 1000 });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Debit', Amount: '150' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-02', Direction: 'Debit', Amount: '50' });
  await simulateReload();
  const rows = await settlementService.listSettlementMovements();
  assert.deepEqual(rows.map((row) => row.Direction), ['Debit', 'Debit']);
  assert.equal(rows[0].DebitMinor, 15000);
  assert.equal(rows[1].DebitMinor, 5000);
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 100000 - 15000 - 5000);
});

test('24. The direction survives closing and reopening the IndexedDB connection', async () => {
  await freshDatabase('d24');
  const customer = await seedCustomer({ opening: 0 });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Credit', Amount: '80' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-02', Direction: 'Debit', Amount: '30' });
  await closeDatabase();
  const info = await (await import('../src/storage/db.js')).openDatabase();
  assert.ok(info);
  const rows = await settlementService.listSettlementMovements();
  assert.deepEqual(rows.map((row) => row.Direction), ['Credit', 'Debit']);
  assert.deepEqual(rows.map((row) => row.CreditMinor), [8000, 0]);
  assert.deepEqual(rows.map((row) => row.DebitMinor), [0, 3000]);
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 5000);
});

test('25. Re-reading after a reload duplicates nothing', async () => {
  await freshDatabase('d25');
  const customer = await seedCustomer({ opening: 1000 });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Credit', Amount: '10' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-02', Direction: 'Debit', Amount: '20' });
  const before = await settlementService.listSettlementMovements();
  await simulateReload();
  const after = await settlementService.listSettlementMovements();
  assert.equal(after.length, before.length);
  assert.deepEqual(after.map((row) => row.Id), before.map((row) => row.Id));
  assert.equal((await transactionService.listByCustomer(customer.Id)).length, 2);
});

// ---------------------------------------------------------------------------
// 26-36 — UI.
// ---------------------------------------------------------------------------

test('26. Switching the direction refreshes the preview without saving anything', async () => {
  await freshDatabase('d26');
  const customer = await seedCustomer({ opening: 1000 });
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  fillForm(container, { customerId: customer.Id, date: '2026-10-01', direction: SETTLEMENT_DIRECTION.CREDIT, amount: '300' });
  const credit = await view.refreshPreview();
  assert.equal(credit.Direction, 'Credit');
  assert.equal(credit.ProjectedBalanceMinor, 130000);
  assert.equal(credit.Insufficient, false);
  fillForm(container, { customerId: customer.Id, date: '2026-10-01', direction: SETTLEMENT_DIRECTION.DEBIT, amount: '300' });
  const debit = await view.refreshPreview();
  assert.equal(debit.Direction, 'Debit');
  assert.equal(debit.DebitMinor, 30000);
  assert.equal(debit.CreditMinor, 0);
  assert.equal(debit.ProjectedBalanceMinor, 70000);
  assert.match(container.querySelector(`#${SETTLEMENTS_PREVIEW_ID}`).innerHTML, /خصم من رصيد المزارع/);
  assert.equal((await settlementService.listSettlementMovements()).length, 0, 'a preview never writes');
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 100000);
});

test('27. Changing the type keeps the shared fields and rebuilds the form correctly', async () => {
  await freshDatabase('d27');
  const customer = await seedCustomer();
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  view.state.values = { CustomerId: customer.Id, CustomerSearch: '', Date: '2026-10-05', Direction: SETTLEMENT_DIRECTION.DEBIT, Amount: '99', Description: 'بيان' };
  assert.equal(view.switchTab(SETTLEMENT_TAB.GOODS_EXCHANGE), true);
  const form = container.querySelector(`#${SETTLEMENTS_FORM_REGION_ID}`).innerHTML;
  assert.match(form, /data-transaction-type="GoodsExchange"/);
  assert.match(form, /id="settlement-direction"/);
  assert.match(form, new RegExp(`value="${customer.Id}" selected`));
  assert.match(form, /value="2026-10-05"/);
  assert.match(form, /value="Debit" selected/);
  assert.match(form, /value="99"/);
  assert.equal((form.match(/id="settlement-direction"/g) || []).length, 1, 'exactly one direction control');
  assert.equal((form.match(/id="settlement-amount"/g) || []).length, 1, 'exactly one amount control');
  assert.equal(view.state.values.Direction, SETTLEMENT_DIRECTION.DEBIT, 'the shared direction survives the switch');
  assert.equal(view.state.fieldErrors.Direction, undefined, 'no stale validation is carried across');
});

test('28. The debt warning appears when a Debit leaves the account in debt', async () => {
  await freshDatabase('d28');
  const customer = await seedCustomer({ opening: 100 });
  const preview = await settlementService.previewMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Direction: 'Debit', Amount: '250' });
  assert.equal(preview.Insufficient, true);
  assert.equal(preview.IncreasesDebt, true);
  assert.equal(preview.CurrentBalanceMinor, 10000);
  assert.equal(preview.ProjectedBalanceMinor, -15000);
  const html = renderSettlementPreview({ preview, awaitingConfirm: true });
  assert.ok(html.includes(CONFIRM_MESSAGE), 'the confirmation wording is shown verbatim');
  assert.ok(html.includes(`id="${SETTLEMENTS_CONFIRM_SUBMIT_ID}"`), 'the confirm button is present');
  assert.match(html, /role="status"|alert--warning/);
  // A credit that only reduces an already-positive balance raises no warning.
  const safe = await settlementService.previewMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Direction: 'Debit', Amount: '50' });
  assert.equal(safe.Insufficient, false);
  assert.equal(safe.IncreasesDebt, false);
});

test('29. Nothing is written before the user confirms the warning', async () => {
  await freshDatabase('d29');
  const customer = await seedCustomer({ opening: 100 });
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  fillForm(container, { customerId: customer.Id, date: '2026-10-01', direction: SETTLEMENT_DIRECTION.DEBIT, amount: '250' });
  const first = await view.submit();
  assert.equal(first, null, 'the first press writes nothing');
  assert.equal(view.state.awaitingConfirm, true);
  assert.match(container.querySelector(`#${SETTLEMENTS_PREVIEW_ID}`).innerHTML, new RegExp(SETTLEMENTS_CONFIRM_SUBMIT_ID));
  assert.equal((await settlementService.listSettlementMovements()).length, 0, 'no row was written before the confirmation');
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 10000, 'the balance is untouched');
  const confirmed = await view.submit({ confirmed: true });
  assert.ok(confirmed, 'the confirmed save succeeds');
  assert.equal((await settlementService.listSettlementMovements()).length, 1);
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, -15000);
});

test('30. A double press can never write two rows', async () => {
  await freshDatabase('d30');
  const customer = await seedCustomer({ opening: 1000 });
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  const formNode = container.querySelector(`#${SETTLEMENTS_FORM_ID}`);
  const submitNode = { disabled: false, setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k] ?? null; } };
  formNode.controls.set(`#${SETTLEMENTS_SUBMIT_ID}`, submitNode);
  fillForm(container, { customerId: customer.Id, date: '2026-10-02', direction: SETTLEMENT_DIRECTION.DEBIT, amount: '40' });
  const [a, b] = await Promise.all([view.submit(), view.submit()]);
  assert.ok(a, 'the first save succeeded');
  assert.equal(b, null, 'the repeated press was refused');
  assert.equal((await settlementService.listSettlementMovements()).length, 1);
  assert.equal(submitNode.disabled, false, 'the button is usable again afterwards');
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 96000);
});

test('31. The statement shows the real type and the real side of each movement', async () => {
  await freshDatabase('d31');
  const customer = await seedCustomer({ opening: 1000 });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Credit', Amount: '100' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-02', Direction: 'Debit', Amount: '60' });
  const ledger = await balanceService.getRunningBalance(customer.Id);
  assert.deepEqual(ledger.Entries.map((entry) => entry.TransactionType), [TRANSACTION_TYPE.SETTLEMENT, TRANSACTION_TYPE.GOODS_EXCHANGE]);
  const labels = ledger.Entries.map((entry) => ledgerTypeLabel(entry.TransactionType));
  assert.deepEqual(labels, ['تسوية', 'تبادل بضائع'], 'GoodsExchange is never shown as a settlement');
  const cells = ledger.Entries.map((entry) => ledgerRow(entry).cells);
  assert.match(cells[0][4], /100\.00/, 'the settlement sits in the credit column');
  assert.ok(cells[0][3].includes(EMPTY_VALUE), 'and not in the debit column');
  assert.match(cells[1][3], /60\.00/, 'the goods exchange debit sits in the debit column');
  assert.ok(cells[1][4].includes(EMPTY_VALUE), 'and not in the credit column');
  assert.equal(LEDGER_COLUMNS[7].label, 'قيمة غير نقدية', 'the non-cash column is not called a settlement');
  assert.equal(LEDGER_COLUMNS[3].label, 'مدين');
  assert.equal(LEDGER_COLUMNS[4].label, 'دائن');
});

test('32. The summary keeps credit totals, debit totals and nets apart', async () => {
  await freshDatabase('d32');
  const customer = await seedCustomer({ opening: 0 });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Credit', Amount: '500' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-02', Direction: 'Debit', Amount: '200' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-03', Direction: 'Credit', Amount: '300' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-04', Direction: 'Debit', Amount: '100' });
  const totals = settlementService.summarize(await settlementService.listSettlementMovements());
  assert.equal(totals.SettlementCreditMinor, 50000);
  assert.equal(totals.SettlementDebitMinor, 20000);
  assert.equal(totals.NetSettlementMinor, 30000);
  assert.equal(totals.GoodsExchangeCreditMinor, 30000);
  assert.equal(totals.GoodsExchangeDebitMinor, 10000);
  assert.equal(totals.NetGoodsExchangeMinor, 20000);
  assert.equal(totals.TotalNonCashMinor, 110000, 'the movement total, not a net');
  assert.equal(totals.NetNonCashMinor, 50000, 'the net impact');
  const html = renderSettlementsSummary(totals);
  for (const label of ['إجمالي التسويات الدائنة', 'إجمالي التسويات المدينة', 'صافي التسويات', 'إجمالي تبادل البضائع الدائن', 'إجمالي تبادل البضائع المدين', 'صافي تبادل البضائع', 'إجمالي التسويات غير النقدية', 'صافي الأثر غير النقدي']) {
    assert.ok(html.includes(label), `${label} must be present`);
  }
  for (const forbidden of ['إجمالي المقبوضات', 'إجمالي النقدية', 'صافي النقدية', 'إجمالي المدفوعات', 'إجمالي المدفوعات النقدية']) {
    assert.equal(html.includes(forbidden), false, `the summary must never use "${forbidden}"`);
  }
});

test('33. Search, the filters and the reset behave exactly as before', async () => {
  await freshDatabase('d33');
  const customer = await seedCustomer({ opening: 0 });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Debit', Amount: '10', Description: 'تسوية مدينة' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-05', Direction: 'Credit', Amount: '20' });
  const rows = await settlementService.listSettlementMovements();
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), search: 'مدينة' }).length, 1);
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), type: TRANSACTION_TYPE.GOODS_EXCHANGE }).length, 1);
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), from: '2026-10-03' }).length, 1);
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), to: '2026-10-03' }).length, 1);
  assert.equal(visibleSettlements(rows, { ...defaultSettlementCriteria(), search: 'zzz' }).length, 0);
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  await view.load();
  view.setCriteria({ search: 'zzz' });
  assert.match(container.querySelector(`#${SETTLEMENTS_REGION_ID}`).innerHTML, new RegExp(NO_RESULTS_MESSAGE));
  container.dispatch('click', { target: { closest: (selector) => (selector === '[data-action="reset-filters"]' ? {} : null) } });
  assert.deepEqual(view.state.criteria, defaultSettlementCriteria());
});

test('34. Loading, empty, no-results and error states all still render', async () => {
  await freshDatabase('d34');
  const container = makeContainer();
  const view = initSettlementsView({ container, autoLoad: false });
  const pending = view.load();
  const loadingHtml = container.querySelector(`#${SETTLEMENTS_REGION_ID}`).innerHTML;
  assert.ok(/spinner/.test(loadingHtml) || /جارٍ/.test(loadingHtml), 'a loading state is shown');
  await pending;
  assert.match(container.querySelector(`#${SETTLEMENTS_REGION_ID}`).innerHTML, new RegExp(EMPTY_STATE_MESSAGE));
  assert.equal(container.querySelector(`#${SETTLEMENTS_REGION_ID}`).attrs['aria-busy'], 'false');
  const customer = await seedCustomer({ opening: 0 });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Credit', Amount: '10' });
  await view.load();
  view.setCriteria({ search: 'لا-يوجد' });
  assert.match(container.querySelector(`#${SETTLEMENTS_REGION_ID}`).innerHTML, new RegExp(NO_RESULTS_MESSAGE));
  const original = settlementService.listSettlementMovements;
  settlementService.listSettlementMovements = async () => { const error = new Error('تعذّر القراءة'); error.code = 'STORAGE_ERROR'; throw error; };
  try {
    await view.load();
    const html = container.querySelector(`#${SETTLEMENTS_REGION_ID}`).innerHTML;
    assert.ok(/تعذّر/.test(html), 'a visible error state is shown');
    assert.match(html, /data-action="retry"/);
    assert.equal(container.querySelector(`#${SETTLEMENTS_REGION_ID}`).attrs['aria-busy'], 'false');
  } finally {
    settlementService.listSettlementMovements = original;
  }
  await view.load();
  assert.equal(view.state.error, null);
});

test('35. No settlement reaches the Payments screen, in either direction', async () => {
  await freshDatabase('d35');
  const customer = await seedCustomer({ opening: 0 });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Debit', Amount: '100' });
  await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-02', Direction: 'Debit', Amount: '200' });
  const cashRows = await paymentService.listCashMovements();
  assert.equal(cashRows.length, 0);
  assert.deepEqual(paymentService.summarize(cashRows), { CashReceivedMinor: 0, CashPaidMinor: 0, NetCashMinor: 0, Count: 0, CancelledCount: 0 });
  const settlementRows = await settlementService.listSettlementMovements();
  assert.equal(settlementRows.length, 2, 'the settlements screen still shows them');
  assert.equal(settlementRows.every((row) => row.CashReceivedMinor === 0 && row.CashPaidMinor === 0), true);
});

test('36. The UI holds no financial engine and no duplicated direction rule', () => {
  const source = readFileSync(join(uiRoot, 'views', 'settlements.js'), 'utf8');
  for (const forbidden of ['deriveFinancials', 'getRunningBalance', 'FINANCIAL_RULES', 'projectBalanceMinor', 'FINANCIAL_ENGINE']) {
    assert.equal(source.includes(forbidden), false, `settlements.js must not use ${forbidden}`);
  }
  assert.doesNotMatch(source, /BalanceMinor\s*[+\-*/]?=/, 'no balance arithmetic in the UI');
  assert.doesNotMatch(source, /CreditMinor\s*[+\-*/]?=/, 'no credit arithmetic in the UI');
  assert.doesNotMatch(source, /DebitMinor\s*[+\-*/]?=/, 'no debit arithmetic in the UI');
  assert.doesNotMatch(source, /OpeningBalanceMinor\s*[+\-]/, 'the balance formula belongs to the core');
  assert.doesNotMatch(source, /Direction\s*=\s*['"](Credit|Debit)['"]\s*;/, 'the UI must not decide a direction by itself');
  assert.doesNotMatch(source, /TODO|FIXME|XXX|HACK/);
  assert.doesNotMatch(source, /window\.alert\(|globalThis\.alert\(|document\.alert\(/, 'no native browser alert()');
  for (const file of walk(uiRoot)) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /TODO|FIXME|XXX|HACK/, `${file} carries a marker`);
    for (const forbidden of ['repositories', 'storage/db', 'storage/schema', 'indexedDB', 'IndexedDB', 'IDBKeyRange']) {
      assert.equal(text.includes(forbidden), false, `${file} must not reference ${forbidden}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Additional guarantees the change needs.
// ---------------------------------------------------------------------------

test('The direction catalogue is limited to the two approved types', () => {
  assert.deepEqual(DIRECTIONAL_TYPES, [TRANSACTION_TYPE.SETTLEMENT, TRANSACTION_TYPE.GOODS_EXCHANGE]);
  assert.equal(usesExplicitDirection(TRANSACTION_TYPE.SETTLEMENT), true);
  assert.equal(usesExplicitDirection(TRANSACTION_TYPE.GOODS_EXCHANGE), true);
  for (const type of TRANSACTION_TYPES.filter((entry) => !DIRECTIONAL_TYPES.includes(entry))) {
    assert.equal(usesExplicitDirection(type), false, `${type} must not take a direction`);
  }
  assert.equal(isDirection('Credit'), true);
  assert.equal(isDirection('Debit'), true);
  assert.equal(isDirection('credit'), false);
  assert.equal(normalizeDirection(undefined), LEGACY_DIRECTION);
  assert.equal(normalizeDirection(''), LEGACY_DIRECTION);
  assert.equal(normalizeDirection('Debit'), 'Debit');
});

test('No derived financial column can be sent from the caller', async () => {
  await freshDatabase('d_derived');
  const customer = await seedCustomer({ opening: 1000 });
  for (const field of ['CreditMinor', 'DebitMinor', 'SettlementMinor', 'CashReceivedMinor', 'CashPaidMinor']) {
    await assert.rejects(() => settlementService.createSettlementMovement({
      TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Debit', Amount: '10', [field]: 999
    }), (error) => error.code === 'BUSINESS_RULE_ERROR', `${field} must be refused as input`);
  }
  assert.equal((await settlementService.listSettlementMovements()).length, 0);
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 100000);
});

test('The amount stays a single positive integer minor value with no override path', async () => {
  await freshDatabase('d_amount');
  const customer = await seedCustomer({ opening: 0 });
  for (const amount of ['', '0', '-1', 'abc', null, undefined]) {
    await assert.rejects(() => settlementService.createSettlementMovement({
      TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Debit', Amount: amount
    }), (error) => error.code === 'VALIDATION_ERROR', `amount ${String(amount)} must be refused`);
  }
  const ok = await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Debit', Amount: '12.34' });
  assert.equal(ok.Record.AmountMinor, 1234);
  assert.equal(Number.isInteger(ok.Record.AmountMinor), true);
});

test('The write path is still the very same entry point Add Transaction uses', async () => {
  await freshDatabase('d_same_path');
  const customer = await seedCustomer({ opening: 1000 });
  const original = transactionFormService.submitTransactionForm;
  let seen = null;
  transactionFormService.submitTransactionForm = async (form) => { seen = form; return original.call(transactionFormService, form); };
  try {
    await settlementService.createSettlementMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-01', Direction: 'Debit', Amount: '10' });
  } finally {
    transactionFormService.submitTransactionForm = original;
  }
  assert.ok(seen, 'the approved service was used');
  assert.equal(seen.TransactionType, TRANSACTION_TYPE.SETTLEMENT);
  assert.equal(seen.Direction, 'Debit');
  assert.equal(Object.prototype.hasOwnProperty.call(seen, 'DebitMinor'), false, 'no derived column is sent');
  assert.equal(Object.prototype.hasOwnProperty.call(seen, 'CreditMinor'), false);
});

test('A preview never writes and never invents a value', async () => {
  await freshDatabase('d_preview_safe');
  const customer = await seedCustomer({ opening: 1000 });
  assert.equal(await settlementService.previewMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Direction: 'Debit', Amount: '' }), null);
  assert.equal(await settlementService.previewMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: '', Direction: 'Debit', Amount: '10' }), null);
  assert.equal(await settlementService.previewMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: 'nope', Direction: 'Debit', Amount: '10' }), null);
  assert.equal(await settlementService.previewMovement({ TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, CustomerId: customer.Id, Direction: 'Debit', Amount: '10' }), null);
  assert.equal(await settlementService.previewMovement({ TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Direction: 'Sideways', Amount: '10' }), null);
  assert.equal((await settlementService.listSettlementMovements()).length, 0);
  assert.equal((await balanceService.getCustomerSummary(customer.Id)).BalanceMinor, 100000);
  const html = renderSettlementPreview({ preview: null });
  assert.match(html, new RegExp(PREVIEW_EMPTY_MESSAGE));
});

test('The direction labels and controls are the approved Arabic wording', () => {
  assert.deepEqual(DIRECTION_OPTIONS.map((option) => option.value), ['Credit', 'Debit']);
  assert.deepEqual(DIRECTION_OPTIONS.map((option) => option.label), ['إضافة إلى رصيد المزارع — دائن', 'خصم من رصيد المزارع — مدين']);
  assert.equal(directionLabel('Debit'), DIRECTION_LABEL_AR.Debit);
  assert.equal(directionLabel('Credit'), DIRECTION_LABEL_AR.Credit);
  assert.equal(DIRECTION_BADGE_LABEL.Debit, 'مدين');
  assert.equal(DIRECTION_BADGE_LABEL.Credit, 'دائن');
  const form = renderSettlementForm({ tab: SETTLEMENT_TAB.SETTLEMENT });
  assert.match(form, /id="settlement-direction"/);
  assert.match(form, /إضافة إلى رصيد المزارع — دائن/);
  assert.match(form, /خصم من رصيد المزارع — مدين/);
  assert.doesNotMatch(form, /<option value="Debit"[^>]*selected/);
  const debitForm = renderSettlementForm({ tab: SETTLEMENT_TAB.SETTLEMENT, values: { Direction: 'Debit' } });
  assert.match(debitForm, /<option value="Debit" selected/);
  // The row badge carries the direction without a colour-only meaning.
  const row = movementRow({ TransactionType: 'Settlement', Direction: 'Debit', DebitMinor: 100, CreditMinor: 0, AmountMinor: 100, SettlementMinor: 100, CustomerId: 'x' });
  assert.match(row.cells[3], /مدين/);
  const creditRow = movementRow({ TransactionType: 'Settlement', Direction: 'Credit', CreditMinor: 100, DebitMinor: 0, AmountMinor: 100, SettlementMinor: 100, CustomerId: 'x' });
  assert.match(creditRow.cells[3], /دائن/);
});

test('The type list, the tab list and the columns stay the approved ones', () => {
  assert.deepEqual(SETTLEMENT_TABS.map((tab) => tab.transactionType), ['Settlement', 'GoodsExchange']);
  assert.deepEqual(SETTLEMENT_TABS.map((tab) => tab.label), ['تسوية', 'تبادل بضائع']);
  assert.equal(typeLabel('GoodsExchange'), 'تبادل بضائع');
  assert.equal(typeLabel('Settlement'), 'تسوية');
  assert.equal(SETTLEMENT_COLUMNS.length, 12);
  assert.equal(settlementService.movementTypes().length, 2);
  assert.equal(settlementService.isSettlementType(TRANSACTION_TYPE.DEBT_TRANSFER), false, 'DebtTransfer stays out');
});
