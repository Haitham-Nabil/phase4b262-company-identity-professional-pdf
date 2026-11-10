// Phase 4B.20 — separate read-only report per transaction type.
import { pageHeader, card, table, alert } from '../components/index.js';
import { loadingState, emptyState, errorState } from '../components/states.js';
import { escapeHtml } from '../components/html.js';
import { formatText, formatCount, formatMoneyMinor } from '../../src/utils/formatting.js';
import { reportExportActionsHtml, bindReportExportActions } from './reportExport.js';
import { generalReportService, GENERAL_REPORT_TYPES, GENERAL_REPORT_TYPE_LABELS_AR, GENERAL_REPORT_CASH_RECEIVED_TYPE, GENERAL_REPORT_CASH_PAID_TYPE } from '../../src/services/generalReportService.js';

export const GENERAL_REPORT_ROOT_ID = 'general-reports-root';
export const GENERAL_REPORT_TYPE_TABS_ID = 'general-report-type-tabs';
export const GENERAL_REPORT_FILTERS_ID = 'general-report-filters';
export const GENERAL_REPORT_RESULTS_ID = 'general-report-results';
export const GENERAL_REPORT_MODE_ID = 'general-report-mode';

const option = (value, label, selected = false) => `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;

export function generalReportViewHtml() {
  const tabs = GENERAL_REPORT_TYPES.map((type, index) => `<button class="btn ${index === 0 ? 'btn--primary' : 'btn--outline'}" type="button" role="tab" aria-selected="${index === 0 ? 'true' : 'false'}" data-general-type="${escapeHtml(type)}">${escapeHtml(GENERAL_REPORT_TYPE_LABELS_AR[type])}</button>`).join('');
  return `<section id="${GENERAL_REPORT_ROOT_ID}" class="stack">
    ${pageHeader({ title: 'تقارير الحركات العامة', description: 'تقرير مستقل لكل نوع حركة، مع التجميع حسب العميل والعرض التفصيلي للحركات.' })}
    <div class="row" role="tablist" aria-label="نوع الحركة" id="${GENERAL_REPORT_TYPE_TABS_ID}">${tabs}</div>
    <div class="page-section" id="${GENERAL_REPORT_FILTERS_ID}"><div class="toolbar">
      <div class="field"><label class="field__label" for="general-report-from">من تاريخ</label><input class="input" type="date" id="general-report-from"></div>
      <div class="field"><label class="field__label" for="general-report-to">إلى تاريخ</label><input class="input" type="date" id="general-report-to"></div>
      <div class="field"><label class="field__label" for="general-report-customer">العميل</label><select class="select" id="general-report-customer">${option('', 'كل العملاء', true)}</select></div>
      <div class="field"><label class="field__label" for="general-report-status">حالة الحركة</label><select class="select" id="general-report-status">${option('active', 'النشطة فقط', true)}${option('cancelled', 'الملغاة فقط')}${option('all', 'الكل')}</select></div>
    </div><div class="row" style="margin-block-start:var(--space-3)"><button class="btn btn--primary" type="button" data-general-action="apply">تطبيق الفلاتر</button><button class="btn btn--outline" type="button" data-general-action="reset">مسح الفلاتر</button></div><div id="general-report-error"></div></div>
    ${reportExportActionsHtml()}
    <div class="row" id="${GENERAL_REPORT_MODE_ID}" role="group" aria-label="طريقة عرض التقرير"><button class="btn btn--primary" type="button" data-general-mode="summary" aria-pressed="true">العرض الإجمالي</button><button class="btn btn--outline" type="button" data-general-mode="details" aria-pressed="false">العرض التفصيلي</button></div>
    <div id="general-report-summary"></div><div id="${GENERAL_REPORT_RESULTS_ID}">${loadingState({ message: 'جارٍ تحميل التقرير…' })}</div>
  </section>`;
}

function period(filters) {
  if (filters.from && filters.to) return `من ${filters.from} إلى ${filters.to}`;
  if (filters.from) return `من ${filters.from} وما بعده`;
  if (filters.to) return `حتى ${filters.to}`;
  return 'كل الفترات';
}

function movementAmount(row) {
  if (row.TransactionType === GENERAL_REPORT_CASH_RECEIVED_TYPE) return Number.isInteger(row.CashReceivedMinor) ? row.CashReceivedMinor : null;
  if (row.TransactionType === GENERAL_REPORT_CASH_PAID_TYPE) return Number.isInteger(row.CashPaidMinor) ? row.CashPaidMinor : null;
  return Number.isInteger(row.AmountMinor) ? row.AmountMinor : null;
}

function movementRows(rows) {
  return table({
    columns: [{ label: 'التاريخ' }, { label: 'العميل' }, { label: 'الطرف الآخر' }, { label: 'المبلغ' }, { label: 'الاتجاه' }, { label: 'البيان' }, { label: 'الحالة' }, { label: 'سبب الإلغاء' }],
    rows: rows.map((row) => ({ cells: [
      escapeHtml(formatText(row.Date) || '—'),
      escapeHtml(formatText(row.CustomerName) || 'مرجع غير متاح'),
      escapeHtml(formatText(row.CounterpartyName) || '—'),
      escapeHtml(formatMoneyMinor(movementAmount(row))),
      escapeHtml(formatText(row.DirectionLabel) || (row.IsLinkedOperation ? 'تحويل بين عميلين' : '—')),
      escapeHtml(formatText(row.Description) || '—'),
      row.IsCancelled ? '<span class="badge badge--cancelled">ملغاة</span>' : '<span class="badge badge--status-active">نشطة</span>',
      escapeHtml(formatText(row.CancellationReason) || '—')
    ] })),
    numeric: true,
    emptyMessage: 'لا توجد حركات مطابقة للفلاتر.'
  });
}

export function initGeneralReportView({ container, autoLoad = true } = {}) {
  if (!container) return null;
  const find = (selector) => container.querySelector(selector);
  bindReportExportActions({ container, root: find(`#${GENERAL_REPORT_ROOT_ID}`), filename: () => `general-${state.type}-${state.mode}` });
  const state = { type: GENERAL_REPORT_TYPES[0], mode: 'summary', filters: { from: '', to: '', customerId: '', status: 'active' }, report: null, loading: false, error: null, customerOptions: [] };
  const read = () => ({ from: find('#general-report-from')?.value || '', to: find('#general-report-to')?.value || '', customerId: find('#general-report-customer')?.value || '', status: find('#general-report-status')?.value || 'active' });
  function renderTabs() { for (const button of container.querySelectorAll('[data-general-type]')) { const active = button.dataset.generalType === state.type; button.className = active ? 'btn btn--primary' : 'btn btn--outline'; button.setAttribute('aria-selected', String(active)); } }
  function renderMode() { for (const button of container.querySelectorAll('[data-general-mode]')) { const active = button.dataset.generalMode === state.mode; button.className = active ? 'btn btn--primary' : 'btn btn--outline'; button.setAttribute('aria-pressed', String(active)); } }
  function render() {
    const summary = find('#general-report-summary'); const results = find(`#${GENERAL_REPORT_RESULTS_ID}`);
    if (!results) return;
    if (state.loading) { results.innerHTML = loadingState({ message: 'جارٍ احتساب التقرير…' }); return; }
    if (state.error) { results.innerHTML = errorState({ title: 'تعذّر تحميل التقرير', message: state.error }); return; }
    if (!state.report) { results.innerHTML = emptyState({ title: 'لم يُحمّل التقرير بعد', message: 'اختر الفلاتر واضغط تطبيق الفلاتر.' }); return; }
    const t = state.report.Totals;
    summary.innerHTML = card({ title: state.report.Title, body: `<p class="toolbar__count">الحركات المحتسبة: ${formatCount(t.MovementCount)} · إجمالي القيمة: ${formatMoneyMinor(t.AmountMinor)} · عدد العملاء: ${formatCount(t.GroupCount)} · الحركات الملغاة المستبعدة: ${formatCount(t.CancelledCount)}</p>${t.MissingAmountCount ? `<p class="text-sm text-muted">حركات بلا مبلغ صالح: ${formatCount(t.MissingAmountCount)}</p>` : ''}<p class="text-sm text-muted">${escapeHtml(period(state.report.Filters))} — الإجماليات تحتسب الحركات النشطة فقط.</p>` });
    if (state.mode === 'details') { results.innerHTML = card({ title: `${state.report.Title} — العرض التفصيلي`, body: movementRows(state.report.Rows) }); return; }
    if (!state.report.Groups.length) { results.innerHTML = emptyState({ title: 'لا توجد حركات نشطة مطابقة.', message: period(state.report.Filters) }); return; }
    results.innerHTML = card({ title: `${state.report.Title} — التجميع حسب العميل`, body: table({ columns: [{ label: 'العميل' }, { label: 'الكود' }, { label: 'عدد الحركات' }, { label: 'إجمالي القيمة' }, { label: 'التفاصيل' }], rows: state.report.Groups.map((group, index) => ({ cells: [escapeHtml(group.CustomerName || 'مرجع غير متاح'), escapeHtml(group.CustomerCode || '—'), formatCount(group.MovementCount), formatMoneyMinor(group.AmountMinor), `<button class="btn btn--outline" type="button" data-general-details="${index}">عرض الحركات</button>`] })), numeric: true }) });
  }
  async function run() { if (state.loading) return; state.loading = true; state.error = null; render(); try { state.report = await generalReportService.buildReport({ type: state.type, filters: state.filters }); } catch (error) { state.report = null; state.error = error?.message || 'تعذّر تحميل التقرير.'; } finally { state.loading = false; render(); renderTabs(); renderMode(); } }
  async function apply() { try { state.filters = generalReportService.normalizeFilters(read()); const err = find('#general-report-error'); if (err) err.innerHTML = ''; await run(); } catch (error) { const err = find('#general-report-error'); if (err) err.innerHTML = alert({ tone: 'danger', title: 'فلاتر غير صالحة', message: error.message }); } }
  async function reset() { for (const id of ['#general-report-from', '#general-report-to']) { const el = find(id); if (el) el.value = ''; } const customer = find('#general-report-customer'); if (customer) customer.value = ''; const status = find('#general-report-status'); if (status) status.value = 'active'; state.filters = generalReportService.normalizeFilters({}); await run(); }
  container.addEventListener('click', (event) => {
    const typeButton = event.target.closest?.('[data-general-type]'); if (typeButton) { state.type = typeButton.dataset.generalType; state.filters = generalReportService.normalizeFilters(read()); renderTabs(); run(); return; }
    const modeButton = event.target.closest?.('[data-general-mode]'); if (modeButton) { state.mode = modeButton.dataset.generalMode; renderMode(); render(); return; }
    if (event.target.closest?.('[data-general-action="apply"]')) { apply(); return; }
    if (event.target.closest?.('[data-general-action="reset"]')) { reset(); return; }
    const detailButton = event.target.closest?.('[data-general-details]'); if (detailButton && state.report) { const group = state.report.Groups[Number(detailButton.dataset.generalDetails)]; if (group) { state.mode = 'details'; renderMode(); const results = find(`#${GENERAL_REPORT_RESULTS_ID}`); results.innerHTML = card({ title: `${state.report.Title} — ${group.CustomerName || 'العميل'}`, body: movementRows(group.Rows) }); } }
  });
  async function loadCustomers() {
    try {
      const customers = await generalReportService.listCustomers();
      const select = find('#general-report-customer');
      if (select) select.innerHTML = option('', 'كل العملاء', true) + customers.filter((c) => c.IsActive).sort((a,b) => String(a.label).localeCompare(String(b.label), 'ar')).map((c) => option(c.value, c.label)).join('');
    } catch (error) { state.error = error?.message || 'تعذّر تحميل قائمة العملاء.'; render(); }
  }
  renderTabs(); renderMode();
  if (autoLoad) loadCustomers().then(run);
  return { state, run, apply, reset, load: () => loadCustomers().then(run) };
}
