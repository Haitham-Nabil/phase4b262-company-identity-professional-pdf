// Phase 4B.1 — customer CRUD, validation, status, persistence and the customer
// balance read model. Everything runs against the real services and a real
// (fake-indexeddb backed) database, never against a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, simulateReload } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { balanceService } from '../src/services/balanceService.js';
import { customerRepository } from '../src/repositories/customerRepository.js';
import { TRANSACTION_TYPE } from '../src/domain/transactionTypes.js';
import { ERROR_CODE } from '../src/domain/errors.js';

async function createManual(overrides = {}) {
  return customerService.createCustomer({ Code: 'C-100', Name: 'مزارع النخيل', ...overrides });
}

test('Create: a customer is stored with the approved fields and integer minor units', async () => {
  await freshDatabase('crud_create');
  const created = await createManual({ Phone: '0100000000', Region: 'المنوفية', Notes: 'ملاحظة', OpeningBalance: 1234.5 });

  assert.equal(created.Code, 'C-100');
  assert.equal(created.Name, 'مزارع النخيل');
  assert.equal(created.Phone, '0100000000');
  assert.equal(created.Region, 'المنوفية');
  assert.equal(created.Notes, 'ملاحظة');
  assert.equal(created.OpeningBalanceMinor, 123450);
  assert.equal(Number.isInteger(created.OpeningBalanceMinor), true);
  assert.equal(created.IsActive, true);
  assert.ok(created.Id);
  assert.ok(created.CreatedAt && created.UpdatedAt);

  const stored = await customerService.getCustomer(created.Id);
  assert.equal(stored.Code, 'C-100');
});

test('Read: the customer survives closing and reopening the database', async () => {
  await freshDatabase('crud_reload');
  const created = await createManual({ OpeningBalance: 500 });
  await simulateReload();
  const reloaded = await customerService.getCustomer(created.Id);
  assert.equal(reloaded.Code, 'C-100');
  assert.equal(reloaded.OpeningBalanceMinor, 50000);
  assert.equal(reloaded.IsActive, true);
});

test('Opening balance is stored in its own field and is never a transaction', async () => {
  await freshDatabase('crud_opening');
  const created = await createManual({ OpeningBalance: 500 });
  const summary = await balanceService.getCustomerSummary(created.Id);
  const entries = await transactionService.listByCustomer(created.Id);
  assert.equal(summary.OpeningBalanceMinor, 50000);
  assert.equal(summary.BalanceMinor, 50000);
  assert.equal(summary.TotalCreditMinor, 0);
  assert.equal(summary.TotalDebitMinor, 0);
  assert.equal(entries.length, 0);
});

test('Validation: a duplicate code is rejected and the stored data is untouched', async () => {
  await freshDatabase('crud_duplicate');
  await createManual();
  await assert.rejects(
    () => customerService.createCustomer({ Code: 'C-100', Name: 'عميل آخر' }),
    (error) => error.code === ERROR_CODE.CONFLICT && error.field === 'Code'
  );
  const all = await customerService.listCustomers();
  assert.equal(all.length, 1);
  assert.equal(all[0].Name, 'مزارع النخيل');
});

test('Validation: an empty code is rejected', async () => {
  await freshDatabase('crud_empty_code');
  await assert.rejects(
    () => customerService.createCustomer({ Code: '   ', Name: 'بدون كود' }),
    (error) => error.code === ERROR_CODE.VALIDATION_ERROR && error.field === 'Code'
  );
  assert.equal((await customerService.listCustomers()).length, 0);
});

test('Validation: an empty name is rejected for manual creation', async () => {
  await freshDatabase('crud_empty_name');
  await assert.rejects(
    () => customerService.createCustomer({ Code: 'C-200', Name: '   ' }),
    (error) => error.code === ERROR_CODE.VALIDATION_ERROR && error.field === 'Name'
  );
  await assert.rejects(() => customerService.createCustomer({ Code: 'C-201' }));
  assert.equal((await customerService.listCustomers()).length, 0);
});

