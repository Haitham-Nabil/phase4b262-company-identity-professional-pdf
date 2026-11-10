// Customer Account / كشف حساب العميل (Phase 4B.2).
// This module reads exclusively through the services layer: the running balance,
// the summary totals, the cancellation state and the type labels are all produced
// by the core. It decides nothing financially — it formats and lays out what the
// services returned, and it never recomputes a balance.
import { pageHeader, card, badge, table, kpi, alert } from '../components/index.js';
import { loadingState, emptyState, errorState } from '../components/states.js';
import { escapeHtml } from '../components/html.js';
import { amountClass } from '../components/financial.js';
import { formatMoneyMinor, formatQuantityTrimmed, formatText, formatCount } from '../../src/utils/formatting.js';
import { logger } from '../../src/utils/logger.js';
import { customerService } from '../../src/services/customerService.js';
import { referencePartsFor } from '../../src/services/movementNotes.js';
import {
  balanceService, TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS_AR, CASH_TYPES, NON_CASH_TYPES
} from '../../src/services/balanceService.js';
// TRANSACTION_TYPES / TRANSACTION_TYPE_LABELS_AR are re-exported by the services
// module; the screen never reaches the domain layer on its own.
import { customerListPath, transactionAddPath } from '../routes.js';
import { buildHash } from '../router.js';
import { transactionLifecycleService } from '../../src/services/transactionLifecycleService.js';
// Phase 4B.11 fix — the two reference catalogues the carton edit dialog needs, read
// through the same services module that already supplies the form keys.
import { FORM_KEY, listReferenceOptions } from '../../src/services/transactionFormService.js';
import { FIELD_ID } from './transactionForm.js';
// Phase 4B.14 — the opening balance dialog is rendered by a presentation-only module.
import {
  OPENING_BALANCE_REGION_ID, OPENING_BALANCE_FORM_ID, OPENING_BALANCE_CONFIRM_FORM_ID,
  OPENING_BALANCE_VALUE_ID, OPENING_BALANCE_REASON_ID, OPENING_BALANCE_STEP,
  closedOpeningBalanceState, renderOpeningBalanceDialog
} from './openingBalance.js';
import { openingBalanceService } from '../../src/services/openingBalanceService.js';
// Phase 4B.6 — the edit / cancel dialogs and the audit trail are rendered by a
// presentation-only module; this controller only routes intent through the services.
import {
  TRANSACTION_DIALOGS_ID, TRANSACTION_FEEDBACK_ID,
  EDIT_FORM_ID, CANCEL_FORM_ID, EDIT_REASON_ID, EDIT_AMOUNT_ID, EDIT_DATE_ID,
  EDIT_DESCRIPTION_ID, EDIT_DIRECTION_ID, CANCEL_REASON_ID,
  renderEditDialog, renderCancelDialog, renderAuditTrail, renderTransactionFeedback, rowActionsCell
} from './transactionActions.js';

export const ACCOUNT_REGION_ID = 'account-region';
export const LEDGER_REGION_ID = 'account-ledger';
export const TOOLBAR_REGION_ID = 'account-toolbar';
export const AUDIT_REGION_ID = 'account-audit';
// Phase 4B.14 — re-exported so the screen keeps a single import surface for its regions.
export { OPENING_BALANCE_REGION_ID } from './openingBalance.js';

export const EMPTY_VALUE = '—';
export const NEEDS_NAME_LABEL = 'بحاجة إلى اسم';

export const FILTER_ALL = 'all';
export const FILTER_CASH = 'cash';
export const FILTER_NON_CASH = 'nonCash';
export const FILTER_CANCELLED = 'cancelled';
export const FILTER_ACTIVE = 'active';
export const FILTER_TYPE_PREFIX = 'type:';

export const DIRECTION_LABEL = Object.freeze({
  Credit: 'الرصيد لصالح العميل',
  Debit: 'الرصيد على العميل للشركة',
  Zero: 'الحساب متعادل'
});

export const LEDGER_STATUS_LABEL = Object.freeze({ Active: 'نشطة', Cancelled: 'ملغاة' });

export const LEDGER_COLUMNS = Object.freeze([
  { label: 'التاريخ' },
  { label: 'نوع الحركة' },
  { label: 'البيان' },
  { label: 'مدين' },
  { label: 'دائن' },
  { label: 'نقدية واردة' },
  { label: 'نقدية منصرفة' },
  { label: 'قيمة غير نقدية' },
  { label: 'الرصيد الجاري' },
  { label: 'الحالة' }
]);

export function defaultLedgerCriteria() {
  return { search: '', filter: FILTER_ALL, from: '', to: '' };
}

export function ledgerTypeLabel(transactionType) {
  const label = TRANSACTION_TYPE_LABELS_AR[transactionType];
  return label ? label : (formatText(transactionType) || EMPTY_VALUE);
}

export function ledgerTypeOptions() {
  return TRANSACTION_TYPES.map((type) => ({ value: type, label: ledgerTypeLabel(type) }));
}

export function ledgerFilterOptions() {
  return [
    { value: FILTER_ALL, label: 'جميع الحركات' },
    ...ledgerTypeOptions().map((option) => ({ value: `${FILTER_TYPE_PREFIX}${option.value}`, label: `حسب النوع: ${option.label}` })),
    { value: FILTER_CASH, label: 'الحركات النقدية' },
    { value: FILTER_NON_CASH, label: 'التسويات غير النقدية' },
    { value: FILTER_CANCELLED, label: 'الحركات الملغاة' },
    { value: FILTER_ACTIVE, label: 'الحركات الفعالة' }
  ];
}

// Cash vs non-cash classification uses the approved type lists, never a guess
// made from the Arabic label.
export function isCashTransaction(transactionType) {
  return CASH_TYPES.includes(transactionType);
}

export function isNonCashTransaction(transactionType) {
  return NON_CASH_TYPES.includes(transactionType);
}

