// Payments screen (Phase 4B.4) — the functional Cash Received / Cash Paid screen.
//
// This module collects input and lays out what the services returned. It contains
// NO financial engine: the direction (Credit / Debit), the cash / non-cash split,
// the running balance and the cancellation state of every row come from the core
// projection through the services layer. The two cash columns shown are the core
// values verbatim — never swapped, never inferred from a type name, never
// recomputed here, and never summed into a balance of the screen's own.
import { pageHeader, card, badge, table, kpi, alert } from '../components/index.js';
import { loadingState, emptyState, errorState } from '../components/states.js';
import { escapeHtml } from '../components/html.js';
import { amountClass } from '../components/financial.js';
import { formatMoneyMinor, formatText, formatCount } from '../../src/utils/formatting.js';
import { logger } from '../../src/utils/logger.js';
import { paymentService } from '../../src/services/paymentService.js';
import { TRANSACTION_TYPE_LABELS_AR } from '../../src/services/balanceService.js';
import { customerAccountPath, customerListPath } from '../routes.js';
import { buildHash } from '../router.js';

export const PAYMENTS_SUMMARY_ID = 'payments-summary';
export const PAYMENTS_TOOLBAR_ID = 'payments-toolbar';
export const PAYMENTS_REGION_ID = 'payments-region';
export const PAYMENTS_TABS_REGION_ID = 'payments-tabs-region';
export const PAYMENTS_FORM_REGION_ID = 'payments-form-region';
export const PAYMENTS_SUCCESS_ID = 'payment-success';
export const PAYMENTS_FORM_ID = 'payment-form';
export const PAYMENTS_FORM_ERROR_ID = 'payment-form-error';
export const PAYMENTS_SUBMIT_ID = 'payment-submit';

// The screen's two tabs map 1:1 onto the two approved cash types.
export const PAYMENT_TAB = Object.freeze({ RECEIVED: 'received', PAID: 'paid' });

export const PAYMENT_TABS = Object.freeze([
  Object.freeze({ id: PAYMENT_TAB.RECEIVED, label: 'استلام نقدية', transactionType: 'CashReceived' }),
  Object.freeze({ id: PAYMENT_TAB.PAID, label: 'دفع نقدية', transactionType: 'CashPaid' })
]);

export const PAYMENT_TYPE_FILTER = Object.freeze({ ALL: 'all' });
export const PAYMENT_STATUS_FILTER = Object.freeze({ ALL: 'all', ACTIVE: 'active', CANCELLED: 'cancelled' });

export const EMPTY_VALUE = '—';
export const CANCELLED_LABEL = 'ملغاة';
export const ACTIVE_LABEL = 'نشطة';
export const EMPTY_STATE_MESSAGE = 'لا توجد حركات نقدية حتى الآن';
export const NO_RESULTS_MESSAGE = 'لا توجد نتائج مطابقة للفلاتر الحالية';
export const RECEIVED_SUCCESS_LABEL = 'تم تسجيل استلام النقدية بنجاح';
export const PAID_SUCCESS_LABEL = 'تم تسجيل الدفعة النقدية بنجاح';

export const PAYMENT_COLUMNS = Object.freeze([
  { label: 'التاريخ' },
  { label: 'العميل' },
  { label: 'النوع' },
  { label: 'البيان' },
  { label: 'المبلغ' },
  { label: 'المقبوض' },
  { label: 'المدفوع' },
  { label: 'الرصيد بعد الحركة' },
  { label: 'الحالة' },
  { label: 'إجراء' }
]);

export function tabFor(transactionType) {
  return transactionType === PAYMENT_TABS[1].transactionType ? PAYMENT_TAB.PAID : PAYMENT_TAB.RECEIVED;
}

export function transactionTypeForTab(tab) {
  const found = PAYMENT_TABS.find((entry) => entry.id === tab);
  return (found || PAYMENT_TABS[0]).transactionType;
}

export function defaultPaymentCriteria() {
  return {
    search: '',
    type: PAYMENT_TYPE_FILTER.ALL,
    from: '',
    to: '',
    status: PAYMENT_STATUS_FILTER.ALL
  };
}

export function typeLabel(transactionType) {
  const label = TRANSACTION_TYPE_LABELS_AR[transactionType];
  return label ? label : (formatText(transactionType) || EMPTY_VALUE);
}

export function movementCustomer(row) {
  const record = row || {};
  return { Code: record.Code ?? null, Name: record.Name ?? null, Phone: record.Phone ?? null };
}

