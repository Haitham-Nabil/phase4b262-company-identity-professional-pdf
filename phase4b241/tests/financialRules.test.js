import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveFinancials, resolveDirection, DIRECTION } from '../src/domain/financialDirection.js';
import { TRANSACTION_TYPE, DEBT_TRANSFER_ROLE, STATUS, isCashType, isNonCashType } from '../src/domain/transactionTypes.js';

const AMOUNT = 1000000; // 10,000.00

function record(type, extra = {}) {
  return { TransactionType: type, AmountMinor: AMOUNT, Status: STATUS.ACTIVE, ...extra };
}

test('Debit types are SalePesticides / SaleIrrigation / CashPaid', () => {
  assert.equal(deriveFinancials(record(TRANSACTION_TYPE.SALE_PESTICIDES)).DebitMinor, AMOUNT);
  assert.equal(deriveFinancials(record(TRANSACTION_TYPE.SALE_IRRIGATION)).DebitMinor, AMOUNT);
  assert.equal(deriveFinancials(record(TRANSACTION_TYPE.CASH_PAID)).DebitMinor, AMOUNT);
  assert.equal(resolveDirection(TRANSACTION_TYPE.SALE_PESTICIDES), DIRECTION.DEBIT);
});

test('Credit types are SalesReturn / both crop purchases / CashReceived / Settlement / GoodsExchange', () => {
  for (const type of [
    TRANSACTION_TYPE.SALES_RETURN, TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, TRANSACTION_TYPE.CROP_PURCHASE_CARTON,
    TRANSACTION_TYPE.CASH_RECEIVED, TRANSACTION_TYPE.SETTLEMENT, TRANSACTION_TYPE.GOODS_EXCHANGE
  ]) {
    const f = deriveFinancials(record(type));
    assert.equal(f.CreditMinor, AMOUNT, `${type} must be a credit`);
    assert.equal(f.DebitMinor, 0, `${type} must not be a debit`);
  }
});

test('CashReceived is the only cash-in and CashPaid the only cash-out', () => {
  const received = deriveFinancials(record(TRANSACTION_TYPE.CASH_RECEIVED));
  assert.equal(received.CashReceivedMinor, AMOUNT);
  assert.equal(received.CashPaidMinor, 0);
  assert.equal(received.isCash, true);

  const paid = deriveFinancials(record(TRANSACTION_TYPE.CASH_PAID));
  assert.equal(paid.CashPaidMinor, AMOUNT);
  assert.equal(paid.CashReceivedMinor, 0);
  assert.equal(paid.isCash, true);
});

test('Settlement, GoodsExchange and DebtTransfer are non-cash', () => {
  for (const type of [TRANSACTION_TYPE.SETTLEMENT, TRANSACTION_TYPE.GOODS_EXCHANGE, TRANSACTION_TYPE.DEBT_TRANSFER]) {
    const f = deriveFinancials(record(type, type === TRANSACTION_TYPE.DEBT_TRANSFER ? { TransferRole: DEBT_TRANSFER_ROLE.CREDIT_SIDE } : {}));
    assert.equal(f.CashReceivedMinor, 0);
    assert.equal(f.CashPaidMinor, 0);
    assert.equal(f.isCash, false);
    assert.equal(f.SettlementMinor, AMOUNT);
    assert.equal(isNonCashType(type), true);
  }
  assert.equal(isCashType(TRANSACTION_TYPE.SETTLEMENT), false);
});

test('DebtTransfer credit side credits and debit side debits', () => {
  const credit = deriveFinancials(record(TRANSACTION_TYPE.DEBT_TRANSFER, { TransferRole: DEBT_TRANSFER_ROLE.CREDIT_SIDE }));
  const debit = deriveFinancials(record(TRANSACTION_TYPE.DEBT_TRANSFER, { TransferRole: DEBT_TRANSFER_ROLE.DEBIT_SIDE }));
  assert.equal(credit.CreditMinor, AMOUNT);
  assert.equal(credit.DebitMinor, 0);
  assert.equal(debit.DebitMinor, AMOUNT);
  assert.equal(debit.CreditMinor, 0);
});

test('Unknown type and non-positive amount are rejected', () => {
  assert.throws(() => deriveFinancials(record('MadeUpType')), /نوع الحركة غير معروف/);
  assert.throws(() => deriveFinancials(record(TRANSACTION_TYPE.SALE_PESTICIDES, { AmountMinor: 0 })), /أكبر من صفر/);
  assert.throws(() => deriveFinancials(record(TRANSACTION_TYPE.SALE_PESTICIDES, { AmountMinor: -500 })), /أكبر من صفر/);
});

test('The 10-type catalogue contains exactly the approved types', () => {
  const types = Object.values(TRANSACTION_TYPE);
  assert.equal(types.length, 10);
  assert.deepEqual([...types].sort(), ['CashPaid', 'CashReceived', 'CropPurchaseCarton', 'CropPurchaseLocal', 'DebtTransfer', 'GoodsExchange', 'SaleIrrigation', 'SalePesticides', 'SalesReturn', 'Settlement'].sort());
});
