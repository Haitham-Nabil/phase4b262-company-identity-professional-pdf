// Phase 4B.1 — customers screen: search, filters, sorting, display projection,
// route destinations, form mapping and the layering guarantee. The view modules
// are pure string builders, so they are tested directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  defaultCriteria, matchesSearch, matchesStatus, matchesBalance, matchesRegion, filterCustomers,
  sortCustomers, visibleCustomers, countCustomers, collectRegions, balanceDisplay, openingBalanceDisplay,
  nameCell, statusBadge, renderCustomersRegion, renderCustomersToolbar, renderCustomersSummary,
  customersScreenHtml, customersViewHtml, CUSTOMER_SORT_KEY, SORT_DIRECTION, NEEDS_NAME_LABEL
} from '../ui/views/customers.js';
import { customerFormHtml, customerFormShellHtml, buildDraftFromValues, fieldErrorsFromAppError, FORM_MODE } from '../ui/views/customerForm.js';
import {
  matchCustomerSubroute, customerAccountPath, customerEditPath, customerNewPath,
  customerListPath, CUSTOMER_DESTINATION
} from '../ui/routes.js';
import { resolveDestination } from '../ui/router.js';
import { renderDestinationView } from '../ui/views/index.js';
import { logger } from '../src/utils/logger.js';

logger.disable?.();

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const uiRoot = join(projectRoot, 'ui');

function row({ id = 'id-1', code = 'C-1', name = 'عميل', phone = null, region = null, active = true, balanceMinor = 0, side = 'Zero', openingMinor = 0 }) {
  return {
    Customer: {
      Id: id, Code: code, Name: name, Phone: phone, Region: region, Notes: null,
      OpeningBalanceMinor: openingMinor, IsActive: active,
      CreatedAt: '2026-10-01T00:00:00.000Z', UpdatedAt: '2026-10-01T00:00:00.000Z'
    },
    Summary: {
      OpeningBalanceMinor: openingMinor, TotalDebitMinor: 0, TotalCreditMinor: 0,
      CashReceivedMinor: 0, CashPaidMinor: 0, NonCashSettlementMinor: 0,
      BalanceMinor: balanceMinor, BalanceSide: side
    }
  };
}

const FIXTURE = [
  row({ id: 'a', code: 'C-100', name: 'أحمد المصري', phone: '0123456789', region: 'المنوفية', balanceMinor: 130000, side: 'Credit' }),
  row({ id: 'b', code: 'C-101', name: 'شركة الدلتا', phone: '0112223333', region: 'طنطا', balanceMinor: -150000, side: 'Debit', active: false }),
  row({ id: 'c', code: 'C-102', name: null, phone: null, region: null, balanceMinor: 0, side: 'Zero' })
];

test('Search matches code, name and phone, case-insensitively', () => {
  assert.equal(matchesSearch(FIXTURE[0], 'c-100'), true);
  assert.equal(matchesSearch(FIXTURE[0], 'أحمد'), true);
  assert.equal(matchesSearch(FIXTURE[0], '0123'), true);
  assert.equal(matchesSearch(FIXTURE[0], ''), true);
  assert.equal(matchesSearch(FIXTURE[0], 'لا يوجد'), false);
});

test('Search does not match on region alone (spec: code, name, phone)', () => {
  assert.equal(matchesSearch(FIXTURE[1], 'طنطا'), false);
});

test('Status filter: all / active / inactive read IsActive only', () => {
  assert.equal(matchesStatus(FIXTURE[0], 'all'), true);
  assert.equal(matchesStatus(FIXTURE[0], 'active'), true);
  assert.equal(matchesStatus(FIXTURE[1], 'active'), false);
  assert.equal(matchesStatus(FIXTURE[1], 'inactive'), true);
  assert.equal(matchesStatus(FIXTURE[2], 'inactive'), false);
});

test('Balance filter: positive / negative / zero read the core balance side', () => {
  assert.equal(matchesBalance(FIXTURE[0], 'positive'), true);
  assert.equal(matchesBalance(FIXTURE[1], 'positive'), false);
  assert.equal(matchesBalance(FIXTURE[1], 'negative'), true);
  assert.equal(matchesBalance(FIXTURE[2], 'zero'), true);
  assert.equal(matchesBalance(FIXTURE[0], 'all'), true);
});

