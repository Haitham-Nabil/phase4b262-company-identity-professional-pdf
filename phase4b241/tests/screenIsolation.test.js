// Phase 4B.7A — screen-isolation regression tests.
//
// These are the findings of the functional audit turned into deterministic checks on the
// real services: what each screen is allowed to show, and how a cancelled movement is
// treated by the read paths. No rule is restated here: every number comes from the
// approved services (paymentService / settlementService / balanceService) and from
// deriveFinancials().
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { paymentService } from '../src/services/paymentService.js';
import { settlementService } from '../src/services/settlementService.js';
import { transactionLifecycleService } from '../src/services/transactionLifecycleService.js';
import { transactionFormService } from '../src/services/transactionFormService.js';
import { balanceService } from '../src/services/balanceService.js';
import { deriveFinancials } from '../src/domain/financialDirection.js';
import { TRANSACTION_TYPE, STATUS } from '../src/domain/transactionTypes.js';
import { filterCustomers, defaultCriteria, CUSTOMER_STATUS_FILTER, CUSTOMER_BALANCE_FILTER, ALL_REGIONS } from '../ui/views/customers.js';
import { logger } from '../src/utils/logger.js';

logger.disable?.();

const MONEY = 100;

async function seedCustomer({ code = 'C-980', name = 'مزارع العزل', region = 'طنطا', opening = 0 } = {}) {
  return customerService.createCustomer({ Code: code, Name: name, Phone: '0100000009', Region: region, OpeningBalance: opening });
}
async function cash(customerId, { type, amount, date = '2026-10-01', description }) {
  const result = await paymentService.createCashMovement({
    TransactionType: type, CustomerId: customerId, Date: date, Amount: amount, Description: description
  });
  return result.Record;
}

test('1 — the Payments screen list carries cash movements only (never a Settlement or a GoodsExchange)', async () => {
  await freshDatabase('iso_payments_scope');
  const customer = await seedCustomer();
  await cash(customer.Id, { type: TRANSACTION_TYPE.CASH_RECEIVED, amount: 555, description: 'استلام' });
  await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-03', Direction: 'Credit', Amount: 300
  });
  await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-04', Direction: 'Credit', Amount: 120
  });

  const rows = await paymentService.listCashMovements();
  assert.equal(rows.length, 1, 'exactly the one cash movement');
  assert.equal(rows[0].TransactionType, TRANSACTION_TYPE.CASH_RECEIVED);
  assert.equal(rows.some((r) => r.TransactionType === TRANSACTION_TYPE.SETTLEMENT), false);
  assert.equal(rows.some((r) => r.TransactionType === TRANSACTION_TYPE.GOODS_EXCHANGE), false);
});

test('2 — the Settlements screen list carries Settlement + GoodsExchange only (never a cash movement)', async () => {
  await freshDatabase('iso_settlements_scope');
  const customer = await seedCustomer();
  await cash(customer.Id, { type: TRANSACTION_TYPE.CASH_RECEIVED, amount: 555, description: 'استلام' });
  await cash(customer.Id, { type: TRANSACTION_TYPE.CASH_PAID, amount: 111, description: 'دفعة' });
  await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-03', Direction: 'Debit', Amount: 40
  });

  const rows = await settlementService.listSettlementMovements();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].TransactionType, TRANSACTION_TYPE.SETTLEMENT);
  assert.equal(rows[0].Direction, 'Debit');
  assert.equal(rows.some((r) => [TRANSACTION_TYPE.CASH_RECEIVED, TRANSACTION_TYPE.CASH_PAID].includes(r.TransactionType)), false);
});

