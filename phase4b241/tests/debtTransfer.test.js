import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { debtTransferService } from '../src/services/debtTransferService.js';
import { balanceService } from '../src/services/balanceService.js';
import { transactionService } from '../src/services/transactionService.js';
import { TRANSACTION_TYPE, DEBT_TRANSFER_ROLE } from '../src/domain/transactionTypes.js';

test('One user action creates exactly two linked rows sharing one LinkId', async () => {
  await freshDatabase('transfer');
  const a = await customerService.createCustomer({ Code: 'A', Name: 'الطرف الأول' });
  const b = await customerService.createCustomer({ Code: 'B', Name: 'الطرف الثاني' });
  const result = await debtTransferService.createDebtTransfer({ FromCustomerId: a.Id, ToCustomerId: b.Id, Amount: 5000, Date: '2026-09-10', Description: 'تحويل مديونية' });

  assert.equal(result.CashImpactMinor, 0);
  assert.equal(result.CreditRow.LinkId, result.DebitRow.LinkId);
  assert.equal(result.CreditRow.TransferRole, DEBT_TRANSFER_ROLE.CREDIT_SIDE);
  assert.equal(result.DebitRow.TransferRole, DEBT_TRANSFER_ROLE.DEBIT_SIDE);
  assert.equal(result.CreditRow.AmountMinor, result.DebitRow.AmountMinor);
  assert.equal(result.CreditRow.Date, result.DebitRow.Date);

  const stored = await transactionService.listByLinkId(result.LinkId);
  assert.equal(stored.length, 2);
});

test('Debt transfer moves the balance only between the two involved customers, with zero cash', async () => {
  await freshDatabase('transfer-balance');
  const a = await customerService.createCustomer({ Code: 'A', Name: 'الطرف الأول' });
  const b = await customerService.createCustomer({ Code: 'B', Name: 'الطرف الثاني' });
  await debtTransferService.createDebtTransfer({ FromCustomerId: a.Id, ToCustomerId: b.Id, Amount: 5000, Date: '2026-09-10' });

  const summaryA = await balanceService.getCustomerSummary(a.Id);
  const summaryB = await balanceService.getCustomerSummary(b.Id);
  assert.equal(summaryA.BalanceMinor, 500000);   // credit side: balance up
  assert.equal(summaryB.BalanceMinor, -500000);  // debit side: balance down
  assert.equal(summaryA.CashReceivedMinor, 0);
  assert.equal(summaryB.CashPaidMinor, 0);
});

test('A debt transfer is NOT double counted in the aggregate non-cash total', async () => {
  await freshDatabase('transfer-once');
  const a = await customerService.createCustomer({ Code: 'A', Name: 'الطرف الأول' });
  const b = await customerService.createCustomer({ Code: 'B', Name: 'الطرف الثاني' });
  await debtTransferService.createDebtTransfer({ FromCustomerId: a.Id, ToCustomerId: b.Id, Amount: 5000, Date: '2026-09-10' });

  const portfolio = await balanceService.getPortfolioSummary();
  assert.equal(portfolio.NonCashSettlementMinor, 500000); // 5,000 counted ONCE, not 10,000
  assert.equal(portfolio.ByType[TRANSACTION_TYPE.DEBT_TRANSFER].AmountMinor, 500000);
  assert.equal(portfolio.TotalBalanceMinor, 0); // +5,000 and -5,000 across the portfolio
  assert.equal(portfolio.CashReceivedMinor, 0);
  assert.equal(portfolio.CashPaidMinor, 0);
});

test('A transfer to the same customer is rejected and writes nothing', async () => {
  await freshDatabase('transfer-self');
  const a = await customerService.createCustomer({ Code: 'A', Name: 'الطرف الأول' });
  await assert.rejects(
    () => debtTransferService.createDebtTransfer({ FromCustomerId: a.Id, ToCustomerId: a.Id, Amount: 100, Date: '2026-09-10' }),
    /لا يمكن تحويل المديونية إلى نفس العميل/
  );
  assert.equal((await transactionService.listByCustomer(a.Id)).length, 0);
});
