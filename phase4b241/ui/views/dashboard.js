// Phase 4B.16 — the Dashboard screen (#/dashboard).
//
// Display only. Every number this module prints was produced by `dashboardService`
// (which itself reuses balanceService and the Phase 4B.15 ledger). This module owns NO
// balance rule, NO cash rule, NO date rule and NO aggregation: it formats strings and
// lays them out. That is why it can be tested by handing it a fixture read model.
//
// It reaches the data layer only through the services barrel, like every other screen:
// no repository, no storage module, no direct database access of any kind.
import { pageHeader, card, badge, button } from '../components/index.js';
import { loadingState, emptyState, errorState } from '../components/states.js';
import { escapeHtml } from '../components/html.js';
import { formatMoneyMinor, formatCount, formatQuantityTrimmed, formatText } from '../../src/utils/formatting.js';
import {
  dashboardService,
  DASHBOARD_PERIOD_OPTIONS,
  DASHBOARD_SCOPE,
  DASHBOARD_SCOPE_LABELS_AR
} from '../../src/services/dashboardService.js';
import { customerAccountPath } from '../routes.js';
import { buildHash } from '../router.js';

export const DASHBOARD_ROOT_ID = 'dashboard-root';
export const DASHBOARD_PERIOD_FIELD_ID = 'dashboard-period';
export const DASHBOARD_PERIOD_LABEL_ID = 'dashboard-period-label';
export const DASHBOARD_KPI_ID = 'dashboard-kpis';
export const DASHBOARD_ALERTS_ID = 'dashboard-alerts';
export const DASHBOARD_CHART_ID = 'dashboard-chart';
export const DASHBOARD_PERIOD_SUMMARY_ID = 'dashboard-period-summary';
export const DASHBOARD_LATEST_ID = 'dashboard-latest';
export const DASHBOARD_CROP_ID = 'dashboard-crop';
export const DASHBOARD_SCOPE_NOTE_ID = 'dashboard-scope-note';

export const DASHBOARD_TITLE = 'لوحة التحكم';
export const DASHBOARD_DESCRIPTION = 'نظرة سريعة على أرصدة العملاء والحركة المالية ومشتريات المحصول. كل رقم مقروء من البيانات المسجّلة.';
export const DASHBOARD_SCOPE_NOTE = 'الأرصدة وأعداد العملاء تُقرأ كما هي الآن ولا تتأثر بالفترة. الإجماليات والرسوم والمشتريات محسوبة على الحركات الواقعة داخل الفترة المحددة.';
export const DASHBOARD_LOAD_ERROR = 'تعذّر تحميل لوحة التحكم.';
export const DASHBOARD_NO_DATA = 'لا توجد حركات مسجّلة بعد.';
export const DASHBOARD_PERIOD_EMPTY = 'لا توجد حركات خلال الفترة المحددة.';
export const DASHBOARD_CHART_EMPTY = 'لا توجد تدفقات نقدية خلال الفترة المحددة لعرضها على الرسم.';
export const DASHBOARD_CHART_TITLE = 'تطور التدفق النقدي';
export const DASHBOARD_CHART_NOTE = 'التحصيل النقدي والمدفوعات النقدية فقط. التسويات وتبادل البضائع وتحويل المديونية غير نقدية ولا تظهر كتدفق نقدي.';
export const DASHBOARD_LATEST_TITLE = 'أحدث الحركات';
export const DASHBOARD_LATEST_LINK = 'فتح سجل الحركات';
export const DASHBOARD_UNRESOLVED_WEIGHT = 'الوزن غير محسوم';
export const DASHBOARD_EMPTY_CELL = '—';

export const DASHBOARD_KPI_LABEL = Object.freeze({
  DEBIT: 'إجمالي أرصدة العملاء المدينة',
  CREDIT: 'إجمالي أرصدة العملاء الدائنة',
  NET: 'صافي أرصدة العملاء',
  ACTIVE_CUSTOMERS: 'عدد العملاء النشطين',
  SALES: 'إجمالي المبيعات',
  CASH_IN: 'إجمالي التحصيلات النقدية',
  CASH_OUT: 'إجمالي المدفوعات النقدية',
  LOCAL_CROP: 'إجمالي مشتريات المحصول المحلي',
  CARTON: 'إجمالي مشتريات الكرتون'
});

