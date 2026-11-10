// Phase 4B.15 — the central transactions ledger screen (#/transactions).
//
// Display and lookup ONLY. This module prints what `transactionLedgerService` returned:
// it owns no counting rule, no grouping rule, no date rule, no direction and no financial
// value. Every figure — amount, debit, credit, cash — and every state (cancelled or not)
// arrives already decided by the services layer.
//
// There is deliberately NO create, edit, delete or cancel action here: the approved
// Add Transaction screen keeps those responsibilities. Opening this screen, searching or
// filtering performs reads only, so a balance can never move because of it.
//
// It reaches the data layer only through the services barrel, exactly like every other
// screen: no repository, no storage module, no direct database access.
import { pageHeader, card, table, alert, modal, badge } from '../components/index.js';
import { loadingState, emptyState, errorState } from '../components/states.js';
import { escapeHtml } from '../components/html.js';
import { formatText, formatCount, formatMoneyMinor, formatQuantityTrimmed } from '../../src/utils/formatting.js';
import {
  transactionLedgerService,
  LEDGER_STATUS_FILTER,
  LEDGER_STATUS_OPTIONS,
  LEDGER_UNSPECIFIED,
  LEDGER_UNAVAILABLE,
  LEDGER_EMPTY_VALUE,
  LEDGER_TRANSFER_TITLE
} from '../../src/services/transactionLedgerService.js';
import { cartonCountLabel } from '../../src/services/movementNotes.js';
import { customerService } from '../../src/services/customerService.js';
import { customerAccountPath } from '../routes.js';

export const LEDGER_ROOT_ID = 'ledger-root';
export const LEDGER_SEARCH_ID = 'ledger-search';
export const LEDGER_FILTERS_ID = 'ledger-filters';
export const LEDGER_FILTER_ERROR_ID = 'ledger-filter-error';
export const LEDGER_SUMMARY_ID = 'ledger-summary';
export const LEDGER_RESULTS_ID = 'ledger-results';
export const LEDGER_DETAILS_ID = 'ledger-details-dialog';
export const LEDGER_DETAILS_TITLE_ID = 'ledger-details-dialog-title';
export const LEDGER_DETAILS_BODY_ID = 'ledger-details-body';

export const LEDGER_FILTER_FIELD = Object.freeze({
  CUSTOMER: 'ledger-customer',
  TYPE: 'ledger-type',
  FROM: 'ledger-from',
  TO: 'ledger-to',
  STATUS: 'ledger-status'
});

export const LEDGER_ACTION = Object.freeze({
  DETAILS: 'details',
  CLOSE_DETAILS: 'close-details',
  RESET: 'reset'
});

export const LEDGER_COLUMNS = Object.freeze([
  { label: 'التاريخ' },
  { label: 'نوع الحركة' },
  { label: 'العميل' },
  { label: 'البيان' },
  { label: 'المبلغ' },
  { label: 'الحالة' },
  { label: 'تفاصيل' }
]);

export const LEDGER_TITLE = 'سجل الحركات';
export const LEDGER_DESCRIPTION = 'كل حركة مسجلة في النظام، مع البحث والتصفية وعرض التفاصيل. الشاشة للعرض فقط.';
export const LEDGER_SEARCH_LABEL = 'بحث';
export const LEDGER_SEARCH_PLACEHOLDER = 'اسم العميل أو كوده أو البيان';
export const LEDGER_EMPTY_MESSAGE = 'لا توجد حركات مطابقة للبحث أو الفلاتر الحالية.';
export const LEDGER_NO_DATA_MESSAGE = 'لا توجد حركات مسجلة بعد.';
export const LEDGER_LOAD_ERROR = 'تعذّر تحميل سجل الحركات.';
export const LEDGER_RESET_LABEL = 'مسح الفلاتر';
export const LEDGER_DETAILS_LABEL = 'عرض';
export const LEDGER_ANY_OPTION = 'الكل';
// Actions this screen deliberately does NOT offer. Exported so a test can assert the
// absence rather than trusting a comment.
export const LEDGER_ACTIONS_ABSENT = Object.freeze(['edit', 'delete', 'cancel']);
export const LEDGER_READ_ONLY_NOTE = 'هذه الشاشة للعرض والاستعلام فقط؛ لا تُنشئ ولا تُعدّل ولا تُلغي أي حركة.';

function directionBadge(row) {
  if (row.DirectionLabel) return badge(row.DirectionLabel, row.Direction === 'Debit' ? 'debit' : 'credit');
  return '';
}