test('Region filter and combined criteria narrow the list without mutating it', () => {
  assert.equal(matchesRegion(FIXTURE[0], 'المنوفية'), true);
  assert.equal(matchesRegion(FIXTURE[0], 'all'), true);
  assert.equal(filterCustomers(FIXTURE, { ...defaultCriteria(), region: 'طنطا' }).length, 1);
  assert.equal(filterCustomers(FIXTURE, { ...defaultCriteria(), status: 'inactive', balance: 'negative' }).length, 1);
  assert.equal(filterCustomers(FIXTURE, { ...defaultCriteria(), search: 'C-10' }).length, 3);
  assert.equal(FIXTURE.length, 3, 'the source list is not modified');
});

test('Sorting by code, name and balance is deterministic in both directions', () => {
  const byCode = sortCustomers(FIXTURE, CUSTOMER_SORT_KEY.CODE, SORT_DIRECTION.ASC).map((r) => r.Customer.Code);
  assert.deepEqual(byCode, ['C-100', 'C-101', 'C-102']);
  const byCodeDesc = sortCustomers(FIXTURE, CUSTOMER_SORT_KEY.CODE, SORT_DIRECTION.DESC).map((r) => r.Customer.Code);
  assert.deepEqual(byCodeDesc, ['C-102', 'C-101', 'C-100']);

  const byBalance = sortCustomers(FIXTURE, CUSTOMER_SORT_KEY.BALANCE, SORT_DIRECTION.ASC).map((r) => r.Summary.BalanceMinor);
  assert.deepEqual(byBalance, [-150000, 0, 130000]);

  const byName = sortCustomers(FIXTURE, CUSTOMER_SORT_KEY.NAME, SORT_DIRECTION.ASC);
  assert.equal(byName.length, 3);
  assert.deepEqual(FIXTURE.map((r) => r.Customer.Code), ['C-100', 'C-101', 'C-102'], 'sorting never mutates the input');
});

test('visibleCustomers applies filters and sorting together', () => {
  const visible = visibleCustomers(FIXTURE, { ...defaultCriteria(), status: 'active', sortKey: CUSTOMER_SORT_KEY.BALANCE, sortDir: SORT_DIRECTION.DESC });
  assert.equal(visible.length, 2);
  assert.equal(visible[0].Customer.Code, 'C-100');
});

test('Counts come from the loaded rows', () => {
  const counts = countCustomers(FIXTURE);
  assert.equal(counts.Total, 3);
  assert.equal(counts.Active, 2);
  assert.equal(counts.Inactive, 1);
  assert.equal(counts.NeedsName, 1);
});

test('Regions are collected uniquely, sorted, and empty values are dropped', () => {
  assert.deepEqual(collectRegions(FIXTURE), ['المنوفية', 'طنطا']);
  assert.deepEqual(collectRegions([]), []);
});

test('Balance display reads the core summary and picks the financial class', () => {
  const credit = balanceDisplay(FIXTURE[0]);
  assert.equal(credit.text, '1,300.00');
  assert.equal(credit.className, 'amount amount--positive');
  const debit = balanceDisplay(FIXTURE[1]);
  assert.equal(debit.text, '-1,500.00');
  assert.equal(debit.className, 'amount amount--negative');
  const zero = balanceDisplay(FIXTURE[2]);
  assert.equal(zero.text, '0.00');
  assert.equal(zero.className, 'amount amount--zero');
});

test('Balance display never recomputes the balance from the opening balance', () => {
  const inconsistent = row({ openingMinor: 999999, balanceMinor: 0, side: 'Zero' });
  assert.equal(balanceDisplay(inconsistent).text, '0.00');
  assert.equal(balanceDisplay({ Customer: {}, Summary: {} }).text, '—');
  assert.equal(openingBalanceDisplay(row({ openingMinor: 50000 })).text, '500.00');
});

test('Names: a nameless imported customer is shown as needing a name', () => {
  assert.match(nameCell({ Id: 'c', Name: null }), /بحاجة إلى اسم/);
  assert.match(nameCell(FIXTURE[0].Customer), /href="#\/customer\/a"/);
  assert.equal(NEEDS_NAME_LABEL, 'بحاجة إلى اسم');
});