test('3 — a cancelled cash movement leaves the cash totals while the row itself is still returned with its status', async () => {
  await freshDatabase('iso_cancelled_cash');
  const customer = await seedCustomer();
  const keep = await cash(customer.Id, { type: TRANSACTION_TYPE.CASH_RECEIVED, amount: 555, description: 'استلام صحيح' });
  const drop = await cash(customer.Id, { type: TRANSACTION_TYPE.CASH_PAID, amount: 777, description: 'دفعة خاطئة' });

  const before = paymentService.summarize(await paymentService.listCashMovements());
  assert.match(JSON.stringify(before), /55500/);
  assert.match(JSON.stringify(before), /77700/);

  await transactionLifecycleService.cancelTransaction(drop.Id, 'قيد خاطئ للاختبار', { confirmed: true });

  const rows = await paymentService.listCashMovements();
  const stored = rows.find((r) => r.Id === drop.Id);
  assert.ok(stored, 'the cancelled movement is still listed so the screen can show its status');
  assert.equal(stored.Status, STATUS.CANCELLED);
  assert.equal(deriveFinancials(stored).isActive, false, 'the approved engine reads the stored status, not the caller');

  const after = paymentService.summarize(rows);
  assert.doesNotMatch(JSON.stringify(after), /77700/, 'the cancelled amount left the totals');
  assert.match(JSON.stringify(after), /55500/, 'the active amount is still measured');
  assert.equal(keep.AmountMinor, 55500);
});

test('4 — a cancelled movement also leaves the customer balance (Balance = Opening + Credits − Debits)', async () => {
  await freshDatabase('iso_cancelled_balance');
  const customer = await seedCustomer({ opening: 1000 });
  const received = await cash(customer.Id, { type: TRANSACTION_TYPE.CASH_RECEIVED, amount: 777, description: 'استلام' });
  const paid = await cash(customer.Id, { type: TRANSACTION_TYPE.CASH_PAID, amount: 555, description: 'دفعة' });

  const before = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(before.BalanceMinor, 1000 * MONEY + 777 * MONEY - 555 * MONEY);

  await transactionLifecycleService.cancelTransaction(received.Id, 'نقدية مسجلة مرتين', { confirmed: true });
  await transactionLifecycleService.cancelTransaction(paid.Id, 'دفعة مكررة', { confirmed: true });

  const after = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(after.BalanceMinor, 1000 * MONEY, 'both cancelled movements left the balance');
  assert.equal(after.CashReceivedMinor, 0);
  assert.equal(after.CashPaidMinor, 0);
});

test('5 — a non-cash movement never enters the cash totals of the Payments screen', async () => {
  await freshDatabase('iso_noncash_not_cash');
  const customer = await seedCustomer();
  await cash(customer.Id, { type: TRANSACTION_TYPE.CASH_RECEIVED, amount: 555, description: 'استلام' });
  await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-03', Direction: 'Credit', Amount: 999
  });
  await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-04', Direction: 'Credit', Amount: 888
  });

  const cashTotals = paymentService.summarize(await paymentService.listCashMovements());
  assert.doesNotMatch(JSON.stringify(cashTotals), /99900/);
  assert.doesNotMatch(JSON.stringify(cashTotals), /88800/);
  const summary = await balanceService.getCustomerSummary(customer.Id);
  assert.equal(summary.CashReceivedMinor, 555 * MONEY);
  assert.equal(summary.NonCashSettlementMinor, (999 + 888) * MONEY);
});

test('6 — Settlement and GoodsExchange never produce a cash receipt or a cash payment', async () => {
  await freshDatabase('iso_directional_types_are_noncash');
  const customer = await seedCustomer();
  const settlement = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-03', Direction: 'Credit', Amount: 300
  });
  const exchange = await settlementService.createSettlementMovement({
    TransactionType: TRANSACTION_TYPE.GOODS_EXCHANGE, CustomerId: customer.Id, Date: '2026-10-04', Direction: 'Debit', Amount: 120
  });

  for (const row of [settlement.Record, exchange.Record]) {
    const financials = deriveFinancials(row);
    assert.equal(financials.CashReceivedMinor, 0);
    assert.equal(financials.CashPaidMinor, 0);
    assert.equal(financials.isCash, false);
    assert.equal(financials.isNonCash, true);
  }
  assert.equal(deriveFinancials(settlement.Record).CreditMinor, 300 * MONEY);
  assert.equal(deriveFinancials(exchange.Record).DebitMinor, 120 * MONEY);
});