function normalizeText(value) {
  return formatText(value).toLowerCase();
}

export function customerDisplay(row) {
  const customer = movementCustomer(row);
  const parts = [formatText(customer.Code), formatText(customer.Name)].filter(Boolean);
  return parts.length ? parts.join(' — ') : EMPTY_VALUE;
}

// Search covers exactly Code, Name, Phone and Description (spec §19) — a view-level
// narrowing that changes no data and recalculates no value.
export function matchesPaymentSearch(row, term) {
  const needle = normalizeText(term);
  if (!needle) return true;
  const record = row || {};
  const customer = movementCustomer(row);
  return [customer.Code, customer.Name, customer.Phone, record.Description]
    .some((value) => normalizeText(value).includes(needle));
}

export function matchesPaymentType(row, type) {
  if (!type || type === PAYMENT_TYPE_FILTER.ALL) return true;
  return (row || {}).TransactionType === type;
}

export function matchesPaymentStatus(row, status) {
  if (!status || status === PAYMENT_STATUS_FILTER.ALL) return true;
  const isCancelled = (row || {}).IsCancelled === true;
  return status === PAYMENT_STATUS_FILTER.CANCELLED ? isCancelled : !isCancelled;
}

// Dates are stored as ISO YYYY-MM-DD, so the range comparison is exact and needs no
// conversion. The narrowing never recalculates and never reorders: each row keeps
// the running balance the service produced over the full financial sequence.
export function matchesPaymentRange(row, { from = '', to = '' } = {}) {
  const date = formatText((row || {}).Date);
  if (from && date && date < from) return false;
  if (to && date && date > to) return false;
  return true;
}

export function visibleMovements(rows, criteria = defaultPaymentCriteria()) {
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((row) => (
    matchesPaymentSearch(row, criteria.search)
    && matchesPaymentType(row, criteria.type)
    && matchesPaymentStatus(row, criteria.status)
    && matchesPaymentRange(row, criteria)
  ));
}