export function matchesLedgerSearch(entry, term) {
  const needle = formatText(term).toLowerCase();
  if (!needle) return true;
  const record = entry || {};
  const fields = [
    record.Description,
    ledgerTypeLabel(record.TransactionType),
    record.TransactionType,
    record.Date,
    record.CancellationReason
  ];
  return fields.some((value) => formatText(value).toLowerCase().includes(needle));
}

export function matchesLedgerFilter(entry, filter = FILTER_ALL) {
  const record = entry || {};
  if (!filter || filter === FILTER_ALL) return true;
  if (filter === FILTER_CASH) return isCashTransaction(record.TransactionType);
  if (filter === FILTER_NON_CASH) return isNonCashTransaction(record.TransactionType);
  if (filter === FILTER_CANCELLED) return record.IsCancelled === true;
  if (filter === FILTER_ACTIVE) return record.IsCancelled !== true;
  if (String(filter).startsWith(FILTER_TYPE_PREFIX)) return record.TransactionType === String(filter).slice(FILTER_TYPE_PREFIX.length);
  return true;
}

// Date range is a display narrowing only: dates are stored as ISO YYYY-MM-DD, so
// string comparison is exact and no conversion is needed.
export function matchesLedgerRange(entry, { from = '', to = '' } = {}) {
  const date = formatText((entry || {}).Date);
  if (from && date && date < from) return false;
  if (to && date && date > to) return false;
  return true;
}

// Filtering NEVER recalculates and NEVER reorders: the rows already carry the
// running balance computed over the full financial sequence by the service.
export function visibleLedger(entries, criteria = defaultLedgerCriteria()) {
  const list = Array.isArray(entries) ? entries : [];
  return list.filter((entry) => (
    matchesLedgerSearch(entry, criteria.search)
    && matchesLedgerFilter(entry, criteria.filter)
    && matchesLedgerRange(entry, criteria)
  ));
}

function amountCell(minor, kind, { cancelled = false } = {}) {
  if (!Number.isInteger(minor) || minor === 0) return `<span class="amount">${EMPTY_VALUE}</span>`;
  const className = cancelled ? amountClass('cancelled') : amountClass(kind);
  return `<span class="${escapeHtml(className)}">${escapeHtml(formatMoneyMinor(minor))}</span>`;
}

export function runningBalanceCell(minor) {
  if (!Number.isInteger(minor)) return `<span class="amount">${EMPTY_VALUE}</span>`;
  const kind = minor > 0 ? 'positiveBalance' : (minor < 0 ? 'negativeBalance' : 'zeroBalance');
  const direction = minor > 0 ? 'لصالح العميل' : (minor < 0 ? 'على العميل' : 'متعادل');
  return `<span class="${escapeHtml(amountClass(kind))}" aria-label="${escapeHtml(`${formatMoneyMinor(minor)} ${direction}`)}">${escapeHtml(formatMoneyMinor(minor))}</span>`;
}

export function statusCell(entry) {
  const record = entry || {};
  if (record.IsCancelled === true) {
    const reason = formatText(record.CancellationReason);
    return badge(reason ? `${LEDGER_STATUS_LABEL.Cancelled} — ${reason}` : LEDGER_STATUS_LABEL.Cancelled, 'cancelled');
  }
  return badge(LEDGER_STATUS_LABEL.Active);
}

// Phase 4B.9 — a linked debt-transfer leg is presented with the counterparty and the
// role of each side. Both values were read back by the services layer from the stored
// LinkId; nothing is derived and no financial figure is produced here.
export function ledgerCounterpartyNote(record = {}) {
  const hasCounterparty = Boolean(record.CounterpartyId || record.CounterpartyCode || record.CounterpartyName);
  if (!hasCounterparty) return '';
  const roleLabel = (role) => (role === 'CreditSide' ? 'دائن' : (role === 'DebitSide' ? 'مدين' : null));
  const own = roleLabel(record.TransferRole);
  const other = roleLabel(record.CounterpartyTransferRole);
  const name = [formatText(record.CounterpartyCode), formatText(record.CounterpartyName)].filter(Boolean).join(' — ');
  const parts = [
    own ? `دورك في التحويل: ${own}` : null,
    `الطرف المقابل: ${[name, other].filter(Boolean).join(' — ') || EMPTY_VALUE}`
  ].filter(Boolean);
  return `<span class="text-sm text-muted">${escapeHtml(parts.join(' · '))}</span>`;
}

// Phase 4B.11 — read-only notes for a statement row.
//  · CartonPurchaseCarton: the receiving company and the carton type it stored, or
//    «غير محدد» when the row predates them. The carton COUNT is already the amount basis.
//  · CropPurchaseLocal: the package weight used at recording time, or «وزن العبوة غير
//    محسوم» when the row was recorded before the weight was stored. Nothing is inferred.
export function ledgerReferenceNote(record = {}) {
  // The parts are built by the services layer (movementNotes): the ONE place that knows
  // how a carton purchase (company · type · stored count) and a local purchase (package
  // count · net weight) are described. This function only escapes and prints them.
  const parts = referencePartsFor(record);
  if (!parts.length) return '';
  return `<span class="text-sm text-muted">${escapeHtml(parts.join(' · '))}</span>`;
}

export function ledgerRow(entry) {
  const record = entry || {};
  const cancelled = record.IsCancelled === true;
  return {
    className: cancelled ? 'ledger-row--cancelled' : null,
    cells: [
      escapeHtml(formatText(record.Date) || EMPTY_VALUE),
      escapeHtml(ledgerTypeLabel(record.TransactionType)),
      `${escapeHtml(formatText(record.Description) || EMPTY_VALUE)}${ledgerCounterpartyNote(record)}${ledgerReferenceNote(record)}`,
      amountCell(record.DebitMinor, 'debit', { cancelled }),
      amountCell(record.CreditMinor, 'credit', { cancelled }),
      amountCell(record.CashReceivedMinor, 'cashIn', { cancelled }),
      amountCell(record.CashPaidMinor, 'cashOut', { cancelled }),
      amountCell(record.SettlementMinor, 'nonCash', { cancelled }),
      runningBalanceCell(record.RunningBalanceMinor),
      // The lifecycle actions live inside the status cell, so the approved ten-column
      // statement layout is unchanged and a movement that may not be edited or
      // cancelled simply shows no such button.
      `${statusCell(record)}${rowActionsCell(record)}`
    ]
  };
}