test('Status badge is driven by IsActive only', () => {
  assert.match(statusBadge({ IsActive: true }), /نشط/);
  assert.match(statusBadge({ IsActive: false }), /غير نشط/);
  assert.match(statusBadge({ IsActive: true }), /badge--status-active/);
  assert.match(statusBadge({ IsActive: false }), /badge--status-inactive/);
});

test('Customer destinations resolve by pattern, with parameters and safe decoding', () => {
  assert.equal(matchCustomerSubroute('/customers/new').id, CUSTOMER_DESTINATION.NEW);
  assert.equal(matchCustomerSubroute('/customers/edit/C-100').params.id, 'C-100');
  assert.equal(matchCustomerSubroute('/customer/C-100').id, CUSTOMER_DESTINATION.ACCOUNT);
  assert.equal(matchCustomerSubroute('/customers'), null);
  assert.equal(matchCustomerSubroute('/customers/a/b'), null);
  assert.equal(matchCustomerSubroute('/customers/edit'), null);
  assert.equal(matchCustomerSubroute('/customer/%E0%A4%A').params.id, '%E0%A4%A');
  assert.equal(customerNewPath(), '/customers/new');
  assert.equal(customerEditPath('C 1'), '/customers/edit/C%201');
  assert.equal(customerAccountPath('C 1'), '/customer/C%201');
  assert.equal(customerListPath(), '/customers');
});

test('The router resolves every customer destination and keeps its fallback', () => {
  assert.equal(resolveDestination('#/customers').destination.id, 'customers');
  assert.equal(resolveDestination('#/customers/new').destination.id, CUSTOMER_DESTINATION.NEW);
  assert.equal(resolveDestination('#/customers/edit/x').params.id, 'x');
  assert.equal(resolveDestination('#/customer/x').destination.parentRouteId, 'customers');
  assert.equal(resolveDestination('#/reports').destination.id, 'reports');
  assert.equal(resolveDestination('#/nope').destination.id, 'dashboard');
  assert.equal(resolveDestination('#/nope').resolved, false);
});

test('Destination dispatch: customers screens and reports are functional, others stay placeholders', () => {
  const list = renderDestinationView({ route: { id: 'customers', title: 'العملاء', subtitle: 'س' } });
  assert.match(list, /\+ إضافة عميل/);
  assert.match(list, /جارٍ تحميل العملاء…/);
  assert.match(list, /customers-region/);

  const form = renderDestinationView({ route: { id: 'customers-new', title: 'إضافة عميل' } });
  assert.match(form, /class="customer-form"/);
  assert.match(form, /name="Code"/);

  const account = renderDestinationView({ route: { id: 'customer-account', title: 'حساب العميل' }, params: { id: 'C-100' } });
  assert.match(account, /جارٍ تحميل كشف حساب العميل/);

  // Phase 4B.12 — /reports is no longer a placeholder: it renders the carton reports.
  const reports = renderDestinationView({ route: { id: 'reports', title: 'التقارير', subtitle: 'س', group: 'التحليل' } });
  assert.match(reports, /تقارير مشتريات الكرتون/);
  assert.match(reports, /id="report-filters"/);
  assert.match(reports, /data-report-kind="byFarmer"/);
  assert.match(reports, /data-report-kind="byCompany"/);
  assert.match(reports, /data-report-kind="byCartonType"/);
  assert.match(reports, /data-report-kind="cross"/);

  // Phase 4B.16 — /dashboard is no longer a placeholder either: it renders the real
  // read-only dashboard. The placeholder assertion below now uses a route that really
  // is still unimplemented, so the check keeps its original meaning.
  const dashboard = renderDestinationView({ route: { id: 'dashboard', title: 'لوحة التحكم', subtitle: 'س', group: 'نظرة عامة' } });
  assert.match(dashboard, /id="dashboard-root"/);
  assert.match(dashboard, /id="dashboard-period"/);
  assert.doesNotMatch(dashboard, /لم تُبنَ وظائف الشاشة بعد/);

  // Phase 4B.23 — settings and crop purchases now have functional entry screens.
  const settings = renderDestinationView({ route: { id: 'settings', title: 'الإعدادات', subtitle: 'س', group: 'النظام' } });
  assert.match(settings, /settings-root/);
  assert.match(settings, /إعدادات التطبيق/);
  assert.doesNotMatch(settings, /لم تُبنَ وظائف الشاشة بعد/);
  const cropPurchases = renderDestinationView({ route: { id: 'crop-purchases', title: 'مشتريات المحصول', subtitle: 'س', group: 'العمليات اليومية' } });
  assert.match(cropPurchases, /إضافة مشتريات محصول محلي/);
  assert.match(cropPurchases, /إضافة مشتريات كرتون/);
  assert.doesNotMatch(cropPurchases, /لم تُبنَ وظائف الشاشة بعد/);
});