export const DASHBOARD_KPI_HINT = Object.freeze({
  DEBIT: 'مجموع أرصدة العملاء السالبة (مدينون لنا) — رصيد حالي',
  CREDIT: 'مجموع أرصدة العملاء الموجبة (دائنون لنا) — رصيد حالي',
  NET: 'الدائن مطروحًا منه المدين — ليس مجموع المدين ولا الدائن',
  ACTIVE_CUSTOMERS: 'من إجمالي العملاء المسجّلين — عدد حالي',
  SALES: 'بيع المبيدات وبيع شبكات الري خلال الفترة',
  CASH_IN: 'استلام نقدية فقط — بلا تسويات ولا تبادل بضائع',
  CASH_OUT: 'دفعة نقدية فقط',
  LOCAL_CROP: 'قيمة مشتريات المحصول المحلي من الحركات المخزّنة',
  CARTON: 'قيمة مشتريات الكرتون من الحركات المخزّنة'
});

function moneyOrDash(minor) {
  return Number.isInteger(minor) ? formatMoneyMinor(minor) : DASHBOARD_EMPTY_CELL;
}

function quantityOrDash(minor) {
  return Number.isInteger(minor) ? formatQuantityTrimmed(minor) : DASHBOARD_EMPTY_CELL;
}

function countOrDash(value) {
  return Number.isFinite(value) ? formatCount(value) : DASHBOARD_EMPTY_CELL;
}

export function periodOptionsHtml(selected) {
  return DASHBOARD_PERIOD_OPTIONS
    .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('');
}

function scopeBadge(scope) {
  const label = DASHBOARD_SCOPE_LABELS_AR[scope] ?? scope;
  const kind = scope === DASHBOARD_SCOPE.PERIOD_TOTAL ? 'cash' : 'status-active';
  return badge(label, kind);
}

function kpiCard({ label, value, hint, scope, id, tone = null }) {
  const valueClass = tone === 'negative' ? 'kpi__value amount--negative'
    : tone === 'positive' ? 'kpi__value amount--positive'
      : 'kpi__value';
  return `<div class="card card--flat dash-kpi"${id ? ` id="${escapeHtml(id)}"` : ''}>
  <div class="card__body dash-kpi__body">
    <span class="kpi__label">${escapeHtml(label)}</span>
    <span class="${valueClass}" data-kpi-value>${escapeHtml(value)}</span>
    <div class="dash-kpi__meta">${scopeBadge(scope)}</div>
    ${hint ? `<span class="dash-kpi__hint">${escapeHtml(hint)}</span>` : ''}
  </div>
</div>`;
}

