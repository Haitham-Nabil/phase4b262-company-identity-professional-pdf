// Phase 4B.3 — review snapshots for the Add Transaction screen.
//
// It exercises the REAL services against a temporary fake-indexeddb database (the
// same helpers the test suite uses) and only then renders the real view functions.
// Nothing is mocked: the numbers in the snapshots come from the Core, and the
// temporary database is deleted when the script finishes. It writes files into
// preview/ and creates no record in any real store.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freshDatabase, deleteDatabase } from '../tests/helpers.js';
import { customerService, settingsService, transactionFormService } from '../src/services/index.js';
import { renderTransactionForm, renderTransactionSuccess, transactionFormShellHtml } from '../ui/views/transactionForm.js';
import { TRANSACTION_TYPE, TRANSACTION_TYPE_LABELS_AR } from '../src/domain/transactionTypes.js';
import { AppError, ERROR_CODE } from '../src/domain/errors.js';
import { emptyForm } from '../src/validation/transactionFormInput.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PREVIEW_DIR = join(ROOT, 'preview');
const CSS_FILES = ['tokens.css', 'base.css', 'layout.css', 'components.css', 'financial.css'];
const TODAY = '2026-09-10';

function inlinedCss() {
  return CSS_FILES.map((file) => `/* ${file} */\n${readFileSync(join(ROOT, 'ui/styles', file), 'utf8')}`).join('\n');
}

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — حسابات العملاء</title>
<style>${inlinedCss()}</style>
</head>
<body>
<div class="app-shell" data-sidebar="closed">
  <div class="app-main">
    <main class="app-content" tabindex="-1">${body}</main>
  </div>
</div>
</body>
</html>
`;
}

async function main() {
  mkdirSync(PREVIEW_DIR, { recursive: true });
  await freshDatabase('preview_add_transaction');
  await settingsService.setDefaultPackageWeight(25);

  const ahmed = await customerService.createCustomer({ Code: 'C-100', Name: 'أحمد المصري', OpeningBalance: 1000, Phone: '0100', Region: 'المنوفية' });
  const delta = await customerService.createCustomer({ Code: 'C-101', Name: 'شركة الدلتا الزراعية', OpeningBalance: 0, Region: 'الدقهلية' });
  const hassan = await customerService.createCustomer({ Code: 'C-102', Name: 'حسن عبد الله', OpeningBalance: -250, Region: 'الغربية' });
  const customers = await transactionFormService.listSelectableCustomers();
  const packageWeightKg = await transactionFormService.getDefaultPackageWeight();

  const written = [];

  // 1 — loaded form (SalePesticides): customer list, dynamic fields, package weight
  const saleForm = { ...emptyForm({ transactionType: TRANSACTION_TYPE.SALE_PESTICIDES, date: TODAY }), CustomerId: ahmed.Id, Amount: '250' };
  writeFileSync(join(PREVIEW_DIR, 'transaction-form.html'), page('تسجيل حركة مالية', [
    transactionFormShellHtml(),
    renderTransactionForm({ customers, transactionType: TRANSACTION_TYPE.SALE_PESTICIDES, values: saleForm, packageWeightKg })
  ].join('\n')), 'utf8');
  written.push('transaction-form.html');

  // 2 — local crop purchase with the real preview from the Core calculator
  const cropForm = {
    ...emptyForm({ transactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, date: TODAY }),
    CustomerId: ahmed.Id, Units: '4', LooseKg: '2', DeductionKg: '1', UnitPrice: '10'
  };
  const cropPreview = await transactionFormService.previewCrop(cropForm);
  const cropHtml = renderTransactionForm({ customers, transactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL, values: cropForm, packageWeightKg, cropPreview });
  writeFileSync(join(PREVIEW_DIR, 'transaction-crop-local.html'), page('مشتريات محصول محلي', [
    transactionFormShellHtml({ transactionType: TRANSACTION_TYPE.CROP_PURCHASE_LOCAL }),
    cropHtml
  ].join('\n')), 'utf8');
  written.push('transaction-crop-local.html');

  // 3 — debt transfer form (two customers, one operation)
  const transferForm = { ...emptyForm({ transactionType: TRANSACTION_TYPE.DEBT_TRANSFER, date: TODAY }), FromCustomerId: ahmed.Id, ToCustomerId: delta.Id, Amount: '250' };
  writeFileSync(join(PREVIEW_DIR, 'transaction-debt-transfer.html'), page('تحويل مديونية', [
    transactionFormShellHtml({ transactionType: TRANSACTION_TYPE.DEBT_TRANSFER }),
    renderTransactionForm({ customers, transactionType: TRANSACTION_TYPE.DEBT_TRANSFER, values: transferForm, packageWeightKg })
  ].join('\n')), 'utf8');
  written.push('transaction-debt-transfer.html');

  // 4 — success state, from a really saved transaction
  const result = await transactionFormService.submitTransactionForm({
    ...emptyForm({ transactionType: TRANSACTION_TYPE.SALE_PESTICIDES, date: TODAY }), CustomerId: ahmed.Id, Amount: '250'
  });
  writeFileSync(join(PREVIEW_DIR, 'transaction-success.html'), page('تم تسجيل الحركة', [
    renderTransactionSuccess({ result, transactionType: TRANSACTION_TYPE.SALE_PESTICIDES })
  ].join('\n')), 'utf8');
  written.push('transaction-success.html');

  // 5 — error state: the Core refused a negative amount, the form keeps the values
  let failure = null;
  try {
    await transactionFormService.submitTransactionForm({
      ...emptyForm({ transactionType: TRANSACTION_TYPE.CASH_PAID, date: TODAY }), CustomerId: hassan.Id, Amount: '-100'
    });
  } catch (error) {
    failure = error;
  }
  const errorForm = { ...emptyForm({ transactionType: TRANSACTION_TYPE.CASH_PAID, date: TODAY }), CustomerId: hassan.Id, Amount: '-100' };
  writeFileSync(join(PREVIEW_DIR, 'transaction-error.html'), page('خطأ في تسجيل الحركة', [
    renderTransactionForm({
      customers,
      transactionType: TRANSACTION_TYPE.CASH_PAID,
      values: errorForm,
      fieldErrors: { Amount: failure ? failure.message : '' },
      error: failure,
      packageWeightKg
    })
  ].join('\n')), 'utf8');
  written.push('transaction-error.html');

  await deleteDatabase();
  console.log(JSON.stringify({
    written,
    packageWeightKg,
    cropPreview,
    successBalanceMinor: result.NewBalanceMinor,
    refusalCode: failure ? failure.code : null,
    refusalIsAppError: failure instanceof AppError && failure.code === ERROR_CODE.VALIDATION_ERROR,
    labels: { sale: TRANSACTION_TYPE_LABELS_AR[TRANSACTION_TYPE.SALE_PESTICIDES] }
  }, null, 2));
}

main().catch((error) => {
  console.error('preview build failed', error);
  process.exitCode = 1;
});