function controlField(label, controlId, control) {
  return `<div class="field"><label class="field__label" for="${escapeHtml(controlId)}">${escapeHtml(label)}</label>${control}</div>`;
}

export function renderLedgerToolbar({ criteria = defaultLedgerCriteria() } = {}) {
  const options = ledgerFilterOptions()
    .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === criteria.filter ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('');
  const search = `<input class="input" id="ledger-search" type="search" placeholder="البيان أو نوع الحركة أو التاريخ" value="${escapeHtml(criteria.search)}" data-ledger="search" aria-label="بحث داخل كشف الحساب">`;
  const filter = `<select class="select" id="ledger-filter" data-ledger="filter" aria-label="تصفية الحركات">${options}</select>`;
  const from = `<input class="input" id="ledger-from" type="date" value="${escapeHtml(criteria.from)}" data-ledger="from" aria-label="من تاريخ">`;
  const to = `<input class="input" id="ledger-to" type="date" value="${escapeHtml(criteria.to)}" data-ledger="to" aria-label="إلى تاريخ">`;
  return `<div class="ledger-toolbar">
${controlField('بحث في الحركات', 'ledger-search', search)}
${controlField('تصفية', 'ledger-filter', filter)}
${controlField('من تاريخ', 'ledger-from', from)}
${controlField('إلى تاريخ', 'ledger-to', to)}
</div>
<p class="ledger-note">البحث والتصفية يعرضان صفوفًا أقل فقط؛ الرصيد الجاري لكل حركة يبقى محسوبًا على التسلسل المالي الكامل المعتمد.</p>`;
}

export function renderLedgerSection({ entries = [], criteria = defaultLedgerCriteria() } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) {
    return card({
      title: 'كشف الحركات',
      body: emptyState({
        title: 'لا توجد حركات مسجلة على هذا الحساب',
        message: 'لا يحتوي الحساب على حركات مالية حتى الآن. الرصيد المعروض هو الرصيد الافتتاحي المسجل للعميل.',
        icon: '🧾'
      })
    });
  }
  const visible = visibleLedger(list, criteria);
  if (!visible.length) {
    return card({
      title: 'كشف الحركات',
      body: `${emptyState({ title: 'لا نتائج مطابقة', message: 'لا توجد حركات مطابقة للبحث أو التصفية الحالية.', icon: '🔎' })}
<div class="row"><button class="btn btn--outline" type="button" data-action="clear-ledger-filters">مسح البحث والتصفية</button></div>`
    });
  }
  const countLine = `<p class="toolbar__count" aria-live="polite">عدد الحركات المعروضة: ${formatCount(visible.length)} من ${formatCount(list.length)}</p>`;
  return `${countLine}${table({
    numeric: true,
    columns: LEDGER_COLUMNS,
    rows: visible.map(ledgerRow),
    emptyMessage: 'لا توجد حركات.'
  })}`;
}

export function balanceDirection(summary) {
  const side = (summary || {}).BalanceSide;
  const minor = (summary || {}).BalanceMinor;
  const label = DIRECTION_LABEL[side] || DIRECTION_LABEL.Zero;
  const kind = side === 'Credit' ? 'positiveBalance' : (side === 'Debit' ? 'negativeBalance' : 'zeroBalance');
  return {
    label,
    text: Number.isInteger(minor) ? formatMoneyMinor(minor) : EMPTY_VALUE,
    className: amountClass(kind)
  };
}

export function renderAccountSummary(summary = {}) {
  const direction = balanceDirection(summary);
  const cards = [
    card({ body: kpi({ label: 'الرصيد الافتتاحي', value: Number.isInteger(summary.OpeningBalanceMinor) ? formatMoneyMinor(summary.OpeningBalanceMinor) : EMPTY_VALUE }) }),
    card({ body: kpi({ label: 'إجمالي المدين', value: Number.isInteger(summary.TotalDebitMinor) ? formatMoneyMinor(summary.TotalDebitMinor) : EMPTY_VALUE }) }),
    card({ body: kpi({ label: 'إجمالي الدائن', value: Number.isInteger(summary.TotalCreditMinor) ? formatMoneyMinor(summary.TotalCreditMinor) : EMPTY_VALUE }) }),
    card({
      body: `${kpi({ label: 'الرصيد الحالي', value: direction.text })}
<div class="account-direction"><span class="${escapeHtml(direction.className)}">${escapeHtml(direction.text)}</span><span>${escapeHtml(direction.label)}</span></div>`
    })
  ];
  return `<div class="grid grid--cols-3">${cards.join('\n')}</div>
<p class="ledger-note">المعادلة المعتمدة: الرصيد الحالي = الرصيد الافتتاحي + الدائن − المدين. القيم مصدرها طبقة الخدمات المالية.</p>`;
}

// Cash and non-cash are shown apart on purpose: the non-cash figure must never be
// read as an amount of money collected.
export function renderCashSplit(summary = {}) {
  const cards = [
    card({ body: kpi({ label: 'نقدية واردة (دفعها العميل)', value: Number.isInteger(summary.CashReceivedMinor) ? formatMoneyMinor(summary.CashReceivedMinor) : EMPTY_VALUE }) }),
    card({ body: kpi({ label: 'نقدية منصرفة (دفعتها الشركة)', value: Number.isInteger(summary.CashPaidMinor) ? formatMoneyMinor(summary.CashPaidMinor) : EMPTY_VALUE }) }),
    card({ body: kpi({ label: 'تسويات غير نقدية', value: Number.isInteger(summary.NonCashSettlementMinor) ? formatMoneyMinor(summary.NonCashSettlementMinor) : EMPTY_VALUE }) })
  ];
  return `<div class="grid grid--cols-3">${cards.join('\n')}</div>
<p class="ledger-note">النقدية والتسويات غير النقدية مفصولة تمامًا ولا تُجمع في رقم واحد. التسوية ومبادلة البضاعة وتحويل المديونية ليست مبالغ نقدية محصّلة.</p>`;
}

