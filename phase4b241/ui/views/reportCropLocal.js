// Phase 4B.18 — the local crop purchase report screen.
//
// Reporting only: every figure printed here comes from `cropReportService`. This module
// owns no counting rule, no grouping rule, no date rule, no weight rule and no financial
// value — the only thing it computes is the merged filter object that the user explicitly
// asked for by drilling into a group.
//
// It reaches the data layer only through the service: no repository, no storage module,
// no direct database access, no `the finance engine`, no `settingsService`.
import { pageHeader, card, table, alert, kpi } from '../components/index.js';
import { loadingState, emptyState, errorState } from '../components/states.js';
import { escapeHtml } from '../components/html.js';
import { formatText, formatCount, formatQuantityTrimmed, formatMoneyMinor } from '../../src/utils/formatting.js';
import { reportExportActionsHtml, bindReportExportActions } from './reportExport.js';
import {
  cropReportService,
  CROP_REPORT_GROUPING,
  CROP_REPORT_GROUPINGS,
  CROP_REPORT_GROUPING_TITLES_AR,
  CROP_REPORT_MODE,
  CROP_REPORT_MODES,
  CROP_REPORT_STATUS,
  CROP_REPORT_STATUS_OPTIONS,
  CROP_REPORT_STATUS_LABELS_AR,
  DEFAULT_CROP_REPORT_GROUPING,
  DEFAULT_CROP_REPORT_STATUS,
  NO_VARIETY_KEY,
  NO_VARIETY_LABEL,
  UNRESOLVED_WEIGHT_LABEL,
  UNAVAILABLE_REFERENCE_LABEL
} from '../../src/services/cropReportService.js';

export const CROP_REPORT_ROOT_ID = 'crop-report-root';
export const CROP_REPORT_MODE_TABS_ID = 'crop-report-mode-tabs';
export const CROP_REPORT_GROUP_TABS_ID = 'crop-report-group-tabs';
export const CROP_REPORT_FILTERS_ID = 'crop-report-filters';
export const CROP_REPORT_FILTER_ERROR_ID = 'crop-report-filter-error';
export const CROP_REPORT_SUMMARY_ID = 'crop-report-summary';
export const CROP_REPORT_RESULTS_ID = 'crop-report-results';
export const CROP_REPORT_CONTEXT_ID = 'crop-report-context';
export const CROP_REPORT_KPIS_ID = 'crop-report-kpis';

export const CROP_REPORT_FILTER_FIELD = Object.freeze({
  FROM: 'crop-report-from',
  TO: 'crop-report-to',
  CUSTOMER: 'crop-report-customer',
  VARIETY: 'crop-report-variety',
  STATUS: 'crop-report-status',
  SEARCH: 'crop-report-search'
});

export const CROP_REPORT_MODE_TABS = Object.freeze([
  Object.freeze({ id: CROP_REPORT_MODE.SUMMARY, label: 'العرض الإجمالي' }),
  Object.freeze({ id: CROP_REPORT_MODE.DETAILS, label: 'العرض التفصيلي' })
]);

export const CROP_REPORT_GROUP_TABS = Object.freeze([
  Object.freeze({ id: CROP_REPORT_GROUPING.BY_FARMER, label: 'حسب المزارع' }),
  Object.freeze({ id: CROP_REPORT_GROUPING.BY_VARIETY, label: 'حسب صنف الفراولة' })
]);

export const CROP_REPORT_LABELS = Object.freeze({
  apply: 'تطبيق الفلاتر',
  reset: 'مسح الفلاتر',
  details: 'تفاصيل الحركات',
  back: 'العودة إلى التجميع',
  empty: 'لا توجد مشتريات محصول محلي مطابقة للفلاتر الحالية.',
  noData: 'لا توجد مشتريات محصول محلي مسجلة بعد.',
  loadError: 'تعذّر تحميل تقرير مشتريات المحصول المحلي.',
  any: 'الكل',
  packageUnit: 'عبوة',
  weightUnit: 'كجم صافي',
  weightUnresolved: UNRESOLVED_WEIGHT_LABEL,
  weightStored: 'مخزن تاريخيًا',
  weightDerived: 'مشتق من المكونات التاريخية'
});

