// Settlements screen (Phase 4B.5 / 4B.5.1) — the functional non-cash screen for the two
// approved directional non-cash types: Settlement and GoodsExchange.
//
// This module collects input and lays out what the services returned. It contains NO
// financial engine: the derived Debit / Credit columns, the zero cash columns, the
// non-cash value and the running balance of every row come from the core projection
// through the services layer. The direction is the user's explicit statement (Credit =
// added to the farmer balance, Debit = deducted from it); the preview figures come from
// the service, never from arithmetic written here.
import { pageHeader, card, badge, table, kpi, alert } from '../components/index.js';
import { loadingState, emptyState, errorState } from '../components/states.js';
import { escapeHtml } from '../components/html.js';
import { amountClass, badgeClass } from '../components/financial.js';
import { formatMoneyMinor, formatText, formatCount } from '../../src/utils/formatting.js';
import { logger } from '../../src/utils/logger.js';
import { settlementService } from '../../src/services/settlementService.js';
import { TRANSACTION_TYPE_LABELS_AR } from '../../src/services/balanceService.js';
import { customerAccountPath, customerListPath } from '../routes.js';
import { buildHash } from '../router.js';

export const SETTLEMENTS_SUMMARY_ID = 'settlements-summary';
export const SETTLEMENTS_TOOLBAR_ID = 'settlements-toolbar';
export const SETTLEMENTS_REGION_ID = 'settlements-region';
export const SETTLEMENTS_TABS_REGION_ID = 'settlements-tabs-region';
export const SETTLEMENTS_FORM_REGION_ID = 'settlements-form-region';
export const SETTLEMENTS_PREVIEW_ID = 'settlement-preview';
export const SETTLEMENTS_CONFIRM_ID = 'settlement-confirm';
export const SETTLEMENTS_SUCCESS_ID = 'settlement-success';
export const SETTLEMENTS_FORM_ID = 'settlement-form';
export const SETTLEMENTS_FORM_ERROR_ID = 'settlement-form-error';
export const SETTLEMENTS_SUBMIT_ID = 'settlement-submit';
export const SETTLEMENTS_CONFIRM_SUBMIT_ID = 'settlement-confirm-submit';

// The screen's two tabs map 1:1 onto the two approved non-cash types.
export const SETTLEMENT_TAB = Object.freeze({ SETTLEMENT: 'settlement', GOODS_EXCHANGE: 'goods-exchange' });

export const SETTLEMENT_TABS = Object.freeze([
  Object.freeze({ id: SETTLEMENT_TAB.SETTLEMENT, label: 'تسوية', transactionType: 'Settlement' }),
  Object.freeze({ id: SETTLEMENT_TAB.GOODS_EXCHANGE, label: 'تبادل بضائع', transactionType: 'GoodsExchange' })
]);

export const SETTLEMENT_TYPE_FILTER = Object.freeze({ ALL: 'all' });
export const SETTLEMENT_STATUS_FILTER = Object.freeze({ ALL: 'all', ACTIVE: 'active', CANCELLED: 'cancelled' });

// The two accepted directions of a non-cash movement, written in plain language.
export const SETTLEMENT_DIRECTION = Object.freeze({ CREDIT: 'Credit', DEBIT: 'Debit' });

export const DIRECTION_OPTIONS = Object.freeze([
  Object.freeze({ value: SETTLEMENT_DIRECTION.CREDIT, label: 'إضافة إلى رصيد المزارع — دائن' }),
  Object.freeze({ value: SETTLEMENT_DIRECTION.DEBIT, label: 'خصم من رصيد المزارع — مدين' })
]);

export const DIRECTION_LABEL_AR = Object.freeze({
  Credit: 'إضافة إلى رصيد المزارع — دائن',
  Debit: 'خصم من رصيد المزارع — مدين'
});

export const DIRECTION_BADGE_LABEL = Object.freeze({ Credit: 'دائن', Debit: 'مدين' });

export const EMPTY_VALUE = '—';
export const CANCELLED_LABEL = 'ملغاة';
export const ACTIVE_LABEL = 'نشطة';
export const EMPTY_STATE_MESSAGE = 'لا توجد تسويات حتى الآن';
export const NO_RESULTS_MESSAGE = 'لا توجد نتائج مطابقة للفلاتر الحالية';
export const SETTLEMENT_SUCCESS_LABEL = 'تم تسجيل التسوية بنجاح';
export const GOODS_EXCHANGE_SUCCESS_LABEL = 'تم تسجيل تبادل البضائع بنجاح';

export const PREVIEW_EMPTY_MESSAGE = 'أدخل العميل والمبلغ لعرض معاينة الأثر على الرصيد. الحساب النهائي يتم في النظام عند الحفظ.';
export const CONFIRM_MESSAGE = 'الرصيد الحالي لا يكفي لتغطية هذا الخصم؛ سيصبح رصيد المزارع سالبًا (مديونية). هل تريد المتابعة؟';
export const DEBT_WARNING_MESSAGE = 'سيؤدي هذا الخصم إلى مديونية على المزارع (رصيد سالب) أو زيادتها.';

export const SETTLEMENT_COLUMNS = Object.freeze([
  { label: 'التاريخ' },
  { label: 'العميل' },
  { label: 'النوع' },
  { label: 'الاتجاه' },
  { label: 'البيان' },
  { label: 'المبلغ' },
  { label: 'مدين' },
  { label: 'دائن' },
  { label: 'قيمة غير نقدية' },
  { label: 'الرصيد بعد الحركة' },
  { label: 'الحالة' },
  { label: 'إجراء' }
]);

