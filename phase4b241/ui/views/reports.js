// Phase 4B.12 — the carton purchase reports screen.
//
// Reporting only: this module prints what cartonReportService returned. It owns no
// counting rule, no grouping rule, no date rule and no financial value. Every figure on
// the screen — the count of a group, the total, the number of groups, the number of
// cancelled movements — is read from the service result; the only thing computed here is
// text formatting.
//
// It reaches the data layer only through the services barrel, exactly like every other
// screen in the project: no repository, no storage module, no direct database access.
import { pageHeader, card, table, alert, modal } from '../components/index.js';
import { loadingState, emptyState, errorState } from '../components/states.js';
import { escapeHtml } from '../components/html.js';
import { formatText, formatCount, formatQuantityTrimmed, formatMoneyMinor } from '../../src/utils/formatting.js';
import {
  cartonReportService,
  CARTON_REPORT_KIND,
  CARTON_REPORT_KINDS,
  CARTON_REPORT_TITLES_AR,
  DEFAULT_CARTON_REPORT_KIND,
  UNAVAILABLE_REFERENCE_LABEL,
  UNSPECIFIED_CARTON_COUNT_LABEL
} from '../../src/services/cartonReportService.js';
import { cartonCountLabel } from '../../src/services/movementNotes.js';
import { customerAccountPath } from '../routes.js';
import { cropReportViewHtml, initCropReportView } from './reportCropLocal.js';
import { generalReportViewHtml, initGeneralReportView } from './reportGeneral.js';
import { customerReportViewHtml, initCustomerReportView } from './reportCustomers.js';
import { reportExportActionsHtml, bindReportExportActions } from './reportExport.js';

export const REPORTS_ROOT_ID = 'reports-root';

// `#/reports` hosts separate report families: carton purchases, local crop purchases,
// general transaction types, and customer/account reporting. Each family mounts lazily;
// the previously approved report modules remain isolated from the customer reports.
export const REPORT_DOMAIN = Object.freeze({ CARTON: 'carton', CROP_LOCAL: 'cropLocal', GENERAL: 'general', CUSTOMERS: 'customers' });
export const REPORT_DOMAIN_TABS_ID = 'report-domain-tabs';
export const REPORT_DOMAIN_CARTON_ID = 'report-domain-carton';
export const REPORT_DOMAIN_CROP_ID = 'report-domain-crop';
export const REPORT_DOMAIN_GENERAL_ID = 'report-domain-general';
export const REPORT_DOMAIN_CUSTOMERS_ID = 'report-domain-customers';
export const REPORT_DOMAIN_TABS = Object.freeze([
  Object.freeze({ id: REPORT_DOMAIN.CARTON, label: 'مشتريات الكرتون' }),
  Object.freeze({ id: REPORT_DOMAIN.CROP_LOCAL, label: 'مشتريات المحصول المحلي' }),
  Object.freeze({ id: REPORT_DOMAIN.GENERAL, label: 'تقارير الحركات العامة' }),
  Object.freeze({ id: REPORT_DOMAIN.CUSTOMERS, label: 'تقارير العملاء والحسابات' })
]);
export const REPORT_TABS_ID = 'report-kind-tabs';
export const REPORT_FILTERS_ID = 'report-filters';
export const REPORT_FILTER_ERROR_ID = 'report-filter-error';
export const REPORT_SUMMARY_ID = 'report-summary';
export const REPORT_RESULTS_ID = 'report-results';
export const REPORT_VIEW_MODE_ID = 'report-view-mode';
export const REPORT_STATUS_FILTER_ID = 'report-status-filter';
export const REPORT_DETAILS_ID = 'report-details-dialog';
export const REPORT_DETAILS_TITLE_ID = 'report-details-dialog-title';
export const REPORT_DETAILS_BODY_ID = 'report-details-body';

export const REPORT_FILTER_FIELD = Object.freeze({
  FROM: 'report-from',
  TO: 'report-to',
  CUSTOMER: 'report-customer',
  COMPANY: 'report-company',
  TYPE: 'report-type'
});