export function renderCustomerInfo(customer = {}) {
  const name = formatText(customer.Name);
  const items = [
    ['كود العميل', formatText(customer.Code) || EMPTY_VALUE],
    ['الاسم', name || NEEDS_NAME_LABEL],
    ['الهاتف', formatText(customer.Phone) || EMPTY_VALUE],
    ['المنطقة', formatText(customer.Region) || EMPTY_VALUE],
    ['الحالة', customer.IsActive === true ? 'نشط' : 'غير نشط']
  ];
  const body = `<div class="account-meta">${items.map(([label, value]) => `<span class="account-meta__item"><span class="account-meta__label">${escapeHtml(label)}</span><span class="account-meta__value">${escapeHtml(value)}</span></span>`).join('')}</div>`;
  return card({ title: 'بيانات العميل', body });
}

// The stored stamp is an ISO date-time. It is shown as `YYYY-MM-DD HH:MM` so the log
// carries both the date and the time; anything unparsable is shown verbatim, never guessed.
export function historyTimestamp(value) {
  const text = formatText(value);
  if (!text) return EMPTY_VALUE;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(text);
  return match ? `${match[1]} ${match[2]}` : text;
}

// Opening balance changes are shown as a log of the separate field they belong
// to — they are not transactions, not cash and not settlements.
export function renderOpeningBalanceHistory(rows = [], options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const opts = options || {};
  const entry = opts.canEdit === false
    ? ''
    : `<button class="btn btn--primary" type="button" data-action="open-opening-balance">تعديل الرصيد الافتتاحي</button>`;
  const dialogHtml = renderOpeningBalanceDialog(opts.dialog || closedOpeningBalanceState());
  if (!list.length) {
    return [
      card({
        title: 'سجل تعديلات الرصيد الافتتاحي',
        body: `<p class="ledger-note">الرصيد الافتتاحي حقل مستقل وليس حركة مالية. لا توجد تعديلات مسجلة على هذا الحقل.</p>`,
        footer: entry || null
      }),
      dialogHtml
    ].join('\n');
  }
  const items = list.map((row) => `<div class="history-item">
  <span class="account-meta__item"><span class="account-meta__label">القيمة السابقة</span><span class="account-meta__value">${escapeHtml(Number.isInteger(row.OldValueMinor) ? formatMoneyMinor(row.OldValueMinor) : EMPTY_VALUE)}</span></span>
  <span class="account-meta__item"><span class="account-meta__label">القيمة الجديدة</span><span class="account-meta__value">${escapeHtml(Number.isInteger(row.NewValueMinor) ? formatMoneyMinor(row.NewValueMinor) : EMPTY_VALUE)}</span></span>
  <span class="account-meta__item"><span class="account-meta__label">تاريخ ووقت التعديل</span><span class="account-meta__value">${escapeHtml(historyTimestamp(row.ChangedAt))}</span></span>
  <span class="history-item__reason"><span class="account-meta__label">السبب</span> ${escapeHtml(formatText(row.Reason) || EMPTY_VALUE)}</span>
</div>`).join('\n');
  return [
    card({
      title: 'سجل تعديلات الرصيد الافتتاحي',
      body: `<div class="history-list">${items}</div>
<p class="ledger-note">الرصيد الافتتاحي حقل مستقل عن الحركات، ولا يُسجَّل كحركة ولا كنقدية ولا كتسوية. السجل للقراءة فقط ولا يمكن تعديله أو حذفه من هذه الشاشة.</p>`,
      footer: entry || null
    }),
    dialogHtml
  ].join('\n');
}

export function renderAccountError(error = null) {
  return `<div class="stack">
${errorState({
    title: 'تعذّر تحميل كشف حساب العميل',
    message: 'لم يتم تحميل بيانات العميل أو حركاته من المخزن المحلي، ولم تُعرض أي قيم بديلة.',
    code: error && error.code ? String(error.code) : null
  })}
<div class="row"><button class="btn btn--primary" type="button" data-action="retry-account">إعادة المحاولة</button></div>
</div>`;
}

function accountHeader(customer, summary) {
  const name = formatText((customer || {}).Name);
  const code = formatText((customer || {}).Code);
  const title = name ? `${name}${code ? ` — ${code}` : ''}` : `${NEEDS_NAME_LABEL}${code ? ` — ${code}` : ''}`;
  const direction = balanceDirection(summary);
  return pageHeader({
    title: 'حساب العميل',
    description: title,
    actions: `<a class="btn btn--outline" href="${escapeHtml(buildHash(transactionAddPath(customer.Id)))}">تسجيل حركة</a><button class="btn btn--outline" type="button" data-action="open-opening-balance">تعديل الرصيد الافتتاحي</button><a class="btn btn--outline" href="${escapeHtml(buildHash(customerListPath()))}">العودة إلى العملاء</a>`
  });
}

export function renderAuditSection(audit = null) {
  const current = audit || {};
  return renderAuditTrail({ transactionId: current.transactionId || null, entries: current.entries || [] });
}