export function tabFor(transactionType) {
  return transactionType === SETTLEMENT_TABS[1].transactionType ? SETTLEMENT_TAB.GOODS_EXCHANGE : SETTLEMENT_TAB.SETTLEMENT;
}

export function transactionTypeForTab(tab) {
  const found = SETTLEMENT_TABS.find((entry) => entry.id === tab);
  return (found || SETTLEMENT_TABS[0]).transactionType;
}

export function directionOption(value) {
  const found = DIRECTION_OPTIONS.find((entry) => entry.value === value);
  return found || DIRECTION_OPTIONS[0];
}

export function directionLabel(value) {
  return DIRECTION_LABEL_AR[value] || DIRECTION_LABEL_AR.Credit;
}

export function defaultSettlementCriteria() {
  return {
    search: '',
    type: SETTLEMENT_TYPE_FILTER.ALL,
    from: '',
    to: '',
    status: SETTLEMENT_STATUS_FILTER.ALL
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

// Search covers exactly Code, Name, Phone and Description — a view-level narrowing
// that changes no data and recalculates no value.
export function matchesSettlementSearch(row, term) {
  const needle = normalizeText(term);
  if (!needle) return true;
  const record = row || {};
  const customer = movementCustomer(row);
  return [customer.Code, customer.Name, customer.Phone, record.Description]
    .some((value) => normalizeText(value).includes(needle));
}

export function matchesSettlementType(row, type) {
  if (!type || type === SETTLEMENT_TYPE_FILTER.ALL) return true;
  return (row || {}).TransactionType === type;
}

export function matchesSettlementStatus(row, status) {
  if (!status || status === SETTLEMENT_STATUS_FILTER.ALL) return true;
  const isCancelled = (row || {}).IsCancelled === true;
  return status === SETTLEMENT_STATUS_FILTER.CANCELLED ? isCancelled : !isCancelled;
}

// Dates are stored as ISO YYYY-MM-DD, so the range comparison is exact and needs no
// conversion. The narrowing never recalculates and never reorders: each row keeps
// the running balance the service produced over the full financial sequence.
export function matchesSettlementRange(row, { from = '', to = '' } = {}) {
  const date = formatText((row || {}).Date);
  if (from && date && date < from) return false;
  if (to && date && date > to) return false;
  return true;
}

export function visibleSettlements(rows, criteria = defaultSettlementCriteria()) {
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((row) => (
    matchesSettlementSearch(row, criteria.search)
    && matchesSettlementType(row, criteria.type)
    && matchesSettlementStatus(row, criteria.status)
    && matchesSettlementRange(row, criteria)
  ));
}

// Phase 4B.7A.1 — the selected tab scopes the TABLE to its own stored type. The scope is
// applied on top of the criteria filters (search / type / status / date range), which stay
// in force, and it is deliberately kept OUT of `visibleSettlements` so the approved totals
// and the displayed count keep being computed from the criteria set: switching a tab can
// never change a total, a direction or a stored movement. The scope reads the STORED
// TransactionType carried by the movement itself — never a label, never the Direction.
export function tabScopedSettlements(rows, criteria = defaultSettlementCriteria(), tab = SETTLEMENT_TAB.SETTLEMENT) {
  return visibleSettlements(rows, criteria).filter((row) => matchesSettlementType(row, transactionTypeForTab(tab)));
}

export function collectRegions(rows) {
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const region = formatText((row || {}).Region);
    if (region) seen.add(region);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

// The operation value carries no direction claim of its own, so it uses the neutral
// amount class; the debit and credit columns carry the core values verbatim.
function plainAmountCell(minor, { cancelled = false } = {}) {
  if (!Number.isInteger(minor) || minor === 0) return `<span class="amount">${EMPTY_VALUE}</span>`;
  const className = cancelled ? amountClass('cancelled') : 'amount';
  return `<span class="${escapeHtml(className)}">${escapeHtml(formatMoneyMinor(minor))}</span>`;
}

function sideCell(minor, kind, { cancelled = false } = {}) {
  if (!Number.isInteger(minor) || minor === 0) return `<span class="amount">${EMPTY_VALUE}</span>`;
  const className = cancelled ? amountClass('cancelled') : amountClass(kind);
  return `<span class="${escapeHtml(className)}">${escapeHtml(formatMoneyMinor(minor))}</span>`;
}

// The non-cash bucket: this column is explicitly NOT cash and never claims to be.
function nonCashCell(minor, { cancelled = false } = {}) {
  if (!Number.isInteger(minor) || minor === 0) return `<span class="amount">${EMPTY_VALUE}</span>`;
  const className = cancelled ? amountClass('cancelled') : amountClass('nonCash');
  return `<span class="${escapeHtml(className)}">${escapeHtml(formatMoneyMinor(minor))}</span>`;
}

function directionCell(row) {
  const record = row || {};
  const direction = record.Direction === SETTLEMENT_DIRECTION.DEBIT ? SETTLEMENT_DIRECTION.DEBIT : SETTLEMENT_DIRECTION.CREDIT;
  const kind = direction === SETTLEMENT_DIRECTION.DEBIT ? 'debit' : 'credit';
  return `<span class="${escapeHtml(badgeClass(kind))}" title="${escapeHtml(directionLabel(direction))}">${escapeHtml(DIRECTION_BADGE_LABEL[direction])}</span>`;
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
      directionCell(record),
      escapeHtml(formatText(record.Description) || EMPTY_VALUE),
      plainAmountCell(record.AmountMinor, { cancelled }),
      sideCell(record.DebitMinor, 'debit', { cancelled }),
      sideCell(record.CreditMinor, 'credit', { cancelled }),
      nonCashCell(record.SettlementMinor, { cancelled }),
      runningBalanceCell(record.RunningBalanceMinor),
      statusCell(record),
      action
    ]
  };
}

export function renderSettlementTabs({ tab = SETTLEMENT_TAB.SETTLEMENT } = {}) {
  const buttons = SETTLEMENT_TABS.map((entry) => {
    const isActive = entry.id === tab;
    return `<button class="btn ${isActive ? 'btn--primary' : 'btn--outline'}" type="button" role="tab" id="settlement-tab-${escapeHtml(entry.id)}" data-tab="${escapeHtml(entry.id)}" aria-selected="${isActive ? 'true' : 'false'}" aria-controls="${escapeHtml(SETTLEMENTS_REGION_ID)}">${escapeHtml(entry.label)}</button>`;
  }).join('');
  return `<div class="row" role="tablist" aria-label="نوع التسوية غير النقدية">${buttons}</div>`;
}

// Non-cash summary. Every label avoids the word مقبوضات and every cash term on
// purpose: these movements are not cash and must never be presented as collections.
// Credit and Debit totals are kept apart, and the net figures are named as net so a
// movement total can never be mistaken for a net effect.
export function renderSettlementsSummary(totals) {
  const data = totals || settlementService.summarize([]);
  const blocks = [
    card({ body: kpi({ label: 'إجمالي التسويات الدائنة', value: formatMoneyMinor(data.SettlementCreditMinor), hint: 'إجمالي حركة التسويات الدائنة' }) }),
    card({ body: kpi({ label: 'إجمالي التسويات المدينة', value: formatMoneyMinor(data.SettlementDebitMinor), hint: 'إجمالي حركة التسويات المدينة' }) }),
    card({ body: kpi({ label: 'صافي التسويات', value: formatMoneyMinor(data.NetSettlementMinor), hint: 'الدائن − المدين' }) }),
    card({ body: kpi({ label: 'إجمالي تبادل البضائع الدائن', value: formatMoneyMinor(data.GoodsExchangeCreditMinor), hint: 'إجمالي حركة تبادل البضائع الدائنة' }) }),
    card({ body: kpi({ label: 'إجمالي تبادل البضائع المدين', value: formatMoneyMinor(data.GoodsExchangeDebitMinor), hint: 'إجمالي حركة تبادل البضائع المدينة' }) }),
    card({ body: kpi({ label: 'صافي تبادل البضائع', value: formatMoneyMinor(data.NetGoodsExchangeMinor), hint: 'الدائن − المدين' }) }),
    card({ body: kpi({ label: 'إجمالي التسويات غير النقدية', value: formatMoneyMinor(data.TotalNonCashMinor), hint: 'إجمالي حركة النوعين معًا' }) }),
    card({ body: kpi({ label: 'صافي الأثر غير النقدي', value: formatMoneyMinor(data.NetNonCashMinor), hint: 'صافي أثر النوعين على الرصيد' }) })
  ];
  return `<div class="grid grid--cols-3">${blocks.join('\n')}</div>
<p class="toolbar__count" aria-live="polite">الحركات المعروضة: ${formatCount(data.Count)}${data.CancelledCount ? ` — ملغاة غير محتسبة: ${formatCount(data.CancelledCount)}` : ''}</p>`;
}

export function renderSettlementsToolbar({ criteria = defaultSettlementCriteria() } = {}) {
  const typeOptions = [
    { value: SETTLEMENT_TYPE_FILTER.ALL, label: 'الكل' },
    { value: SETTLEMENT_TABS[0].transactionType, label: SETTLEMENT_TABS[0].label },
    { value: SETTLEMENT_TABS[1].transactionType, label: SETTLEMENT_TABS[1].label }
  ];
  const statusOptions = [
    { value: SETTLEMENT_STATUS_FILTER.ALL, label: 'الكل' },
    { value: SETTLEMENT_STATUS_FILTER.ACTIVE, label: 'نشطة' },
    { value: SETTLEMENT_STATUS_FILTER.CANCELLED, label: 'ملغاة' }
  ];
  const selectControl = (id, key, label, options) => `<div class="field">
  <label class="field__label" for="${escapeHtml(id)}">${escapeHtml(label)}</label>
  <select class="select" id="${escapeHtml(id)}" data-criteria="${escapeHtml(key)}">${options
    .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === criteria[key] ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('')}</select>
</div>`;
  return `<div class="toolbar">
<div class="field">
  <label class="field__label" for="settlement-search">بحث</label>
  <input class="input" id="settlement-search" type="search" data-criteria="search" value="${escapeHtml(criteria.search)}" placeholder="كود أو اسم أو هاتف أو بيان" aria-label="بحث في التسويات بالكود أو الاسم أو الهاتف أو البيان">
</div>
${selectControl('settlement-filter-type', 'type', 'النوع', typeOptions)}
${selectControl('settlement-filter-status', 'status', 'الحالة', statusOptions)}
<div class="field">
  <label class="field__label" for="settlement-filter-from">من تاريخ</label>
  <input class="input" id="settlement-filter-from" type="date" data-criteria="from" value="${escapeHtml(criteria.from)}">
</div>
<div class="field">
  <label class="field__label" for="settlement-filter-to">إلى تاريخ</label>
  <input class="input" id="settlement-filter-to" type="date" data-criteria="to" value="${escapeHtml(criteria.to)}">
</div>
<div class="field">
  <span class="field__label">إعادة الضبط</span>
  <button class="btn btn--outline" type="button" data-action="reset-filters">إعادة ضبط الفلاتر</button>
</div>
</div>`;
}

export function renderSettlementsRegion({ rows = null, visible = null, criteria = defaultSettlementCriteria(), error = null, loading = false } = {}) {
  if (loading) return loadingState({ message: 'جارٍ تحميل التسويات…' });
  if (error) {
    return `<div class="stack">
${errorState({ title: 'تعذّر تحميل التسويات', message: 'لم يتم تحميل التسويات من المخزن المحلي، ولم تُعرض أي بيانات بديلة.', code: error.code ? String(error.code) : null })}
<div class="row"><button class="btn btn--primary" type="button" data-action="retry">إعادة المحاولة</button></div>
</div>`;
  }
  const all = Array.isArray(rows) ? rows : [];
  if (!all.length) {
    return card({
      title: EMPTY_STATE_MESSAGE,
      body: `${emptyState({ title: EMPTY_STATE_MESSAGE, message: 'سجّل أول تسوية غير نقدية للبدء.', icon: '🤝' })}
<div class="row"><button class="btn btn--primary" type="button" data-action="open-form">+ تسجيل تسوية</button></div>`
    });
  }
  const list = Array.isArray(visible) ? visible : visibleSettlements(all, criteria);
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
    columns: SETTLEMENT_COLUMNS,
    rows: list.map(movementRow),
    emptyMessage: NO_RESULTS_MESSAGE
  })}`;
}

// ---------------------------------------------------------------------------
// The movement form: Customer + Date + Direction + Amount + Description only.
// ---------------------------------------------------------------------------
export const SETTLEMENT_FIELD_ID = Object.freeze({
  CustomerId: 'settlement-customer',
  CustomerSearch: 'settlement-customer-search',
  Date: 'settlement-date',
  Direction: 'settlement-direction',
  Amount: 'settlement-amount',
  Description: 'settlement-description'
});

export const SETTLEMENT_FIELD_LABEL = Object.freeze({
  CustomerId: 'العميل',
  Date: 'التاريخ',
  Direction: 'اتجاه الحركة',
  Amount: 'المبلغ',
  Description: 'البيان (اختياري)'
});

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

function controlFor({ key, label, error = null, control }) {
  const hintId = error ? `settlement-hint-${key}` : null;
  return `<div class="field">
  <label class="field__label" for="${escapeHtml(SETTLEMENT_FIELD_ID[key])}">${escapeHtml(label)}</label>
  ${control}
  ${error ? `<span class="field__hint" id="${escapeHtml(hintId)}" role="alert">${escapeHtml(error)}</span>` : ''}