export const REPORT_TABS = Object.freeze([
  Object.freeze({ id: CARTON_REPORT_KIND.BY_FARMER, label: 'حسب المزارع' }),
  Object.freeze({ id: CARTON_REPORT_KIND.BY_COMPANY, label: 'حسب الشركة المستلمة' }),
  Object.freeze({ id: CARTON_REPORT_KIND.BY_CARTON_TYPE, label: 'حسب نوع الكرتونة' }),
  Object.freeze({ id: CARTON_REPORT_KIND.CROSS, label: 'تقاطعي تفصيلي' })
]);

export const REPORT_EMPTY_MESSAGE = 'لا توجد مشتريات كرتون مطابقة للفلاتر الحالية.';
export const REPORT_NO_DATA_MESSAGE = 'لا توجد مشتريات كرتون مسجلة بعد.';
export const REPORT_LOAD_ERROR = 'تعذّر تحميل بيانات التقرير.';
export const REPORT_APPLY_LABEL = 'تطبيق الفلاتر';
export const REPORT_RESET_LABEL = 'مسح الفلاتر';
export const REPORT_DETAILS_LABEL = 'عرض الحركات';
export const REPORT_ANY_OPTION = 'الكل';
export const REPORT_VIEW_MODE = Object.freeze({ SUMMARY: 'summary', DETAILS: 'details' });
export const REPORT_STATUS_FILTER = Object.freeze({ ACTIVE: 'active', CANCELLED: 'cancelled', ALL: 'all' });

export const REPORT_COLUMNS = Object.freeze({
  byFarmer: Object.freeze([{ label: 'المزارع' }, { label: 'الكود' }, { label: 'عدد الحركات' }, { label: 'عدد الكراتين' }, { label: 'متوسط سعر الكرتونة' }, { label: 'القيمة الإجمالية' }, { label: 'تفاصيل' }]),
  byCompany: Object.freeze([{ label: 'الشركة المستلمة' }, { label: 'عدد الحركات' }, { label: 'عدد الكراتين' }, { label: 'متوسط سعر الكرتونة' }, { label: 'القيمة الإجمالية' }, { label: 'تفاصيل' }]),
  byCartonType: Object.freeze([{ label: 'نوع الكرتونة' }, { label: 'عدد الحركات' }, { label: 'عدد الكراتين' }, { label: 'متوسط سعر الكرتونة' }, { label: 'القيمة الإجمالية' }, { label: 'تفاصيل' }]),
  cross: Object.freeze([{ label: 'المزارع' }, { label: 'الشركة المستلمة' }, { label: 'نوع الكرتونة' }, { label: 'عدد الحركات' }, { label: 'عدد الكراتين' }, { label: 'متوسط سعر الكرتونة' }, { label: 'القيمة الإجمالية' }, { label: 'تفاصيل' }])
});

export const REPORT_DETAIL_COLUMNS = Object.freeze([
  { label: 'التاريخ' }, { label: 'المزارع' }, { label: 'الشركة المستلمة' }, { label: 'نوع الكرتونة' }, { label: 'عدد الكراتين' }, { label: 'خصم الكراتين' }, { label: 'صافي الكراتين' }, { label: 'سعر الكرتونة' }, { label: 'القيمة الإجمالية' }, { label: 'الحالة' }, { label: 'سبب الإلغاء' }
]);

// A stored count is printed with its Arabic counted noun; a row that carries no valid
// count keeps an explicit state instead of a fabricated zero.
export function countLabel(quantityMilli) {
  const label = cartonCountLabel(quantityMilli);
  return label === null ? UNSPECIFIED_CARTON_COUNT_LABEL : label;
}

function referenceCell(name, isActive, id) {
  const text = formatText(name);
  if (text === '' || (id && isActive === null)) return `<span class="text-sm text-muted">${escapeHtml(UNAVAILABLE_REFERENCE_LABEL)}</span>`;
  const inactive = isActive === false ? ' <span class="badge">غير نشطة</span>' : '';
  return `${escapeHtml(text)}${inactive}`;
}