test('7 — the Customers screen filters (status / balance / region) never lose or invent a row', async () => {
  await freshDatabase('iso_customer_filters');
  const active1 = await seedCustomer({ code: 'C-981', name: 'نشط طنطا', region: 'طنطا', opening: 500 });
  const active2 = await seedCustomer({ code: 'C-982', name: 'نشط المحلة', region: 'المحلة', opening: 0 });
  const inactive = await seedCustomer({ code: 'C-983', name: 'غير نشط', region: 'طنطا', opening: 0 });
  await customerService.setActive(inactive.Id, false);

  const rows = await balanceService.listCustomerBalances();
  assert.equal(rows.length, 3);
  assert.equal(filterCustomers(rows, { ...defaultCriteria(), status: CUSTOMER_STATUS_FILTER.ACTIVE }).length, 2);
  assert.equal(filterCustomers(rows, { ...defaultCriteria(), status: CUSTOMER_STATUS_FILTER.INACTIVE }).length, 1);
  assert.equal(filterCustomers(rows, { ...defaultCriteria(), balance: CUSTOMER_BALANCE_FILTER.ZERO }).length, 2);
  assert.equal(filterCustomers(rows, { ...defaultCriteria(), region: 'طنطا' }).length, 2);
  assert.equal(filterCustomers(rows, { ...defaultCriteria(), region: ALL_REGIONS }).length, 3);
  // The search is code/name/phone only and never changes the loaded set.
  assert.equal(filterCustomers(rows, { ...defaultCriteria(), search: 'C-982' }).length, 1);
  assert.equal(filterCustomers(rows, { ...defaultCriteria(), search: 'المحلة' }).length, 1);
  assert.equal(rows.length, 3, 'filtering is a projection: the loaded rows are untouched');
  assert.deepEqual(rows.map((r) => r.Customer.Code).sort(), ['C-981', 'C-982', 'C-983']);
  assert.equal(active1.Id !== active2.Id, true);
});

test('8 — the statement of one customer never carries another customer rows', async () => {
  await freshDatabase('iso_statement_isolation');
  const a = await seedCustomer({ code: 'C-984', name: 'عميل أ', opening: 100 });
  const b = await seedCustomer({ code: 'C-985', name: 'عميل ب', opening: 200 });
  await cash(a.Id, { type: TRANSACTION_TYPE.CASH_RECEIVED, amount: 555, description: 'خاص بعميل أ' });
  await cash(b.Id, { type: TRANSACTION_TYPE.CASH_RECEIVED, amount: 444, description: 'خاص بعميل ب' });

  const rowA = await balanceService.getCustomerBalanceRow(a.Id);
  const summaryA = await balanceService.getCustomerSummary(a.Id);
  assert.equal(rowA.Summary.CashReceivedMinor, 555 * MONEY);
  assert.equal(summaryA.BalanceMinor, (100 + 555) * MONEY);
  const historyA = await transactionFormService.listSelectableCustomers();
  assert.equal(historyA.some((c) => c.Code === 'C-985'), true, 'both customers stay selectable');
});

test('9 — the payments creation path still refuses a non-cash type', async () => {
  await freshDatabase('iso_payments_refuses_noncash');
  const customer = await seedCustomer();
  await assert.rejects(
    () => paymentService.createCashMovement({
      TransactionType: TRANSACTION_TYPE.SETTLEMENT, CustomerId: customer.Id, Date: '2026-10-03', Amount: 100, Direction: 'Credit'
    }),
    /نقدي/
  );
  assert.equal((await paymentService.listCashMovements()).length, 0);
});