function statusBadge(row) {
  return row.IsCancelled ? badge('ملغاة', 'cancelled') : badge('نشطة');
}

function amountCell(row) {
  const minor = Number.isInteger(row.AmountMinor) ? row.AmountMinor : null;
  const text = minor === null ? LEDGER_EMPTY_VALUE : formatMoneyMinor(minor);
  const kind = row.IsCancelled ? 'amount amount--cancelled' : (row.Direction === 'Debit' ? 'amount amount--debit' : (row.Direction === 'Credit' ? 'amount amount--credit' : 'amount'));
  return `<span class="${kind}">${escapeHtml(text)}</span>${directionBadge(row) ? ` ${directionBadge(row)}` : ''}`;
}

function customerCell(row) {
  const name = formatText(row.CustomerName);
  const code = formatText(row.CustomerCode);
  if (!name && !code) {
    return `<span class="text-sm text-muted">${escapeHtml(row.CustomerId ? LEDGER_UNAVAILABLE : LEDGER_UNSPECIFIED)}</span>`;
  }
  const label = name || LEDGER_EMPTY_VALUE;
  const codeText = code ? `<span class="text-sm text-muted"> (${escapeHtml(code)})</span>` : '';
  return `${escapeHtml(label)}${codeText}`;
}

// The statement part of a ledger row: the stored description, then the reference facts the
// service produced (company / carton type / count, or variety / packages / net weight), then
// the linked-operation note. Nothing is added that the service did not return.
function descriptionCell(row) {
  const parts = [];
  const description = formatText(row.Description);
  if (description) parts.push(`<div>${escapeHtml(description)}</div>`);
  if (Array.isArray(row.ReferenceParts) && row.ReferenceParts.length) {
    parts.push(`<div class="text-sm text-muted">${escapeHtml(row.ReferenceParts.join(' · '))}</div>`);
  }
  if (row.IsLinkedOperation) {
    const parties = [row.CustomerName, row.CounterpartyName].map((value) => formatText(value)).filter(Boolean);
    if (parties.length === 2) {
      parts.push(`<div class="text-sm text-muted">${escapeHtml(`الطرفان: ${parties[0]} ↔ ${parties[1]}`)}</div>`);
    }
  }
  return parts.length ? parts.join('') : `<span class="text-sm text-muted">${escapeHtml(LEDGER_EMPTY_VALUE)}</span>`;
}

function rowsHtml(rows) {
  return table({
    columns: LEDGER_COLUMNS,
    numeric: true,
    rows: rows.map((row) => ({
      className: row.IsCancelled ? 'row--cancelled' : null,
      cells: [
        escapeHtml(row.Date),
        escapeHtml(row.TypeLabel),
        customerCell(row),
        descriptionCell(row),
        amountCell(row),
        statusBadge(row),
        `<button class="btn btn--outline btn--small" type="button" data-ledger-action="${LEDGER_ACTION.DETAILS}" data-ledger-row="${escapeHtml(row.RowKey)}">${escapeHtml(LEDGER_DETAILS_LABEL)}</button>`
      ]
    })),
    emptyMessage: LEDGER_EMPTY_MESSAGE
  });
}

function typeOptionsHtml(types, selected) {
  const anyOption = `<option value=""${selected ? '' : ' selected'}>${escapeHtml(LEDGER_ANY_OPTION)}</option>`;
  const items = types.map((type) => {
    const isSelected = type.value === selected ? ' selected' : '';
    return `<option value="${escapeHtml(type.value)}"${isSelected}>${escapeHtml(type.label)}</option>`;
  }).join('');
  return `${anyOption}${items}`;
}

function statusOptionsHtml(selected) {
  return LEDGER_STATUS_OPTIONS.map((status) => {
    const isSelected = status.value === selected ? ' selected' : '';
    return `<option value="${escapeHtml(status.value)}"${isSelected}>${escapeHtml(status.label)}</option>`;
  }).join('');
}

export function ledgerSummaryHtml(result) {
  if (!result) return '';
  const summary = result.Summary;
  const sentences = [`عدد الحركات المعروضة: ${formatCount(summary.FilteredCount)}`];
  if (summary.FilteredCount !== summary.TotalCount) sentences.push(`من إجمالي ${formatCount(summary.TotalCount)}`);
  if (summary.LinkedOperationCount > 0) sentences.push(`تحويلات مديونية معروضة كعملية واحدة: ${formatCount(summary.LinkedOperationCount)}`);
  if (summary.FilteredCancelledCount > 0) sentences.push(`منها ملغاة: ${formatCount(summary.FilteredCancelledCount)}`);
  return `<p class="toolbar__count" role="status" aria-live="polite" id="ledger-totals-line">${escapeHtml(sentences.join(' · '))}</p>`;
}