test('The list region renders the real rows it is given, in order, and nothing else', () => {
  const html = renderCustomersRegion({ rows: FIXTURE, criteria: defaultCriteria() });
  assert.match(html, /C-100/);
  assert.match(html, /أحمد المصري/);
  assert.match(html, /1,300.00/);
  assert.match(html, /-1,500.00/);
  assert.match(html, /نشط/);
  assert.match(html, /غير نشط/);
  assert.match(html, /عدد النتائج: 3 من 3/);
  assert.equal((html.match(/data-action="edit"/g) || []).length, 3);
  assert.doesNotMatch(html, /Customer [0-9]/);
});

test('The list region shows the real empty state when there are no customers', () => {
  const html = renderCustomersRegion({ rows: [], criteria: defaultCriteria() });
  assert.match(html, /لا يوجد عملاء حتى الآن/);
  assert.match(html, /أضف أول عميل للبدء/);
  assert.match(html, /data-action="add-customer"/);
  assert.doesNotMatch(html, /<tbody>/);
});

test('The list region shows a no-results state when filters exclude everything', () => {
  const html = renderCustomersRegion({ rows: FIXTURE, criteria: { ...defaultCriteria(), search: 'zzz' } });
  assert.match(html, /لا نتائج مطابقة/);
  assert.match(html, /data-action="clear-filters"/);
});

test('The list region shows a visible error state with a retry action, never data', () => {
  const html = renderCustomersRegion({ rows: [], criteria: defaultCriteria(), error: { code: 'STORAGE_ERROR' } });
  assert.match(html, /role="alert"/);
  assert.match(html, /تعذّر تحميل العملاء/);
  assert.match(html, /STORAGE_ERROR/);
  assert.match(html, /data-action="retry"/);
  assert.doesNotMatch(html, /<tbody>/);
  assert.doesNotMatch(html, /0\.00/);
});

test('The screen shell renders the loading state and no customer rows before data arrives', () => {
  const html = customersViewHtml();
  assert.match(html, /<h2>العملاء<\/h2>/);
  assert.match(html, /class="spinner"/);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /<td/);
});

test('The screen with data renders counts, the toolbar and the rows it was given', () => {
  const html = customersScreenHtml({ rows: FIXTURE, criteria: defaultCriteria() });
  assert.match(html, /إجمالي العملاء/);
  assert.match(html, /class="toolbar"/);
  assert.match(html, /id="filter-status"/);
  assert.match(html, /id="filter-balance"/);
  assert.match(html, /id="filter-region"/);
  assert.match(html, /id="sort-key"/);
  assert.match(html, /عملاء بحاجة إلى اسم/);
  assert.match(html, /aria-busy="false"/);
});

test('Toolbar keeps the current criteria selected', () => {
  const html = renderCustomersToolbar({ criteria: { ...defaultCriteria(), status: 'inactive', sortKey: 'balance' }, regions: ['طنطا'] });
  assert.match(html, /value="inactive" selected/);
  assert.match(html, /value="balance" selected/);
  assert.match(html, /طنطا/);
});

test('Summary counts are rendered from the rows, and the nameless note appears only when needed', () => {
  const withNameless = renderCustomersSummary(countCustomers(FIXTURE));
  assert.match(withNameless, />3</);
  assert.match(withNameless, />2</);
  assert.match(withNameless, /عملاء بحاجة إلى اسم/);
  const withoutNameless = renderCustomersSummary(countCustomers([FIXTURE[0]]));
  assert.doesNotMatch(withoutNameless, /عملاء بحاجة إلى اسم/);
});

