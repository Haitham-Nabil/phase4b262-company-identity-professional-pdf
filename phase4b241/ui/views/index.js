// View layer. Phase 4A ships the shell only: each route renders an honest
// placeholder built from the shared design system. No feature logic lives here.
import { pageHeader, card, alert, button, table, badge } from '../components/index.js';
import { emptyState } from '../components/states.js';
import { escapeHtml } from '../components/html.js';
import { financialLegend } from '../components/financial.js';
import { customersViewHtml, initCustomersView } from './customers.js';
import { customerFormShellHtml, initCustomerFormView, FORM_MODE } from './customerForm.js';
import { customerAccountShellHtml, initCustomerAccountView } from './customerAccount.js';
import { transactionFormShellHtml, initTransactionFormView } from './transactionForm.js';
import { paymentsViewHtml, initPaymentsView } from './payments.js';
import { settlementsViewHtml, initSettlementsView } from './settlements.js';
import { backupViewHtml, initBackupView } from './backup.js';
import { referencesViewHtml, initReferencesView } from './references.js';
import { reportsViewHtml, initReportsView } from './reports.js';
import { transactionsViewHtml, initTransactionsView } from './transactions.js';
import { dashboardViewHtml, initDashboardView } from './dashboard.js';
import { settingsViewHtml, initSettingsView } from './settings.js';
import { cropPurchasesViewHtml, initCropPurchasesView } from './cropPurchases.js';

// Phase 4B.4 — the Payments navigation item now renders its real, functional screen.
export const PAYMENTS_DESTINATION = 'payments';

// Phase 4B.5 — the Settlements navigation item now renders its real, functional screen.
export const SETTLEMENTS_DESTINATION = 'settlements';

// Phase 4B.10 — the Backup navigation item now renders its real, functional screen.
export const BACKUP_DESTINATION = 'backup';

// Phase 4B.12 — the Reports navigation item renders the carton purchase reports.
export const REPORTS_DESTINATION = 'reports';

// Phase 4B.16 — the Dashboard navigation item renders the real read-only dashboard.
export const DASHBOARD_DESTINATION = 'dashboard';
import { CUSTOMER_DESTINATION, TRANSACTION_DESTINATION, REFERENCE_DESTINATION, cropReferencesPath } from '../routes.js';

// Per-screen orientation copy. Text only — describes what the screen will hold
// and which approved services back it. No value, no rule, no calculation.
const VIEW_COPY = Object.freeze({
  dashboard: {
    note: 'ستعرض هذه الشاشة ملخّص الحسابات: إجماليات الحركة النقدية وغير النقدية وأعلى المديونيات، منقسمة كما هي معتمدة.',
    points: ['الحركة النقدية منفصلة عن غير النقدية', 'لا يوجد عنصر تجميع واحد للنقدي وغير النقدي']
  },
  customers: {
    note: 'ستعرض هذه الشاشة سجل العملاء: الكود (هوية العميل)، الاسم، كود الاتصال، المنطقة، والرصيد الافتتاحي.',
    points: ['الكود فريد لكل عميل', 'الاسم إلزامي للإدخال اليدوي ومقبول كفارغ للعملاء المستوردين']
  },
  transactions: {
    note: 'ستعرض هذه الشاشة سجل الحركات المركزي، حيث كل حركة سجل مستقل بذاته.',
    points: ['لا دمج لحركتين في سجل واحد', 'الحركة الملغاة تبقى ظاهرة ولا تدخل في الحساب']
  },
  'crop-purchases': {
    note: 'ستعرض هذه الشاشة مشتريات المحصول بنوعيها، وتُحسب قيمة الحركة من بيانات المحصول وإعداد الوزن الافتراضي للعبوة فقط.',
    points: ['صافي الوزن (G) قيمة محسوبة لا تُدخل يدويًا', 'لا يُقبل مبلغ صريح في مشتريات المحصول']
  },
  payments: {
    note: 'ستعرض هذه الشاشة الحركة النقدية للعملاء: الاستلام والدفع.',
    points: ['النقدي يُقاس منفصلًا عن غير النقدي', 'لا عنصر تجميع واحد يجمع النقدي بغير النقدي']
  },
  settlements: {
    note: 'ستعرض هذه الشاشة التسويات ومبادلة البضاعة وتحويل المديونية.',
    points: ['التسوية ومبادلة البضاعة وتحويل المديونية بلا أثر نقدي', 'تحويل المديونية عملية واحدة بسجلين مرتبطين']
  },
  reports: {
    note: 'ستضم تقارير العملاء والحسابات كشف الحساب الفردي والمجمع وأرصدة العملاء وتحليل حركة الحسابات.',
    points: ['كشف حساب كامل أو خلال فترة', 'تقرير أرصدة العملاء في تاريخ محدد', 'تحليل حركة العملاء مع فتح كشف كل عميل']
  },
  settings: {
    note: 'ستعرض هذه الشاشة إعدادات التطبيق المستخدمة في الحساب.',
    points: ['الوزن الافتراضي للعبوة هو الإعداد الحالي', 'قيمته تُقرأ من المخزن ولا تُثبَّت داخل الشاشة']
  },
  import: {
    note: 'ستنفّذ هذه الشاشة استيراد بيانات العملاء والحركات من ملف Excel، بعد معاينة وموافقة صريحة قبل الكتابة.',
    points: ['الربط بين العميل وورقة العميل يتم عبر الارتباط التشعبي في قائمة العملاء', 'لا تُكتب أي حركة قبل تأكيد المستخدم']
  },
  backup: {
    note: 'ستنفّذ هذه الشاشة إنشاء نسخة احتياطية كاملة من بيانات المخزن المحلي واستعادتها.',
    points: ['الاستعادة تحلّ محل البيانات دفعة واحدة بعد نجاح التحقق كاملًا', 'ملف النسخة غير الصالح يُرفض دون أي تعديل على البيانات القائمة']
  }
});