export function reportSummaryHtml(report) {
  if (!report) return '';
  const totals = report.Totals;
  const items = [
    { label: 'إجمالي عدد الكراتين', value: `${formatQuantityTrimmed(totals.QuantityMilli)} كرتونة`, hint: 'العدد قبل خصم الكراتين' },
    { label: 'صافي عدد الكراتين', value: `${formatQuantityTrimmed(totals.NetQuantityMilli)} كرتونة`, hint: 'بعد خصم الكراتين' },
    { label: 'إجمالي قيمة المشتريات', value: `${formatMoneyMinor(totals.AmountMinor)} ج`, hint: 'من القيمة المخزنة للحركات' },
    { label: 'متوسط سعر الكرتونة المرجح', value: Number.isInteger(totals.AverageUnitPriceMinor) ? `${formatMoneyMinor(totals.AverageUnitPriceMinor)} ج` : '—', hint: 'مرجح بصافي عدد الكراتين' },
    { label: 'عدد الحركات المحتسبة', value: formatCount(totals.MovementCount), hint: 'الحركات النشطة فقط' },
    { label: 'عدد المجموعات', value: formatCount(totals.GroupCount), hint: null }
  ];
  if (totals.DiscountQuantityMilli > 0) items.splice(2, 0, { label: 'إجمالي الكراتين المخصومة', value: `${formatQuantityTrimmed(totals.DiscountQuantityMilli)} كرتونة`, hint: 'كمية وليست خصمًا نقديًا' });
  if (totals.MissingQuantityCount > 0) items.push({ label: 'حركات بلا عدد مسجل', value: formatCount(totals.MissingQuantityCount), hint: 'مستبعدة من إجمالي الكمية' });
  if (totals.CancelledCount > 0) items.push({ label: 'حركات ملغاة', value: formatCount(totals.CancelledCount), hint: 'مستبعدة من الإجماليات' });
  const cards = items.map((item) => `<div class="card card--flat dash-kpi report-kpi"><div class="card__body dash-kpi__body"><span class="kpi__label">${escapeHtml(item.label)}</span><strong class="kpi__value">${escapeHtml(item.value)}</strong>${item.hint ? `<span class="dash-kpi__hint">${escapeHtml(item.hint)}</span>` : ''}</div></div>`).join('');
  return `<div class="dash-kpis report-kpis" id="report-kpis" role="region" aria-label="إجماليات مشتريات الكرتون" aria-live="polite">${cards}</div>`;
}

function periodLine(filters) {
  const from = formatText(filters.from);
  const to = formatText(filters.to);
  if (!from && !to) return 'كل الفترات';
  if (from && to) return `من ${from} إلى ${to}`;
  if (from) return `من ${from} وما بعده`;
  return `حتى ${to}`;
}