test('Form draft mapping trims text, omits empty optionals and keeps an invalid number for the service to reject', () => {
  const draft = buildDraftFromValues({ Code: '  C-9  ', Name: '  عميل  ', Phone: '  ', Region: 'طنطا', Notes: '', OpeningBalance: ' 125.50 ' });
  assert.equal(draft.Code, 'C-9');
  assert.equal(draft.Name, 'عميل');
  assert.equal(draft.Phone, null);
  assert.equal(draft.Region, 'طنطا');
  assert.equal(draft.Notes, null);
  assert.equal(draft.OpeningBalance, 125.5);
  assert.equal('IsActive' in draft, false);
  assert.equal(buildDraftFromValues({ Code: 'C-9' }).OpeningBalance, undefined);
  assert.equal(Number.isNaN(buildDraftFromValues({ Code: 'C-9', OpeningBalance: 'abc' }).OpeningBalance), true);
  assert.equal(buildDraftFromValues({ IsActive: 'false' }).IsActive, false);
});

test('Form errors are mapped to their field from the service error', () => {
  const mapped = fieldErrorsFromAppError({ code: 'CONFLICT', details: { errors: [{ field: 'Code', message: 'كود العميل مستخدم بالفعل لعميل آخر.' }] } });
  assert.deepEqual(mapped, [{ field: 'Code', message: 'كود العميل مستخدم بالفعل لعميل آخر.' }]);
  assert.equal(fieldErrorsFromAppError({ message: 'خطأ عام' })[0].field, null);
  assert.equal(fieldErrorsFromAppError(null)[0].message, 'تعذّر حفظ بيانات العميل.');
});

test('The create form asks for the approved fields, and the edit form locks the code', () => {
  const create = customerFormHtml({ mode: FORM_MODE.CREATE });
  assert.match(create, /name="Code"/);
  assert.match(create, /name="Name"/);
  assert.match(create, /name="Phone"/);
  assert.match(create, /name="Region"/);
  assert.match(create, /name="Notes"/);
  assert.match(create, /name="OpeningBalance"/);
  assert.match(create, /novalidate/);
  assert.doesNotMatch(create, /name="IsActive"/);

  const edit = customerFormHtml({ mode: FORM_MODE.EDIT, values: { Code: 'C-100', Name: 'أحمد', IsActive: false } });
  assert.match(edit, /readonly aria-readonly="true"/);
  assert.match(edit, /name="IsActive"/);
  assert.match(edit, /value="false" selected/);
  assert.doesNotMatch(edit, /name="OpeningBalance"/);
});

test('Form errors are rendered next to their field and as an invalid state', () => {
  const html = customerFormHtml({ mode: FORM_MODE.CREATE, values: { Code: 'C-1' }, errors: [{ field: 'Name', message: 'اسم العميل مطلوب.' }] });
  assert.match(html, /class="field__error">اسم العميل مطلوب\./);
  assert.match(html, /id="customer-name"[^>]*aria-invalid="true"/);
});

test('The edit form loads its shell in a busy state and the account screen stays a hook', () => {
  const edit = customerFormShellHtml({ mode: FORM_MODE.EDIT });
  assert.match(edit, /جارٍ تحميل بيانات العميل…/);
  assert.match(edit, /aria-busy="true"/);
  const create = customerFormShellHtml({ mode: FORM_MODE.CREATE });
  assert.match(create, /class="customer-form"/);
  assert.match(create, /aria-busy="false"/);
});

test('Layering: every UI module reaches the services layer only', () => {
  const walk = (directory) => readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.js') ? [full] : [];
  });
  const files = walk(uiRoot);
  assert.ok(files.length >= 10, 'the ui tree must contain the shell and the customer screen');
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const forbidden of ['repositories', 'storage/db', 'storage/schema', 'indexedDB', 'IndexedDB', 'IDBKeyRange']) {
      assert.equal(source.includes(forbidden), false, `${file} must not reference ${forbidden}`);
    }
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    for (const target of imports) {
      const intoSrc = target.includes('/src/');
      if (intoSrc) assert.match(target, /\/src\/(services|utils)\//, `${file} may only reach the services and utils layers, got ${target}`);
    }
  }
});

test('The customers screen module holds no sample data and no write path of its own', () => {
  const source = readFileSync(join(uiRoot, 'views/customers.js'), 'utf8');
  assert.doesNotMatch(source, /const customers = \[/);
  assert.doesNotMatch(source, /delete\s*\(/);
  assert.equal(source.includes('Customer 1'), false);
  const form = readFileSync(join(uiRoot, 'views/customerForm.js'), 'utf8');
  assert.doesNotMatch(form, /delete\s*\(/);
});
