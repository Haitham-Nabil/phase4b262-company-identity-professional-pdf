// Builds self-contained review snapshots of the Customers screen. The data is
// produced by RUNNING the real services against a temporary fake database, so the
// snapshot is the actual output of the screen and not hand written markup. The
// fixture lives only in this tool: the application never ships sample data.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { freshDatabase, deleteDatabase } from '../tests/helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { balanceService } from '../src/services/balanceService.js';
import { TRANSACTION_TYPE } from '../src/domain/transactionTypes.js';
import { shellRegions } from '../ui/components/layout.js';
import { findRouteById } from '../ui/routes.js';
import { customersScreenHtml, defaultCriteria } from '../ui/views/customers.js';
import { customerFormHtml, FORM_MODE } from '../ui/views/customerForm.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(root, 'preview');
mkdirSync(out, { recursive: true });

const APP_NAME = 'حسابات العملاء';
const APP_TAGLINE = 'تطبيق محلي يعمل دون اتصال';
const SHEETS = ['tokens.css', 'base.css', 'layout.css', 'components.css', 'financial.css'];
const inlinedCss = SHEETS.map((name) => `/* ===== ${name} ===== */\n${readFileSync(join(root, 'ui/styles', name), 'utf8')}`).join('\n');
const banner = '<div class="preview-banner">صفحة مراجعة: البيانات أدناه مُنتَجة بتشغيل طبقة الخدمات على قاعدة تجريبية مؤقتة داخل أداة اللقطة، ولا توجد أي بيانات تجريبية داخل التطبيق.</div>';

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${inlinedCss}
.preview-banner { padding: var(--space-3) var(--space-4); background: var(--color-alert-warning-soft); border-bottom: 1px solid var(--color-alert-warning); font-size: var(--font-size-xs); }
</style>
</head>
<body>
${banner}
${body}
</body>
</html>
`;
}

const customersRoute = findRouteById('customers');

async function seededRows() {
  await freshDatabase('preview_customers');
  const ahmed = await customerService.createCustomer({ Code: 'C-100', Name: 'أحمد المصري', Phone: '0123456789', Region: 'المنوفية', OpeningBalance: 1000 });
  const delta = await customerService.createCustomer({ Code: 'C-101', Name: 'شركة الدلتا الزراعية', Phone: '0112223333', Region: 'طنطا', OpeningBalance: 0 });
  const hassan = await customerService.createCustomer({ Code: 'C-102', Name: 'حسن عبد الله', Phone: '0109998887', Region: 'المنوفية', OpeningBalance: 0 });
  const imported = await customerService.createImportedCustomer({ Code: 'IMP-205' });
  await transactionService.createTransaction({ CustomerId: ahmed.Id, Date: '2026-09-05', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 500 });
  await transactionService.createTransaction({ CustomerId: ahmed.Id, Date: '2026-09-09', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 200 });
  await transactionService.createTransaction({ CustomerId: delta.Id, Date: '2026-09-11', TransactionType: TRANSACTION_TYPE.SALE_IRRIGATION, Amount: 1500 });
  await transactionService.createTransaction({ CustomerId: hassan.Id, Date: '2026-09-12', TransactionType: TRANSACTION_TYPE.SETTLEMENT, Amount: 300 });
  await customerService.setActive(delta.Id, false);
  const rows = await balanceService.listCustomerBalances();
  return { rows, ids: { ahmed: ahmed.Id, delta: delta.Id, hassan: hassan.Id, imported: imported.Id } };
}

const { rows } = await seededRows();
writeFileSync(join(out, 'customers-loaded.html'), page('لقطة شاشة العملاء — بيانات محمَّلة', shellRegions({ route: customersRoute, appName: APP_NAME, appTagline: APP_TAGLINE, packageWeightKg: 14, body: customersScreenHtml({ rows, criteria: defaultCriteria() }) })), 'utf8');
writeFileSync(join(out, 'customers-empty.html'), page('لقطة شاشة العملاء — لا يوجد عملاء', shellRegions({ route: customersRoute, appName: APP_NAME, appTagline: APP_TAGLINE, packageWeightKg: 14, body: customersScreenHtml({ rows: [] }) })), 'utf8');
writeFileSync(join(out, 'customers-error.html'), page('لقطة شاشة العملاء — حالة خطأ', shellRegions({ route: customersRoute, appName: APP_NAME, appTagline: APP_TAGLINE, packageWeightKg: 14, body: customersScreenHtml({ rows: [], error: { code: 'STORAGE_ERROR' } }) })), 'utf8');
writeFileSync(join(out, 'customer-form.html'), page('لقطة شاشة إضافة عميل', shellRegions({ route: { id: 'customers-new', title: 'إضافة عميل', subtitle: 'إنشاء عميل جديد بكود فريد' }, appName: APP_NAME, appTagline: APP_TAGLINE, packageWeightKg: 14, activeRouteId: 'customers', body: customerFormHtml({ mode: FORM_MODE.CREATE }) })), 'utf8');
await deleteDatabase();
console.log('customers previews written to', out, `(${rows.length} real customer rows from the services layer)`);