export function transactionsViewHtml() {
  const options = transactionLedgerService.listFilterOptions();
  const field = (id, label, control) => `<div class="field"><label class="field__label" for="${escapeHtml(id)}">${escapeHtml(label)}</label>${control}</div>`;
  return `<div id="${escapeHtml(LEDGER_ROOT_ID)}" class="stack">
${pageHeader({ title: LEDGER_TITLE, description: LEDGER_DESCRIPTION })}
  <div class="page-section" id="${escapeHtml(LEDGER_FILTERS_ID)}">
    <div class="toolbar">
      ${field(LEDGER_SEARCH_ID, LEDGER_SEARCH_LABEL, `<input class="input" type="search" id="${escapeHtml(LEDGER_SEARCH_ID)}" placeholder="${escapeHtml(LEDGER_SEARCH_PLACEHOLDER)}" autocomplete="off">`)}
      ${field(LEDGER_FILTER_FIELD.CUSTOMER, 'العميل', `<select class="select" id="${escapeHtml(LEDGER_FILTER_FIELD.CUSTOMER)}"><option value="">كل العملاء</option></select>`)}
      ${field(LEDGER_FILTER_FIELD.TYPE, 'نوع الحركة', `<select class="select" id="${escapeHtml(LEDGER_FILTER_FIELD.TYPE)}">${typeOptionsHtml(options.Types, '')}</select>`)}
      ${field(LEDGER_FILTER_FIELD.FROM, 'من تاريخ', `<input class="input" type="date" id="${escapeHtml(LEDGER_FILTER_FIELD.FROM)}">`)}
      ${field(LEDGER_FILTER_FIELD.TO, 'إلى تاريخ', `<input class="input" type="date" id="${escapeHtml(LEDGER_FILTER_FIELD.TO)}">`)}
      ${field(LEDGER_FILTER_FIELD.STATUS, 'حالة الحركة', `<select class="select" id="${escapeHtml(LEDGER_FILTER_FIELD.STATUS)}">${statusOptionsHtml(LEDGER_STATUS_FILTER.ALL)}</select>`)}
    </div>
    <div class="row" style="margin-block-start: var(--space-3)">
      <button class="btn btn--outline" type="button" data-ledger-action="${LEDGER_ACTION.RESET}">${escapeHtml(LEDGER_RESET_LABEL)}</button>
    </div>
    <div id="${escapeHtml(LEDGER_FILTER_ERROR_ID)}"></div>
    <p class="text-sm text-muted">${escapeHtml(LEDGER_READ_ONLY_NOTE)}</p>
  </div>
  <div id="${escapeHtml(LEDGER_SUMMARY_ID)}"></div>
  <div id="${escapeHtml(LEDGER_RESULTS_ID)}">${loadingState({ message: 'جارٍ تحميل الحركات…' })}</div>
${modal({ id: LEDGER_DETAILS_ID, title: 'تفاصيل الحركة', body: `<div id="${escapeHtml(LEDGER_DETAILS_BODY_ID)}"></div>`, footer: `<button class="btn btn--outline" type="button" data-ledger-action="${LEDGER_ACTION.CLOSE_DETAILS}">رجوع إلى السجل</button>` })}
</div>`;
}

// Detail rows are printed in the same order every time: a label and the stored value.
// A value the row never had is reported with an explicit state, never as a zero.
function detailRow(label, value) {
  return `<tr><th scope="row">${escapeHtml(label)}</th><td>${value}</td></tr>`;
}

function textOrState(value) {
  const text = formatText(value);
  return text ? escapeHtml(text) : `<span class="text-sm text-muted">${escapeHtml(LEDGER_EMPTY_VALUE)}</span>`;
}

function referenceState(name, isActive, id) {
  const text = formatText(name);
  if (text) return `${escapeHtml(text)}${isActive === false ? ' <span class="badge">غير نشطة</span>' : ''}`;
  return `<span class="text-sm text-muted">${escapeHtml(id ? LEDGER_UNAVAILABLE : LEDGER_UNSPECIFIED)}</span>`;
}