test('Optional fields may be omitted and are stored as null', async () => {
  await freshDatabase('crud_optional');
  const created = await createManual();
  assert.equal(created.Phone, null);
  assert.equal(created.Region, null);
  assert.equal(created.Notes, null);
  assert.equal(created.OpeningBalanceMinor, 0);
});

test('Update: basic fields change, the code stays, and the change persists', async () => {
  await freshDatabase('crud_update');
  const created = await createManual({ OpeningBalance: 250 });
  const updated = await customerService.updateCustomer(created.Id, {
    Name: 'مزارع النخيل الجديد', Phone: '0111111111', Region: 'طنطا', Notes: 'محدَّث'
  });
  assert.equal(updated.Code, 'C-100');
  assert.equal(updated.Name, 'مزارع النخيل الجديد');
  assert.equal(updated.Phone, '0111111111');
  assert.equal(updated.Region, 'طنطا');
  assert.equal(updated.Notes, 'محدَّث');
  assert.equal(updated.OpeningBalanceMinor, 25000);
  assert.equal(updated.Id, created.Id);

  await simulateReload();
  const reloaded = await customerService.getCustomer(created.Id);
  assert.equal(reloaded.Name, 'مزارع النخيل الجديد');
  assert.equal(reloaded.Region, 'طنطا');
});

test('Update: an unknown customer is rejected', async () => {
  await freshDatabase('crud_update_missing');
  await assert.rejects(
    () => customerService.updateCustomer('missing-id', { Name: 'لا وجود له' }),
    (error) => error.code === ERROR_CODE.NOT_FOUND
  );
});

test('Status: deactivate and reactivate persist across a reload', async () => {
  await freshDatabase('crud_status');
  const created = await createManual();
  const deactivated = await customerService.setActive(created.Id, false);
  assert.equal(deactivated.IsActive, false);

  await simulateReload();
  const afterReload = await customerService.getCustomer(created.Id);
  assert.equal(afterReload.IsActive, false);

  await customerService.setActive(created.Id, true);
  await simulateReload();
  assert.equal((await customerService.getCustomer(created.Id)).IsActive, true);
});

test('Status: a non-boolean activation value is rejected and nothing changes', async () => {
  await freshDatabase('crud_status_invalid');
  const created = await createManual();
  await assert.rejects(
    () => customerService.setActive(created.Id, 'no'),
    (error) => error.code === ERROR_CODE.VALIDATION_ERROR && error.field === 'IsActive'
  );
  assert.equal((await customerService.getCustomer(created.Id)).IsActive, true);
});

test('Status: deactivation keeps the record and does not change the balance', async () => {
  await freshDatabase('crud_deactivate_balance');
  const created = await createManual({ OpeningBalance: 1000 });
  await transactionService.createTransaction({ CustomerId: created.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 500 });
  const before = await balanceService.getCustomerSummary(created.Id);

  await customerService.setActive(created.Id, false);

  const stored = await customerService.getCustomer(created.Id);
  const after = await balanceService.getCustomerSummary(created.Id);
  assert.ok(stored, 'the record must still exist');
  assert.equal(stored.IsActive, false);
  assert.equal(after.BalanceMinor, before.BalanceMinor);
  assert.equal(after.BalanceMinor, 150000);
});

test('No physical delete exists on the customer repository', async () => {
  await freshDatabase('crud_no_delete');
  assert.equal(typeof customerRepository.delete, 'undefined');
  assert.equal(typeof customerRepository.remove, 'undefined');

  const created = await createManual();
  await customerService.setActive(created.Id, false);
  const all = await customerService.listCustomers();
  assert.equal(all.length, 1);
  assert.equal(all[0].Id, created.Id);
});