</div>`;
}

function previewItem(label, value) {
  return `<span class="preview-item"><span class="preview-item__label">${escapeHtml(label)}</span><span class="preview-item__value">${escapeHtml(value)}</span></span>`;
}

// Preview panel: every figure is the value the service returned (the core engine plus
// the approved balance formula one movement ahead). Nothing is computed here.
export function renderSettlementPreview({ preview = null, awaitingConfirm = false } = {}) {
  if (!preview) {
    return card({ title: 'معاينة الأثر على الرصيد', body: `<p class="text-sm text-muted">${escapeHtml(PREVIEW_EMPTY_MESSAGE)}</p>` });
  }
  const items = [
    previewItem('العميل', [formatText(preview.Code), formatText(preview.Name)].filter(Boolean).join(' — ') || EMPTY_VALUE),
    previewItem('نوع العملية', typeLabel(preview.TransactionType)),
    previewItem('الاتجاه', directionLabel(preview.Direction)),
    previewItem('المبلغ', formatMoneyMinor(preview.AmountMinor)),
    previewItem('الرصيد الحالي', formatMoneyMinor(preview.CurrentBalanceMinor)),
    previewItem('الرصيد المتوقع بعد الحركة', formatMoneyMinor(preview.ProjectedBalanceMinor))
  ];
  const warning = preview.Insufficient
    ? alert({ tone: 'warning', title: 'تحذير: الرصيد الدائن غير كافٍ', message: CONFIRM_MESSAGE })
    : (preview.IncreasesDebt ? alert({ tone: 'info', title: 'تنبيه', message: DEBT_WARNING_MESSAGE }) : '');
  const confirmPanel = (preview.Insufficient && awaitingConfirm)
    ? `<div class="confirm-panel" id="${escapeHtml(SETTLEMENTS_CONFIRM_ID)}">
  <button class="btn btn--primary" type="button" id="${escapeHtml(SETTLEMENTS_CONFIRM_SUBMIT_ID)}" data-action="confirm-save">تأكيد الحفظ</button>
  <button class="btn btn--outline" type="button" data-action="cancel-confirm">إلغاء</button>