export function reportsViewHtml() {
  const tabs = REPORT_TABS.map((tab) => `<button class="btn btn--outline" type="button" role="tab" data-report-action="kind" data-report-kind="${escapeHtml(tab.id)}" aria-selected="false">${escapeHtml(tab.label)}</button>`).join('');
  const option = (value, label) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  const anyOption = option('', REPORT_ANY_OPTION);
  const domainTabs = REPORT_DOMAIN_TABS.map((tab, index) => `<button class="btn ${index === 0 ? 'btn--primary' : 'btn--outline'}" type="button" role="tab" aria-selected="${index === 0 ? 'true' : 'false'}" data-report-domain="${escapeHtml(tab.id)}">${escapeHtml(tab.label)}</button>`).join('');
  return `<div id="${escapeHtml(REPORTS_ROOT_ID)}" class="stack">
  <div class="row" role="tablist" aria-label="مجموعة التقارير" id="${escapeHtml(REPORT_DOMAIN_TABS_ID)}">${domainTabs}</div>
  <div id="${escapeHtml(REPORT_DOMAIN_CARTON_ID)}" class="stack">
${pageHeader({ title: 'تقارير مشتريات الكرتون', description: 'كميات الكراتين وقيم المشتريات ومتوسط سعر الكرتونة المرجح، مجمّعة حسب المزارع أو الشركة المستلمة أو نوع الكرتونة.' })}
  ${reportExportActionsHtml()}
  <div class="row" role="tablist" aria-label="نوع التقرير" id="${escapeHtml(REPORT_TABS_ID)}">${tabs}</div>
  <div class="page-section" id="${escapeHtml(REPORT_FILTERS_ID)}">
    <div class="toolbar">
      <div class="field"><label class="field__label" for="${escapeHtml(REPORT_FILTER_FIELD.FROM)}">من تاريخ</label><input class="input" type="date" id="${escapeHtml(REPORT_FILTER_FIELD.FROM)}"></div>
      <div class="field"><label class="field__label" for="${escapeHtml(REPORT_FILTER_FIELD.TO)}">إلى تاريخ</label><input class="input" type="date" id="${escapeHtml(REPORT_FILTER_FIELD.TO)}"></div>
      <div class="field"><label class="field__label" for="${escapeHtml(REPORT_FILTER_FIELD.CUSTOMER)}">المزارع</label><select class="select" id="${escapeHtml(REPORT_FILTER_FIELD.CUSTOMER)}">${anyOption}</select></div>
      <div class="field"><label class="field__label" for="${escapeHtml(REPORT_FILTER_FIELD.COMPANY)}">الشركة المستلمة</label><select class="select" id="${escapeHtml(REPORT_FILTER_FIELD.COMPANY)}">${anyOption}</select></div>
      <div class="field"><label class="field__label" for="${escapeHtml(REPORT_FILTER_FIELD.TYPE)}">نوع الكرتونة</label><select class="select" id="${escapeHtml(REPORT_FILTER_FIELD.TYPE)}">${anyOption}</select></div>
    </div>
    <div class="row" style="margin-block-start: var(--space-3)">
      <button class="btn btn--primary" type="button" data-report-action="apply">${escapeHtml(REPORT_APPLY_LABEL)}</button>
      <button class="btn btn--outline" type="button" data-report-action="reset">${escapeHtml(REPORT_RESET_LABEL)}</button>
    </div>
    <div id="${escapeHtml(REPORT_FILTER_ERROR_ID)}"></div>
  </div>
  <div class="row" id="${escapeHtml(REPORT_VIEW_MODE_ID)}" role="group" aria-label="طريقة عرض التقرير">
    <button class="btn btn--primary" type="button" data-report-action="view-mode" data-report-mode="summary" aria-pressed="true">العرض الإجمالي</button>
    <button class="btn btn--outline" type="button" data-report-action="view-mode" data-report-mode="details" aria-pressed="false">العرض التفصيلي</button>
    <div class="field"><label class="field__label" for="${escapeHtml(REPORT_STATUS_FILTER_ID)}">حالة الحركات في العرض التفصيلي</label><select class="select" id="${escapeHtml(REPORT_STATUS_FILTER_ID)}"><option value="active">النشطة فقط</option><option value="cancelled">الملغاة فقط</option><option value="all">النشطة والملغاة</option></select></div>
  </div>
  <div id="${escapeHtml(REPORT_SUMMARY_ID)}"></div>
  <div id="${escapeHtml(REPORT_RESULTS_ID)}">${loadingState({ message: 'جارٍ تحميل التقرير…' })}</div>
${modal({ id: REPORT_DETAILS_ID, title: 'حركات المجموعة', body: `<div id="${escapeHtml(REPORT_DETAILS_BODY_ID)}"></div>`, footer: '<button class="btn btn--outline" type="button" data-report-action="close-details">رجوع إلى التقرير</button>' })}
  </div>
  <div id="${escapeHtml(REPORT_DOMAIN_CROP_ID)}" class="stack" hidden>${cropReportViewHtml()}</div>
  <div id="${escapeHtml(REPORT_DOMAIN_GENERAL_ID)}" class="stack" hidden>${generalReportViewHtml()}</div>
  <div id="${escapeHtml(REPORT_DOMAIN_CUSTOMERS_ID)}" class="stack" hidden>${customerReportViewHtml()}</div>
</div>`;
}

function selectOptionsHtml(options, selected) {
  const anyOption = `<option value=""${selected ? '' : ' selected'}>${escapeHtml(REPORT_ANY_OPTION)}</option>`;
  const items = options.map((option) => {
    const isSelected = option.value === selected ? ' selected' : '';
    const suffix = option.IsActive === false ? ' (غير نشطة)' : '';
    return `<option value="${escapeHtml(option.value)}"${isSelected}>${escapeHtml(option.label + suffix)}</option>`;
  }).join('');
  return `${anyOption}${items}`;
}