export function customerAccountHtml({ customer = {}, summary = {}, ledger = {}, openingHistory = [], criteria = defaultLedgerCriteria(), feedback = null, dialogs = null, audit = null, opening = null } = {}) {
  const entries = ledger && Array.isArray(ledger.Entries) ? ledger.Entries : [];
  const open = dialogs || {};
  // A caller that predates Phase 4B.14 passes no opening state: the card then renders
  // its entry point with the dialog closed, exactly as the controller does.
  const openingState = opening || {};
  return [
    accountHeader(customer, summary),
    `<div class="page-section">${renderCustomerInfo(customer)}</div>`,
    `<div class="page-section">${renderAccountSummary(summary)}</div>`,
    `<div class="page-section">${renderCashSplit(summary)}</div>`,
    `<div class="page-section" id="${TOOLBAR_REGION_ID}">${card({ title: 'البحث والتصفية في الحركات', body: renderLedgerToolbar({ criteria }) })}</div>`,
    `<div class="page-section" id="${LEDGER_REGION_ID}">${renderLedgerSection({ entries, criteria })}</div>`,
    `<div class="page-section" id="${OPENING_BALANCE_REGION_ID}">${renderOpeningBalanceHistory(openingHistory, { canEdit: openingState.canEdit !== false, dialog: openingState.dialog || null })}</div>`,
    `<div class="page-section" id="${AUDIT_REGION_ID}">${renderAuditSection(audit)}</div>`,
    `<div id="${TRANSACTION_FEEDBACK_ID}">${renderTransactionFeedback(feedback || {})}</div>`,
    `<div id="${TRANSACTION_DIALOGS_ID}">${renderEditDialog(open.edit || {})}${renderCancelDialog(open.cancel || {})}</div>`
  ].join('\n');
}

// Shell rendered before the services answer: a visible loading state and no
// financial value of any kind.
export function customerAccountShellHtml({ customerId = null } = {}) {
  return [
    pageHeader({
      title: 'حساب العميل',
      description: `جارٍ تحميل كشف الحساب${customerId ? '' : ' — معرّف العميل غير مُمرَّر'}`,
      actions: `<a class="btn btn--outline" href="${escapeHtml(buildHash(customerListPath()))}">العودة إلى العملاء</a>`
    }),
    `<div class="page-section" id="${ACCOUNT_REGION_ID}" aria-busy="true">${loadingState({ message: 'جارٍ تحميل كشف حساب العميل…' })}</div>`
  ].join('\n');
}

export const defaultAccountServices = Object.freeze({
  getCustomer: (customerId) => customerService.getCustomer(customerId),
  getSummary: (customerId) => balanceService.getCustomerSummary(customerId),
  getLedger: (customerId) => balanceService.getRunningBalance(customerId),
  listOpeningHistory: (customerId) => customerService.listOpeningBalanceHistory(customerId),
  // Phase 4B.14 — the review step and the write both go through the one approved service.
  previewOpeningChange: (customerId, input) => openingBalanceService.previewChange(customerId, input),
  setOpeningBalance: (customerId, input) => openingBalanceService.setOpeningBalance(customerId, input),
  getEditableTransaction: (transactionId) => transactionLifecycleService.getEditableTransaction(transactionId),
  // Phase 4B.11 fix — the two reference catalogues the carton edit dialog needs. Read through
  // the services layer only; the screen reaches no data layer of its own.
  listReferenceOptions: () => listReferenceOptions(),
  editTransaction: (transactionId, form) => transactionLifecycleService.editTransaction(transactionId, form),
  cancelTransaction: (transactionId, reason, options) => transactionLifecycleService.cancelTransaction(transactionId, reason, options),
  listAuditTrail: (transactionId) => transactionLifecycleService.listAuditTrail(transactionId)
});

