// Phase 4B.21 — customer and account reports. Presentation only: all monetary
// figures, period balances and row classifications come from customerReportService.
import { pageHeader, card, table, alert } from '../components/index.js';
import { loadingState, emptyState, errorState } from '../components/states.js';
import { escapeHtml } from '../components/html.js';
import { formatMoneyMinor, formatCount, formatText } from '../../src/utils/formatting.js';
import { reportExportActionsHtml, bindReportExportActions } from './reportExport.js';
import { customerReportService, CUSTOMER_REPORT_MODE, CUSTOMER_REPORT_STATUS, CUSTOMER_REPORT_TYPE_LABELS_AR } from '../../src/services/customerReportService.js';
import { authService } from '../../src/services/authService.js';

export const CUSTOMER_REPORT_ROOT_ID = 'customer-reports-root';
export const CUSTOMER_REPORT_RESULTS_ID = 'customer-report-results';
const MODES = [
  [CUSTOMER_REPORT_MODE.STATEMENT, 'كشف حساب عميل'],
  [CUSTOMER_REPORT_MODE.CONSOLIDATED, 'كشف مجمع لجميع العملاء'],
  [CUSTOMER_REPORT_MODE.BALANCES, 'أرصدة العملاء'],
  [CUSTOMER_REPORT_MODE.ACTIVITY, 'حركة العملاء']
];
const option = (value, label, selected = false) => `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
const periodLabel = (f) => f.from && f.to ? `من ${f.from} إلى ${f.to}` : f.from ? `من ${f.from} وما بعده` : f.to ? `حتى ${f.to}` : 'كل الفترات';

export function customerReportViewHtml() {
  return `<section id="${CUSTOMER_REPORT_ROOT_ID}" class="stack">
    ${pageHeader({ title: 'تقارير العملاء والحسابات', description: 'كشف حساب كامل أو خلال فترة، وأرصدة العملاء وحركة الحسابات مع تفاصيل كل حركة.' })}
    ${reportExportActionsHtml()}
    <div class="row" role="tablist" aria-label="نوع تقرير العملاء" id="customer-report-modes">${MODES.map(([id, label], i) => `<button class="btn ${i === 0 ? 'btn--primary' : 'btn--outline'}" type="button" role="tab" data-customer-report-mode="${id}" aria-selected="${i === 0}">${label}</button>`).join('')}</div>
    <div class="page-section"><div class="toolbar">
      <div class="field"><label class="field__label" for="customer-report-customer">العميل</label><select class="select" id="customer-report-customer">${option('', 'كل العملاء', true)}</select></div>
      <div class="field" id="customer-report-from-field"><label class="field__label" for="customer-report-from">من تاريخ</label><input class="input" type="date" id="customer-report-from"></div>
      <div class="field"><label class="field__label" for="customer-report-to">إلى تاريخ / حتى تاريخ الرصيد</label><input class="input" type="date" id="customer-report-to"></div>
      <div class="field"><label class="field__label" for="customer-report-status">حالة الحركات المعروضة</label><select class="select" id="customer-report-status">${option('active', 'النشطة فقط', true)}${option('cancelled', 'الملغاة فقط')}${option('all', 'النشطة والملغاة')}</select></div>
    </div><div class="row" style="margin-block-start:var(--space-3)"><button class="btn btn--primary" type="button" data-customer-report-action="apply">تطبيق الفلاتر</button><button class="btn btn--outline" type="button" data-customer-report-action="reset">مسح الفلاتر</button></div><div id="customer-report-filter-error"></div></div>
    <div class="row" id="customer-report-view-mode" role="group" aria-label="طريقة عرض التقرير"><button class="btn btn--primary" type="button" data-customer-report-view="summary" aria-pressed="true">العرض الإجمالي</button><button class="btn btn--outline" type="button" data-customer-report-view="details" aria-pressed="false">العرض التفصيلي</button></div>
    <div id="customer-report-summary"></div><div id="${CUSTOMER_REPORT_RESULTS_ID}">${loadingState({ message: 'جارٍ تحميل تقارير العملاء…' })}</div>
  </section>`;
}

function movementExtra(row) {
  const parts = [];
  if (row.CounterpartyName) parts.push(`الطرف المقابل: ${row.CounterpartyName}`);
  if (Array.isArray(row.ReferenceParts)) parts.push(...row.ReferenceParts);
  return parts.join(' · ');
}

function statementRows(statement, includeCustomer = false) {
  return table({
    columns: [...(includeCustomer ? [{ label: 'العميل' }] : []), { label: 'التاريخ' }, { label: 'نوع الحركة' }, { label: 'البيان' }, { label: 'تفاصيل إضافية' }, { label: 'مدين' }, { label: 'دائن' }, { label: 'نقدية واردة' }, { label: 'نقدية منصرفة' }, { label: 'قيمة غير نقدية' }, { label: 'الرصيد بعد الحركة' }, { label: 'الحالة' }, { label: 'سبب الإلغاء' }],
    numeric: true,
    rows: statement.Rows.map((row) => ({
      className: row.IsCancelled ? 'ledger-row--cancelled' : null,
      cells: [
        ...(includeCustomer ? [escapeHtml(`${statement.Customer.Name || 'عميل بدون اسم'} (${statement.Customer.Code || '—'})`)] : []),
        escapeHtml(formatText(row.Date) || '—'),
        escapeHtml(CUSTOMER_REPORT_TYPE_LABELS_AR[row.TransactionType] || row.TransactionType || '—'),
        escapeHtml(formatText(row.Description) || '—'),
        escapeHtml(movementExtra(row) || '—'),
        formatMoneyMinor(row.DebitMinor),
        formatMoneyMinor(row.CreditMinor),
        formatMoneyMinor(row.CashReceivedMinor),
        formatMoneyMinor(row.CashPaidMinor),
        formatMoneyMinor(row.SettlementMinor),
        formatMoneyMinor(row.RunningBalanceMinor),
        row.IsCancelled ? '<span class="badge badge--cancelled">ملغاة</span>' : '<span class="badge badge--status-active">نشطة</span>',
        escapeHtml(formatText(row.CancellationReason) || '—')
      ]
    })),
    emptyMessage: 'لا توجد حركات مطابقة للفلاتر الحالية.'
  });
}

function customerStatementPrintBlock(statement) {
  const customer = statement.Customer || {};
  const classification = (row) => Number(row.DebitMinor || 0) > 0 ? 'مدين' : (Number(row.CreditMinor || 0) > 0 ? 'دائن' : 'غير نقدي');
  const rows = statement.Rows.map((row) => ({
    className: row.IsCancelled ? 'ledger-row--cancelled' : null,
    cells: [
      escapeHtml(row.Date || '—'),
      escapeHtml(row.TransactionCode || row.TransactionNumber || row.Id || '—'),
      escapeHtml(CUSTOMER_REPORT_TYPE_LABELS_AR[row.TransactionType] || row.TransactionType || '—'),
      escapeHtml(classification(row)),
      escapeHtml(row.CounterpartyName || '—'),
      escapeHtml([formatText(row.Description), movementExtra(row)].filter(Boolean).join(' · ') || '—'),
      formatMoneyMinor(row.DebitMinor), formatMoneyMinor(row.CreditMinor), formatMoneyMinor(row.RunningBalanceMinor)
    ]
  }));
  const movementTable = table({ columns: [{ label: 'التاريخ' }, { label: 'رقم / معرّف الحركة' }, { label: 'نوع الحركة' }, { label: 'التصنيف' }, { label: 'الطرف' }, { label: 'البيان والتفاصيل' }, { label: 'مدين' }, { label: 'دائن' }, { label: 'الرصيد' }], numeric: true, rows, emptyMessage: 'لا توجد حركات خلال الفترة المحددة.' });
  const period = periodLabel(statement.Filters || {});
  const user = authService.current()?.DisplayName || authService.current()?.Username || '—';
  return `<section class="customer-statement-print-only" dir="rtl">
    <div class="statement-print-heading"><div><h2>كشف حساب عميل</h2><p>${escapeHtml(customer.Name || 'عميل بدون اسم')} — كود: ${escapeHtml(customer.Code || '—')}</p><p>الفترة: ${escapeHtml(period)}</p></div><div class="statement-print-status">${customer.IsActive ? 'عميل نشط' : 'عميل غير نشط'}</div></div>
    <div class="statement-print-kpis"><div><span>الرصيد السابق</span><strong>${formatMoneyMinor(statement.OpeningBalanceMinor)}</strong></div><div><span>إجمالي المدين</span><strong>${formatMoneyMinor(statement.TotalDebitMinor)}</strong></div><div><span>إجمالي الدائن</span><strong>${formatMoneyMinor(statement.TotalCreditMinor)}</strong></div><div><span>صافي الحركة</span><strong>${formatMoneyMinor(statement.NetChangeMinor)}</strong></div><div><span>الرصيد الختامي</span><strong>${formatMoneyMinor(statement.ClosingBalanceMinor)}</strong></div></div>
    <div class="statement-print-table">${movementTable}</div>
    <div class="statement-print-footer"><span>إعداد التقرير: ${escapeHtml(user)}</span><span>الحركات المحتسبة: ${formatCount(statement.MovementCount)} — الملغاة: ${formatCount(statement.CancelledCount)}</span></div>
  </section>`;
}

function statementSummary(statement) {
  return `<div class="grid grid--cols-2 page-section">${card({ title: 'الرصيد الافتتاحي للفترة', body: `<strong>${formatMoneyMinor(statement.OpeningBalanceMinor)}</strong>` })}${card({ title: 'إجمالي المدين', body: `<strong>${formatMoneyMinor(statement.TotalDebitMinor)}</strong>` })}${card({ title: 'إجمالي الدائن', body: `<strong>${formatMoneyMinor(statement.TotalCreditMinor)}</strong>` })}${card({ title: 'الرصيد الختامي', body: `<strong>${formatMoneyMinor(statement.ClosingBalanceMinor)}</strong>` })}</div><p class="text-sm text-muted">${escapeHtml(periodLabel(statement.Filters))} · الحركات المحتسبة: ${formatCount(statement.MovementCount)} · الحركات الملغاة المستبعدة: ${formatCount(statement.CancelledCount)}</p>`;
}

export function initCustomerReportView({ container, autoLoad = true } = {}) {
  if (!container) return null;
  const find = (selector) => container.querySelector(selector);
  bindReportExportActions({ container, root: find(`#${CUSTOMER_REPORT_ROOT_ID}`), filename: () => `customer-account-${state.mode}-${state.view}`, getFallbackSections: () => {
    const report = state.report;
    if (!report || report.Statement || state.view !== 'summary' || state.mode !== CUSTOMER_REPORT_MODE.CONSOLIDATED) return [];
    return [{ title: report.Title, headers: ['العميل', 'الرصيد الافتتاحي', 'إجمالي المدين', 'إجمالي الدائن', 'الرصيد الختامي', 'عدد الحركات'], rows: report.Customers.map((row) => [row.Customer.Name || 'عميل بدون اسم', formatMoneyMinor(row.OpeningBalanceMinor), formatMoneyMinor(row.TotalDebitMinor), formatMoneyMinor(row.TotalCreditMinor), formatMoneyMinor(row.ClosingBalanceMinor), row.MovementCount]) }];
  } });
  const state = { mode: CUSTOMER_REPORT_MODE.STATEMENT, view: 'summary', filters: { from: '', to: '', customerId: '', status: CUSTOMER_REPORT_STATUS.ACTIVE }, report: null, options: [], loading: false, error: null };
  const read = () => ({ from: find('#customer-report-from')?.value || '', to: find('#customer-report-to')?.value || '', customerId: find('#customer-report-customer')?.value || '', status: find('#customer-report-status')?.value || 'active' });
  function renderModes() { for (const button of container.querySelectorAll('[data-customer-report-mode]')) { const active = button.dataset.customerReportMode === state.mode; button.className = active ? 'btn btn--primary' : 'btn btn--outline'; button.setAttribute('aria-selected', String(active)); } }
  function renderFilterControls() { const fromField = find('#customer-report-from-field'); if (fromField) fromField.hidden = state.mode === CUSTOMER_REPORT_MODE.BALANCES; }
  function renderView() { for (const button of container.querySelectorAll('[data-customer-report-view]')) { const active = button.dataset.customerReportView === state.view; button.className = active ? 'btn btn--primary' : 'btn btn--outline'; button.setAttribute('aria-pressed', String(active)); } }
  function renderSummary() {
    const box = find('#customer-report-summary'); if (!box || !state.report) { if (box) box.innerHTML = ''; return; }
    if (state.report.Statement) { box.innerHTML = card({ title: `${state.report.Statement.Customer.Name || 'العميل'} — ملخص كشف الحساب`, body: statementSummary(state.report.Statement) }); return; }
    const t = state.report.Totals;
    const range = state.mode === CUSTOMER_REPORT_MODE.BALANCES ? (state.report.Filters.to ? `حتى ${state.report.Filters.to}` : 'حتى آخر حركة مسجلة') : periodLabel(state.report.Filters);
    box.innerHTML = card({ title: state.report.Title, body: `<p class="toolbar__count">عدد العملاء: ${formatCount(state.report.Customers.length)} · قيود الحسابات النشطة: ${formatCount(t.MovementCount)} · إجمالي المدين: ${formatMoneyMinor(t.TotalDebitMinor)} · إجمالي الدائن: ${formatMoneyMinor(t.TotalCreditMinor)}</p><p class="text-sm text-muted">${escapeHtml(range)} · الحركات الملغاة المعروضة لا تدخل في الإجماليات.</p>${state.mode === CUSTOMER_REPORT_MODE.CONSOLIDATED ? '<p class="text-sm text-muted">تحويل المديونية يظهر في كشف كل طرف لأنه يؤثر على رصيد حسابه؛ لذلك يظهر كقيدين مرتبطين عند تجميع حسابات العملاء، وليس كعمليتي تحويل مستقلتين.</p>' : ''}` });
  }
  function customerTable(customers) {
    return table({ columns: [{ label: 'العميل' }, { label: 'الرصيد الافتتاحي' }, { label: 'إجمالي المدين' }, { label: 'إجمالي الدائن' }, { label: 'الرصيد الختامي' }, { label: 'عدد الحركات' }, { label: 'كشف الحساب' }], numeric: true, rows: customers.map((row, index) => ({ cells: [escapeHtml(`${row.Customer.Name || 'عميل بدون اسم'} (${row.Customer.Code || '—'})`), formatMoneyMinor(row.OpeningBalanceMinor), formatMoneyMinor(row.TotalDebitMinor), formatMoneyMinor(row.TotalCreditMinor), formatMoneyMinor(row.ClosingBalanceMinor), formatCount(row.MovementCount), `<button class="btn btn--outline" type="button" data-customer-report-open="${index}">فتح الكشف</button>`] })) , emptyMessage: 'لا توجد حسابات مطابقة.' });
  }

  function consolidatedSections(customers) {
    if (!customers.length) return emptyState({ title: 'لا توجد حسابات مطابقة.', message: periodLabel(state.report.Filters) });
    return customers.map((row, index) => card({
      title: `${row.Customer.Name || 'عميل بدون اسم'} — ${row.Customer.Code || 'بدون كود'}`,
      body: `<div class="grid grid--cols-2">${card({ title: 'الرصيد الافتتاحي', body: `<strong>${formatMoneyMinor(row.OpeningBalanceMinor)}</strong>` })}${card({ title: 'إجمالي المدين', body: `<strong>${formatMoneyMinor(row.TotalDebitMinor)}</strong>` })}${card({ title: 'إجمالي الدائن', body: `<strong>${formatMoneyMinor(row.TotalCreditMinor)}</strong>` })}${card({ title: 'الرصيد الختامي', body: `<strong>${formatMoneyMinor(row.ClosingBalanceMinor)}</strong>` })}</div><p class="text-sm text-muted">الحركات النشطة: ${formatCount(row.MovementCount)} · الملغاة: ${formatCount(row.CancelledCount)}</p><button class="btn btn--outline" type="button" data-customer-report-open="${index}">فتح كشف الحساب التفصيلي</button>`
    })).join('');
  }
  function activityTable(customers) {
    return table({ columns: [{ label: 'العميل' }, { label: 'عدد الحركات' }, { label: 'إجمالي المدين' }, { label: 'إجمالي الدائن' }, { label: 'صافي التغير' }, { label: 'التفاصيل' }], numeric: true, rows: customers.map((row, index) => ({ cells: [escapeHtml(`${row.Customer.Name || 'عميل بدون اسم'} (${row.Customer.Code || '—'})`), formatCount(row.MovementCount), formatMoneyMinor(row.TotalDebitMinor), formatMoneyMinor(row.TotalCreditMinor), formatMoneyMinor(row.NetChangeMinor), `<button class="btn btn--outline" type="button" data-customer-report-open="${index}">عرض الحركات</button>`] })), emptyMessage: 'لا توجد حركات مطابقة.' });
  }
  function render() {
    renderSummary();
    const results = find(`#${CUSTOMER_REPORT_RESULTS_ID}`); if (!results) return;
    if (state.loading) { results.innerHTML = loadingState({ message: 'جارٍ احتساب التقرير…' }); return; }
    if (state.error) { results.innerHTML = errorState({ title: 'تعذّر تحميل التقرير', message: state.error }); return; }
    if (!state.report) { results.innerHTML = emptyState({ title: 'لم يُحمّل التقرير بعد', message: 'اختر نوع التقرير والفلاتر ثم اضغط تطبيق الفلاتر.' }); return; }
    if (state.report.Statement) {
      const statement = state.report.Statement;
      if (state.view === 'details') { results.innerHTML = `${card({ title: `${state.report.Title} — العرض التفصيلي`, body: statementRows(statement) })}${customerStatementPrintBlock(statement)}`; return; }
      const byType = table({ columns: [{ label: 'نوع الحركة' }, { label: 'عدد الحركات' }, { label: 'إجمالي المدين' }, { label: 'إجمالي الدائن' }], numeric: true, rows: statement.TypeGroups.map((group) => ({ cells: [escapeHtml(CUSTOMER_REPORT_TYPE_LABELS_AR[group.TransactionType] || group.TransactionType), formatCount(group.MovementCount), formatMoneyMinor(group.TotalDebitMinor), formatMoneyMinor(group.TotalCreditMinor)] })), emptyMessage: 'لا توجد حركات نشطة في الفترة.' });
      results.innerHTML = `${card({ title: `${state.report.Title} — ملخص حسب نوع الحركة`, body: byType })}${customerStatementPrintBlock(statement)}`; return;
    }
    const customers = state.report.Customers;
    if (state.view === 'details') {
      const allRows = customers.flatMap((row) => row.Rows.map((entry) => ({ ...entry, __customer: row.Customer })));
      const detailRows = table({ columns: [{ label: 'العميل' }, { label: 'التاريخ' }, { label: 'نوع الحركة' }, { label: 'البيان' }, { label: 'تفاصيل إضافية' }, { label: 'مدين' }, { label: 'دائن' }, { label: 'نقدية واردة' }, { label: 'نقدية منصرفة' }, { label: 'قيمة غير نقدية' }, { label: 'الرصيد بعد الحركة' }, { label: 'الحالة' }, { label: 'سبب الإلغاء' }], numeric: true, rows: allRows.map((row) => ({ className: row.IsCancelled ? 'ledger-row--cancelled' : null, cells: [escapeHtml(`${row.__customer.Name || 'عميل بدون اسم'} (${row.__customer.Code || '—'})`), escapeHtml(row.Date || '—'), escapeHtml(CUSTOMER_REPORT_TYPE_LABELS_AR[row.TransactionType] || row.TransactionType || '—'), escapeHtml(row.Description || '—'), escapeHtml(movementExtra(row) || '—'), formatMoneyMinor(row.DebitMinor), formatMoneyMinor(row.CreditMinor), formatMoneyMinor(row.CashReceivedMinor), formatMoneyMinor(row.CashPaidMinor), formatMoneyMinor(row.SettlementMinor), formatMoneyMinor(row.RunningBalanceMinor), row.IsCancelled ? '<span class="badge badge--cancelled">ملغاة</span>' : '<span class="badge badge--status-active">نشطة</span>', escapeHtml(row.CancellationReason || '—')] })), emptyMessage: 'لا توجد حركات مطابقة.' });
      results.innerHTML = card({ title: `${state.report.Title} — العرض التفصيلي`, body: detailRows }); return;
    }
    if (state.mode === CUSTOMER_REPORT_MODE.ACTIVITY) { results.innerHTML = card({ title: 'تحليل حركة العملاء', body: activityTable(customers) }); return; }
    if (state.mode === CUSTOMER_REPORT_MODE.CONSOLIDATED) { results.innerHTML = `<div class="stack">${consolidatedSections(customers)}</div>`; return; }
    results.innerHTML = card({ title: 'أرصدة العملاء', body: customerTable(customers) });
  }
  async function run() {
    if (state.loading) return;
    state.loading = true; state.error = null; state.report = null; render();
    try { state.report = await customerReportService.buildReport({ mode: state.mode, filters: state.filters }); }
    catch (error) { state.report = null; state.error = error?.message || 'تعذّر تحميل التقرير.'; }
    finally { state.loading = false; render(); renderModes(); renderView(); renderFilterControls(); }
  }
  function showFilterError(error) { const box = find('#customer-report-filter-error'); if (box) box.innerHTML = alert({ tone: 'danger', title: 'فلاتر غير صالحة', message: error?.message || 'تعذّر تطبيق الفلاتر.' }); }
  async function apply() { try { state.filters = customerReportService.normalizeFilters(read()); const box = find('#customer-report-filter-error'); if (box) box.innerHTML = ''; await run(); } catch (error) { showFilterError(error); } }
  async function reset() { for (const id of ['#customer-report-from', '#customer-report-to']) { const el = find(id); if (el) el.value = ''; } const c = find('#customer-report-customer'); if (c) c.value = ''; const s = find('#customer-report-status'); if (s) s.value = 'active'; state.filters = customerReportService.normalizeFilters({}); const box = find('#customer-report-filter-error'); if (box) box.innerHTML = ''; await run(); }
  async function loadCustomers() {
    state.options = await customerReportService.listCustomers();
    const select = find('#customer-report-customer');
    if (select) select.innerHTML = option('', 'كل العملاء', true) + state.options.map((row) => option(row.value, `${row.label}${row.IsActive ? '' : ' (غير نشط)'}`)).join('');
  }
  container.addEventListener('click', (event) => {
    const mode = event.target.closest?.('[data-customer-report-mode]');
    if (mode) { state.mode = mode.dataset.customerReportMode; renderModes(); renderFilterControls(); run(); return; }
    const view = event.target.closest?.('[data-customer-report-view]');
    if (view) { state.view = view.dataset.customerReportView; renderView(); render(); return; }
    if (event.target.closest?.('[data-customer-report-action="apply"]')) { apply(); return; }
    if (event.target.closest?.('[data-customer-report-action="reset"]')) { reset(); return; }
    const open = event.target.closest?.('[data-customer-report-open]');
    if (open && state.report?.Customers) {
      const row = state.report.Customers[Number(open.dataset.customerReportOpen)];
      if (row) { state.mode = CUSTOMER_REPORT_MODE.STATEMENT; state.filters = { ...state.filters, customerId: row.Customer.Id }; const select = find('#customer-report-customer'); if (select) select.value = row.Customer.Id; state.view = 'summary'; renderModes(); renderView(); run(); }
    }
  });
  renderModes(); renderView(); renderFilterControls();
  if (autoLoad) loadCustomers().then(() => { if (state.mode === CUSTOMER_REPORT_MODE.STATEMENT) { state.mode = CUSTOMER_REPORT_MODE.CONSOLIDATED; renderModes(); renderFilterControls(); } return run(); }).catch((error) => { state.error = error?.message || 'تعذّر تحميل قائمة العملاء.'; render(); });
  return { state, run, apply, reset, load: () => loadCustomers().then(run) };
}