function detailsRowsHtml(rows) {
  return table({
    columns: REPORT_DETAIL_COLUMNS,
    numeric: true,
    rows: rows.map((row) => ({
      cells: [
        escapeHtml(row.Date),
        referenceCell(row.CustomerName, row.CustomerActive, row.CustomerId),
        referenceCell(row.ReceivingCompanyName, row.ReceivingCompanyActive, row.ReceivingCompanyId),
        referenceCell(row.CartonTypeName, row.CartonTypeActive, row.CartonTypeId),
        escapeHtml(countLabel(row.CartonQuantityMilli)),
        escapeHtml(row.DiscountQuantityMilli === null ? '—' : countLabel(row.DiscountQuantityMilli)),
        escapeHtml(row.NetQuantityMilli === null ? '—' : countLabel(row.NetQuantityMilli)),
        escapeHtml(Number.isInteger(row.CartonUnitPriceMinor) ? `${formatMoneyMinor(row.CartonUnitPriceMinor)} ج` : '—'),
        escapeHtml(Number.isInteger(row.AmountMinor) ? `${formatMoneyMinor(row.AmountMinor)} ج` : '—'),
        row.Status === 'Cancelled' ? '<span class="badge badge--cancelled">ملغاة</span>' : '<span class="badge">نشطة</span>',
        row.Status === 'Cancelled' ? escapeHtml(formatText(row.CancellationReason) || '—') : '—'
      ]
    })),
    emptyMessage: REPORT_EMPTY_MESSAGE
  });
}

export function reportDetailRows(report, statusFilter) {
  if (statusFilter === REPORT_STATUS_FILTER.CANCELLED) return report.CancelledRows || [];
  if (statusFilter === REPORT_STATUS_FILTER.ALL) return [...(report.Rows || []), ...(report.CancelledRows || [])]
    .sort((a, b) => (a.Date === b.Date ? String(a.Id).localeCompare(String(b.Id)) : a.Date.localeCompare(b.Date)));
  return report.Rows || [];
}

function groupRowsHtml(report) {
  const columns = REPORT_COLUMNS[report.Kind];
  const rows = report.Groups.map((group, index) => {
    const cells = [];
    if (report.Kind === CARTON_REPORT_KIND.BY_FARMER) {
      cells.push(referenceCell(group.CustomerName, group.CustomerActive, group.CustomerId));
      cells.push(group.CustomerCode ? escapeHtml(group.CustomerCode) : '—');
    } else if (report.Kind === CARTON_REPORT_KIND.BY_COMPANY) {
      cells.push(referenceCell(group.ReceivingCompanyName, group.ReceivingCompanyActive, group.ReceivingCompanyId));
    } else if (report.Kind === CARTON_REPORT_KIND.BY_CARTON_TYPE) {
      cells.push(referenceCell(group.CartonTypeName, group.CartonTypeActive, group.CartonTypeId));
    } else {
      cells.push(referenceCell(group.CustomerName, group.CustomerActive, group.CustomerId));
      cells.push(referenceCell(group.ReceivingCompanyName, group.ReceivingCompanyActive, group.ReceivingCompanyId));
      cells.push(referenceCell(group.CartonTypeName, group.CartonTypeActive, group.CartonTypeId));
    }
    cells.push(escapeHtml(formatCount(group.MovementCount)));
    cells.push(escapeHtml(countLabel(group.QuantityMilli)));
    cells.push(escapeHtml(Number.isInteger(group.AverageUnitPriceMinor) ? `${formatMoneyMinor(group.AverageUnitPriceMinor)} ج` : '—'));
    cells.push(escapeHtml(`${formatMoneyMinor(group.AmountMinor)} ج`));
    cells.push(`<button class="btn btn--outline" type="button" data-report-action="details" data-report-group="${index}">${escapeHtml(REPORT_DETAILS_LABEL)}</button>`);
    return { cells };
  });
  return table({
    columns,
    numeric: true,
    rows,
    caption: `${report.Title} — ${periodLine(report.Filters)}`,
    emptyMessage: REPORT_EMPTY_MESSAGE
  });
}

