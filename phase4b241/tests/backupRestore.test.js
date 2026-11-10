import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, configureDatabase, deleteDatabase } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { balanceService } from '../src/services/balanceService.js';
import { openingBalanceService } from '../src/services/openingBalanceService.js';
import { backupService } from '../src/services/backupService.js';
import { restoreService, validateBackup } from '../src/services/restoreService.js';
import { databaseInit } from '../src/services/databaseInit.js';
import { settingsService } from '../src/services/settingsService.js';
import { TRANSACTION_TYPE } from '../src/domain/transactionTypes.js';

async function seedScenario() {
  const customer = await customerService.createCustomer({ Code: 'B1', Name: 'عميل النسخة', OpeningBalance: 1000 });
  const nameless = await customerService.createImportedCustomer({ Code: '26', Name: null });
  await openingBalanceService.setOpeningBalance(customer.Id, { newValue: 2000, reason: 'تصحيح' });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 350 });
  await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-02', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 800 });
  // A crop purchase carries no amount: its value is derived from the crop inputs
  // (G = 10*(14-0)+0 = 140 ; Amount = 140*5 = 700.00).
  await transactionService.createTransaction({
    CustomerId: nameless.Id,
    Date: '2026-09-03',
    TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL,
    crop: { LocalUnitsMilli: 10000, LocalDeductionKgMilli: 0, LocalLooseKgMilli: 0, LocalUnitPriceMinor: 500 }
  });
  return { customer, nameless };
}

test('Backup -> clear -> restore reproduces the exact same data', async () => {
  await freshDatabase('backup-source');
  const { customer, nameless } = await seedScenario();
  const balanceBefore = await balanceService.getCurrentBalanceMinor(customer.Id);
  const portfolioBefore = await balanceService.getPortfolioSummary();
  const json = await backupService.createBackupJson(2);

  // Wipe the live database entirely, then restore into a clean instance.
  await databaseInit.drop();
  configureDatabase({ name: 'ca_backup-target' });
  await deleteDatabase();
  await databaseInit.initialize();
  assert.equal((await customerService.listCustomers()).length, 0, 'the fresh database must start empty');

  const result = await restoreService.restoreFromJson(json);
  assert.equal(result.restored, true);
  assert.equal(result.counts.customers, 2);
  assert.equal(result.counts.transactions, 3);
  assert.equal(result.counts.openingBalanceHistory, 1);

  const restoredCustomer = await customerService.getByCode('B1');
  assert.equal(restoredCustomer.Name, 'عميل النسخة');
  assert.equal(restoredCustomer.OpeningBalanceMinor, 200000);
  assert.equal(await balanceService.getCurrentBalanceMinor(restoredCustomer.Id), balanceBefore);

  const restoredNameless = await customerService.getByCode('26');
  assert.equal(restoredNameless.Name, null);

  const portfolioAfter = await balanceService.getPortfolioSummary();
  assert.equal(portfolioAfter.TotalBalanceMinor, portfolioBefore.TotalBalanceMinor);
  assert.equal(portfolioAfter.CashReceivedMinor, portfolioBefore.CashReceivedMinor);
  assert.equal(portfolioAfter.TotalDebitMinor, portfolioBefore.TotalDebitMinor);

  const history = await openingBalanceService.listHistory(restoredCustomer.Id);
  assert.equal(history.length, 1);
  assert.equal(history[0].Reason, 'تصحيح');
  assert.equal(await settingsService.getDefaultPackageWeight(), 14);
});

test('An invalid backup file is rejected and the live data is left untouched', async () => {
  await freshDatabase('backup-invalid');
  const { customer } = await seedScenario();
  const balanceBefore = await balanceService.getCurrentBalanceMinor(customer.Id);
  const countBefore = (await customerService.listCustomers()).length;

  const invalidFiles = [
    { Customers: [] },
    { Meta: { App: 'OtherApp', FormatVersion: 1, SchemaVersion: 1 }, Customers: [], Transactions: [], OpeningBalanceHistory: [], Settings: [], Metadata: [] },
    { Meta: { App: 'CustomerAccountsDB', FormatVersion: 1, SchemaVersion: 999 }, Customers: [], Transactions: [], OpeningBalanceHistory: [], Settings: [], Metadata: [] }
  ];

  for (const invalid of invalidFiles) {
    const validation = validateBackup(invalid);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.length > 0);
    await assert.rejects(() => restoreService.restore(invalid));
  }

  await assert.rejects(() => restoreService.restoreFromJson('{ not json'), /JSON غير صالح/);

  // Nothing was replaced.
  assert.equal((await customerService.listCustomers()).length, countBefore);
  assert.equal((await balanceService.getCurrentBalanceMinor(customer.Id)), balanceBefore);
});

test('A structurally valid backup with broken references is rejected', async () => {
  await freshDatabase('backup-broken-ref');
  const backup = {
    Meta: { App: 'CustomerAccountsDB', FormatVersion: 1, SchemaVersion: 1 },
    Customers: [{ Id: 'cus_1', Code: 'X', Name: 'اسم', OpeningBalanceMinor: 0, IsActive: true }],
    Transactions: [{ Id: 'trx_1', CustomerId: 'missing-customer', Date: '2026-09-01', TransactionType: 'SalePesticides', AmountMinor: 100, Status: 'Active' }],
    OpeningBalanceHistory: [],
    Settings: [{ Key: 'DefaultPackageWeight', Value: 14 }],
    Metadata: [{ Key: 'SchemaVersion', Value: 1 }]
  };
  const validation = validateBackup(backup);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((e) => e.message.includes('عميل غير موجود')));
});

test('A broken debt transfer pair inside a backup is rejected', async () => {
  await freshDatabase('backup-broken-pair');
  const backup = {
    Meta: { App: 'CustomerAccountsDB', FormatVersion: 1, SchemaVersion: 1 },
    Customers: [
      { Id: 'cus_1', Code: 'A', Name: 'أ', OpeningBalanceMinor: 0, IsActive: true },
      { Id: 'cus_2', Code: 'B', Name: 'ب', OpeningBalanceMinor: 0, IsActive: true }
    ],
    Transactions: [
      { Id: 'trx_1', CustomerId: 'cus_1', Date: '2026-09-01', TransactionType: 'DebtTransfer', AmountMinor: 100, Status: 'Active', LinkId: 'lnk_1', TransferRole: 'CreditSide' }
    ],
    OpeningBalanceHistory: [],
    Settings: [{ Key: 'DefaultPackageWeight', Value: 14 }],
    Metadata: [{ Key: 'SchemaVersion', Value: 1 }]
  };
  const validation = validateBackup(backup);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((e) => e.message.includes('غير مكتمل')));
});

test('A cancelled transaction inside a backup must carry its reason', async () => {
  await freshDatabase('backup-cancel-rule');
  const backup = {
    Meta: { App: 'CustomerAccountsDB', FormatVersion: 1, SchemaVersion: 1 },
    Customers: [{ Id: 'cus_1', Code: 'A', Name: 'أ', OpeningBalanceMinor: 0, IsActive: true }],
    Transactions: [{ Id: 'trx_1', CustomerId: 'cus_1', Date: '2026-09-01', TransactionType: 'SalePesticides', AmountMinor: 100, Status: 'Cancelled' }],
    OpeningBalanceHistory: [],
    Settings: [{ Key: 'DefaultPackageWeight', Value: 14 }],
    Metadata: [{ Key: 'SchemaVersion', Value: 1 }]
  };
  const validation = validateBackup(backup);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((e) => e.message.includes('سبب إلغاء')));
});
