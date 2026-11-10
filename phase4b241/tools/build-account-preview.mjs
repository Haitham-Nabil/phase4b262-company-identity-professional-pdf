// Builds self-contained review snapshots of the Customer Account screen. The data
// comes from RUNNING the real services against a temporary fake database; the
// fixture lives only in this tool and the application never ships sample data.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { freshDatabase, deleteDatabase } from '../tests/helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { balanceService } from '../src/services/balanceService.js';
import { cancellationService } from '../src/services/cancellationService.js';
import { openingBalanceService } from '../src/services/openingBalanceService.js';
import { TRANSACTION_TYPE } from '../src/domain/transactionTypes.js';
import { shellRegions } from '../ui/components/layout.js';
import { findRouteById, CUSTOMER_DESTINATION } from '../ui/routes.js';
import { customerAccountHtml, renderAccountError, defaultLedgerCriteria } from '../ui/views/customerAccount.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(root, 'preview');
mkdirSync(out, { recursive: true });

const APP_NAME = 'حسابات العملاء';
const SHEETS = ['tokens.css', 'base.css', 'layout.css', 'components.css', 'financial.css'];
const inlinedCss = SHEETS.map((n) => `/* ===== ${n} ===== */\n${readFileSync(join(root, 'ui/styles', n), 'utf8')}`).join('\n');
const banner = '<div class="preview-banner">صفحة مراجعة: البيانات أدناه مُنتَجة بتشغيل طبقة الخدمات على قاعدة تجريبية مؤقتة داخل أداة اللقطة، ولا توجد أي بيانات تجريبية داخل التطبيق.</div>';
const page = (title, body) => `<!DOCTYPE html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n<style>\n${inlinedCss}\n.preview-banner { padding: var(--space-3) var(--space-4); background: var(--color-alert-warning-soft); border-bottom: 1px solid var(--color-alert-warning); font-size: var(--font-size-xs); }\n</style>\n</head>\n<body>\n${banner}\n${body}\n</body>\n</html>\n`;

const accountRoute = { id: CUSTOMER_DESTINATION.ACCOUNT, title: 'حساب العميل', subtitle: 'كشف حساب العميل', parentRouteId: 'customers' };
const shell = (body, route = accountRoute) => shellRegions({ route, activeRouteId: 'customers', appName: APP_NAME, appTagline: 'تطبيق محلي يعمل دون اتصال', packageWeightKg: 14, body });

await freshDatabase('preview_account');
const customer = await customerService.createCustomer({ Code: 'C-100', Name: 'أحمد المصري', Phone: '0123456789', Region: 'المنوفية', OpeningBalance: 1000 });
await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: TRANSACTION_TYPE.CASH_RECEIVED, Amount: 500, Description: 'دفعة نقدية من العميل' });
await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-02', TransactionType: TRANSACTION_TYPE.SALE_PESTICIDES, Amount: 1200, Description: 'فاتورة مبيدات' });
const settled = await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-03', TransactionType: TRANSACTION_TYPE.SETTLEMENT, Amount: 300, Description: 'تسوية غير نقدية' });
await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-04', TransactionType: TRANSACTION_TYPE.CASH_PAID, Amount: 150, Description: 'صرف نقدي' });
await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-05', TransactionType: TRANSACTION_TYPE.CROP_PURCHASE_CARTON, crop: { CartonQuantityMilli: 4000, CartonUnitPriceMinor: 5000, CartonDiscountMinor: 0 } });
await cancellationService.cancelTransaction(settled.Id, 'حركة ملغاة للعرض');
await openingBalanceService.setOpeningBalance(customer.Id, { newValue: 1000, reason: 'تثبيت الرصيد الافتتاحي بعد المراجعة' });

const summary = await balanceService.getCustomerSummary(customer.Id);
const ledger = await balanceService.getRunningBalance(customer.Id);
const history = await customerService.listOpeningBalanceHistory(customer.Id);
const loaded = customerAccountHtml({ customer, summary, ledger, openingHistory: history, criteria: defaultLedgerCriteria() });
writeFileSync(join(out, 'account-loaded.html'), page('لقطة كشف حساب العميل — بيانات محمَّلة', shell(loaded)), 'utf8');

const emptyCustomer = await customerService.createCustomer({ Code: 'C-101', Name: 'عميل بلا حركات', OpeningBalance: 250 });
const emptySummary = await balanceService.getCustomerSummary(emptyCustomer.Id);
writeFileSync(join(out, 'account-empty.html'), page('لقطة كشف حساب العميل — بلا حركات', shell(customerAccountHtml({ customer: emptyCustomer, summary: emptySummary, ledger: { Entries: [] }, openingHistory: [] }))), 'utf8');

writeFileSync(join(out, 'account-error.html'), page('لقطة كشف حساب العميل — حالة خطأ', shell(renderAccountError({ code: 'STORAGE_ERROR' }))), 'utf8');

const filtered = customerAccountHtml({ customer, summary, ledger, openingHistory: history, criteria: { ...defaultLedgerCriteria(), filter: 'cash' } });
writeFileSync(join(out, 'account-filtered-cash.html'), page('لقطة كشف الحساب — تصفية الحركات النقدية', shell(filtered)), 'utf8');

await deleteDatabase();
console.log('account previews written to', out, `(ledger rows: ${ledger.Entries.length}, balance: ${summary.BalanceMinor} minor units)`);