export const CROP_REPORT_SUMMARY_COLUMNS = Object.freeze({
  byFarmer: Object.freeze([
    { label: 'المزارع' }, { label: 'الكود' }, { label: 'عدد الحركات' },
    { label: 'عدد المزارعين' }, { label: 'عدد العبوات' }, { label: 'الوزن الصافي' },
    { label: 'حركات وزنها غير محسوم' }, { label: 'متوسط سعر الكيلو' }, { label: 'القيمة الإجمالية' }, { label: 'تفاصيل' }
  ]),
  byVariety: Object.freeze([
    { label: 'صنف الفراولة' }, { label: 'عدد الحركات' }, { label: 'عدد المزارعين' },
    { label: 'عدد العبوات' }, { label: 'الوزن الصافي' }, { label: 'حركات وزنها غير محسوم' },
    { label: 'متوسط سعر الكيلو' }, { label: 'القيمة الإجمالية' }, { label: 'تفاصيل' }
  ])
});

export const CROP_REPORT_DETAIL_COLUMNS = Object.freeze([
  { label: 'التاريخ' }, { label: 'المزارع' }, { label: 'الكود' }, { label: 'عدد العبوات' },
  { label: 'وزن العبوة' }, { label: 'الكيلو السائب' }, { label: 'خصم الكيلو' },
  { label: 'الوزن الصافي' }, { label: 'الصنف' }, { label: 'سعر الكيلو' },
  { label: 'القيمة' }, { label: 'البيان' }, { label: 'الحالة' }
]);

// ---- formatting helpers (text only, no arithmetic) -------------------------
export function packageLabel(packageCountMilli) {
  if (!Number.isInteger(packageCountMilli)) return 'عدد غير محدد';
  const packages = packageCountMilli / 1000;
  if (packages === 1) return 'عبوة واحدة';
  if (packages === 2) return 'عبوتان';
  if (Number.isInteger(packages) && packages >= 3 && packages <= 10) return `${formatQuantityTrimmed(packageCountMilli)} عبوات`;
  return `${formatQuantityTrimmed(packageCountMilli)} ${CROP_REPORT_LABELS.packageUnit}`;
}

export function weightLabel(netWeightMilli, resolved, source = null) {
  if (!resolved || !Number.isInteger(netWeightMilli)) return CROP_REPORT_LABELS.weightUnresolved;
  const value = `${formatQuantityTrimmed(netWeightMilli)} ${CROP_REPORT_LABELS.weightUnit}`;
  if (!source) return value;
  const sourceLabel = source === 'StoredNetWeight'
    ? CROP_REPORT_LABELS.weightStored
    : source === 'DerivedFromStoredComponents'
      ? CROP_REPORT_LABELS.weightDerived
      : 'مصدر الوزن غير محدد';
  return `${value} <span class="badge" title="مصدر قيمة الوزن">${escapeHtml(sourceLabel)}</span>`;
}

export function amountLabel(amountMinor) {
  return Number.isInteger(amountMinor) ? formatMoneyMinor(amountMinor) : '—';
}

function kgLabel(milli) {
  return Number.isInteger(milli) ? formatQuantityTrimmed(milli) : '—';
}

function referenceCell(name, isActive, id) {
  const text = formatText(name);
  if (text === '' || (id && isActive === null)) {
    return `<span class="text-sm text-muted">${escapeHtml(UNAVAILABLE_REFERENCE_LABEL)}</span>`;
  }
  const inactive = isActive === false ? ' <span class="badge">غير نشط</span>' : '';
  return `${escapeHtml(text)}${inactive}`;
}

function varietyCell(row) {
  if (!row.HasVariety) return `<span class="text-sm text-muted">${escapeHtml(NO_VARIETY_LABEL)}</span>`;
  return referenceCell(row.VarietyName, row.VarietyActive, row.VarietyId);
}

function statusBadge(row) {
  if (row.IsActive) return `<span class="badge badge--status-active">${escapeHtml(CROP_REPORT_STATUS_LABELS_AR.Active)}</span>`;
  const reason = row.CancellationReason ? ` — ${escapeHtml(row.CancellationReason)}` : '';
  return `<span class="badge badge--cancelled" title="${escapeHtml(row.CancellationReason || '')}">${escapeHtml(CROP_REPORT_STATUS_LABELS_AR.Cancelled)}</span>${reason}`;
}