// Screen controller. The four reads go through the services layer; the retry
// action re-runs the same reads, and aria-busy is always cleared.
export function initCustomerAccountView({ container, customerId = null, navigate = null, services = defaultAccountServices, autoLoad = true } = {}) {
  if (!container) return null;
  const state = {
    entries: [], criteria: defaultLedgerCriteria(), customer: null, summary: null,
    openingHistory: [], error: null, feedback: null,
    dialogs: { edit: null, cancel: null, busy: false, error: null, fieldErrors: {}, success: null },
    opening: closedOpeningBalanceState(),
    audit: { transactionId: null, entries: [] }
  };
  const region = () => (typeof container.querySelector === 'function' ? container.querySelector(`#${ACCOUNT_REGION_ID}`) : null);
  const ledgerRegion = () => (typeof container.querySelector === 'function' ? container.querySelector(`#${LEDGER_REGION_ID}`) : null);
  const toolbarRegion = () => (typeof container.querySelector === 'function' ? container.querySelector(`#${TOOLBAR_REGION_ID}`) : null);
  const live = () => Boolean(region());

  function paintLedger() {
    const target = ledgerRegion();
    if (target) target.innerHTML = renderLedgerSection({ entries: state.entries, criteria: state.criteria });
  }

  function paintAccount() {
    const target = region();
    if (!target) return;
    // The dialog sub-objects carry the shared error / busy / field-error state, so a
    // refused operation is reported inside the dialog that caused it.
    const open = state.dialogs;
    const dialogs = {
      edit: open.edit
        ? {
          record: open.edit.record,
          editability: open.edit.editability,
          values: open.values || null,
          busy: open.busy,
          error: open.error,
          fieldErrors: open.fieldErrors,
          referenceOptions: open.edit.referenceOptions || null
        }
        : null,
      cancel: open.cancel
        ? { record: open.cancel.record, editability: open.cancel.editability, busy: open.busy, error: open.error, fieldErrors: open.fieldErrors }
        : null
    };
    target.innerHTML = customerAccountHtml({
      customer: state.customer,
      summary: state.summary,
      ledger: { Entries: state.entries },
      openingHistory: state.openingHistory,
      criteria: state.criteria,
      feedback: state.feedback,
      dialogs,
      audit: state.audit,
      opening: { canEdit: true, dialog: state.opening }
    });
    target.setAttribute('aria-busy', 'false');
  }

  async function load() {
    if (typeof container.setAttribute === 'function') container.setAttribute('aria-busy', 'true');
    const start = region();
    if (start) {
      start.setAttribute('aria-busy', 'true');
      start.innerHTML = loadingState({ message: 'جارٍ تحميل كشف حساب العميل…' });
    }
    state.error = null;
    try {
      if (!customerId) throw { code: 'NOT_FOUND', message: 'معرّف العميل غير صالح.' };
      const customer = await services.getCustomer(customerId);
      if (!customer) throw { code: 'NOT_FOUND', message: 'العميل غير موجود.' };
      const summary = await services.getSummary(customerId);
      const ledger = await services.getLedger(customerId);
      const openingHistory = await services.listOpeningHistory(customerId);
      if (!live()) return { ok: false, reason: 'detached' };
      state.customer = customer;
      state.summary = summary;
      state.entries = ledger && Array.isArray(ledger.Entries) ? ledger.Entries : [];
      state.openingHistory = Array.isArray(openingHistory) ? openingHistory : [];
      paintAccount();
      return { ok: true, entries: state.entries.length };
    } catch (error) {
      if (!live()) return { ok: false, reason: 'detached' };
      logger.error('customer account load failed', {
        code: error && error.code ? String(error.code) : null,
        message: error && error.message ? String(error.message) : null
      });
      state.error = error;
      state.entries = [];
      const target = region();
      if (target) {
        target.innerHTML = renderAccountError(error);
        target.setAttribute('aria-busy', 'false');
      }
      return { ok: false, error };
    } finally {
      if (typeof container.setAttribute === 'function') container.setAttribute('aria-busy', 'false');
    }
  }

  function clearFilters() {
    state.criteria = defaultLedgerCriteria();
    paintAccount();
  }

  function messageOf(error) {
    if (error && error.message) return String(error.message);
    return 'تعذر تنفيذ العملية.';
  }

  function fieldErrorsOf(error) {
    const details = error && error.details ? error.details : null;
    const list = details && Array.isArray(details.errors) ? details.errors : [];
    const map = {};
    for (const item of list) {
      if (item && item.field && !map[item.field]) map[item.field] = item.message;
    }
    return map;
  }

  function hasField(id) {
    return typeof container.querySelector === 'function' && Boolean(container.querySelector(`#${id}`));
  }

  function readField(id) {
    const element = typeof container.querySelector === 'function' ? container.querySelector(`#${id}`) : null;
    return element && typeof element.value === 'string' ? element.value : '';
  }

  // Raw input is handed to the service keyed by the approved form keys: the screen
  // performs no unit conversion, no direction decision and no amount calculation.
  function readEditValues() {
    return {
      [FORM_KEY.DATE]: readField(EDIT_DATE_ID),
      [FORM_KEY.DESCRIPTION]: readField(EDIT_DESCRIPTION_ID),
      [FORM_KEY.AMOUNT]: readField(EDIT_AMOUNT_ID),
      [FORM_KEY.DIRECTION]: readField(EDIT_DIRECTION_ID),
      [FORM_KEY.UNITS]: readField(FIELD_ID.Units),
      [FORM_KEY.LOOSE_KG]: readField(FIELD_ID.LooseKg),
      [FORM_KEY.DEDUCTION_KG]: readField(FIELD_ID.DeductionKg),
      [FORM_KEY.UNIT_PRICE]: readField(FIELD_ID.UnitPrice),
      [FORM_KEY.CARTON_QUANTITY]: readField(FIELD_ID.CartonQuantity),
      [FORM_KEY.CARTON_DISCOUNT]: readField(FIELD_ID.CartonDiscount),
      [FORM_KEY.CARTON_PRICE]: readField(FIELD_ID.CartonPrice),
      [FORM_KEY.EDIT_REASON]: readField(EDIT_REASON_ID),
      // The references are added only when the dialog actually rendered their dropdowns.
      // Sending an empty string for a field that is not on screen is what used to make an
      // ordinary edit look like a request to clear both references.
      ...(hasField(FIELD_ID.ReceivingCompanyId) ? { [FORM_KEY.RECEIVING_COMPANY]: readField(FIELD_ID.ReceivingCompanyId) } : {}),
      ...(hasField(FIELD_ID.CartonTypeId) ? { [FORM_KEY.CARTON_TYPE]: readField(FIELD_ID.CartonTypeId) } : {}),
      // Phase 4B.13.1 — same rule for the variety: only sent when the dialog rendered it.
      ...(hasField(FIELD_ID.StrawberryVarietyId) ? { [FORM_KEY.STRAWBERRY_VARIETY]: readField(FIELD_ID.StrawberryVarietyId) } : {})
    };
  }

  async function refreshAudit(transactionId) {
    if (!transactionId) {
      state.audit = { transactionId: null, entries: [] };
      paintAccount();
      return { ok: true, entries: 0 };
    }
    try {
      const entries = await services.listAuditTrail(transactionId);
      if (!live()) return { ok: false, reason: 'detached' };
      state.audit = { transactionId, entries: Array.isArray(entries) ? entries : [] };
      paintAccount();
      return { ok: true, entries: state.audit.entries.length };
    } catch (error) {
      if (!live()) return { ok: false, reason: 'detached' };
      logger.error('audit trail load failed', { message: messageOf(error) });
      state.audit = { transactionId, entries: [], error: messageOf(error) };
      paintAccount();
      return { ok: false, error };
    }
  }

  async function openEdit(transactionId) {
    state.dialogs = { edit: null, cancel: null, busy: false, error: null, fieldErrors: {}, success: null };
    state.opening = closedOpeningBalanceState();
    try {
      const loaded = await services.getEditableTransaction(transactionId);
      if (!live()) return { ok: false, reason: 'detached' };
      if (!loaded.Editability || loaded.Editability.CanEdit !== true) {
        state.feedback = { tone: 'danger', message: (loaded.Editability && loaded.Editability.EditReason) || 'التعديل غير متاح لهذه الحركة.' };
        paintAccount();
        return { ok: false, blocked: true };
      }
      // The stored references are rendered only once the catalogues that back the two
      // dropdowns have arrived, so the save path can never read a half-built form. A failure
      // to read them is reported instead of silently rendering an empty list.
      let referenceOptions = null;
      if (loaded.Record.TransactionType === 'CropPurchaseCarton' || loaded.Record.TransactionType === 'CropPurchaseLocal') {
        try {
          // A caller may inject its own service facade (the app shell does). The catalogue read
          // therefore resolves the injected method first and falls back to the approved named
          // service function, so the dialog can never be blocked by a missing facade entry.
          const loadOptions = typeof services.listReferenceOptions === 'function'
            ? services.listReferenceOptions
            : listReferenceOptions;
          referenceOptions = await loadOptions();
        } catch (error) {
          if (!live()) return { ok: false, reason: 'detached' };
          state.feedback = { tone: 'danger', message: messageOf(error) };
          paintAccount();
          return { ok: false, error };
        }
        if (!live()) return { ok: false, reason: 'detached' };
      }
      state.dialogs = {
        edit: { record: loaded.Record, editability: loaded.Editability, referenceOptions },
        cancel: null, busy: false, error: null, fieldErrors: {}, success: null
      };
      paintAccount();
      return { ok: true };
    } catch (error) {
      if (!live()) return { ok: false, reason: 'detached' };
      state.feedback = { tone: 'danger', message: messageOf(error) };
      paintAccount();
      return { ok: false, error };
    }
  }

  async function submitEdit() {
    const current = state.dialogs.edit;
    if (!current || state.dialogs.busy) return { ok: false, reason: 'busy-or-closed' };
    const values = readEditValues();
    state.dialogs = { ...state.dialogs, busy: true, error: null, fieldErrors: {}, values };
    paintAccount();
    try {
      const result = await services.editTransaction(current.record.Id, values);
      state.dialogs = { edit: null, cancel: null, busy: false, error: null, fieldErrors: {}, success: null };
      state.feedback = { tone: 'success', message: `تم حفظ تعديل الحركة ${result.Record.Id} وتسجيل الحدث في سجل التدقيق.` };
      await load();
      await refreshAudit(result.Record.Id);
      return { ok: true, record: result.Record };
    } catch (error) {
      state.dialogs = { ...state.dialogs, busy: false, error: messageOf(error), fieldErrors: fieldErrorsOf(error), values };
      paintAccount();
      return { ok: false, error };
    }
  }

  async function openCancel(transactionId) {
    state.dialogs = { edit: null, cancel: null, busy: false, error: null, fieldErrors: {}, success: null };
    try {
      const loaded = await services.getEditableTransaction(transactionId);
      if (!live()) return { ok: false, reason: 'detached' };
      if (!loaded.Editability || loaded.Editability.CanCancel !== true) {
        state.feedback = { tone: 'danger', message: (loaded.Editability && loaded.Editability.CancelReason) || 'الإلغاء غير متاح لهذه الحركة.' };
        paintAccount();
        return { ok: false, blocked: true };
      }
      state.dialogs = { edit: null, cancel: { record: loaded.Record, editability: loaded.Editability }, busy: false, error: null, fieldErrors: {}, success: null };
      paintAccount();
      return { ok: true };
    } catch (error) {
      if (!live()) return { ok: false, reason: 'detached' };
      state.feedback = { tone: 'danger', message: messageOf(error) };
      paintAccount();
      return { ok: false, error };
    }
  }

  async function submitCancel() {
    const current = state.dialogs.cancel;
    if (!current || state.dialogs.busy) return { ok: false, reason: 'busy-or-closed' };
    const reason = readField(CANCEL_REASON_ID);
    state.dialogs = { ...state.dialogs, busy: true, error: null, fieldErrors: {}, cancel: { ...current, reason } };
    paintAccount();
    try {
      // Confirmation is explicit: the service refuses to write without it.
      const result = await services.cancelTransaction(current.record.Id, reason, { confirmed: true });
      state.dialogs = { edit: null, cancel: null, busy: false, error: null, fieldErrors: {}, success: null };
      state.feedback = { tone: 'success', message: `تم إلغاء الحركة ${result.Record.Id} مع تسجيل السبب في سجل التدقيق.` };
      await load();
      await refreshAudit(result.Record.Id);
      return { ok: true, record: result.Record };
    } catch (error) {
      state.dialogs = { ...state.dialogs, busy: false, error: messageOf(error), fieldErrors: fieldErrorsOf(error), cancel: { ...current, reason } };
      paintAccount();
      return { ok: false, error };
    }
  }

  // -------------------------------------------------------------------------
  // Phase 4B.14 — opening balance: open -> review (service preview) -> confirm.
  // The screen reads two raw strings and hands them to the service; every value,
  // difference and direction shown in the review comes back from that call.
  // -------------------------------------------------------------------------
  function readOpeningInput() {
    return { NewValue: readField(OPENING_BALANCE_VALUE_ID), Reason: readField(OPENING_BALANCE_REASON_ID) };
  }

  // The service expects a number for the balance. An empty field stays "" so the
  // validation layer reports its own Arabic message instead of the screen guessing.
  function openingInputFrom(values) {
    const raw = String(values.NewValue === undefined || values.NewValue === null ? '' : values.NewValue).trim();
    const parsed = raw === '' ? '' : Number(raw.replace(/\s/g, ''));
    return { newValue: parsed, reason: values.Reason };
  }

  function openOpeningBalance() {
    const current = state.summary || {};
    state.opening = {
      ...closedOpeningBalanceState(),
      open: true,
      step: OPENING_BALANCE_STEP.FORM,
      currentMinor: Number.isInteger(current.OpeningBalanceMinor) ? current.OpeningBalanceMinor : 0,
      values: { NewValue: '', Reason: '' }
    };
    state.feedback = null;
    paintAccount();
    return { ok: true };
  }

  function closeOpeningBalance() {
    // Closing discards the draft: no service call, therefore no write and no log row.
    state.opening = closedOpeningBalanceState();
    paintAccount();
    return { ok: true };
  }

  async function reviewOpeningBalance() {
    if (state.opening.busy) return { ok: false, reason: 'busy' };
    const values = readOpeningInput();
    state.opening = { ...state.opening, values, busy: true, error: null, fieldErrors: {} };
    paintAccount();
    try {
      const preview = await services.previewOpeningChange(customerId, openingInputFrom(values));
      if (!live()) return { ok: false, reason: 'detached' };
      state.opening = {
        ...state.opening,
        step: OPENING_BALANCE_STEP.REVIEW,
        preview,
        values: { NewValue: String(values.NewValue || '').trim(), Reason: preview.Reason },
        busy: false,
        error: null,
        fieldErrors: {},
        customerLabel: customerLabelOf(preview)
      };
      paintAccount();
      return { ok: true, preview };
    } catch (error) {
      if (!live()) return { ok: false, reason: 'detached' };
      state.opening = { ...state.opening, busy: false, error: messageOf(error), fieldErrors: fieldErrorsOf(error) };
      paintAccount();
      return { ok: false, error };
    }
  }

  function customerLabelOf(preview) {
    const name = formatText((state.customer || {}).Name) || NEEDS_NAME_LABEL;
    const code = formatText((state.customer || {}).Code);
    const fromRecord = name + (code ? ` — ${code}` : '');
    if (fromRecord.trim() !== '') return fromRecord;
    return formatText(preview && preview.CustomerName) || EMPTY_VALUE;
  }

  function backToOpeningForm() {
    state.opening = { ...state.opening, step: OPENING_BALANCE_STEP.FORM, error: null, success: null };
    paintAccount();
    return { ok: true };
  }

  async function submitOpeningBalance() {
    if (state.opening.busy) return { ok: false, reason: 'busy' };
    const preview = state.opening.preview;
    if (!preview) return { ok: false, reason: 'no-preview' };
    if (preview.NoChange === true) {
      // The service would write nothing; the screen says so instead of pretending to save.
      state.opening = { ...state.opening, error: 'القيمة الجديدة مطابقة للقيمة الحالية؛ لا يوجد ما يُحفظ.' };
      paintAccount();
      return { ok: false, reason: 'no-change' };
    }
    state.opening = { ...state.opening, busy: true, error: null };
    paintAccount();
    try {
      const input = openingInputFrom(state.opening.values);
      const result = await services.setOpeningBalance(customerId, input);
      if (!live()) return { ok: false, reason: 'detached' };
      state.opening = closedOpeningBalanceState();
      state.feedback = {
        tone: 'success',
        message: result && result.Unchanged
          ? 'القيمة المدخلة مطابقة للقيمة المحفوظة؛ لم يُسجَّل أي تعديل.'
          : 'تم حفظ الرصيد الافتتاحي وتسجيل التعديل في سجله المستقل.'
      };
      await load();
      return { ok: true, result };
    } catch (error) {
      if (!live()) return { ok: false, reason: 'detached' };
      state.opening = { ...state.opening, busy: false, error: messageOf(error), fieldErrors: fieldErrorsOf(error) };
      paintAccount();
      return { ok: false, error };
    }
  }

  function closeDialogs() {
    state.dialogs = { edit: null, cancel: null, busy: false, error: null, fieldErrors: {}, success: null };
    paintAccount();
  }

  if (typeof container.addEventListener === 'function') {
    container.addEventListener('input', (event) => {
      const target = event.target;
      if (target && typeof target.getAttribute === 'function' && target.getAttribute('data-ledger') === 'search') {
        state.criteria.search = target.value;
        paintLedger();
      }
    });

    container.addEventListener('change', (event) => {
      const target = event.target;
      if (!target || typeof target.getAttribute !== 'function') return;
      const key = target.getAttribute('data-ledger');
      if (!key || key === 'search') return;
      state.criteria[key] = target.value;
      paintLedger();
    });

    container.addEventListener('click', (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest('[data-action="retry-account"]')) { load(); return; }
      if (target.closest('[data-action="clear-ledger-filters"]')) { clearFilters(); return; }
      if (target.closest('[data-action="close-dialog"]')) { closeDialogs(); return; }
      if (target.closest('[data-action="open-opening-balance"]')) { openOpeningBalance(); return; }
      if (target.closest('[data-action="close-opening-balance"]')) { closeOpeningBalance(); return; }
      if (target.closest('[data-action="back-opening-balance"]')) { backToOpeningForm(); return; }
      const editButton = target.closest('[data-action="edit-transaction"]');
      if (editButton) { openEdit(editButton.getAttribute('data-transaction-id')); return; }
      const cancelButton = target.closest('[data-action="cancel-transaction"]');
      if (cancelButton) { openCancel(cancelButton.getAttribute('data-transaction-id')); return; }
      const auditButton = target.closest('[data-action="view-audit"]');
      if (auditButton) { refreshAudit(auditButton.getAttribute('data-transaction-id')); }
    });

    container.addEventListener('submit', (event) => {
      const target = event.target;
      if (!target || typeof target.getAttribute !== 'function') return;
      const formId = target.getAttribute('id');
      if (formId === OPENING_BALANCE_FORM_ID) { event.preventDefault(); reviewOpeningBalance(); return; }
      if (formId === OPENING_BALANCE_CONFIRM_FORM_ID) { event.preventDefault(); submitOpeningBalance(); return; }
      if (formId !== EDIT_FORM_ID && formId !== CANCEL_FORM_ID) return;
      event.preventDefault();
      if (formId === EDIT_FORM_ID) submitEdit();
      else submitCancel();
    });
  }

  if (autoLoad) load();
  return {
    reload: load, clearFilters,
    criteria: () => ({ ...state.criteria }),
    entries: () => state.entries.slice(),
    // Exposed for the UI-shell tests; every one of these goes through the services.
    openEdit, openCancel, submitEdit, submitCancel, refreshAudit, closeDialogs,
    // Phase 4B.14 — opening balance flow, exposed for the controller tests.
    openOpeningBalance, closeOpeningBalance, reviewOpeningBalance, backToOpeningForm, submitOpeningBalance,
    openingState: () => ({ ...state.opening })
  };
}