export function collectRegions(rows) {
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const region = formatText((row || {}).Region);
    if (region) seen.add(region);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function moneyCell(minor, kind, { cancelled = false } = {}) {
  if (!Number.isInteger(minor) || minor === 0) return `<span class="amount">${EMPTY_VALUE}</span>`;
  const className = cancelled ? amountClass('cancelled') : amountClass(kind);
  return `<span class="${escapeHtml(className)}">${escapeHtml(formatMoneyMinor(minor))}</span>`;
}

// The amount column carries no direction claim of its own, so it is rendered with
// the neutral amount class; the two cash columns carry the core values verbatim.
function plainAmountCell(minor, { cancelled = false } = {}) {
  if (!Number.isInteger(minor)) return `<span class="amount">${EMPTY_VALUE}</span>`;
  const className = cancelled ? amountClass('cancelled') : 'amount';
  return `<span class="${escapeHtml(className)}">${escapeHtml(formatMoneyMinor(minor))}</span>`;
}

export function runningBalanceCell(minor) {
  if (!Number.isInteger(minor)) return `<span class="amount">${EMPTY_VALUE}</span>`;
  const kind = minor > 0 ? 'positiveBalance' : (minor < 0 ? 'negativeBalance' : 'zeroBalance');
  const direction = minor > 0 ? 'لصالح العميل' : (minor < 0 ? 'على العميل' : 'متعادل');
  return `<span class="${escapeHtml(amountClass(kind))}" aria-label="${escapeHtml(`${formatMoneyMinor(minor)} ${direction}`)}">${escapeHtml(formatMoneyMinor(minor))}</span>`;
}

function statusCell(row) {
  if ((row || {}).IsCancelled === true) {
    const reason = formatText((row || {}).CancellationReason);
    const title = reason ? ` title="${escapeHtml(reason)}"` : '';
    return `<span${title}>${badge(CANCELLED_LABEL, 'cancelled')}</span>`;
  }
  return badge(ACTIVE_LABEL);
}

export function movementRow(row) {
  const record = row || {};
  const cancelled = record.IsCancelled === true;
  const customerId = formatText(record.CustomerId);
  const action = customerId
    ? `<a class="btn btn--outline" href="${escapeHtml(buildHash(customerAccountPath(customerId)))}" data-action="open-account" data-id="${escapeHtml(customerId)}" aria-label="${escapeHtml(`عرض حساب ${customerDisplay(record)}`)}">عرض الحساب</a>`
    : `<span class="amount">${EMPTY_VALUE}</span>`;
  return {
    className: cancelled ? 'ledger-row--cancelled' : null,
    cells: [
      escapeHtml(formatText(record.Date) || EMPTY_VALUE),
      escapeHtml(customerDisplay(record)),
      escapeHtml(typeLabel(record.TransactionType)),
      escapeHtml(formatText(record.Description) || EMPTY_VALUE),
      plainAmountCell(record.AmountMinor, { cancelled }),
      moneyCell(record.CashReceivedMinor, 'cashIn', { cancelled }),
      moneyCell(record.CashPaidMinor, 'cashOut', { cancelled }),
      runningBalanceCell(record.RunningBalanceMinor),
      statusCell(record),
      action
    ]
  };
}

export function renderPaymentTabs({ tab = PAYMENT_TAB.RECEIVED } = {}) {
  const buttons = PAYMENT_TABS.map((entry) => {
    const isActive = entry.id === tab;
    return `<button class="btn ${isActive ? 'btn--primary' : 'btn--outline'}" type="button" role="tab" id="payment-tab-${escapeHtml(entry.id)}" data-tab="${escapeHtml(entry.id)}" aria-selected="${isActive ? 'true' : 'false'}" aria-controls="${escapeHtml(PAYMENTS_REGION_ID)}">${escapeHtml(entry.label)}</button>`;
  }).join('');
  return `<div class="row" role="tablist" aria-label="نوع الحركة النقدية">${buttons}</div>`;
}

export function renderPaymentsSummary(totals) {
  const data = totals || paymentService.summarize([]);
  const blocks = [
    card({ body: kpi({ label: 'إجمالي المقبوضات', value: formatMoneyMinor(data.CashReceivedMinor), hint: 'استلام نقدية من العملاء' }) }),
    card({ body: kpi({ label: 'إجمالي المدفوعات', value: formatMoneyMinor(data.CashPaidMinor), hint: 'دفعات نقدية للعملاء' }) }),
    card({ body: kpi({ label: 'صافي النقدية', value: formatMoneyMinor(data.NetCashMinor), hint: 'المقبوضات ناقص المدفوعات' }) })
  ];
  return `<div class="grid grid--cols-3">${blocks.join('\n')}</div>
<p class="toolbar__count" aria-live="polite">الحركات المعروضة: ${formatCount(data.Count)}${data.CancelledCount ? ` — ملغاة غير محتسبة: ${formatCount(data.CancelledCount)}` : ''}</p>`;
}

export function renderPaymentsToolbar({ criteria = defaultPaymentCriteria() } = {}) {
  const typeOptions = [
    { value: PAYMENT_TYPE_FILTER.ALL, label: 'الكل' },
    { value: PAYMENT_TABS[0].transactionType, label: PAYMENT_TABS[0].label },
    { value: PAYMENT_TABS[1].transactionType, label: PAYMENT_TABS[1].label }
  ];
  const statusOptions = [
    { value: PAYMENT_STATUS_FILTER.ALL, label: 'الكل' },
    { value: PAYMENT_STATUS_FILTER.ACTIVE, label: 'نشطة' },
    { value: PAYMENT_STATUS_FILTER.CANCELLED, label: 'ملغاة' }
  ];
  const selectControl = (id, key, label, options) => `<div class="field">
  <label class="field__label" for="${escapeHtml(id)}">${escapeHtml(label)}</label>
  <select class="select" id="${escapeHtml(id)}" data-criteria="${escapeHtml(key)}">${options
    .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === criteria[key] ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('')}</select>
</div>`;
  return `<div class="toolbar">
<div class="field">
  <label class="field__label" for="payment-search">بحث</label>
  <input class="input" id="payment-search" type="search" data-criteria="search" value="${escapeHtml(criteria.search)}" placeholder="كود أو اسم أو هاتف أو بيان" aria-label="بحث في الحركات النقدية بالكود أو الاسم أو الهاتف أو البيان">
</div>
${selectControl('payment-filter-type', 'type', 'النوع', typeOptions)}
${selectControl('payment-filter-status', 'status', 'الحالة', statusOptions)}
<div class="field">
  <label class="field__label" for="payment-filter-from">من تاريخ</label>
  <input class="input" id="payment-filter-from" type="date" data-criteria="from" value="${escapeHtml(criteria.from)}">
</div>
<div class="field">
  <label class="field__label" for="payment-filter-to">إلى تاريخ</label>
  <input class="input" id="payment-filter-to" type="date" data-criteria="to" value="${escapeHtml(criteria.to)}">
</div>
<div class="field">
  <span class="field__label">إعادة الضبط</span>
  <button class="btn btn--outline" type="button" data-action="reset-filters">إعادة ضبط الفلاتر</button>
</div>
</div>`;
}

export function renderPaymentsRegion({ rows = null, visible = null, criteria = defaultPaymentCriteria(), error = null, loading = false } = {}) {
  if (loading) return loadingState({ message: 'جارٍ تحميل الحركات النقدية…' });
  if (error) {
    return `<div class="stack">
${errorState({ title: 'تعذّر تحميل الحركات النقدية', message: 'لم يتم تحميل الحركات من المخزن المحلي، ولم تُعرض أي بيانات بديلة.', code: error.code ? String(error.code) : null })}
<div class="row"><button class="btn btn--primary" type="button" data-action="retry">إعادة المحاولة</button></div>
</div>`;
  }
  const all = Array.isArray(rows) ? rows : [];
  if (!all.length) {
    return card({
      title: EMPTY_STATE_MESSAGE,
      body: `${emptyState({ title: EMPTY_STATE_MESSAGE, message: 'سجّل أول حركة نقدية للبدء.', icon: '💵' })}
<div class="row"><button class="btn btn--primary" type="button" data-action="open-form">+ تسجيل حركة نقدية</button></div>`
    });
  }
  const list = Array.isArray(visible) ? visible : visibleMovements(all, criteria);
  if (!list.length) {
    return card({
      title: 'لا نتائج مطابقة',
      body: `${emptyState({ title: NO_RESULTS_MESSAGE, message: 'جرّب تعديل البحث أو الفلاتر.', icon: '🔎' })}
<div class="row"><button class="btn btn--outline" type="button" data-action="reset-filters">إعادة ضبط الفلاتر</button></div>`
    });
  }
  const countLine = `<p class="toolbar__count" aria-live="polite">عدد النتائج: ${formatCount(list.length)} من ${formatCount(all.length)}</p>`;
  return `${countLine}${table({
    numeric: true,
    columns: PAYMENT_COLUMNS,
    rows: list.map(movementRow),
    emptyMessage: NO_RESULTS_MESSAGE
  })}`;
}

// ---------------------------------------------------------------------------
// The movement form: Customer + Date + Amount + Description only (spec §9).
// ---------------------------------------------------------------------------
export const PAYMENT_FIELD_ID = Object.freeze({
  CustomerId: 'payment-customer',
  CustomerSearch: 'payment-customer-search',
  Date: 'payment-date',
  Amount: 'payment-amount',
  Description: 'payment-description'
});

export const PAYMENT_FIELD_LABEL = Object.freeze({
  CustomerId: 'العميل',
  Date: 'التاريخ',
  Amount: 'المبلغ',
  Description: 'البيان (اختياري)'
});

export const PAYMENT_FIELD_ORDER = Object.freeze(['CustomerId', 'Date', 'Amount', 'Description']);

export function customerOptions(customers) {
  const list = Array.isArray(customers) ? customers : [];
  return [{ value: '', label: '— اختر عميلًا —', search: '' }, ...list.map((customer) => {
    const code = formatText(customer && customer.Code);
    const name = formatText(customer && customer.Name);
    return {
      value: String(customer && customer.Id),
      label: [code, name].filter(Boolean).join(' — ') || String(customer && customer.Id),
      search: [code, name, formatText(customer && customer.Phone)].join(' ').toLowerCase()
    };
  })];
}

function controlFor({ key, label, value, error = null, control }) {
  const hintId = error ? `payment-hint-${key}` : null;
  return `<div class="field">
  <label class="field__label" for="${escapeHtml(PAYMENT_FIELD_ID[key])}">${escapeHtml(label)}</label>
  ${control}
  ${error ? `<span class="field__hint" id="${escapeHtml(hintId)}" role="alert">${escapeHtml(error)}</span>` : ''}
</div>`;
}

export function renderPaymentForm({
  tab = PAYMENT_TAB.RECEIVED,
  customers = [],
  values = null,
  customerLoadError = null,
  fieldErrors = {},
  error = null,
  busy = false
} = {}) {
  const model = values || { CustomerId: '', Date: '', Amount: '', Description: '', CustomerSearch: '' };
  const transactionType = transactionTypeForTab(tab);
  const invalid = (key) => Boolean(fieldErrors[key]);
  const describedBy = (key) => (invalid(key) ? ` aria-describedby="payment-hint-${escapeHtml(key)}"` : '');
  const customerSelect = `<select class="select" id="${escapeHtml(PAYMENT_FIELD_ID.CustomerId)}"${invalid('CustomerId') ? ' aria-invalid="true"' : ''}${describedBy('CustomerId')}>${customerOptions(customers)
    .map((option) => `<option value="${escapeHtml(option.value)}"${String(option.value) === String(model.CustomerId ?? '') ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('')}</select>`;
  const searchInput = `<input class="input" id="${escapeHtml(PAYMENT_FIELD_ID.CustomerSearch)}" type="search" placeholder="ابحث بالكود أو الاسم أو الهاتف" aria-label="بحث في العملاء" value="${escapeHtml(model.CustomerSearch ?? '')}">`;
  const dateInput = `<input class="input" id="${escapeHtml(PAYMENT_FIELD_ID.Date)}" type="date" value="${escapeHtml(model.Date ?? '')}"${invalid('Date') ? ' aria-invalid="true"' : ''}${describedBy('Date')}>`;
  const amountInput = `<input class="input" id="${escapeHtml(PAYMENT_FIELD_ID.Amount)}" type="number" inputmode="decimal" step="any" min="0" value="${escapeHtml(model.Amount ?? '')}"${invalid('Amount') ? ' aria-invalid="true"' : ''}${describedBy('Amount')}>`;
  const descriptionInput = `<input class="input" id="${escapeHtml(PAYMENT_FIELD_ID.Description)}" type="text" value="${escapeHtml(model.Description ?? '')}">`;

  const submitLabel = tab === PAYMENT_TAB.RECEIVED ? 'حفظ الاستلام' : 'حفظ الدفعة';
  const body = `<form id="${escapeHtml(PAYMENTS_FORM_ID)}" class="stack" novalidate data-transaction-type="${escapeHtml(transactionType)}">
<div class="grid grid--cols-2">
${controlFor({ key: 'CustomerId', label: PAYMENT_FIELD_LABEL.CustomerId, error: fieldErrors.CustomerId, control: `<div class="stack">${searchInput}${customerSelect}</div>` })}
${controlFor({ key: 'Date', label: PAYMENT_FIELD_LABEL.Date, error: fieldErrors.Date, control: dateInput })}
${controlFor({ key: 'Amount', label: PAYMENT_FIELD_LABEL.Amount, error: fieldErrors.Amount, control: amountInput })}
${controlFor({ key: 'Description', label: PAYMENT_FIELD_LABEL.Description, error: fieldErrors.Description, control: descriptionInput })}
</div>
${customerLoadError ? alert({ tone: 'warning', title: 'تعذّر تحميل العملاء', message: 'لم تُحمّل قائمة العملاء من المخزن المحلي، ولم تُعرض أي بيانات بديلة.' }) : ''}
<div id="${escapeHtml(PAYMENTS_FORM_ERROR_ID)}" class="page-section">${error ? alert({ tone: 'danger', title: 'تعذّر حفظ الحركة', message: error }) : ''}</div>
<div class="row">
  <button class="btn btn--primary" type="submit" id="${escapeHtml(PAYMENTS_SUBMIT_ID)}"${busy ? ' disabled aria-disabled="true"' : ''}>${busy ? '<span class="spinner" aria-hidden="true"></span><span>جارٍ الحفظ…</span>' : `<span>${escapeHtml(submitLabel)}</span>`}</button>
</div>
</form>`;

  return card({
    title: tab === PAYMENT_TAB.RECEIVED ? 'تسجيل استلام نقدية' : 'تسجيل دفعة نقدية',
    body,
    footer: `<span class="badge">${escapeHtml(typeLabel(transactionType))}</span>`
  });
}

export function renderPaymentSuccess({ result = null, tab = PAYMENT_TAB.RECEIVED } = {}) {
  const record = (result && result.Record) || null;
  const amountMinor = record && Number.isInteger(record.AmountMinor) ? record.AmountMinor : null;
  const customer = (result && result.Customer) || null;
  const balanceMinor = result && Number.isInteger(result.NewBalanceMinor) ? result.NewBalanceMinor : null;
  const lines = [
    tab === PAYMENT_TAB.RECEIVED ? RECEIVED_SUCCESS_LABEL : PAID_SUCCESS_LABEL,
    amountMinor !== null ? `المبلغ: ${formatMoneyMinor(amountMinor)}` : '',
    customer && customer.Code ? `العميل: ${formatText(customer.Code)}${customer.Name ? ` — ${formatText(customer.Name)}` : ''}` : '',
    balanceMinor !== null ? `الرصيد الحالي للعميل: ${formatMoneyMinor(balanceMinor)}` : ''
  ].filter(Boolean);
  return alert({ tone: 'success', title: 'تم الحفظ', message: lines.join(' — ') });
}

export function paymentsScreenHtml({
  tab = PAYMENT_TAB.RECEIVED,
  rows = null,
  criteria = defaultPaymentCriteria(),
  error = null,
  customers = null,
  values = null,
  customerLoadError = null,
  fieldErrors = {},
  formError = null,
  busy = false,
  success = null
} = {}) {
  const hasData = Array.isArray(rows) && !error;
  const loading = !hasData && !error;
  const visible = hasData ? visibleMovements(rows, criteria) : [];
  const summary = hasData ? renderPaymentsSummary(paymentService.summarize(visible)) : '';
  const toolbar = hasData ? renderPaymentsToolbar({ criteria }) : '';
  const region = renderPaymentsRegion({ rows: rows || [], visible, criteria, error, loading });
  return [
    pageHeader({
      title: 'المدفوعات',
      description: 'تسجيل ومتابعة الحركات النقدية الفعلية مع العملاء',
      actions: `<a class="btn btn--outline" href="${escapeHtml(buildHash(customerListPath()))}">العملاء</a><button class="btn btn--primary" type="button" data-action="open-form">+ تسجيل حركة نقدية</button>`
    }),
    `<div id="${escapeHtml(PAYMENTS_TABS_REGION_ID)}" class="page-section">${renderPaymentTabs({ tab })}</div>`,
    `<div id="${escapeHtml(PAYMENTS_SUCCESS_ID)}" class="page-section">${success ? renderPaymentSuccess(success) : ''}</div>`,
    `<div id="${escapeHtml(PAYMENTS_SUMMARY_ID)}" class="page-section">${summary}</div>`,
    `<div id="${escapeHtml(PAYMENTS_TOOLBAR_ID)}" class="page-section">${toolbar}</div>`,
    `<div id="${escapeHtml(PAYMENTS_FORM_REGION_ID)}" class="page-section">${renderPaymentForm({ tab, customers: customers || [], values, customerLoadError, fieldErrors, error: formError, busy })}</div>`,
    `<div id="${escapeHtml(PAYMENTS_REGION_ID)}" class="page-section" aria-busy="${loading ? 'true' : 'false'}">${region}</div>`
  ].join('\n');
}

export function paymentsViewHtml() {
  return paymentsScreenHtml();
}

// ---------------------------------------------------------------------------
// Screen controller. Reads and writes through the services layer only.
// ---------------------------------------------------------------------------
export function initPaymentsView({ container, customerId = null, navigate = null, autoLoad = true } = {}) {
  if (!container) return null;
  const state = {
    rows: [],
    criteria: defaultPaymentCriteria(),
    tab: PAYMENT_TAB.RECEIVED,
    customers: [],
    customerLoadError: null,
    values: { CustomerId: customerId ? String(customerId) : '', CustomerSearch: '', Date: '', Amount: '', Description: '' },
    fieldErrors: {},
    error: null,
    formError: null,
    busy: false,
    success: null
  };

  const find = (selector) => (typeof container.querySelector === 'function' ? container.querySelector(selector) : null);
  const summaryBox = find(`#${PAYMENTS_SUMMARY_ID}`);
  const toolbarBox = find(`#${PAYMENTS_TOOLBAR_ID}`);
  const successBox = find(`#${PAYMENTS_SUCCESS_ID}`);
  const tabsBox = find(`#${PAYMENTS_TABS_REGION_ID}`);
  const formBox = find(`#${PAYMENTS_FORM_REGION_ID}`);
  const region = find(`#${PAYMENTS_REGION_ID}`);
  const live = () => Boolean(region) && (!('isConnected' in region) || region.isConnected);

  function paintForm() {
    if (formBox) {
      formBox.innerHTML = renderPaymentForm({
        tab: state.tab,
        customers: state.customers,
        values: state.values,
        customerLoadError: state.customerLoadError,
        fieldErrors: state.fieldErrors,
        error: state.formError,
        busy: state.busy
      });
    }
    setBusy(state.busy);
  }

  function paintSummary() {
    if (summaryBox) summaryBox.innerHTML = renderPaymentsSummary(paymentService.summarize(visibleMovements(state.rows, state.criteria)));
  }

  function paintToolbar() {
    if (toolbarBox) toolbarBox.innerHTML = renderPaymentsToolbar({ criteria: state.criteria });
  }

  function paintTabs() {
    if (tabsBox) tabsBox.innerHTML = renderPaymentTabs({ tab: state.tab });
  }

  function paintRegion() {
    if (!live()) return;
    region.innerHTML = renderPaymentsRegion({
      rows: state.rows,
      visible: visibleMovements(state.rows, state.criteria),
      criteria: state.criteria,
      error: state.error
    });
    region.setAttribute('aria-busy', 'false');
  }

  function paintSuccess() {
    if (successBox) successBox.innerHTML = state.success ? renderPaymentSuccess(state.success) : '';
  }

  async function load() {
    state.error = null;
    if (region) {
      region.setAttribute('aria-busy', 'true');
      region.innerHTML = loadingState({ message: 'جارٍ تحميل الحركات النقدية…' });
    }
    if (summaryBox) summaryBox.innerHTML = '';
    if (toolbarBox) toolbarBox.innerHTML = '';
    try {
      const [rows, customers] = await Promise.all([
        paymentService.listCashMovements(),
        paymentService.listSelectableCustomers()
      ]);
      if (!live()) return state;
      state.rows = Array.isArray(rows) ? rows : [];
      state.customers = Array.isArray(customers) ? customers : [];
      state.customerLoadError = null;
    } catch (error) {
      if (!live()) return state;
      logger.error('payments screen load failed', {
        code: error && error.code ? String(error.code) : null,
        message: error && error.message ? String(error.message) : null
      });
      state.error = error;
      state.rows = [];
    }
    paintSummary();
    paintToolbar();
    paintRegion();
    paintForm();
    return state;
  }

  // Field errors are read from the error the Core raised: the UI never decides on
  // its own that a value is invalid, so no second validation authority exists.
  function fieldErrorsFrom(error) {
    const out = {};
    if (!error) return out;
    const details = error.details && Array.isArray(error.details.errors) ? error.details.errors : [];
    for (const item of details) if (item && item.field) out[item.field] = item.message;
    if (!Object.keys(out).length && error.field) out[error.field] = error.message;
    return out;
  }

  function readFormValues() {
    const form = find(`#${PAYMENTS_FORM_ID}`);
    if (!form || typeof form.querySelector !== 'function') return { ...state.values };
    const read = (selector, fallback) => {
      const control = form.querySelector(selector);
      return control ? control.value : fallback;
    };
    return {
      CustomerId: read(`#${PAYMENT_FIELD_ID.CustomerId}`, state.values.CustomerId),
      Date: read(`#${PAYMENT_FIELD_ID.Date}`, state.values.Date),
      Amount: read(`#${PAYMENT_FIELD_ID.Amount}`, state.values.Amount),
      Description: read(`#${PAYMENT_FIELD_ID.Description}`, state.values.Description),
      CustomerSearch: read(`#${PAYMENT_FIELD_ID.CustomerSearch}`, state.values.CustomerSearch ?? '')
    };
  }

  function setBusy(isBusy) {
    state.busy = isBusy;
    const form = find(`#${PAYMENTS_FORM_ID}`);
    const submit = form && typeof form.querySelector === 'function' ? form.querySelector(`#${PAYMENTS_SUBMIT_ID}`) : null;
    if (!submit) return;
    submit.disabled = isBusy;
    submit.setAttribute('aria-disabled', isBusy ? 'true' : 'false');
    submit.innerHTML = isBusy
      ? '<span class="spinner" aria-hidden="true"></span><span>جارٍ الحفظ…</span>'
      : `<span>${state.tab === PAYMENT_TAB.RECEIVED ? 'حفظ الاستلام' : 'حفظ الدفعة'}</span>`;
  }

  // A tab switch is a pure UI act: the form is rebuilt for the new transaction type,
  // the previous validation and success state are dropped, and nothing is submitted
  // or validated. Customer, Date and Description are carried over on purpose.
  function switchTab(tab) {
    if (!tab || tab === state.tab) return false;
    state.tab = tab;
    state.fieldErrors = {};
    state.formError = null;
    state.success = null;
    paintTabs();
    paintForm();
    paintSuccess();
    return true;
  }

  async function submit() {
    if (state.busy) return null; // a repeated press while saving can never create a second row
    state.values = readFormValues();
    state.fieldErrors = {};
    state.formError = null;
    state.success = null;
    setBusy(true);
    try {
      const result = await paymentService.createCashMovement({
        TransactionType: transactionTypeForTab(state.tab),
        CustomerId: state.values.CustomerId,
        Date: state.values.Date,
        Amount: state.values.Amount,
        Description: state.values.Description
      });
      state.success = { result, tab: state.tab };
      // Amount and Description are cleared for the next entry; the customer and the
      // date are deliberately kept so several movements can follow without a reload.
      state.values = { ...state.values, Amount: '', Description: '' };
      paintSuccess();
      await load();
      paintSuccess();
      return result;
    } catch (error) {
      logger.error('payment save failed', {
        code: error && error.code ? String(error.code) : null,
        message: error && error.message ? String(error.message) : null
      });
      state.formError = error && error.message ? String(error.message) : 'تعذّر حفظ الحركة النقدية.';
      state.fieldErrors = fieldErrorsFrom(error);
      paintForm(); // every entered value is preserved: nothing is cleared on failure
      return null;
    } finally {
      setBusy(false); // the loading state always ends, on success and on failure alike
    }
  }

  container.addEventListener('submit', (event) => {
    const target = event && event.target;
    if (!target || typeof target.getAttribute !== 'function' || target.getAttribute('id') !== PAYMENTS_FORM_ID) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    void submit();
  });

  container.addEventListener('click', (event) => {
    const target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    const tabButton = target.closest('[data-tab]');
    if (tabButton) { switchTab(tabButton.getAttribute('data-tab')); return; }
    if (target.closest('[data-action="open-form"]')) {
      const search = find(`#${PAYMENT_FIELD_ID.CustomerSearch}`);
      if (search && typeof search.focus === 'function') search.focus();
      return;
    }
    if (target.closest('[data-action="retry"]')) { void load(); return; }
    if (target.closest('[data-action="reset-filters"]')) {
      state.criteria = defaultPaymentCriteria();
      paintToolbar();
      paintSummary();
      paintRegion();
      return;
    }
    const openAccount = target.closest('[data-action="open-account"]');
    if (openAccount && navigate) navigate(customerAccountPath(openAccount.getAttribute('data-id')));
  });

  container.addEventListener('input', (event) => {
    const target = event && event.target;
    const id = target && typeof target.getAttribute === 'function' ? target.getAttribute('id') : null;
    if (!id) return;
    if (id === PAYMENT_FIELD_ID.CustomerSearch) {
      const form = find(`#${PAYMENTS_FORM_ID}`);
      const selectNode = form && typeof form.querySelector === 'function' ? form.querySelector(`#${PAYMENT_FIELD_ID.CustomerId}`) : null;
      if (!selectNode) return;
      const term = String(target.value || '').trim().toLowerCase();
      const selected = selectNode.value;
      const options = customerOptions(state.customers).filter((option) => option.value === '' || !term || option.search.includes(term));
      selectNode.innerHTML = options
        .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
        .join('');
      return;
    }
    if (target.getAttribute('data-criteria') === 'search') {
      state.criteria.search = target.value;
      paintSummary();
      paintRegion();
    }
  });

  container.addEventListener('change', (event) => {
    const target = event && event.target;
    if (!target || typeof target.getAttribute !== 'function') return;
    const id = target.getAttribute('id');
    if (id === PAYMENT_FIELD_ID.CustomerId) { state.values.CustomerId = target.value; return; }
    if (id === PAYMENT_FIELD_ID.Date) { state.values.Date = target.value; return; }
    if (id === PAYMENT_FIELD_ID.Amount) { state.values.Amount = target.value; return; }
    if (id === PAYMENT_FIELD_ID.Description) { state.values.Description = target.value; return; }
    const key = target.getAttribute('data-criteria');
    if (!key || key === 'search') return;
    state.criteria[key] = target.value;
    paintSummary();
    paintRegion();
  });

  // The screen loads itself as soon as it is mounted, exactly like the other
  // implemented screens, so a real visit never sits on the loading state.
  if (autoLoad) void load();

  return {
    state,
    load,
    submit,
    switchTab,
    reload: load,
    setCriteria(next = {}) {
      state.criteria = { ...state.criteria, ...next };
      paintToolbar();
      paintSummary();
      paintRegion();
      return state.criteria;
    },
    currentTab: () => state.tab
  };
}