// ---- summary ---------------------------------------------------------------
function reportKpiCard(item) {
  return `<div class="card card--flat dash-kpi report-kpi"><div class="card__body dash-kpi__body"><span class="kpi__label">${escapeHtml(item.label)}</span><strong class="kpi__value">${escapeHtml(item.value)}</strong>${item.hint ? `<span class="dash-kpi__hint">${escapeHtml(item.hint)}</span>` : ''}</div></div>`;
}

export function cropReportKpisHtml(report) {
  if (!report) return '';
  const totals = report.Totals;
  const items = [
    { label: 'عدد الحركات المحتسبة', value: formatCount(totals.MovementCount), hint: 'الحركات الملغاة لا تُحتسب' },
    { label: 'عدد المزارعين', value: formatCount(totals.FarmerCount), hint: null },
    { label: 'إجمالي عدد العبوات', value: `${formatQuantityTrimmed(totals.PackageCountMilli)} ${CROP_REPORT_LABELS.packageUnit}`, hint: 'عدد العبوات ليس وزنًا' },
    { label: 'إجمالي الوزن الصافي الموثوق', value: `${formatQuantityTrimmed(totals.NetWeightMilli)} ${CROP_REPORT_LABELS.weightUnit}`, hint: 'من القيم المخزنة تاريخيًا' },
    { label: 'حركات وزنها غير محسوم', value: formatCount(totals.UnresolvedWeightCount), hint: 'مستبعدة من إجمالي الوزن' },
    { label: 'متوسط سعر الكيلو المرجح', value: Number.isInteger(totals.AverageUnitPriceMinor) ? `${formatMoneyMinor(totals.AverageUnitPriceMinor)} ج` : '—', hint: 'مرجح بالوزن الصافي المحسوم فقط' },
    { label: 'إجمالي قيمة المشتريات', value: `${formatMoneyMinor(totals.AmountMinor)} ج`, hint: 'من قيمة الحركة المخزنة' }
  ];
  return `<div class="dash-kpis report-kpis" id="${escapeHtml(CROP_REPORT_KPIS_ID)}" role="region" aria-label="إجماليات مشتريات المحصول المحلي" aria-live="polite">${items.map(reportKpiCard).join('')}</div>`;
}

export function cropReportSummaryLineHtml(report) {
  if (!report) return '';
  const totals = report.Totals;
  const sentences = [
    `عدد الحركات المحتسبة: ${formatCount(totals.MovementCount)}`,
    `عدد المزارعين: ${formatCount(totals.FarmerCount)}`,
    `عدد العبوات: ${formatQuantityTrimmed(totals.PackageCountMilli)} ${CROP_REPORT_LABELS.packageUnit}`,
    `الوزن الصافي الموثوق: ${formatQuantityTrimmed(totals.NetWeightMilli)} ${CROP_REPORT_LABELS.weightUnit}`,
    `متوسط سعر الكيلو المرجح: ${Number.isInteger(totals.AverageUnitPriceMinor) ? formatMoneyMinor(totals.AverageUnitPriceMinor) : 'غير متاح'}`,
    `إجمالي القيمة: ${formatMoneyMinor(totals.AmountMinor)}`
  ];
  if (totals.UnresolvedWeightCount > 0) sentences.push(`حركات وزنها غير محسوم: ${formatCount(totals.UnresolvedWeightCount)}`);
  if (totals.PackageCountMissingCount > 0) sentences.push(`حركات بلا عدد عبوات مسجل: ${formatCount(totals.PackageCountMissingCount)}`);
  if (totals.CancelledCount > 0) sentences.push(`حركات ملغاة غير محتسبة: ${formatCount(totals.CancelledCount)}`);
  return `<p class="toolbar__count" role="status" aria-live="polite" id="crop-report-totals-line">${escapeHtml(sentences.join(' · '))}</p>`;
}

