import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCustomerDraft, validateOpeningBalanceChange } from '../src/validation/customerValidation.js';
import { validateTransactionDraft, validateCancellation, validateDebtTransferInput } from '../src/validation/transactionValidation.js';
import { TRANSACTION_TYPE, DEBT_TRANSFER_ROLE, STATUS } from '../src/domain/transactionTypes.js';

test('Manual customer requires a name, code is required and unique', () => {
  const missingName = validateCustomerDraft({ Code: '1' }, { nameRequired: true });
  assert.equal(missingName.ok, false);
  assert.equal(missingName.errors[0].field, 'Name');

  const duplicate = validateCustomerDraft({ Code: '1', Name: 'أحمد' }, { existingCodes: new Set(['1']) });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.errors[0].code, 'CONFLICT');

  const okDraft = validateCustomerDraft({ Code: '1', Name: 'أحمد' }, { existingCodes: new Set() });
  assert.equal(okDraft.ok, true);
  assert.equal(okDraft.data.OpeningBalanceMinor, 0);
});

test('Imported customer may be nameless (name = 0 / empty)', () => {
  const a = validateCustomerDraft({ Code: '26', Name: 0 }, { nameRequired: false });
  assert.equal(a.ok, true);
  assert.equal(a.data.Name, null);
  const b = validateCustomerDraft({ Code: '26', Name: '' }, { nameRequired: false });
  assert.equal(b.ok, true);
  assert.equal(b.data.Name, null);
});

test('Duplicate code is still rejected while keeping the original name optional', () => {
  const r = validateCustomerDraft({ Code: '26', Name: null }, { existingCodes: new Set(['26']), nameRequired: false });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'CONFLICT');
});

test('Transaction validation: customer, date, type and positive amount', () => {
  const base = { CustomerId: 'cus_1', Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 100 };

  assert.equal(validateTransactionDraft({ ...base }, { customerExists: true }).ok, true);

  const noCustomer = validateTransactionDraft({ ...base, CustomerId: null }, { customerExists: true });
  assert.equal(noCustomer.errors[0].field, 'CustomerId');

  const missingCustomer = validateTransactionDraft({ ...base }, { customerExists: false });
  assert.equal(missingCustomer.errors[0].code, 'NOT_FOUND');

  const badDate = validateTransactionDraft({ ...base, Date: '01/09/2026' }, { customerExists: true });
  assert.equal(badDate.errors[0].field, 'Date');

  const badType = validateTransactionDraft({ ...base, TransactionType: 'Unknown' }, { customerExists: true });
  assert.equal(badType.errors[0].field, 'TransactionType');

  const negative = validateTransactionDraft({ ...base, Amount: -100 }, { customerExists: true });
  assert.equal(negative.errors[0].field, 'Amount');
  assert.match(negative.errors[0].message, /أكبر من صفر/);

  const zero = validateTransactionDraft({ ...base, Amount: 0 }, { customerExists: true });
  assert.equal(zero.ok, false);

  const notNumber = validateTransactionDraft({ ...base, Amount: 'abc' }, { customerExists: true });
  assert.equal(notNumber.ok, false);
});

test('Link fields only allowed for DebtTransfer and are mandatory there', () => {
  const bad = validateTransactionDraft({ CustomerId: 'c', Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 10, LinkId: 'x' }, { customerExists: true });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, 'BUSINESS_RULE_ERROR');

  const missing = validateTransactionDraft({ CustomerId: 'c', Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER, Amount: 10 }, { customerExists: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].field, 'LinkId');

  const okTransfer = validateTransactionDraft({ CustomerId: 'c', Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER, Amount: 10, LinkId: 'lnk1', TransferRole: DEBT_TRANSFER_ROLE.CREDIT_SIDE }, { customerExists: true });
  assert.equal(okTransfer.ok, true);
});

test('Crop fields are rejected for non-crop types', () => {
  const r = validateTransactionDraft({ CustomerId: 'c', Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 10, crop: { LocalUnitsMilli: 1000 } }, { customerExists: true });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'BUSINESS_RULE_ERROR');
});

test('Cancellation requires a mandatory reason and rejects a second cancellation', () => {
  const active = { Status: STATUS.ACTIVE };
  assert.throws(() => validateCancellation(active, ''), /سبب إلغاء الحركة مطلوب/);
  assert.equal(validateCancellation(active, 'خطأ في الإدخال'), 'خطأ في الإدخال');
  assert.throws(() => validateCancellation({ Status: STATUS.CANCELLED }, 'again'), /ملغاة بالفعل/);
  assert.throws(() => validateCancellation(null, 'x'), /الحركة غير موجودة/);
});

test('Debt transfer requires two distinct customers and a positive amount', () => {
  const same = validateDebtTransferInput({ FromCustomerId: 'a', ToCustomerId: 'a', Amount: 100, Date: '2026-09-01' });
  assert.equal(same.ok, false);
  assert.equal(same.errors[0].code, 'BUSINESS_RULE_ERROR');

  const badAmount = validateDebtTransferInput({ FromCustomerId: 'a', ToCustomerId: 'b', Amount: -5, Date: '2026-09-01' });
  assert.equal(badAmount.ok, false);

  const okTransfer = validateDebtTransferInput({ FromCustomerId: 'a', ToCustomerId: 'b', Amount: 100, Date: '2026-09-01' });
  assert.equal(okTransfer.ok, true);
  assert.equal(okTransfer.data.AmountMinor, 10000);
});

test('Opening balance change requires a new value and a mandatory reason', () => {
  assert.equal(validateOpeningBalanceChange({ newValue: 500, reason: '' }).ok, false);
  assert.equal(validateOpeningBalanceChange({ newValue: 'x', reason: 'تصحيح' }).ok, false);
  const okChange = validateOpeningBalanceChange({ newValue: 500, reason: 'تصحيح افتتاحي' });
  assert.equal(okChange.ok, true);
  assert.equal(okChange.data.NewValueMinor, 50000);
  const negativeAllowed = validateOpeningBalanceChange({ newValue: -500, reason: 'رصيد افتتاحي مدين' });
  assert.equal(negativeAllowed.ok, true);
  assert.equal(negativeAllowed.data.NewValueMinor, -50000);
});