export function kpisHtml(data) {
  const b = data.Balances;
  const t = data.Totals;
  const net = b.NetBalanceMinor;
  return [
    kpiCard({ id: 'kpi-debit', label: DASHBOARD_KPI_LABEL.DEBIT, value: moneyOrDash(b.DebitTotalMinor), hint: DASHBOARD_KPI_HINT.DEBIT, scope: DASHBOARD_SCOPE.CURRENT_BALANCE, tone: 'negative' }),
    kpiCard({ id: 'kpi-credit', label: DASHBOARD_KPI_LABEL.CREDIT, value: moneyOrDash(b.CreditTotalMinor), hint: DASHBOARD_KPI_HINT.CREDIT, scope: DASHBOARD_SCOPE.CURRENT_BALANCE, tone: 'positive' }),
    kpiCard({ id: 'kpi-net', label: DASHBOARD_KPI_LABEL.NET, value: moneyOrDash(net), hint: DASHBOARD_KPI_HINT.NET, scope: DASHBOARD_SCOPE.CURRENT_BALANCE, tone: net < 0 ? 'negative' : null }),
    kpiCard({ id: 'kpi-active-customers', label: DASHBOARD_KPI_LABEL.ACTIVE_CUSTOMERS, value: `${countOrDash(b.ActiveCustomerCount)} / ${countOrDash(b.CustomerCount)}`, hint: DASHBOARD_KPI_HINT.ACTIVE_CUSTOMERS, scope: DASHBOARD_SCOPE.CURRENT_COUNT }),
    kpiCard({ id: 'kpi-sales', label: DASHBOARD_KPI_LABEL.SALES, value: moneyOrDash(t.SalesMinor), hint: DASHBOARD_KPI_HINT.SALES, scope: DASHBOARD_SCOPE.PERIOD_TOTAL }),
    kpiCard({ id: 'kpi-cash-in', label: DASHBOARD_KPI_LABEL.CASH_IN, value: moneyOrDash(t.CashReceivedMinor), hint: DASHBOARD_KPI_HINT.CASH_IN, scope: DASHBOARD_SCOPE.PERIOD_TOTAL }),
    kpiCard({ id: 'kpi-cash-out', label: DASHBOARD_KPI_LABEL.CASH_OUT, value: moneyOrDash(t.CashPaidMinor), hint: DASHBOARD_KPI_HINT.CASH_OUT, scope: DASHBOARD_SCOPE.PERIOD_TOTAL }),
    kpiCard({ id: 'kpi-local-crop', label: DASHBOARD_KPI_LABEL.LOCAL_CROP, value: moneyOrDash(t.LocalCropMinor), hint: DASHBOARD_KPI_HINT.LOCAL_CROP, scope: DASHBOARD_SCOPE.PERIOD_TOTAL }),
    kpiCard({ id: 'kpi-carton', label: DASHBOARD_KPI_LABEL.CARTON, value: moneyOrDash(t.CartonMinor), hint: DASHBOARD_KPI_HINT.CARTON, scope: DASHBOARD_SCOPE.PERIOD_TOTAL })
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Chart — a plain inline SVG. No chart library is added to the project.
// ---------------------------------------------------------------------------
const CHART_WIDTH = 820;
const CHART_HEIGHT = 292;
const CHART_PAD = { top: 24, right: 20, bottom: 52, left: 78 };

function seriesMax(series) {
  let max = 0;
  for (const bucket of series.Buckets) {
    max = Math.max(max, bucket.CashInMinor, bucket.CashOutMinor);
  }
  return max;
}

/** Read-only grouped cash-flow chart. It visualizes only the two cash totals
 * already supplied by dashboardService; it does not derive a new balance. */
export function chartHtml(series) {
  if (!series || !series.HasCashFlow || seriesMax(series) === 0) {
    return `<div id="dashboard-chart-state">${emptyState({ title: 'لا توجد تدفقات نقدية', message: DASHBOARD_CHART_EMPTY, icon: '📈' })}</div>`;
  }
  const buckets = series.Buckets;
  const max = seriesMax(series);
  const plotWidth = CHART_WIDTH - CHART_PAD.left - CHART_PAD.right;
  const plotHeight = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;
  const slot = plotWidth / buckets.length;
  const barWidth = Math.max(4, Math.min(22, slot / 3.1));
  const baseY = CHART_PAD.top + plotHeight;
  const grid = Array.from({ length: 5 }, (_, i) => {
    const value = max * (4 - i) / 4;
    const y = CHART_PAD.top + (plotHeight * i / 4);
    return `<g class="dash-chart__grid"><line x1="${CHART_PAD.left}" y1="${y.toFixed(1)}" x2="${CHART_WIDTH - CHART_PAD.right}" y2="${y.toFixed(1)}"/><text x="${CHART_PAD.left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end">${escapeHtml(formatMoneyMinor(Math.round(value)))}</text></g>`;
  }).join('');
  const bars = buckets.map((bucket, index) => {
    const center = CHART_PAD.left + slot * index + slot / 2;
    const inHeight = Math.max(0, Math.round((bucket.CashInMinor / max) * plotHeight));
    const outHeight = Math.max(0, Math.round((bucket.CashOutMinor / max) * plotHeight));
    const xIn = center - barWidth - 2;
    const xOut = center + 2;
    return [
      `<rect class="dash-bar dash-bar--in" data-bar="in" data-bucket="${escapeHtml(bucket.Key)}" x="${xIn.toFixed(1)}" y="${(baseY - inHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${inHeight}" rx="${Math.min(6, barWidth / 2).toFixed(1)}"><title>${escapeHtml(`${bucket.Label} — تحصيل نقدي: ${formatMoneyMinor(bucket.CashInMinor)}`)}</title></rect>`,
      `<rect class="dash-bar dash-bar--out" data-bar="out" data-bucket="${escapeHtml(bucket.Key)}" x="${xOut.toFixed(1)}" y="${(baseY - outHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${outHeight}" rx="${Math.min(6, barWidth / 2).toFixed(1)}"><title>${escapeHtml(`${bucket.Label} — مدفوعات نقدية: ${formatMoneyMinor(bucket.CashOutMinor)}`)}</title></rect>`
    ].join('');
  }).join('');
  const labelStep = buckets.length > 18 ? Math.ceil(buckets.length / 9) : buckets.length > 10 ? 2 : 1;
  const labels = buckets.map((bucket, index) => {
    if (index % labelStep !== 0 && index !== buckets.length - 1) return '';
    const center = CHART_PAD.left + slot * index + slot / 2;
    return `<text class="dash-chart__tick" x="${center.toFixed(1)}" y="${CHART_HEIGHT - 18}" text-anchor="middle">${escapeHtml(bucket.Label)}</text>`;
  }).join('');
  return `<div class="dash-chart" id="dashboard-chart-state">
<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="${escapeHtml(DASHBOARD_CHART_TITLE)}" preserveAspectRatio="xMidYMid meet">
  <defs>
    <linearGradient id="dashCashInGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2b9bda"/><stop offset="100%" stop-color="#1767b1"/></linearGradient>
    <linearGradient id="dashCashOutGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f08b83"/><stop offset="100%" stop-color="#c7464f"/></linearGradient>
  </defs>
  ${grid}
  <line class="dash-chart__baseline" x1="${CHART_PAD.left}" y1="${baseY}" x2="${CHART_WIDTH - CHART_PAD.right}" y2="${baseY}"/>
  ${bars}
  ${labels}
</svg>
</div>
<div class="dash-legend" aria-label="مفتاح الرسم">
  <span class="dash-legend__item"><i class="dash-legend__swatch dash-legend__swatch--in"></i><span>التحصيل النقدي</span><strong>${escapeHtml(formatMoneyMinor(series.TotalCashInMinor))}</strong></span>
  <span class="dash-legend__item"><i class="dash-legend__swatch dash-legend__swatch--out"></i><span>المدفوعات النقدية</span><strong>${escapeHtml(formatMoneyMinor(series.TotalCashOutMinor))}</strong></span>
</div>`;
}

// ---------------------------------------------------------------------------
// Period summary — each category on its own line, never merged.
// ---------------------------------------------------------------------------
function summaryTableHtml(data) {
  const t = data.Totals;
  const rows = [
    ['المبيعات', moneyOrDash(t.SalesMinor), `${countOrDash(t.ByType.filter((x) => x.TransactionType === 'SalePesticides' || x.TransactionType === 'SaleIrrigation').reduce((sum, x) => sum + x.MovementCount, 0))} حركة`],
    ['المردودات', moneyOrDash(t.SalesReturnMinor), `${countOrDash(t.ByType.find((x) => x.TransactionType === 'SalesReturn')?.MovementCount ?? 0)} حركة`],
    ['التحصيل النقدي', moneyOrDash(t.CashReceivedMinor), `${countOrDash(t.ByType.find((x) => x.TransactionType === 'CashReceived')?.MovementCount ?? 0)} حركة`],
    ['المدفوعات النقدية', moneyOrDash(t.CashPaidMinor), `${countOrDash(t.ByType.find((x) => x.TransactionType === 'CashPaid')?.MovementCount ?? 0)} حركة`],
    ['التسويات (غير نقدية)', moneyOrDash(t.SettlementMinor), `${countOrDash(t.ByType.find((x) => x.TransactionType === 'Settlement')?.MovementCount ?? 0)} حركة`],
    ['تبادل البضائع (غير نقدي)', moneyOrDash(t.GoodsExchangeMinor), `${countOrDash(t.ByType.find((x) => x.TransactionType === 'GoodsExchange')?.MovementCount ?? 0)} حركة`],
    ['تحويل مديونية (غير نقدي)', moneyOrDash(t.DebtTransferMinor), `${countOrDash(t.DebtTransferCount)} عملية`]
  ];
  return `<div class="table-wrapper"><table class="table table--numeric" id="dashboard-period-table">
  <thead><tr><th scope="col">الفئة</th><th scope="col">الإجمالي</th><th scope="col">عدد الحركات</th></tr></thead>
  <tbody>${rows.map(([label, value, count]) => `<tr><td>${escapeHtml(label)}</td><td><span class="amount">${escapeHtml(value)}</span></td><td>${escapeHtml(count)}</td></tr>`).join('')}</tbody>
</table></div>`;
}

// ---------------------------------------------------------------------------
// Latest movements
// ---------------------------------------------------------------------------
export function latestRowsHtml(data) {
  if (!data.Latest.length) {
    return emptyState({
      title: data.DataState.HaveAnyTransaction ? 'لا توجد حركات في الفترة' : 'لا توجد حركات مسجّلة',
      message: data.DataState.HaveAnyTransaction ? DASHBOARD_PERIOD_EMPTY : DASHBOARD_NO_DATA,
      icon: '🧾'
    });
  }
  const rows = data.Latest.map((row) => {
    const customerCell = row.CustomerName
      ? `<a class="customer-link" href="${escapeHtml(buildHash(customerAccountPath(row.CustomerId)))}">${escapeHtml(formatText(row.CustomerName))}</a>`
      : `<span class="customer-name--missing">${escapeHtml('بلا اسم')}</span>`;
    const detail = row.IsLinkedOperation && row.CounterpartyName
      ? `مع ${escapeHtml(formatText(row.CounterpartyName))}`
      : (row.ReferenceParts && row.ReferenceParts.length ? escapeHtml(row.ReferenceParts.join(' · ')) : escapeHtml(formatText(row.Description) || DASHBOARD_EMPTY_CELL));
    const statusCell = row.IsCancelled
      ? badge('ملغاة', 'cancelled')
      : badge('نشطة', 'status-active');
    return {
      className: row.IsCancelled ? 'ledger-row--cancelled' : '',
      cells: [
        escapeHtml(row.Date),
        escapeHtml(row.TypeLabel),
        customerCell,
        detail,
        `<span class="amount">${escapeHtml(moneyOrDash(row.AmountMinor))}</span>`,
        statusCell
      ]
    };
  });
  const head = ['التاريخ', 'نوع الحركة', 'العميل', 'البيان', 'المبلغ', 'الحالة']
    .map((label) => `<th scope="col">${escapeHtml(label)}</th>`).join('');
  return `<div class="table-wrapper"><table class="table table--numeric" id="dashboard-latest-table">
  <thead><tr>${head}</tr></thead>
  <tbody>${rows.map((row) => `<tr${row.className ? ` class="${escapeHtml(row.className)}"` : ''}>${row.cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody>
</table></div>`;
}

// ---------------------------------------------------------------------------
// Crop indicators
// ---------------------------------------------------------------------------
function distributionHtml(entries, { labelHeader, quantityLabel, emptyMessage }) {
  if (!entries.length) {
    return `<p class="text-sm text-muted">${escapeHtml(emptyMessage)}</p>`;
  }
  const valueOf = (entry) => entry.CartonQuantityMilli ?? entry.PackageCountMilli ?? null;
  const values = entries.map(valueOf).filter(Number.isFinite);
  const max = Math.max(0, ...values);
  const visual = max > 0 ? `<div class="dash-distribution" role="img" aria-label="مقارنة ${escapeHtml(quantityLabel)} حسب ${escapeHtml(labelHeader)}">${entries.map((entry) => {
    const value = valueOf(entry);
    const width = Number.isFinite(value) && max > 0 ? Math.max(2, (value / max) * 100) : 0;
    return `<div class="dash-distribution__row"><div class="dash-distribution__top"><span>${escapeHtml(entry.Label)}</span><strong>${escapeHtml(quantityOrDash(value))}</strong></div><div class="dash-distribution__track"><span style="width:${width.toFixed(1)}%"></span></div></div>`;
  }).join('')}</div>` : '';
  const head = [labelHeader, 'عدد الحركات', quantityLabel].map((label) => `<th scope="col">${escapeHtml(label)}</th>`).join('');
  const body = entries.map((entry) => `<tr><td>${escapeHtml(entry.Label)}</td><td>${escapeHtml(countOrDash(entry.MovementCount))}</td><td><span class="amount">${escapeHtml(quantityOrDash(valueOf(entry)))}</span></td></tr>`).join('');
  return `${visual}<div class="table-wrapper"><table class="table table--numeric"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function cropHtml(data) {
  const local = data.Crop.Local;
  const carton = data.Crop.Carton;
  const localCard = `<section class="card" id="dashboard-crop-local">
  <header class="card__header"><h3 class="card__title">مشتريات المحصول المحلي — خلال الفترة</h3></header>
  <div class="card__body">
    <div class="dash-mini-kpis">
      <div class="dash-mini"><span class="kpi__label">عدد الحركات</span><span class="dash-mini__value" data-crop="local-count">${escapeHtml(countOrDash(local.MovementCount))}</span></div>
      <div class="dash-mini"><span class="kpi__label">إجمالي عدد العبوات</span><span class="dash-mini__value" data-crop="local-packages">${escapeHtml(quantityOrDash(local.PackageCountMilli))}</span></div>
      <div class="dash-mini"><span class="kpi__label">إجمالي الوزن الصافي</span><span class="dash-mini__value" data-crop="local-weight">${escapeHtml(quantityOrDash(local.NetWeightMilli))} كجم</span></div>
    </div>
    ${local.UnresolvedWeightCount > 0 ? `<p class="dash-caveat">${escapeHtml(`${countOrDash(local.UnresolvedWeightCount)} حركة بوزن صافٍ غير محسوم (حركة سابقة لحفظ وزن العبوة) — لم يُضف لها وزن ولم يُستخدم وزن العبوة الحالي.`)}</p>` : ''}
    ${local.PackageCountMissingCount > 0 ? `<p class="dash-caveat">${escapeHtml(`${countOrDash(local.PackageCountMissingCount)} حركة بلا عدد عبوات مسجّل.`)}</p>` : ''}
    <div class="dash-sub">${escapeHtml('توزيع الأصناف')}</div>
    ${distributionHtml(local.ByVariety, { labelHeader: 'الصنف', quantityLabel: 'عدد العبوات', emptyMessage: 'لا توجد حركات محصول محلي في الفترة.' })}
  </div>
</section>`;
  const cartonCard = `<section class="card" id="dashboard-crop-carton">
  <header class="card__header"><h3 class="card__title">مشتريات الكرتون — خلال الفترة</h3></header>
  <div class="card__body">
    <div class="dash-mini-kpis">
      <div class="dash-mini"><span class="kpi__label">عدد الحركات</span><span class="dash-mini__value" data-crop="carton-count">${escapeHtml(countOrDash(carton.MovementCount))}</span></div>
      <div class="dash-mini"><span class="kpi__label">إجمالي عدد الكراتين</span><span class="dash-mini__value" data-crop="carton-quantity">${escapeHtml(quantityOrDash(carton.CartonQuantityMilli))} كرتونة</span></div>
    </div>
    ${carton.MissingQuantityCount > 0 ? `<p class="dash-caveat">${escapeHtml(`${countOrDash(carton.MissingQuantityCount)} حركة بلا عدد كراتين مسجّل — لم يُحتسب لها عدد.`)}</p>` : ''}
    <div class="dash-sub">${escapeHtml('توزيع الشركات المستلمة')}</div>
    ${distributionHtml(carton.ByCompany, { labelHeader: 'الشركة المستلمة', quantityLabel: 'عدد الكراتين', emptyMessage: 'لا توجد حركات كرتون في الفترة.' })}
    <div class="dash-sub">${escapeHtml('توزيع أنواع الكراتين')}</div>
    ${distributionHtml(carton.ByCartonType, { labelHeader: 'نوع الكرتونة', quantityLabel: 'عدد الكراتين', emptyMessage: 'لا توجد حركات كرتون في الفترة.' })}
  </div>
</section>`;
  return `${localCard}\n${cartonCard}`;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
export function alertsHtml(data) {
  if (!data.Alerts.length) {
    return `<p class="text-sm text-muted">${escapeHtml('لا توجد تنبيهات تشغيلية حالية.')}</p>`;
  }
  return `<div class="dash-alerts">${data.Alerts.map((alert) => `<div class="dash-alert dash-alert--${escapeHtml(alert.Tone)}" data-alert="${escapeHtml(alert.Kind)}">
    <span class="dash-alert__count">${escapeHtml(countOrDash(alert.Count))}</span>
    <span class="dash-alert__label">${escapeHtml(alert.Label)}</span>
  </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// The screen shell
// ---------------------------------------------------------------------------
export function dashboardViewHtml() {
  return `<div id="${DASHBOARD_ROOT_ID}" class="stack">
  <section class="dash-welcome" aria-label="مقدمة لوحة التحكم">
    <div class="dash-welcome__copy">
      <span class="dash-welcome__eyebrow">مركز المتابعة</span>
      <h2>${escapeHtml(DASHBOARD_TITLE)}</h2>
      <p>${escapeHtml(DASHBOARD_DESCRIPTION)}</p>
    </div>
    <div class="dash-welcome__mark" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
  </section>
  <div class="dash-toolbar">${pageHeader({
    title: 'ملخص الأداء',
    description: 'اختر الفترة الزمنية لمراجعة المؤشرات والحركات المسجلة.',
    actions: `<label class="field dash-period" for="${DASHBOARD_PERIOD_FIELD_ID}"><span class="field__label">الفترة الزمنية</span>
      <select class="select" id="${DASHBOARD_PERIOD_FIELD_ID}" name="period">${periodOptionsHtml(dashboardService.DEFAULT_PERIOD)}</select>
    </label>`
  })}</div>
  <p class="dash-scope-note" id="${DASHBOARD_SCOPE_NOTE_ID}">${escapeHtml(DASHBOARD_SCOPE_NOTE)}</p>
  <div class="dash-period-label" id="${DASHBOARD_PERIOD_LABEL_ID}">جارٍ تحديد الفترة…</div>
  <div class="state" id="dashboard-state">${loadingState({ message: 'جارٍ تحميل لوحة التحكم…' })}</div>
  <div id="dashboard-content" hidden>
    <div class="dash-kpis" id="${DASHBOARD_KPI_ID}"></div>
    <div class="page-section" id="${DASHBOARD_ALERTS_ID}"></div>
    <div class="grid grid--cols-2 page-section dash-analytics-grid">
      <section class="card dash-analytics-card" id="dashboard-chart-card">
        <header class="card__header dash-analytics-card__header"><div><h3 class="card__title">${escapeHtml(DASHBOARD_CHART_TITLE)}</h3><p class="dash-chart__subtitle">مقارنة التحصيل والمدفوعات النقدية عبر الفترة المختارة</p></div><span class="dash-chart__unit">جنيه</span></header>
        <div class="card__body">
          <p class="dash-note">${escapeHtml(DASHBOARD_CHART_NOTE)}</p>
          <div id="${DASHBOARD_CHART_ID}"></div>
        </div>
      </section>
      <section class="card dash-analytics-card" id="dashboard-period-card">
        <header class="card__header dash-analytics-card__header"><div><h3 class="card__title">ملخص الحركة المالية — خلال الفترة</h3><p class="dash-chart__subtitle">تفصيل القيم حسب طبيعة الحركة</p></div></header>
        <div id="${DASHBOARD_PERIOD_SUMMARY_ID}"></div>
      </section>
    </div>
    <section class="card page-section">
      <header class="card__header dash-card-head"><h3 class="card__title">${escapeHtml(DASHBOARD_LATEST_TITLE)}</h3>
        <a class="btn btn--outline btn--sm" href="#/transactions" id="dashboard-open-ledger">${escapeHtml(DASHBOARD_LATEST_LINK)}</a>
      </header>
      <div class="card__body" id="${DASHBOARD_LATEST_ID}"></div>
    </section>
    <div class="grid grid--cols-2" id="${DASHBOARD_CROP_ID}"></div>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
export function initDashboardView({ container, navigate = null, autoLoad = true } = {}) {
  if (!container) return null;
  const find = (selector) => container.querySelector(selector);
  const state = { period: dashboardService.DEFAULT_PERIOD, data: null, error: null, loading: false };

  // Three mutually exclusive states, never two at once: loading, error, content.
  function showLoading() {
    state.loading = true;
    const stateBox = find('#dashboard-state');
    const content = find('#dashboard-content');
    if (stateBox) { stateBox.hidden = false; stateBox.innerHTML = loadingState({ message: 'جارٍ تحميل لوحة التحكم…' }); }
    if (content) content.hidden = true;
  }

  // Only called after a successful read: this is what hides the status box, so a failure can
  // never be erased by the success path.
  function clearState() {
    const stateBox = find('#dashboard-state');
    if (stateBox) { stateBox.hidden = true; stateBox.innerHTML = ''; }
  }

  function renderPeriodLabel() {
    const box = find(`#${DASHBOARD_PERIOD_LABEL_ID}`);
    if (!box || !state.data) return;
    const range = state.data.Period;
    box.textContent = `${range.Label} — من ${range.From} إلى ${range.To} (${range.Days} يومًا)`;
  }

  function renderError() {
    const stateBox = find('#dashboard-state');
    if (!stateBox) return;
    stateBox.hidden = false;
    stateBox.innerHTML = errorState({
      title: DASHBOARD_LOAD_ERROR,
      message: state.error && state.error.message ? state.error.message : 'أعد المحاولة لاحقًا.',
      code: state.error && state.error.code ? String(state.error.code) : null
    });
  }

  function render() {
    if (!state.data) return;
    const kpis = find(`#${DASHBOARD_KPI_ID}`);
    if (kpis) kpis.innerHTML = kpisHtml(state.data);
    const alerts = find(`#${DASHBOARD_ALERTS_ID}`);
    if (alerts) alerts.innerHTML = alertsHtml(state.data);
    const chart = find(`#${DASHBOARD_CHART_ID}`);
    if (chart) chart.innerHTML = chartHtml(state.data.Series);
    const summary = find(`#${DASHBOARD_PERIOD_SUMMARY_ID}`);
    if (summary) summary.innerHTML = state.data.Totals.MovementCount === 0 && state.data.Totals.CancelledCount === 0
      ? `<div class="card__body">${emptyState({ title: 'لا توجد حركات في الفترة', message: DASHBOARD_PERIOD_EMPTY, icon: '🗓️' })}</div>`
      : `${summaryTableHtml(state.data)}<div class="card__footer dash-summary-note">
        <span>حركات نشطة في الفترة: <strong>${escapeHtml(countOrDash(state.data.Totals.MovementCount))}</strong></span>
        <span>حركات ملغاة: <span class="badge badge--cancelled">${escapeHtml(countOrDash(state.data.Totals.CancelledCount))}</span></span>
        ${state.data.Totals.MissingAmountCount > 0 ? `<span class="badge badge--status-inactive">${escapeHtml(`${countOrDash(state.data.Totals.MissingAmountCount)} حركة بلا مبلغ مسجّل`)}</span>` : ''}
      </div>`;
    const latest = find(`#${DASHBOARD_LATEST_ID}`);
    if (latest) latest.innerHTML = latestRowsHtml(state.data);
    const crop = find(`#${DASHBOARD_CROP_ID}`);
    if (crop) crop.innerHTML = cropHtml(state.data);
    renderPeriodLabel();
    const content = find('#dashboard-content');
    if (content) content.hidden = false;
  }

  let pending = null;
  let confirmedOnce = false;
  async function load() {
    showLoading();
    state.error = null;
    try {
      let data = await dashboardService.buildDashboard({ period: state.period });
      // A cold start can land the first read before the store answers. One confirming re-read
      // is taken ONLY when the first pass reports a completely empty ledger, so a slow open can
      // never leave an empty dashboard on screen. It reads again — it never invents a row.
      if (!confirmedOnce && data.DataState.HaveAnyTransaction === false) {
        confirmedOnce = true;
        data = await dashboardService.buildDashboard({ period: state.period });
      }
      state.data = data;
      render();
      clearState();
    } catch (error) {
      state.error = error;
      state.data = null;
      renderError();
    } finally {
      state.loading = false;
    }
  }

  // Serialised: a period change during a running build never renders an older result.
  function run() {
    pending = (pending ?? Promise.resolve()).then(load, load);
    return pending;
  }

  function onPeriodChange(event) {
    const value = event && event.target ? event.target.value : state.period;
    if (value === state.period) return;
    state.period = value;
    run();
  }

  // Delegated listeners: one change handler and one click handler for the whole screen, so
  // the period can be changed and the ledger opened without rebinding on every repaint.
  if (typeof container.addEventListener === 'function') {
    container.addEventListener('change', (event) => {
      const target = event && event.target ? event.target : null;
      if (!target || target.id !== DASHBOARD_PERIOD_FIELD_ID) return;
      onPeriodChange(event);
    });
    container.addEventListener('click', (event) => {
      const target = event && event.target ? event.target : null;
      const id = target && typeof target.getAttribute === 'function' ? target.id ?? target.getAttribute('id') : null;
      if (id !== 'dashboard-open-ledger' || typeof navigate !== 'function') return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      navigate('/transactions');
    });
  }

  if (autoLoad) run();
  return { state, load: run, setPeriod(value) { state.period = value; const box = find(`#${DASHBOARD_PERIOD_FIELD_ID}`); if (box) box.value = value; return run(); } };
}

export const DASHBOARD_ACTIONS_ABSENT = Object.freeze(['create', 'edit', 'delete', 'cancel']);