test('Search matches code, name and phone through the service', async () => {
  await freshDatabase('crud_search');
  await customerService.createCustomer({ Code: 'C-300', Name: 'أحمد المصري', Phone: '0123456789' });
  await customerService.createCustomer({ Code: 'C-301', Name: 'شركة الدلتا', Phone: '0112223333' });

  assert.equal((await customerService.searchCustomers('C-300')).length, 1);
  assert.equal((await customerService.searchCustomers('c-301'))[0].Code, 'C-301');
  assert.equal((await customerService.searchCustomers('الدلتا'))[0].Code, 'C-301');
  assert.equal((await customerService.searchCustomers('0123456789'))[0].Code, 'C-300');
  assert.equal((await customerService.searchCustomers('')).length, 2);
});

test('Read model: listCustomerBalances reports the canonical engine result for every customer', async () => {
  await freshDatabase('crud_read_model');
  const credit = await createManual({ Code: 'C-400', Name: 'عميل دائن', OpeningBalance: 1000 });
  const debit = await customerService.createCustomer({ Code: 'C-401', Name: 'عميل مدين' });
  const zero = await customerService.createCustomer({ Code: 'C-402', Name: 'عميل صفر' });

  await transactionService.createTransaction({ CustomerId: credit.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 500 });
  await transactionService.createTransaction({ CustomerId: credit.Id, Date: '2026-09-02', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 200 });
  await transactionService.createTransaction({ CustomerId: debit.Id, Date: '2026-09-03', TransactionType: TRANSACTION_TYPE.SALE_IRRIGATION, Amount: 1500 });

  const rows = await balanceService.listCustomerBalances();
  assert.equal(rows.length, 3);

  const byCode = new Map(rows.map((row) => [row.Customer.Code, row]));
  assert.equal(byCode.get('C-400').Summary.BalanceMinor, 130000);
  assert.equal(byCode.get('C-400').Summary.BalanceSide, 'Credit');
  assert.equal(byCode.get('C-401').Summary.BalanceMinor, -150000);
  assert.equal(byCode.get('C-401').Summary.BalanceSide, 'Debit');
  assert.equal(byCode.get('C-402').Summary.BalanceMinor, 0);
  assert.equal(byCode.get('C-402').Summary.BalanceSide, 'Zero');

  // The read model must equal the per-customer canonical summary, value for value.
  for (const row of rows) {
    const canonical = await balanceService.getCustomerSummary(row.Customer.Id);
    assert.equal(row.Summary.BalanceMinor, canonical.BalanceMinor);
    assert.equal(row.Summary.BalanceSide, canonical.BalanceSide);
    assert.equal(row.Summary.OpeningBalanceMinor, canonical.OpeningBalanceMinor);
    assert.equal(row.Summary.TotalCreditMinor, canonical.TotalCreditMinor);
    assert.equal(row.Summary.TotalDebitMinor, canonical.TotalDebitMinor);
    assert.equal(Number.isInteger(row.Summary.BalanceMinor), true);
  }
});

test('Read model: an imported nameless customer stays visible with its balance', async () => {
  await freshDatabase('crud_nameless');
  const imported = await customerService.createImportedCustomer({ Code: 'IMP-1', OpeningBalance: 0 });
  const rows = await balanceService.listCustomerBalances();
  const row = rows.find((entry) => entry.Customer.Id === imported.Id);
  assert.ok(row);
  assert.equal(row.Customer.Name, null);
  assert.equal(row.Summary.BalanceMinor, 0);
});

test('Read model: a single customer row matches the canonical summary too', async () => {
  await freshDatabase('crud_read_model_one');
  const created = await createManual({ OpeningBalance: 700 });
  await transactionService.createTransaction({ CustomerId: created.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SETTLEMENT, Amount: 300 });
  const row = await balanceService.getCustomerBalanceRow(created.Id);
  assert.equal(row.Customer.Code, 'C-100');
  assert.equal(row.Summary.BalanceMinor, 100000);
  assert.equal(row.Summary.NonCashSettlementMinor, 30000);
  await assert.rejects(() => balanceService.getCustomerBalanceRow('missing-id'), (error) => error.code === ERROR_CODE.NOT_FOUND);
});