const SHARED_NOTICE = 'هذه الشاشة جزء من هيكل التطبيق. وُصلت طبقة الخدمات ولم تُبنَ وظائف الشاشة بعد.';

function orientationCard(route) {
  const copy = VIEW_COPY[route.id];
  if (!copy) return '';
  const list = copy.points.length
    ? `<ul>${copy.points.map((point) => `<li>${escapeHtml(point)}</li>`).join('')}</ul>`
    : '';
  return card({
    title: 'نطاق الشاشة المعتمد',
    body: `<p>${escapeHtml(copy.note)}</p>${list}`
  });
}

function placeholderActions() {
  return [button({ label: 'الإجراءات تظهر عند تنفيذ الشاشة', variant: 'outline', disabled: true })];
}

// Every route renders the same honest structure until its phase arrives.
export function renderPlaceholderView(route) {
  return [
    pageHeader({
      title: route.title,
      description: route.subtitle,
      actions: placeholderActions(route)
    }),
    alert({ tone: 'info', title: 'مرحلة الهيكل', message: SHARED_NOTICE }),
    '<div class="grid grid--cols-2 page-section">',
    orientationCard(route),
    card({ title: 'حالة البيانات', body: emptyState({ title: 'لا توجد بيانات للعرض في هذه المرحلة', message: 'لا تُعرض بيانات وهمية أو قيم مالية تقديرية.' }) }),
    '</div>',
    card({
      title: 'مفتاح الدلالات المالية المعتمد',
      body: `<p class="text-sm text-muted">المفتاح التالي محجوز للاستخدام في الشاشات القادمة، ويمثّل عرضًا بصريًا فقط.</p>${financialLegend()}`,
      footer: `${badge('دائن', 'credit')}${badge('مدين', 'debit')}${badge('نقدي', 'cash')}${badge('غير نقدي', 'nonCash')}${badge('ملغاة', 'cancelled')}`
    })
  ].join('\n');
}

// Empty shell table used by preview/tests to prove the table primitive works
// (headers only — no rows, therefore no invented data).
export function headerOnlyTable(columns) {
  return table({ columns, rows: [], numeric: true, emptyMessage: 'لا توجد صفوف.' });
}

export function renderView(route) {
  return renderPlaceholderView(route);
}