export function ledgerDetailsHtml(row) {
  if (!row) return '';
  const detailRows = [
    detailRow('نوع الحركة', escapeHtml(row.TypeLabel)),
    detailRow('التاريخ', escapeHtml(row.Date)),
    detailRow('العميل', `${customerCell(row)}${row.CustomerId ? ` · <a href="${escapeHtml(customerAccountPath(row.CustomerId))}">كشف الحساب</a>` : ''}`),
    detailRow('البيان', textOrState(row.Description)),
    detailRow('المبلغ', amountCell(row)),
    detailRow('الاتجاه', row.DirectionLabel ? escapeHtml(row.DirectionLabel) : `<span class="text-sm text-muted">${escapeHtml(LEDGER_EMPTY_VALUE)}</span>`),
    detailRow('الحالة', statusBadge(row))
  ];
  if (row.IsCancelled) {
    detailRows.push(detailRow('سبب الإلغاء', textOrState(row.CancellationReason)));
    detailRows.push(detailRow('تاريخ الإلغاء', textOrState(row.CancelledAt)));
  }
  detailRows.push(detailRow('معرّف الحركة', textOrState(row.Id)));

  if (row.IsLinkedOperation) {
    detailRows.push(detailRow('العملية', escapeHtml(LEDGER_TRANSFER_TITLE)));
    detailRows.push(detailRow('الطرف الأول', `${customerCell(row)}${row.CustomerId ? ` · <a href="${escapeHtml(customerAccountPath(row.CustomerId))}">كشف الحساب</a>` : ''}`));
    detailRows.push(detailRow('الطرف الثاني', `${row.CounterpartyName || row.CounterpartyCode ? `${escapeHtml(formatText(row.CounterpartyName) || LEDGER_UNAVAILABLE)}${row.CounterpartyCode ? ` <span class="text-sm text-muted">(${escapeHtml(row.CounterpartyCode)})</span>` : ''}` : `<span class="text-sm text-muted">${escapeHtml(row.CounterpartyId ? LEDGER_UNAVAILABLE : LEDGER_UNSPECIFIED)}</span>`}`));
    if (row.CounterpartyId) detailRows.push(detailRow('كشف حساب الطرف الثاني', `<a href="${escapeHtml(customerAccountPath(row.CounterpartyId))}">فتح كشف الحساب</a>`));
    detailRows.push(detailRow('عدد السجلات المرتبطة', escapeHtml(formatCount(row.LegCount))));
    if (row.MergedNote) detailRows.push(detailRow('ملاحظة', escapeHtml(row.MergedNote)));
  }

  if (row.TransactionType === 'CropPurchaseCarton') {
    detailRows.push(detailRow('الشركة المستلمة', referenceState(row.ReceivingCompanyName, row.ReceivingCompanyActive, row.ReceivingCompanyId)));
    detailRows.push(detailRow('نوع الكرتونة', referenceState(row.CartonTypeName, row.CartonTypeActive, row.CartonTypeId)));
    detailRows.push(detailRow('عدد الكراتين', escapeHtml(cartonCountLabel(row.CartonQuantityMilli) || LEDGER_UNSPECIFIED)));
    detailRows.push(detailRow('سعر الكرتونة', Number.isInteger(row.CartonUnitPriceMinor) ? `${escapeHtml(formatMoneyMinor(row.CartonUnitPriceMinor))} ج` : `<span class="text-sm text-muted">${escapeHtml(LEDGER_UNSPECIFIED)}</span>`));
  }
  if (row.TransactionType === 'CropPurchaseLocal') {
    detailRows.push(detailRow('صنف الفراولة', referenceState(row.StrawberryVarietyName, row.StrawberryVarietyActive, row.StrawberryVarietyId)));
    detailRows.push(detailRow('عدد العبوات', Number.isInteger(row.PackageCountMilli) ? escapeHtml(formatQuantityTrimmed(row.PackageCountMilli)) : `<span class="text-sm text-muted">${escapeHtml(LEDGER_UNSPECIFIED)}</span>`));
    detailRows.push(detailRow('الوزن الصافي', row.CropWeightResolved === true && Number.isInteger(row.CropNetWeightMilli)
      ? `${escapeHtml(formatQuantityTrimmed(row.CropNetWeightMilli))} كجم`
      : `<span class="text-sm text-muted">${escapeHtml(LEDGER_UNSPECIFIED)}</span>`));
    // The package weight STORED on this row, printed as stored. It is never the current
    // setting and never re-derived, so a changed setting cannot rewrite history.
    detailRows.push(detailRow('سعر الكيلو', Number.isInteger(row.LocalUnitPriceMinor) ? `${escapeHtml(formatMoneyMinor(row.LocalUnitPriceMinor))} ج` : `<span class="text-sm text-muted">${escapeHtml(LEDGER_UNSPECIFIED)}</span>`));
    detailRows.push(detailRow('وزن العبوة المحفوظ', row.PackageWeightKg === null || row.PackageWeightKg === undefined
      ? `<span class="text-sm text-muted">${escapeHtml(LEDGER_UNSPECIFIED)}</span>`
      : `${escapeHtml(String(row.PackageWeightKg))} كجم`));
  }

  return `<table class="table table--numeric"><tbody>${detailRows.join('')}</tbody></table>`;
}