export function periodLine(filters) {
  const from = formatText(filters.from);
  const to = formatText(filters.to);
  if (!from && !to) return 'كل الفترات';
  if (from && to) return `من ${from} إلى ${to}`;
  if (from) return `من ${from} وما بعده`;
  return `حتى ${to}`;
}

// ---- shell -----------------------------------------------------------------
function option(value, label, selected = false) {
  return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

export function cropReportViewHtml() {
  const modeTabs = CROP_REPORT_MODE_TABS
    .map((tab) => `<button class="btn btn--outline" type="button" role="tab" aria-selected="false" data-crop-action="mode" data-crop-mode="${escapeHtml(tab.id)}">${escapeHtml(tab.label)}</button>`)
    .join('');
  const groupTabs = CROP_REPORT_GROUP_TABS
    .map((tab) => `<button class="btn btn--outline" type="button" role="tab" aria-selected="false" data-crop-action="grouping" data-crop-grouping="${escapeHtml(tab.id)}">${escapeHtml(tab.label)}</button>`)
    .join('');
  const statusOptions = CROP_REPORT_STATUS_OPTIONS
    .map((entry) => option(entry.value, entry.label, entry.value === DEFAULT_CROP_REPORT_STATUS))
    .join('');
  return `<div id="${escapeHtml(CROP_REPORT_ROOT_ID)}" class="stack">
${pageHeader({
    title: 'تقارير مشتريات المحصول المحلي',
    description: 'العدد والوزن الصافي وسعر الكيلو وقيمة المشتريات؛ متوسط السعر مرجح بالوزن المحسوم فقط.'
  })}
  ${reportExportActionsHtml()}
  <div class="row" role="tablist" aria-label="طريقة العرض" id="${escapeHtml(CROP_REPORT_MODE_TABS_ID)}">${modeTabs}</div>
  <div class="row" role="tablist" aria-label="طريقة التجميع" id="${escapeHtml(CROP_REPORT_GROUP_TABS_ID)}">${groupTabs}</div>
  <div class="page-section" id="${escapeHtml(CROP_REPORT_FILTERS_ID)}">
    <div class="toolbar">
      <div class="field"><label class="field__label" for="${escapeHtml(CROP_REPORT_FILTER_FIELD.FROM)}">من تاريخ</label><input class="input" type="date" id="${escapeHtml(CROP_REPORT_FILTER_FIELD.FROM)}"></div>
      <div class="field"><label class="field__label" for="${escapeHtml(CROP_REPORT_FILTER_FIELD.TO)}">إلى تاريخ</label><input class="input" type="date" id="${escapeHtml(CROP_REPORT_FILTER_FIELD.TO)}"></div>
      <div class="field"><label class="field__label" for="${escapeHtml(CROP_REPORT_FILTER_FIELD.CUSTOMER)}">المزارع</label><select class="select" id="${escapeHtml(CROP_REPORT_FILTER_FIELD.CUSTOMER)}">${option('', CROP_REPORT_LABELS.any, true)}</select></div>
      <div class="field"><label class="field__label" for="${escapeHtml(CROP_REPORT_FILTER_FIELD.VARIETY)}">صنف الفراولة</label><select class="select" id="${escapeHtml(CROP_REPORT_FILTER_FIELD.VARIETY)}">${option('', CROP_REPORT_LABELS.any, true)}${option(NO_VARIETY_KEY, NO_VARIETY_LABEL)}</select></div>
      <div class="field"><label class="field__label" for="${escapeHtml(CROP_REPORT_FILTER_FIELD.STATUS)}">حالة الحركة</label><select class="select" id="${escapeHtml(CROP_REPORT_FILTER_FIELD.STATUS)}">${statusOptions}</select></div>
      <div class="field"><label class="field__label" for="${escapeHtml(CROP_REPORT_FILTER_FIELD.SEARCH)}">بحث</label><input class="input" type="search" id="${escapeHtml(CROP_REPORT_FILTER_FIELD.SEARCH)}" placeholder="اسم المزارع أو الكود أو البيان"></div>
    </div>
    <div class="row" style="margin-block-start: var(--space-3)">
      <button class="btn btn--primary" type="button" data-crop-action="apply">${escapeHtml(CROP_REPORT_LABELS.apply)}</button>
      <button class="btn btn--outline" type="button" data-crop-action="reset">${escapeHtml(CROP_REPORT_LABELS.reset)}</button>
    </div>
    <div id="${escapeHtml(CROP_REPORT_FILTER_ERROR_ID)}"></div>
  </div>
  <div id="${escapeHtml(CROP_REPORT_CONTEXT_ID)}"></div>
  <div id="${escapeHtml(CROP_REPORT_SUMMARY_ID)}"></div>
  <div id="${escapeHtml(CROP_REPORT_RESULTS_ID)}">${loadingState({ message: 'جارٍ تحميل التقرير…' })}</div>
</div>`;
}

// ---- rows ------------------------------------------------------------------
export function cropGroupRowsHtml(report) {
  const columns = CROP_REPORT_SUMMARY_COLUMNS[report.Grouping];
  const rows = report.Groups.map((group, index) => {
    const cells = [];
    if (report.Grouping === CROP_REPORT_GROUPING.BY_VARIETY) {
      cells.push(group.HasVariety
        ? referenceCell(group.VarietyName, group.VarietyActive, group.VarietyId)
        : `<span class="text-sm text-muted">${escapeHtml(NO_VARIETY_LABEL)}</span>`);
    } else {
      cells.push(referenceCell(group.CustomerName, group.CustomerActive, group.CustomerId));
      cells.push(group.CustomerCode ? escapeHtml(group.CustomerCode) : '—');
    }
    cells.push(escapeHtml(formatCount(group.MovementCount)));
    cells.push(escapeHtml(formatCount(group.FarmerCount)));
    cells.push(escapeHtml(`${formatQuantityTrimmed(group.PackageCountMilli)} ${CROP_REPORT_LABELS.packageUnit}`));
    cells.push(escapeHtml(weightLabel(group.NetWeightMilli, group.WeightResolvedCount > 0 || group.UnresolvedWeightCount === 0)));
    cells.push(escapeHtml(formatCount(group.UnresolvedWeightCount)));
    cells.push(escapeHtml(Number.isInteger(group.AverageUnitPriceMinor) ? `${formatMoneyMinor(group.AverageUnitPriceMinor)} ج` : '—'));
    cells.push(escapeHtml(amountLabel(group.AmountMinor)));
    cells.push(`<button class="btn btn--outline btn--small" type="button" data-crop-action="drill" data-crop-group="${index}">${escapeHtml(CROP_REPORT_LABELS.details)}</button>`);
    return { cells };
  });
  return table({
    columns,
    numeric: true,
    rows,
    caption: `${report.GroupingTitle} — ${periodLine(report.Filters)}`,
    emptyMessage: CROP_REPORT_LABELS.empty
  });
}

export function cropDetailRowsHtml(report) {
  return table({
    columns: CROP_REPORT_DETAIL_COLUMNS,
    numeric: true,
    rows: report.DisplayRows.map((row) => ({
      className: row.IsActive ? null : 'ledger-row--cancelled',
      cells: [
        escapeHtml(row.Date),
        referenceCell(row.CustomerName, row.CustomerActive, row.CustomerId),
        row.CustomerCode ? escapeHtml(row.CustomerCode) : '—',
        escapeHtml(packageLabel(row.PackageCountMilli)),
        escapeHtml(Number.isFinite(row.PackageWeightKg) ? `${formatQuantityTrimmed(Math.round(row.PackageWeightKg * 1000))} كجم` : (row.WeightResolved ? '—' : UNRESOLVED_WEIGHT_LABEL)),
        escapeHtml(`${kgLabel(row.LooseKgMilli)} كجم`),
        escapeHtml(`${kgLabel(row.DeductionKgMilli)} كجم`),
        weightLabel(row.NetWeightMilli, row.WeightResolved, row.WeightSource),
        varietyCell(row),
        escapeHtml(row.UnitPriceMinor === null ? '—' : formatMoneyMinor(row.UnitPriceMinor)),
        escapeHtml(amountLabel(row.AmountMinor)),
        row.Description ? escapeHtml(row.Description) : '—',
        statusBadge(row)
      ]
    })),
    emptyMessage: CROP_REPORT_LABELS.empty
  });
}

// ---- behaviour -------------------------------------------------------------
export function initCropReportView({ container, autoLoad = false } = {}) {
  if (!container) return null;
  const find = (selector) => container.querySelector(selector);
  bindReportExportActions({ container, root: find(`#${CROP_REPORT_ROOT_ID}`), filename: () => `local-crop-${state.mode}-${state.grouping}` });
  const state = {
    mode: CROP_REPORT_MODE.SUMMARY,
    grouping: DEFAULT_CROP_REPORT_GROUPING,
    // `applied` is what the user entered; a drill-down is an EXTRA constraint on top of it,
    // never a replacement, so returning restores exactly the previous report.
    applied: cropReportService.normalizeFilters({}),
    drill: null,
    report: null,
    options: { customers: [], varieties: [], statuses: [], noVariety: null },
    error: null,
    filterError: null,
    loading: false,
    hasLoadedOnce: false
  };

  function effectiveFilters() {
    if (!state.drill) return { ...state.applied };
    const merged = { ...state.applied };
    if (state.drill.kind === CROP_REPORT_GROUPING.BY_FARMER) merged.customerId = state.drill.key;
    else merged.varietyId = state.drill.key;
    return merged;
  }

  function renderModeTabs() {
    const box = find(`#${CROP_REPORT_MODE_TABS_ID}`);
    if (!box) return;
    for (const button of box.querySelectorAll('[data-crop-mode]')) {
      const isActive = button.getAttribute('data-crop-mode') === state.mode;
      button.className = isActive ? 'btn btn--primary' : 'btn btn--outline';
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  }

  function renderGroupTabs() {
    const box = find(`#${CROP_REPORT_GROUP_TABS_ID}`);
    if (!box) return;
    box.hidden = state.mode !== CROP_REPORT_MODE.SUMMARY;
    for (const button of box.querySelectorAll('[data-crop-grouping]')) {
      const isActive = button.getAttribute('data-crop-grouping') === state.grouping;
      button.className = isActive ? 'btn btn--primary' : 'btn btn--outline';
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  }

  function renderContext() {
    const box = find(`#${CROP_REPORT_CONTEXT_ID}`);
    if (!box) return;
    if (!state.drill) { box.innerHTML = ''; return; }
    const label = state.drill.label || (state.drill.key === NO_VARIETY_KEY ? NO_VARIETY_LABEL : state.drill.key);
    const subject = state.drill.kind === CROP_REPORT_GROUPING.BY_FARMER ? 'المزارع' : 'صنف الفراولة';
    box.innerHTML = `<div class="ledger-note" role="status" id="crop-report-drill-note">
  <span>تصفية إضافية: ${escapeHtml(subject)} — <strong>${escapeHtml(label)}</strong> · بقية الفلاتر محفوظة كما هي.</span>
  <button class="btn btn--outline btn--small" type="button" data-crop-action="back">${escapeHtml(CROP_REPORT_LABELS.back)}</button>
</div>`;
  }

  function renderFilterError() {
    const box = find(`#${CROP_REPORT_FILTER_ERROR_ID}`);
    if (!box) return;
    box.innerHTML = state.filterError
      ? alert({ tone: 'danger', title: 'فلاتر غير صالحة', message: state.filterError })
      : '';
  }

  function renderResults() {
    const summaryBox = find(`#${CROP_REPORT_SUMMARY_ID}`);
    const resultsBox = find(`#${CROP_REPORT_RESULTS_ID}`);
    if (summaryBox) {
      summaryBox.innerHTML = state.report
        ? cropReportKpisHtml(state.report)
        : '';
    }
    if (!resultsBox) return;
    if (state.loading) { resultsBox.innerHTML = loadingState({ message: 'جارٍ احتساب التقرير…' }); return; }
    if (state.error) { resultsBox.innerHTML = errorState({ title: CROP_REPORT_LABELS.loadError, message: state.error }); return; }
    if (!state.report) {
      resultsBox.innerHTML = emptyState({ title: 'لم يُحمَّل تقرير بعد', message: 'اختر طريقة العرض ثم اضغط تطبيق الفلاتر.' });
      return;
    }
    if (state.mode === CROP_REPORT_MODE.DETAILS) {
      if (!state.report.DisplayRows.length) {
        resultsBox.innerHTML = card({ title: 'تفاصيل حركات مشتريات المحصول المحلي', body: emptyState({ title: CROP_REPORT_LABELS.empty, message: periodLine(state.report.Filters) }) });
        return;
      }
      resultsBox.innerHTML = card({ title: 'تفاصيل حركات مشتريات المحصول المحلي', body: cropDetailRowsHtml(state.report) });
      return;
    }
    if (!state.report.Groups.length) {
      resultsBox.innerHTML = card({ title: state.report.GroupingTitle, body: emptyState({ title: CROP_REPORT_LABELS.empty, message: periodLine(state.report.Filters) }) });
      return;
    }
    resultsBox.innerHTML = card({ title: state.report.GroupingTitle, body: cropGroupRowsHtml(state.report) });
  }

  function setBusy(busy) {
    state.loading = busy;
    for (const button of container.querySelectorAll('[data-crop-action]')) button.disabled = busy;
  }

  async function run() {
    if (state.loading) return;
    state.error = null;
    setBusy(true);
    renderResults();
    try {
      state.report = await cropReportService.buildReport({
        grouping: state.grouping,
        mode: state.mode,
        filters: effectiveFilters()
      });
      state.hasLoadedOnce = true;
    } catch (error) {
      state.report = null;
      state.error = (error && error.message) ? error.message : CROP_REPORT_LABELS.loadError;
    } finally {
      setBusy(false);
      renderModeTabs();
      renderGroupTabs();
      renderContext();
      renderResults();
    }
  }

  function selectOptionsHtml(options, selected) {
    const items = options.map((entry) => {
      const isSelected = entry.value === selected ? ' selected' : '';
      const suffix = entry.IsActive === false ? ' (غير نشط)' : '';
      return `<option value="${escapeHtml(entry.value)}"${isSelected}>${escapeHtml(entry.label + suffix)}</option>`;
    }).join('');
    return `<option value=""${selected ? '' : ' selected'}>${escapeHtml(CROP_REPORT_LABELS.any)}</option>${items}`;
  }

  function renderOptions() {
    const customerBox = find(`#${CROP_REPORT_FILTER_FIELD.CUSTOMER}`);
    const varietyBox = find(`#${CROP_REPORT_FILTER_FIELD.VARIETY}`);
    if (customerBox) customerBox.innerHTML = selectOptionsHtml(state.options.customers, state.applied.customerId || '');
    if (varietyBox) {
      const selected = state.applied.varietyId || '';
      // «بدون صنف» is a real filter value, so it is listed next to the catalogue rather
      // than being treated as a missing choice.
      const anySelected = selected === '';
      const catalogue = state.options.varieties.map((entry) => {
        const isSelected = entry.value === selected ? ' selected' : '';
        const suffix = entry.IsActive === false ? ' (غير نشط)' : '';
        return `<option value="${escapeHtml(entry.value)}"${isSelected}>${escapeHtml(entry.label + suffix)}</option>`;
      }).join('');
      varietyBox.innerHTML = `<option value=""${anySelected ? ' selected' : ''}>${escapeHtml(CROP_REPORT_LABELS.any)}</option>`
        + `<option value="${escapeHtml(NO_VARIETY_KEY)}"${selected === NO_VARIETY_KEY ? ' selected' : ''}>${escapeHtml(NO_VARIETY_LABEL)}</option>`
        + catalogue;
    }
  }

  function readFiltersFromForm() {
    const value = (id) => {
      const element = find(`#${id}`);
      return element ? formatText(element.value) : '';
    };
    const statusBox = find(`#${CROP_REPORT_FILTER_FIELD.STATUS}`);
    return {
      from: value(CROP_REPORT_FILTER_FIELD.FROM),
      to: value(CROP_REPORT_FILTER_FIELD.TO),
      customerId: value(CROP_REPORT_FILTER_FIELD.CUSTOMER),
      varietyId: value(CROP_REPORT_FILTER_FIELD.VARIETY),
      status: statusBox ? formatText(statusBox.value) || DEFAULT_CROP_REPORT_STATUS : DEFAULT_CROP_REPORT_STATUS,
      search: value(CROP_REPORT_FILTER_FIELD.SEARCH)
    };
  }

  async function apply() {
    const next = readFiltersFromForm();
    state.filterError = null;
    try {
      state.applied = cropReportService.normalizeFilters(next);
      // An explicit filter change ends the previous drill-down: the new report is the one
      // the user asked for, not the old group with a new filter hidden inside it.
      state.drill = null;
      state.mode = CROP_REPORT_MODE.SUMMARY;
    } catch (error) {
      state.filterError = (error && error.message) ? error.message : 'فلاتر غير صالحة.';
      renderFilterError();
      return;
    }
    renderFilterError();
    await run();
  }

  async function reset() {
    for (const id of [CROP_REPORT_FILTER_FIELD.FROM, CROP_REPORT_FILTER_FIELD.TO, CROP_REPORT_FILTER_FIELD.SEARCH]) {
      const element = find(`#${id}`);
      if (element) element.value = '';
    }
    const statusBox = find(`#${CROP_REPORT_FILTER_FIELD.STATUS}`);
    if (statusBox) statusBox.value = DEFAULT_CROP_REPORT_STATUS;
    state.filterError = null;
    state.drill = null;
    state.applied = cropReportService.normalizeFilters({});
    renderOptions();
    renderFilterError();
    await run();
  }

  async function drill(index) {
    if (!state.report || state.mode !== CROP_REPORT_MODE.SUMMARY) return;
    const group = state.report.Groups[index];
    if (!group) return;
    const kind = state.report.Grouping;
    const key = kind === CROP_REPORT_GROUPING.BY_FARMER ? group.CustomerId : (group.VarietyId || NO_VARIETY_KEY);
    if (!key) return;
    const label = kind === CROP_REPORT_GROUPING.BY_FARMER ? group.CustomerName : group.Label;
    state.drill = { kind, key, label };
    state.mode = CROP_REPORT_MODE.DETAILS;
    await run();
  }

  async function back() {
    if (!state.drill) return;
    state.drill = null;
    state.mode = CROP_REPORT_MODE.SUMMARY;
    await run();
  }

  async function setMode(mode) {
    if (!CROP_REPORT_MODES.includes(mode) || mode === state.mode) return;
    state.mode = mode;
    await run();
  }

  async function setGrouping(grouping) {
    if (!CROP_REPORT_GROUPINGS.includes(grouping) || grouping === state.grouping) return;
    state.grouping = grouping;
    if (state.mode !== CROP_REPORT_MODE.SUMMARY) state.mode = CROP_REPORT_MODE.SUMMARY;
    await run();
  }

  container.addEventListener('click', (event) => {
    const trigger = event.target && event.target.closest ? event.target.closest('[data-crop-action]') : null;
    if (!trigger) return;
    const action = trigger.getAttribute('data-crop-action');
    if (action === 'mode') { setMode(trigger.getAttribute('data-crop-mode')); return; }
    if (action === 'grouping') { setGrouping(trigger.getAttribute('data-crop-grouping')); return; }
    if (action === 'apply') { apply(); return; }
    if (action === 'reset') { reset(); return; }
    if (action === 'drill') { drill(Number(trigger.getAttribute('data-crop-group'))); return; }
    if (action === 'back') { back(); }
  });

  async function loadOptions() {
    try {
      state.options = await cropReportService.listFilterOptions();
      renderOptions();
    } catch (error) {
      // A failed catalogue read must not hide the report: the dropdowns keep only «الكل»
      // and the results area reports the problem honestly.
      state.options = { customers: [], varieties: [], statuses: [], noVariety: null };
      state.error = (error && error.message) ? error.message : CROP_REPORT_LABELS.loadError;
      renderResults();
    }
  }

  renderModeTabs();
  renderGroupTabs();
  if (autoLoad) loadOptions().then(() => run());
  return {
    state,
    run,
    apply,
    reset,
    drill,
    back,
    setMode,
    setGrouping,
    load: () => loadOptions().then(() => run()),
    effectiveFilters
  };
}