// ---------------------------------------------------------------------------
// Phase 4B.1 — destination dispatch. Screens that are implemented get their real
// view; every other route keeps the honest placeholder from Phase 4A.
// ---------------------------------------------------------------------------
export function renderDestinationView({ route, params = {} } = {}) {
  if (!route) return '';
  // Phase 4B.16 — the dashboard is no longer a placeholder: a read-only overview.
  if (route.id === DASHBOARD_DESTINATION) return dashboardViewHtml();
  if (route.id === 'settings') return settingsViewHtml();
  if (route.id === 'crop-purchases') return cropPurchasesViewHtml();
  if (route.id === CUSTOMER_DESTINATION.LIST) return customersViewHtml();
  if (route.id === CUSTOMER_DESTINATION.NEW) return customerFormShellHtml({ mode: FORM_MODE.CREATE });
  if (route.id === CUSTOMER_DESTINATION.EDIT) return customerFormShellHtml({ mode: FORM_MODE.EDIT });
  if (route.id === CUSTOMER_DESTINATION.ACCOUNT) return customerAccountShellHtml({ customerId: params.id ?? null });
  if (route.id === PAYMENTS_DESTINATION) return paymentsViewHtml();
  if (route.id === SETTLEMENTS_DESTINATION) return settlementsViewHtml();
  if (route.id === BACKUP_DESTINATION) return backupViewHtml();
  if (route.id === REPORTS_DESTINATION) return reportsViewHtml();
  if (route.id === REFERENCE_DESTINATION.LIST) return referencesViewHtml();
  // Phase 4B.15 — the central ledger replaces the placeholder: a read-only register.
  if (route.id === TRANSACTION_DESTINATION.LEDGER) return transactionsViewHtml();
  if (route.id === TRANSACTION_DESTINATION.ADD) return transactionFormShellHtml({ lockedCustomerId: params.customerId ?? null, transactionType: params.type ?? '' });
  return renderPlaceholderView(route);
}

export function initDestinationView({ container, route, params = {}, navigate = null } = {}) {
  if (!container || !route) return null;
  if (route.id === DASHBOARD_DESTINATION) return initDashboardView({ container, navigate });
  if (route.id === 'settings') return initSettingsView({ container });
  if (route.id === 'crop-purchases') return initCropPurchasesView({ container, navigate });
  if (route.id === CUSTOMER_DESTINATION.LIST) return initCustomersView({ container, navigate });
  if (route.id === CUSTOMER_DESTINATION.NEW) return initCustomerFormView({ container, mode: FORM_MODE.CREATE, navigate });
  if (route.id === CUSTOMER_DESTINATION.EDIT) return initCustomerFormView({ container, mode: FORM_MODE.EDIT, customerId: params.id ?? null, navigate });
  if (route.id === CUSTOMER_DESTINATION.ACCOUNT) return initCustomerAccountView({ container, customerId: params.id ?? null, navigate });
  if (route.id === PAYMENTS_DESTINATION) return initPaymentsView({ container, customerId: params.customerId ?? null, navigate });
  if (route.id === SETTLEMENTS_DESTINATION) return initSettlementsView({ container, customerId: params.customerId ?? null, navigate });
  if (route.id === BACKUP_DESTINATION) return initBackupView({ container, navigate });
  if (route.id === REPORTS_DESTINATION) return initReportsView({ container, navigate });
  if (route.id === REFERENCE_DESTINATION.LIST) return initReferencesView({ container, navigate });
  if (route.id === 'crop-purchases') {
    // The placeholder itself gains exactly one working action: open the reference screen.
    container.addEventListener('click', (event) => {
      const link = event.target && event.target.closest ? event.target.closest('#open-references') : null;
      if (link && typeof navigate === 'function') navigate(cropReferencesPath());
    });
    return null;
  }
  if (route.id === TRANSACTION_DESTINATION.LEDGER) return initTransactionsView({ container, navigate });
  if (route.id === TRANSACTION_DESTINATION.ADD) return initTransactionFormView({ container, lockedCustomerId: params.customerId ?? null, transactionType: params.type ?? '', navigate });
  return null;
}

export { VIEW_COPY, SHARED_NOTICE };
