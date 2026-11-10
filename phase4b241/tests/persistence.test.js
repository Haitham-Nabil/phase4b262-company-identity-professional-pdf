import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, simulateReload } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { balanceService } from '../src/services/balanceService.js';
import { settingsService } from '../src/services/settingsService.js';
import { databaseInit } from '../src/services/databaseInit.js';
import { DB_VERSION } from '../src/storage/schema.js';
import { TRANSACTION_TYPE } from '../src/domain/transactionTypes.js';

test('A customer survives an application reload', async () => {
  await freshDatabase('persist-customer');
  const created = await customerService.createCustomer({ Code: 'P1', Name: 'عميل مستمر' });
  await simulateReload();
  const reloaded = await customerService.getCustomer(created.Id);
  assert.ok(reloaded);
  assert.equal(reloaded.Code, 'P1');
  assert.equal(reloaded.Name, 'عميل مستمر');
});

test('A transaction survives a reload and the balance stays correct', async () => {
  await freshDatabase('persist-transaction');
  const customer = await customerService.createCustomer({ Code: 'P2', Name: 'عميل حركات', OpeningBalance: 1000 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 200 });
  await simulateReload();
  const rows = await transactionService.listByCustomer(customer.Id);
  assert.equal(rows.length, 1);
  assert.equal(await balanceService.getCurrentBalanceMinor(customer.Id), 80000);
});

test('IndexedDB schema exposes the stores and their indexes', async () => {
  await freshDatabase('schema');
  const info = await databaseInit.getInfo();
  assert.equal(info.schema.name.startsWith('ca_schema'), true);
  // Phase 4B.6 added the audit trail (version 2); Phase 4B.11 added the two reference
  // catalogues (version 3). Both upgrades were additive only.
  assert.equal(info.schema.version, DB_VERSION);
  assert.equal(DB_VERSION, 4);
  assert.deepEqual([...info.schema.stores].sort(), ['auditLog', 'cartonTypes', 'customers', 'metadata', 'openingBalanceHistory', 'receivingCompanies', 'settings', 'strawberryVarieties', 'transactions'].sort());
  assert.deepEqual([...info.schema.indexes.customers].sort(), ['code', 'name', 'phone']);
  assert.deepEqual([...info.schema.indexes.transactions].sort(), ['customerId', 'customerId_date', 'date', 'linkId', 'status', 'transactionType']);
  assert.deepEqual([...info.schema.indexes.openingBalanceHistory].sort(), ['changedAt', 'customerId']);
  assert.deepEqual([...info.schema.indexes.auditLog].sort(), ['eventType', 'occurredAt', 'transactionId']);
});

test('First run seeds DefaultPackageWeight = 14 and writes no fake data', async () => {
  await freshDatabase('seed');
  assert.equal(await settingsService.getDefaultPackageWeight(), 14);
  assert.equal((await customerService.listCustomers()).length, 0);
  assert.equal((await transactionService.listByCustomer('any')).length, 0);
});