export function initTransactionsView({ container, navigate = null, autoLoad = true } = {}) {
  if (!container) return null;
  const find = (selector) => container.querySelector(selector);
  const state = {
    criteria: { search: '', customerId: '', type: '', from: '', to: '', status: LEDGER_STATUS_FILTER.ALL },
    result: null,
    error: null,
    filterError: null,
    loading: false,
    pending: false,
    hasLoadedOnce: false
  };

  function renderFilterError() {
    const box = find(`#${LEDGER_FILTER_ERROR_ID}`);
    if (!box) return;
    box.innerHTML = state.filterError ? alert({ tone: 'danger', title: 'فلاتر غير صالحة', message: state.filterError }) : '';
  }

  function renderSummary() {
    const box = find(`#${LEDGER_SUMMARY_ID}`);
    if (!box) return;
    box.innerHTML = state.result ? ledgerSummaryHtml(state.result) : '';
  }

  function renderResults() {
    const box = find(`#${LEDGER_RESULTS_ID}`);
    if (!box) return;
    if (state.loading) { box.innerHTML = loadingState({ message: 'جارٍ تحميل الحركات…' }); return; }
    if (state.error) { box.innerHTML = errorState({ title: LEDGER_LOAD_ERROR, message: state.error }); return; }
    if (!state.result) { box.innerHTML = emptyState({ title: 'لم يُحمَّل السجل بعد', message: LEDGER_NO_DATA_MESSAGE }); return; }
    if (!state.result.Rows.length) {
      box.innerHTML = card({
        title: LEDGER_TITLE,
        body: emptyState({ title: state.hasLoadedOnce && state.result.Summary.TotalCount > 0 ? LEDGER_EMPTY_MESSAGE : LEDGER_NO_DATA_MESSAGE })
      });
      return;
    }
    box.innerHTML = card({ title: LEDGER_TITLE, body: rowsHtml(state.result.Rows) });
  }

  function setBusy(busy) {
    state.loading = busy;
    for (const element of container.querySelectorAll('[data-ledger-action="reset"], [data-ledger-action="details"]')) {
      element.disabled = busy;
    }
  }

  // Every run recomputes from the service with the CURRENT criteria; no earlier result is
  // reused, so a changed filter can never show a stale table.
  // A criteria change that arrives while a run is in flight is NOT dropped: it is marked
  // pending and the run repeats with the newest criteria, so the table can never lag behind
  // the controls (a rapid search-then-date sequence used to leave stale rows on screen).
  async function run() {
    if (state.loading) { state.pending = true; return; }
    state.error = null;
    setBusy(true);
    renderFilterError();
    renderResults();
    try {
      const result = await transactionLedgerService.listLedger(state.criteria);
      state.result = result;
      state.hasLoadedOnce = true;
    } catch (error) {
      state.result = null;
      state.error = (error && error.message) ? error.message : LEDGER_LOAD_ERROR;
    } finally {
      setBusy(false);
      renderSummary();
      renderResults();
      if (state.pending) { state.pending = false; await run(); }
    }
  }

  function readCriteriaFromForm() {
    const value = (id) => {
      const element = find(`#${id}`);
      return element ? formatText(element.value) : '';
    };
    return {
      search: value(LEDGER_SEARCH_ID),
      customerId: value(LEDGER_FILTER_FIELD.CUSTOMER),
      type: value(LEDGER_FILTER_FIELD.TYPE),
      from: value(LEDGER_FILTER_FIELD.FROM),
      to: value(LEDGER_FILTER_FIELD.TO),
      status: value(LEDGER_FILTER_FIELD.STATUS) || LEDGER_STATUS_FILTER.ALL
    };
  }

  // Validation lives in the service; the screen only displays the refusal and keeps the
  // criteria it already had, so an invalid range cannot wipe good results.
  async function applyCriteria(next) {
    let normalized;
    try {
      normalized = transactionLedgerService.normalizeFilters(next);
    } catch (error) {
      state.filterError = (error && error.message) ? error.message : 'فلاتر غير صالحة.';
      renderFilterError();
      return;
    }
    state.filterError = null;
    state.criteria = normalized;
    await run();
  }

  async function reset() {
    const search = find(`#${LEDGER_SEARCH_ID}`);
    const customer = find(`#${LEDGER_FILTER_FIELD.CUSTOMER}`);
    const type = find(`#${LEDGER_FILTER_FIELD.TYPE}`);
    const from = find(`#${LEDGER_FILTER_FIELD.FROM}`);
    const to = find(`#${LEDGER_FILTER_FIELD.TO}`);
    const status = find(`#${LEDGER_FILTER_FIELD.STATUS}`);
    if (search) search.value = '';
    if (customer) customer.value = '';
    if (type) type.value = '';
    if (from) from.value = '';
    if (to) to.value = '';
    if (status) status.value = LEDGER_STATUS_FILTER.ALL;
    await applyCriteria({});
  }

  function findRow(rowKey) {
    if (!state.result) return null;
    return state.result.Rows.find((row) => row.RowKey === rowKey) || null;
  }

  function openDetails(rowKey) {
    const row = findRow(rowKey);
    const dialog = find(`#${LEDGER_DETAILS_ID}`);
    const body = find(`#${LEDGER_DETAILS_BODY_ID}`);
    if (!row || !dialog || !body) return;
    body.innerHTML = ledgerDetailsHtml(row);
    const titleNode = find(`#${LEDGER_DETAILS_TITLE_ID}`);
    if (titleNode) titleNode.textContent = 'تفاصيل الحركة';
    dialog.removeAttribute('hidden');
  }

  function closeDetails() {
    const dialog = find(`#${LEDGER_DETAILS_ID}`);
    if (dialog) dialog.setAttribute('hidden', '');
  }

  container.addEventListener('click', (event) => {
    const trigger = event.target && event.target.closest ? event.target.closest('[data-ledger-action]') : null;
    if (!trigger) return;
    const action = trigger.getAttribute('data-ledger-action');
    if (action === LEDGER_ACTION.DETAILS) { openDetails(trigger.getAttribute('data-ledger-row')); return; }
    if (action === LEDGER_ACTION.CLOSE_DETAILS) { closeDetails(); return; }
    if (action === LEDGER_ACTION.RESET) { reset(); }
  });

  // Every filter is live: the criteria are re-read from the form and the service recomputes
  // from stored data. `input` covers typing in the search field and a picked date; `change`
  // covers a select. Both go through the same path, so no control can be left unapplied.
  const FILTER_CONTROL_IDS = [LEDGER_SEARCH_ID, LEDGER_FILTER_FIELD.CUSTOMER, LEDGER_FILTER_FIELD.TYPE, LEDGER_FILTER_FIELD.FROM, LEDGER_FILTER_FIELD.TO, LEDGER_FILTER_FIELD.STATUS];

  function onFilterEdited(event) {
    const target = event.target;
    if (!target || !target.id) return;
    if (!FILTER_CONTROL_IDS.includes(target.id)) return;
    applyCriteria(readCriteriaFromForm());
  }

  container.addEventListener('change', onFilterEdited);
  container.addEventListener('input', onFilterEdited);

  container.addEventListener('submit', (event) => { event.preventDefault(); });

  // Customer filter options are read through the customer service; employees receive
  // only the operational identity fields, never account balances.
  customerService.listSelectableCustomers().then(customers => {
    const select = find(`#${LEDGER_FILTER_FIELD.CUSTOMER}`);
    if (!select) return;
    const current = select.value;
    select.innerHTML = `<option value="">كل العملاء</option>${customers.map(c => `<option value="${escapeHtml(c.Id)}">${escapeHtml([c.Code, c.Name].filter(Boolean).join(' — '))}</option>`).join('')}`;
    select.value = current;
  }).catch(() => {});

  if (autoLoad) run();

  return { state, run, reset, applyCriteria, openDetails, closeDetails, navigate };
}