</div>`
    : `<div class="confirm-panel" id="${escapeHtml(SETTLEMENTS_CONFIRM_ID)}"></div>`;
  return card({
    title: 'معاينة الأثر على الرصيد',
    body: `<p class="text-sm text-muted">هذه معاينة للعرض فقط، ولا تُخزَّن ولا يمكن تعديلها. الرصيد المتوقع محسوب بالمعادلة المعتمدة عبر طبقة الخدمات.</p>
<div class="preview-grid">${items.join('')}</div>
${warning}${confirmPanel}`
  });
}

export function renderSettlementForm({
  tab = SETTLEMENT_TAB.SETTLEMENT,
  customers = [],
  values = null,
  customerLoadError = null,
  fieldErrors = {},
  error = null,
  busy = false,
  preview = null,
  awaitingConfirm = false
} = {}) {
  const model = values || { CustomerId: '', Date: '', Direction: SETTLEMENT_DIRECTION.CREDIT, Amount: '', Description: '', CustomerSearch: '' };
  const transactionType = transactionTypeForTab(tab);
  const invalid = (key) => Boolean(fieldErrors[key]);
  const describedBy = (key) => (invalid(key) ? ` aria-describedby="settlement-hint-${escapeHtml(key)}"` : '');
  const customerSelect = `<select class="select" id="${escapeHtml(SETTLEMENT_FIELD_ID.CustomerId)}"${invalid('CustomerId') ? ' aria-invalid="true"' : ''}${describedBy('CustomerId')}>${customerOptions(customers)
    .map((option) => `<option value="${escapeHtml(option.value)}"${String(option.value) === String(model.CustomerId ?? '') ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('')}</select>`;
  const searchInput = `<input class="input" id="${escapeHtml(SETTLEMENT_FIELD_ID.CustomerSearch)}" type="search" placeholder="ابحث بالكود أو الاسم أو الهاتف" aria-label="بحث في العملاء" value="${escapeHtml(model.CustomerSearch ?? '')}">`;
  const dateInput = `<input class="input" id="${escapeHtml(SETTLEMENT_FIELD_ID.Date)}" type="date" value="${escapeHtml(model.Date ?? '')}"${invalid('Date') ? ' aria-invalid="true"' : ''}${describedBy('Date')}>`;
  const selectedDirection = model.Direction === SETTLEMENT_DIRECTION.DEBIT ? SETTLEMENT_DIRECTION.DEBIT : SETTLEMENT_DIRECTION.CREDIT;
  const directionSelect = `<select class="select" id="${escapeHtml(SETTLEMENT_FIELD_ID.Direction)}" aria-label="اتجاه الحركة"${invalid('Direction') ? ' aria-invalid="true"' : ''}${describedBy('Direction')}>${DIRECTION_OPTIONS
    .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selectedDirection ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('')}</select>`;
  const amountInput = `<input class="input" id="${escapeHtml(SETTLEMENT_FIELD_ID.Amount)}" type="number" inputmode="decimal" step="any" min="0" value="${escapeHtml(model.Amount ?? '')}"${invalid('Amount') ? ' aria-invalid="true"' : ''}${describedBy('Amount')}>`;
  const descriptionInput = `<input class="input" id="${escapeHtml(SETTLEMENT_FIELD_ID.Description)}" type="text" value="${escapeHtml(model.Description ?? '')}">`;

  const submitLabel = tab === SETTLEMENT_TAB.SETTLEMENT ? 'حفظ التسوية' : 'حفظ تبادل البضائع';
  const body = `<form id="${escapeHtml(SETTLEMENTS_FORM_ID)}" class="stack" novalidate data-transaction-type="${escapeHtml(transactionType)}">
<div class="grid grid--cols-2">
${controlFor({ key: 'CustomerId', label: SETTLEMENT_FIELD_LABEL.CustomerId, error: fieldErrors.CustomerId, control: `<div class="stack">${searchInput}${customerSelect}</div>` })}
${controlFor({ key: 'Date', label: SETTLEMENT_FIELD_LABEL.Date, error: fieldErrors.Date, control: dateInput })}
${controlFor({ key: 'Direction', label: SETTLEMENT_FIELD_LABEL.Direction, error: fieldErrors.Direction, control: directionSelect })}
${controlFor({ key: 'Amount', label: SETTLEMENT_FIELD_LABEL.Amount, error: fieldErrors.Amount, control: amountInput })}
${controlFor({ key: 'Description', label: SETTLEMENT_FIELD_LABEL.Description, error: fieldErrors.Description, control: descriptionInput })}
</div>
${customerLoadError ? alert({ tone: 'warning', title: 'تعذّر تحميل العملاء', message: 'لم تُحمّل قائمة العملاء من المخزن المحلي، ولم تُعرض أي بيانات بديلة.' }) : ''}
<div id="${escapeHtml(SETTLEMENTS_FORM_ERROR_ID)}" class="page-section">${error ? alert({ tone: 'danger', title: 'تعذّر حفظ التسوية', message: error }) : ''}</div>
<div class="row">
  <button class="btn btn--primary" type="submit" id="${escapeHtml(SETTLEMENTS_SUBMIT_ID)}"${busy ? ' disabled aria-disabled="true"' : ''}>${busy ? '<span class="spinner" aria-hidden="true"></span><span>جارٍ الحفظ…</span>' : `<span>${escapeHtml(submitLabel)}</span>`}</button>
</div>
</form>`;

  return card({
    title: tab === SETTLEMENT_TAB.SETTLEMENT ? 'تسجيل تسوية غير نقدية' : 'تسجيل تبادل بضائع',
    body,
    footer: `<span class="badge badge--noncash">${escapeHtml(typeLabel(transactionType))}</span>`
  });
}

export function renderSettlementSuccess({ result = null, tab = SETTLEMENT_TAB.SETTLEMENT } = {}) {
  const record = (result && result.Record) || null;
  const amountMinor = record && Number.isInteger(record.AmountMinor) ? record.AmountMinor : null;
  const customer = (result && result.Customer) || null;
  const balanceMinor = result && Number.isInteger(result.NewBalanceMinor) ? result.NewBalanceMinor : null;
  const lines = [
    tab === SETTLEMENT_TAB.SETTLEMENT ? SETTLEMENT_SUCCESS_LABEL : GOODS_EXCHANGE_SUCCESS_LABEL,
    record && record.Direction ? `الاتجاه: ${directionLabel(record.Direction)}` : '',
    amountMinor !== null ? `المبلغ: ${formatMoneyMinor(amountMinor)}` : '',
    customer && customer.Code ? `العميل: ${formatText(customer.Code)}${customer.Name ? ` — ${formatText(customer.Name)}` : ''}` : '',
    balanceMinor !== null ? `الرصيد الحالي للعميل: ${formatMoneyMinor(balanceMinor)}` : ''
  ].filter(Boolean);
  return alert({ tone: 'success', title: 'تم الحفظ', message: lines.join(' — ') });
}

export function settlementsScreenHtml({
  tab = SETTLEMENT_TAB.SETTLEMENT,
  rows = null,
  criteria = defaultSettlementCriteria(),
  error = null,
  customers = null,
  values = null,
  customerLoadError = null,
  fieldErrors = {},
  formError = null,
  busy = false,
  success = null,
  preview = null,
  awaitingConfirm = false
} = {}) {
  const hasData = Array.isArray(rows) && !error;
  const loading = !hasData && !error;
  const visible = hasData ? visibleSettlements(rows, criteria) : [];
  const summary = hasData ? renderSettlementsSummary(settlementService.summarize(visible)) : '';
  const toolbar = hasData ? renderSettlementsToolbar({ criteria }) : '';
  const region = renderSettlementsRegion({ rows: rows || [], visible, criteria, error, loading });
  return [
    pageHeader({
      title: 'التسويات',
      description: 'تسجيل ومتابعة التسويات وتبادل البضائع غير النقدية مع العملاء',
      actions: `<a class="btn btn--outline" href="${escapeHtml(buildHash(customerListPath()))}">العملاء</a><button class="btn btn--primary" type="button" data-action="open-form">+ تسجيل تسوية</button>`
    }),
    `<div id="${escapeHtml(SETTLEMENTS_TABS_REGION_ID)}" class="page-section">${renderSettlementTabs({ tab })}</div>`,
    `<div id="${escapeHtml(SETTLEMENTS_SUCCESS_ID)}" class="page-section">${success ? renderSettlementSuccess(success) : ''}</div>`,
    `<div id="${escapeHtml(SETTLEMENTS_SUMMARY_ID)}" class="page-section">${summary}</div>`,
    `<div id="${escapeHtml(SETTLEMENTS_TOOLBAR_ID)}" class="page-section">${toolbar}</div>`,
    `<div id="${escapeHtml(SETTLEMENTS_FORM_REGION_ID)}" class="page-section">${renderSettlementForm({ tab, customers: customers || [], values, customerLoadError, fieldErrors, error: formError, busy })}</div>`,
    `<div id="${escapeHtml(SETTLEMENTS_PREVIEW_ID)}" class="page-section">${renderSettlementPreview({ preview, awaitingConfirm })}</div>`,
    `<div id="${escapeHtml(SETTLEMENTS_REGION_ID)}" class="page-section" aria-busy="${loading ? 'true' : 'false'}">${region}</div>`
  ].join('\n');
}

export function settlementsViewHtml() {
  return settlementsScreenHtml();
}

// ---------------------------------------------------------------------------
// Screen controller. Reads and writes through the services layer only.
// ---------------------------------------------------------------------------
export function initSettlementsView({ container, customerId = null, navigate = null, autoLoad = true } = {}) {
  if (!container) return null;
  const state = {
    rows: [],
    criteria: defaultSettlementCriteria(),
    tab: SETTLEMENT_TAB.SETTLEMENT,
    customers: [],
    customerLoadError: null,
    values: {
      CustomerId: customerId ? String(customerId) : '',
      CustomerSearch: '',
      Date: '',
      Direction: SETTLEMENT_DIRECTION.CREDIT,
      Amount: '',
      Description: ''
    },
    fieldErrors: {},
    error: null,
    formError: null,
    busy: false,
    success: null,
    preview: null,
    awaitingConfirm: false
  };

  const find = (selector) => (typeof container.querySelector === 'function' ? container.querySelector(selector) : null);
  const summaryBox = find(`#${SETTLEMENTS_SUMMARY_ID}`);
  const toolbarBox = find(`#${SETTLEMENTS_TOOLBAR_ID}`);
  const successBox = find(`#${SETTLEMENTS_SUCCESS_ID}`);
  const tabsBox = find(`#${SETTLEMENTS_TABS_REGION_ID}`);
  const formBox = find(`#${SETTLEMENTS_FORM_REGION_ID}`);
  const previewBox = find(`#${SETTLEMENTS_PREVIEW_ID}`);
  const region = find(`#${SETTLEMENTS_REGION_ID}`);
  const live = () => Boolean(region) && (!('isConnected' in region) || region.isConnected);

  function paintForm() {
    if (formBox) {
      formBox.innerHTML = renderSettlementForm({
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

  function paintPreview() {
    if (previewBox) previewBox.innerHTML = renderSettlementPreview({ preview: state.preview, awaitingConfirm: state.awaitingConfirm });
  }

  function paintSummary() {
    if (summaryBox) summaryBox.innerHTML = renderSettlementsSummary(settlementService.summarize(visibleSettlements(state.rows, state.criteria)));
  }

  function paintToolbar() {
    if (toolbarBox) toolbarBox.innerHTML = renderSettlementsToolbar({ criteria: state.criteria });
  }

  function paintTabs() {
    if (tabsBox) tabsBox.innerHTML = renderSettlementTabs({ tab: state.tab });
  }

  function paintRegion() {
    if (!live()) return;
    region.innerHTML = renderSettlementsRegion({
      rows: state.rows,
      // The table follows the selected tab; the criteria (search / type / status / dates)
      // stay applied underneath it. Both narrow the view only: nothing is recomputed.
      visible: tabScopedSettlements(state.rows, state.criteria, state.tab),
      criteria: state.criteria,
      error: state.error
    });
    region.setAttribute('aria-busy', 'false');
  }

  function paintSuccess() {
    if (successBox) successBox.innerHTML = state.success ? renderSettlementSuccess(state.success) : '';
  }

  async function load() {
    state.error = null;
    if (region) {
      region.setAttribute('aria-busy', 'true');
      region.innerHTML = loadingState({ message: 'جارٍ تحميل التسويات…' });
    }
    if (summaryBox) summaryBox.innerHTML = '';
    if (toolbarBox) toolbarBox.innerHTML = '';
    try {
      const [rows, customers] = await Promise.all([
        settlementService.listSettlementMovements(),
        settlementService.listSelectableCustomers()
      ]);
      if (!live()) return state;
      state.rows = Array.isArray(rows) ? rows : [];
      state.customers = Array.isArray(customers) ? customers : [];
      state.customerLoadError = null;
    } catch (error) {
      if (!live()) return state;
      logger.error('settlements screen load failed', {
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
    const form = find(`#${SETTLEMENTS_FORM_ID}`);
    if (!form || typeof form.querySelector !== 'function') return { ...state.values };
    const read = (selector, fallback) => {
      const control = form.querySelector(selector);
      return control ? control.value : fallback;
    };
    const rawDirection = read(`#${SETTLEMENT_FIELD_ID.Direction}`, state.values.Direction);
    return {
      CustomerId: read(`#${SETTLEMENT_FIELD_ID.CustomerId}`, state.values.CustomerId),
      Date: read(`#${SETTLEMENT_FIELD_ID.Date}`, state.values.Date),
      Direction: rawDirection === SETTLEMENT_DIRECTION.DEBIT ? SETTLEMENT_DIRECTION.DEBIT : SETTLEMENT_DIRECTION.CREDIT,
      Amount: read(`#${SETTLEMENT_FIELD_ID.Amount}`, state.values.Amount),
      Description: read(`#${SETTLEMENT_FIELD_ID.Description}`, state.values.Description),
      CustomerSearch: read(`#${SETTLEMENT_FIELD_ID.CustomerSearch}`, state.values.CustomerSearch ?? '')
    };
  }

  function setBusy(isBusy) {
    state.busy = isBusy;
    const form = find(`#${SETTLEMENTS_FORM_ID}`);
    const submit = form && typeof form.querySelector === 'function' ? form.querySelector(`#${SETTLEMENTS_SUBMIT_ID}`) : null;
    if (submit) {
      submit.disabled = isBusy;
      submit.setAttribute('aria-disabled', isBusy ? 'true' : 'false');
      submit.innerHTML = isBusy
        ? '<span class="spinner" aria-hidden="true"></span><span>جارٍ الحفظ…</span>'
        : `<span>${state.tab === SETTLEMENT_TAB.SETTLEMENT ? 'حفظ التسوية' : 'حفظ تبادل البضائع'}</span>`;
    }
    const confirmSubmit = previewBox && typeof previewBox.querySelector === 'function' ? previewBox.querySelector(`#${SETTLEMENTS_CONFIRM_SUBMIT_ID}`) : null;
    if (confirmSubmit) {
      confirmSubmit.disabled = isBusy;
      confirmSubmit.setAttribute('aria-disabled', isBusy ? 'true' : 'false');
    }
  }

  // A tab switch is a pure UI act: the form is rebuilt for the new transaction type,
  // the previous validation, preview and success state are dropped, and nothing is
  // submitted or validated. Customer, Date, Direction and Description are carried over.
  function switchTab(tab) {
    if (!tab || tab === state.tab) return false;
    state.tab = tab;
    state.fieldErrors = {};
    state.formError = null;
    state.success = null;
    state.awaitingConfirm = false;
    paintTabs();
    // The table follows the tab immediately, without a reload and without touching the
    // criteria or the form: the entered values, the customer, the date and the direction
    // are all kept, and no movement is created, edited or cancelled by a tab switch.
    paintRegion();
    paintForm();
    paintPreview();
    paintSuccess();
    return true;
  }

  // Preview only: the numbers come back from the service (core engine + the approved
  // balance formula one movement ahead). Nothing is written and nothing is computed here.
  async function refreshPreview() {
    const values = readFormValues();
    state.values = values;
    let preview = null;
    try {
      preview = await settlementService.previewMovement({
        TransactionType: transactionTypeForTab(state.tab),
        CustomerId: values.CustomerId,
        Direction: values.Direction,
        Amount: values.Amount
      });
    } catch (error) {
      logger.error('settlement preview failed', { code: error && error.code ? String(error.code) : null });
      preview = null;
    }
    state.preview = preview;
    if (!(preview && preview.Insufficient)) state.awaitingConfirm = false;
    paintPreview();
    return preview;
  }

  // One user action -> exactly one write. A Debit that would leave the account in debt
  // is NOT written before the user confirms: the first press only shows the warning.
  async function submit({ confirmed = false } = {}) {
    if (state.busy) return null; // a repeated press while saving can never create a second row
    state.busy = true; // synchronous guard: set before the first await, cleared in finally
    try {
    state.values = readFormValues();
    state.fieldErrors = {};
    state.formError = null;
    state.success = null;

    if (!confirmed) {
      const preview = await refreshPreview();
      if (preview && preview.Insufficient) {
        state.awaitingConfirm = true;
        paintPreview();
        return null; // nothing is written before the explicit confirmation
      }
    }
    state.awaitingConfirm = false;

    setBusy(true);
    try {
      const result = await settlementService.createSettlementMovement({
        TransactionType: transactionTypeForTab(state.tab),
        CustomerId: state.values.CustomerId,
        Date: state.values.Date,
        Direction: state.values.Direction,
        Amount: state.values.Amount,
        Description: state.values.Description
      });
      state.success = { result, tab: state.tab };
      // Amount and Description are cleared for the next entry; the customer, the date
      // and the direction are deliberately kept so several movements can follow.
      state.values = { ...state.values, Amount: '', Description: '' };
      state.preview = null;
      paintSuccess();
      paintPreview();
      await load();
      paintSuccess();
      return result;
    } catch (error) {
      logger.error('settlement save failed', {
        code: error && error.code ? String(error.code) : null,
        message: error && error.message ? String(error.message) : null
      });
      state.formError = error && error.message ? String(error.message) : 'تعذّر حفظ التسوية.';
      state.fieldErrors = fieldErrorsFrom(error);
      paintForm(); // every entered value is preserved: nothing is cleared on failure
      paintPreview();
      return null;
    } finally {
      setBusy(false); // the loading state always ends, on success and on failure alike
      state.busy = false;
    }
    } finally {
      // The guard is released on every path, including the "confirm first" return.
      if (state.busy) { state.busy = false; setBusy(false); }
    }
  }

  container.addEventListener('submit', (event) => {
    const target = event && event.target;
    if (!target || typeof target.getAttribute !== 'function' || target.getAttribute('id') !== SETTLEMENTS_FORM_ID) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    void submit();
  });

  container.addEventListener('click', (event) => {
    const target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    const tabButton = target.closest('[data-tab]');
    if (tabButton) { switchTab(tabButton.getAttribute('data-tab')); return; }
    if (target.closest('[data-action="confirm-save"]')) { void submit({ confirmed: true }); return; }
    if (target.closest('[data-action="cancel-confirm"]')) { state.awaitingConfirm = false; paintPreview(); return; }
    if (target.closest('[data-action="open-form"]')) {
      const search = find(`#${SETTLEMENT_FIELD_ID.CustomerSearch}`);
      if (search && typeof search.focus === 'function') search.focus();
      return;
    }
    if (target.closest('[data-action="retry"]')) { void load(); return; }
    if (target.closest('[data-action="reset-filters"]')) {
      state.criteria = defaultSettlementCriteria();
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
    if (id === SETTLEMENT_FIELD_ID.CustomerSearch) {
      const form = find(`#${SETTLEMENTS_FORM_ID}`);
      const selectNode = form && typeof form.querySelector === 'function' ? form.querySelector(`#${SETTLEMENT_FIELD_ID.CustomerId}`) : null;
      if (!selectNode) return;
      const term = String(target.value || '').trim().toLowerCase();
      const selected = selectNode.value;
      const options = customerOptions(state.customers).filter((option) => option.value === '' || !term || option.search.includes(term));
      selectNode.innerHTML = options
        .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
        .join('');
      return;
    }
    if (id === SETTLEMENT_FIELD_ID.Amount) { state.values.Amount = target.value; void refreshPreview(); return; }
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
    if (id === SETTLEMENT_FIELD_ID.CustomerId) { state.values.CustomerId = target.value; void refreshPreview(); return; }
    if (id === SETTLEMENT_FIELD_ID.Date) { state.values.Date = target.value; return; }
    if (id === SETTLEMENT_FIELD_ID.Direction) {
      state.values.Direction = target.value === SETTLEMENT_DIRECTION.DEBIT ? SETTLEMENT_DIRECTION.DEBIT : SETTLEMENT_DIRECTION.CREDIT;
      state.awaitingConfirm = false;
      void refreshPreview();
      return;
    }
    if (id === SETTLEMENT_FIELD_ID.Amount) { state.values.Amount = target.value; void refreshPreview(); return; }
    if (id === SETTLEMENT_FIELD_ID.Description) { state.values.Description = target.value; return; }
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
    refreshPreview,
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