export function initReportsView({ container, navigate = null, autoLoad = true } = {}) {
  if (!container) return null;
  const find = (selector) => container.querySelector(selector);
  const state = {
    domain: REPORT_DOMAIN.CARTON,
    kind: DEFAULT_CARTON_REPORT_KIND,
    viewMode: REPORT_VIEW_MODE.SUMMARY,
    statusFilter: REPORT_STATUS_FILTER.ACTIVE,
    filters: { from: '', to: '', customerId: '', receivingCompanyId: '', cartonTypeId: '' },
    options: { customers: [], receivingCompanies: [], cartonTypes: [] },
    report: null,
    error: null,
    filterError: null,
    loading: false,
    hasLoadedOnce: false
  };

  function renderTabs() {
    const box = find(`#${REPORT_TABS_ID}`);
    if (!box) return;
    for (const button of box.querySelectorAll('[data-report-kind]')) {
      const isActive = button.getAttribute('data-report-kind') === state.kind;
      button.className = isActive ? 'btn btn--primary' : 'btn btn--outline';
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  }

  function renderOptions() {
    const customerBox = find(`#${REPORT_FILTER_FIELD.CUSTOMER}`);
    const companyBox = find(`#${REPORT_FILTER_FIELD.COMPANY}`);
    const typeBox = find(`#${REPORT_FILTER_FIELD.TYPE}`);
    if (customerBox) customerBox.innerHTML = selectOptionsHtml(state.options.customers, state.filters.customerId);
    if (companyBox) companyBox.innerHTML = selectOptionsHtml(state.options.receivingCompanies, state.filters.receivingCompanyId);
    if (typeBox) typeBox.innerHTML = selectOptionsHtml(state.options.cartonTypes, state.filters.cartonTypeId);
  }

  function renderViewMode() {
    const box = find(`#${REPORT_VIEW_MODE_ID}`);
    if (!box) return;
    for (const button of box.querySelectorAll('[data-report-mode]')) {
      const active = button.getAttribute('data-report-mode') === state.viewMode;
      button.className = active ? 'btn btn--primary' : 'btn btn--outline';
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    const status = find(`#${REPORT_STATUS_FILTER_ID}`);
    if (status) status.value = state.statusFilter;
  }

  function renderFilterError() {
    const box = find(`#${REPORT_FILTER_ERROR_ID}`);
    if (!box) return;
    box.innerHTML = state.filterError ? alert({ tone: 'danger', title: 'فلاتر غير صالحة', message: state.filterError }) : '';
  }

  function renderResults() {
    const summaryBox = find(`#${REPORT_SUMMARY_ID}`);
    const resultsBox = find(`#${REPORT_RESULTS_ID}`);
    if (summaryBox) summaryBox.innerHTML = state.report ? reportSummaryHtml(state.report) : '';
    if (!resultsBox) return;
    if (state.loading) {
      resultsBox.innerHTML = loadingState({ message: 'جارٍ احتساب التقرير…' });
      return;
    }
    if (state.error) {
      resultsBox.innerHTML = errorState({ title: REPORT_LOAD_ERROR, message: state.error });
      return;
    }
    if (!state.report) {
      resultsBox.innerHTML = emptyState({ title: 'لم يُحمَّل تقرير بعد', message: 'اختر نوع التقرير ثم اضغط تطبيق الفلاتر.' });
      return;
    }
    if (state.viewMode === REPORT_VIEW_MODE.DETAILS) {
      const rows = reportDetailRows(state.report, state.statusFilter);
      const statusLabel = state.statusFilter === REPORT_STATUS_FILTER.CANCELLED ? 'الحركات الملغاة' : state.statusFilter === REPORT_STATUS_FILTER.ALL ? 'كل الحركات' : 'الحركات النشطة';
      const detailSummary = `<p class="text-sm text-muted">${escapeHtml(statusLabel)}: ${escapeHtml(formatCount(rows.length))} — ${escapeHtml(periodLine(state.report.Filters))}</p><p class="text-sm text-muted">ملاحظة: إجماليات التقرير تحتسب الحركات النشطة فقط؛ عرض الحركات الملغاة لا يضيفها إلى الإجماليات.</p>`;
      resultsBox.innerHTML = card({ title: `${state.report.Title} — العرض التفصيلي`, body: `${detailSummary}${detailsRowsHtml(rows)}` });
      return;
    }
    if (!state.report.Groups.length) {
      resultsBox.innerHTML = card({
        title: state.report.Title,
        body: emptyState({ title: state.report.Totals.CancelledCount > 0 ? 'لا توجد حركات نشطة مطابقة للفلاتر.' : REPORT_EMPTY_MESSAGE, message: state.report.Totals.CancelledCount > 0 ? `توجد ${formatCount(state.report.Totals.CancelledCount)} حركة ملغاة مستبعدة من الإجماليات؛ يمكنك عرضها من الوضع التفصيلي.` : periodLine(state.report.Filters) })
      });
      return;
    }
    resultsBox.innerHTML = card({ title: state.report.Title, body: groupRowsHtml(state.report) });
  }

  function setBusy(busy) {
    state.loading = busy;
    for (const button of container.querySelectorAll('[data-report-action="apply"], [data-report-action="reset"], [data-report-action="details"], [data-report-action="view-mode"]')) {
      button.disabled = busy;
    }
  }

  // Every run recomputes from the service with the CURRENT filter values; no earlier
  // result is ever reused, so a changed filter can never show a stale table.
  async function run() {
    if (state.loading) return;
    state.error = null;
    setBusy(true);
    renderResults();
    try {
      const report = await cartonReportService.buildReport({ kind: state.kind, filters: state.filters });
      state.report = report;
      state.hasLoadedOnce = true;
    } catch (error) {
      state.report = null;
      state.error = (error && error.message) ? error.message : REPORT_LOAD_ERROR;
    } finally {
      setBusy(false);
      renderTabs();
      renderResults();
    }
  }

  function readFiltersFromForm() {
    const value = (id) => {
      const element = find(`#${id}`);
      return element ? formatText(element.value) : '';
    };
    return {
      from: value(REPORT_FILTER_FIELD.FROM),
      to: value(REPORT_FILTER_FIELD.TO),
      customerId: value(REPORT_FILTER_FIELD.CUSTOMER),
      receivingCompanyId: value(REPORT_FILTER_FIELD.COMPANY),
      cartonTypeId: value(REPORT_FILTER_FIELD.TYPE)
    };
  }

  async function apply() {
    const next = readFiltersFromForm();
    state.filterError = null;
    try {
      // Validation happens in the service; the screen only displays the refusal.
      state.filters = cartonReportService.normalizeFilters(next);
    } catch (error) {
      state.filterError = (error && error.message) ? error.message : 'فلاتر غير صالحة.';
      renderFilterError();
      return;
    }
    renderFilterError();
    await run();
  }

  async function reset() {
    const from = find(`#${REPORT_FILTER_FIELD.FROM}`);
    const to = find(`#${REPORT_FILTER_FIELD.TO}`);
    if (from) from.value = '';
    if (to) to.value = '';
    state.filterError = null;
    state.filters = cartonReportService.normalizeFilters({});
    renderOptions();
    renderFilterError();
    await run();
  }

  function openDetails(index) {
    if (!state.report) return;
    const group = state.report.Groups[index];
    const dialog = find(`#${REPORT_DETAILS_ID}`);
    const body = find(`#${REPORT_DETAILS_BODY_ID}`);
    if (!group || !dialog || !body) return;
    const heading = [group.CustomerName, group.ReceivingCompanyName, group.CartonTypeName].filter((part) => formatText(part) !== '').join(' · ');
    body.innerHTML = `<p class="text-sm text-muted">${escapeHtml(heading)} — ${escapeHtml(countLabel(group.QuantityMilli))} · عدد الحركات: ${escapeHtml(formatCount(group.MovementCount))}</p>${detailsRowsHtml(group.Rows)}`;
    const titleNode = find(`#${REPORT_DETAILS_TITLE_ID}`);
    if (titleNode) titleNode.textContent = 'حركات المجموعة';
    dialog.removeAttribute('hidden');
  }

  function closeDetails() {
    const dialog = find(`#${REPORT_DETAILS_ID}`);
    if (dialog) dialog.setAttribute('hidden', '');
  }

  // Phase 4B.18 — the report family switch. The local crop report is mounted once, on
  // first use, and keeps its own filters/mode afterwards.
  bindReportExportActions({ container, root: find(`#${REPORT_DOMAIN_CARTON_ID}`), filename: () => `carton-purchase-${state.kind}` });
  let cropController = null;
  let generalController = null;
  let customerController = null;
  function renderDomain() {
    const box = find(`#${REPORT_DOMAIN_TABS_ID}`);
    if (box) {
      for (const button of box.querySelectorAll('[data-report-domain]')) {
        const isActive = button.getAttribute('data-report-domain') === state.domain;
        button.className = isActive ? 'btn btn--primary' : 'btn btn--outline';
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      }
    }
    const cartonBox = find(`#${REPORT_DOMAIN_CARTON_ID}`);
    const cropBox = find(`#${REPORT_DOMAIN_CROP_ID}`);
    const generalBox = find(`#${REPORT_DOMAIN_GENERAL_ID}`);
    const customersBox = find(`#${REPORT_DOMAIN_CUSTOMERS_ID}`);
    if (cartonBox) cartonBox.hidden = state.domain !== REPORT_DOMAIN.CARTON;
    if (cropBox) cropBox.hidden = state.domain !== REPORT_DOMAIN.CROP_LOCAL;
    if (generalBox) generalBox.hidden = state.domain !== REPORT_DOMAIN.GENERAL;
    if (customersBox) customersBox.hidden = state.domain !== REPORT_DOMAIN.CUSTOMERS;
  }

  function openDomain(domain) {
    if (domain !== REPORT_DOMAIN.CARTON && domain !== REPORT_DOMAIN.CROP_LOCAL && domain !== REPORT_DOMAIN.GENERAL && domain !== REPORT_DOMAIN.CUSTOMERS) return;
    if (domain === state.domain) return;
    state.domain = domain;
    renderDomain();
    if (domain === REPORT_DOMAIN.CROP_LOCAL && cropController === null) {
      cropController = initCropReportView({ container, autoLoad: true });
    }
    if (domain === REPORT_DOMAIN.GENERAL && generalController === null) {
      generalController = initGeneralReportView({ container, autoLoad: true });
    }
    if (domain === REPORT_DOMAIN.CUSTOMERS && customerController === null) {
      customerController = initCustomerReportView({ container, autoLoad: true });
    }
  }

  container.addEventListener('click', (event) => {
    const domainTrigger = event.target && event.target.closest ? event.target.closest('[data-report-domain]') : null;
    if (domainTrigger) { openDomain(domainTrigger.getAttribute('data-report-domain')); return; }
    const trigger = event.target && event.target.closest ? event.target.closest('[data-report-action]') : null;
    if (!trigger) return;
    const action = trigger.getAttribute('data-report-action');
    if (action === 'kind') {
      const next = trigger.getAttribute('data-report-kind');
      if (!next || next === state.kind) return;
      // Switching report keeps the filters the user entered and recomputes from data.
      state.kind = next;
      state.filters = cartonReportService.normalizeFilters(readFiltersFromForm());
      renderTabs();
      run();
      return;
    }
    if (action === 'view-mode') {
      const mode = trigger.getAttribute('data-report-mode');
      if (mode === REPORT_VIEW_MODE.SUMMARY || mode === REPORT_VIEW_MODE.DETAILS) { state.viewMode = mode; renderViewMode(); renderResults(); }
      return;
    }
    if (action === 'apply') { apply(); return; }
    if (action === 'reset') { reset(); return; }
    if (action === 'details') { openDetails(Number(trigger.getAttribute('data-report-group'))); return; }
    if (action === 'close-details') { closeDetails(); }
  });

  const statusFilterElement = find(`#${REPORT_STATUS_FILTER_ID}`);
  if (statusFilterElement) statusFilterElement.addEventListener('change', () => {
    const value = statusFilterElement.value;
    if (Object.values(REPORT_STATUS_FILTER).includes(value)) state.statusFilter = value;
    renderResults();
  });

  async function loadOptions() {
    try {
      state.options = await cartonReportService.listFilterOptions();
      renderOptions();
    } catch (error) {
      // A failed catalogue read must not hide the report itself: the dropdowns stay empty
      // and the results area reports the problem honestly.
      state.options = { customers: [], receivingCompanies: [], cartonTypes: [] };
      state.error = (error && error.message) ? error.message : REPORT_LOAD_ERROR;
      renderResults();
    }
  }

  renderTabs();
  renderViewMode();
  renderDomain();
  if (autoLoad) {
    loadOptions().then(() => run());
  }
  return {
    state,
    run,
    openDomain,
    getCropController: () => cropController,
    getGeneralController: () => generalController,
    getCustomerController: () => customerController,
    apply,
    reset,
    openDetails,
    closeDetails,
    load: () => loadOptions().then(() => run()),
    navigate
  };
}

export { customerAccountPath, CARTON_REPORT_TITLES_AR, CARTON_REPORT_KINDS };
