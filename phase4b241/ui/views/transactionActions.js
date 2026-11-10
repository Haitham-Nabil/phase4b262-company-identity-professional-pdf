// Phase 4B.6 — edit / cancel / audit-trail dialogs for the customer statement.
//
// Pure view layer: it renders the stored values it is given and reports intent
// through data-action attributes. It never decides whether a value is financially
// valid, never computes a debit / credit figure and never touches storage — the
// controller of the customer account screen routes every call through the services
// layer, and every rule (direction, crop formula, cancellation, audit) lives there.
import { card, badge, alert, button } from '../components/index.js';
import { emptyState } from '../components/states.js';
import { escapeHtml, attrs } from '../components/html.js';
import { amountClass } from '../components/financial.js';
import { formatMoneyMinor, formatText, formatCount } from '../../src/utils/formatting.js';
import { FIELD_ID, FIELD_LABEL, referenceOptionsFor } from './transactionForm.js';
import { FORM_KEY } from '../../src/services/transactionFormService.js';
import { AUDIT_EVENT_LABEL_AR } from '../../src/services/transactionLifecycleService.js';

export const TRANSACTION_DIALOGS_ID = 'transaction-dialogs';
export const TRANSACTION_AUDIT_ID = 'transaction-audit';
export const TRANSACTION_FEEDBACK_ID = 'transaction-feedback';

export const EDIT_DIALOG_ID = 'dialog-edit-transaction';
export const CANCEL_DIALOG_ID = 'dialog-cancel-transaction';

export const EDIT_FORM_ID = 'edit-transaction-form';
export const CANCEL_FORM_ID = 'cancel-transaction-form';

export const EDIT_REASON_ID = 'edit-reason';
export const EDIT_AMOUNT_ID = 'edit-amount';
export const EDIT_DATE_ID = 'edit-date';
export const EDIT_DESCRIPTION_ID = 'edit-description';
export const EDIT_DIRECTION_ID = 'edit-direction';
export const CANCEL_REASON_ID = 'cancel-reason';
export const CANCEL_CONFIRM_ID = 'cancel-confirm';

export const EMPTY_VALUE = '—';

export const DIRECTION_OPTIONS = Object.freeze([
  { value: 'Credit', label: 'إضافة إلى رصيد المزارع — دائن' },
  { value: 'Debit', label: 'خصم من رصيد المزارع — مدين' }
]);

// milli / minor -> the plain major-unit string a number input shows. No rounding rule
// is applied here: the value is scaled back exactly as it was stored.
export function majorFromMinor(value, factor) {
  if (!Number.isInteger(value)) return '';
  return String(value / factor);
}

function field(label, controlId, control, { hint = null, error = null } = {}) {
  return `<div class="field">
  <label class="field__label" for="${escapeHtml(controlId)}">${escapeHtml(label)}</label>
  ${control}
  ${hint ? `<span class="field__hint">${escapeHtml(hint)}</span>` : ''}
  ${error ? `<span class="field__error">${escapeHtml(error)}</span>` : ''}
</div>`;
}

function numberInput(id, value, { error = null } = {}) {
  return `<input class="input"${attrs({
    id, type: 'number', inputmode: 'decimal', step: 'any', min: '0',
    value: value === '' || value === null || value === undefined ? null : value,
    'aria-invalid': error ? 'true' : null
  })}>`;
}

function textInput(id, value, { error = null } = {}) {
  return `<input class="input"${attrs({
    id, type: 'text',
    value: value === '' || value === null || value === undefined ? null : value,
    'aria-invalid': error ? 'true' : null
  })}>`;
}

function dateInput(id, value, { error = null } = {}) {
  return `<input class="input"${attrs({
    id, type: 'date',
    value: value === '' || value === null || value === undefined ? null : value,
    'aria-invalid': error ? 'true' : null
  })}>`;
}

function selectInput(id, options, selected, { error = null } = {}) {
  const rendered = options
    .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('');
  return `<select class="select"${attrs({ id, 'aria-invalid': error ? 'true' : null })}>${rendered}</select>`;
}

export function directionLabel(direction) {
  const found = DIRECTION_OPTIONS.find((option) => option.value === direction);
  return found ? found.label : EMPTY_VALUE;
}

// The dynamic edit fields, mirroring the Add Transaction field set of the type. The
// amount of a crop purchase is never an input: the form shows the crop inputs only and
// the value is recomputed by the core from those inputs.
export function renderEditFields({ record = {}, fieldErrors = {}, values = null, referenceOptions = null } = {}) {
  const type = record.TransactionType;
  const rows = [];
  // A value the user already typed wins over the stored value, so repainting the form
  // (for example when a validation error is shown) never discards what was entered.
  const shown = (key, fallback) => (values && values[key] !== undefined && values[key] !== null ? values[key] : fallback);

  if (type === 'CropPurchaseLocal') {
    // Phase 4B.13.1 — the stored variety is shown as the CURRENT selection of a
    // service-backed dropdown. An inactive (or no longer resolvable) record is merged back
    // in and marked, and the list never falls back to a default or to the first option, so
    // opening the dialog cannot silently re-point the movement.
    const varietySelected = shown(FORM_KEY.STRAWBERRY_VARIETY, record.StrawberryVarietyId ?? '');
    rows.push(field(FIELD_LABEL.StrawberryVarietyId, FIELD_ID.StrawberryVarietyId, selectInput(
      FIELD_ID.StrawberryVarietyId,
      referenceOptionsFor('StrawberryVariety', { referenceOptions, selected: varietySelected }),
      varietySelected,
      { error: fieldErrors.StrawberryVarietyId }
    ), { hint: 'بيان وصفي؛ لا يغيّر الوزن ولا المبلغ', error: fieldErrors.StrawberryVarietyId }));
    rows.push(field(FIELD_LABEL.Units, FIELD_ID.Units, numberInput(FIELD_ID.Units, shown(FORM_KEY.UNITS, majorFromMinor(record.LocalUnitsMilli, 1000)), { error: fieldErrors.LocalUnitsMilli }), { error: fieldErrors.LocalUnitsMilli }));
    rows.push(field(FIELD_LABEL.LooseKg, FIELD_ID.LooseKg, numberInput(FIELD_ID.LooseKg, shown(FORM_KEY.LOOSE_KG, majorFromMinor(record.LocalLooseKgMilli, 1000)), { error: fieldErrors.LocalLooseKgMilli }), { error: fieldErrors.LocalLooseKgMilli }));
    rows.push(field(FIELD_LABEL.DeductionKg, FIELD_ID.DeductionKg, numberInput(FIELD_ID.DeductionKg, shown(FORM_KEY.DEDUCTION_KG, majorFromMinor(record.LocalDeductionKgMilli, 1000)), { error: fieldErrors.LocalDeductionKgMilli }), { error: fieldErrors.LocalDeductionKgMilli }));
    rows.push(field(FIELD_LABEL.UnitPrice, FIELD_ID.UnitPrice, numberInput(FIELD_ID.UnitPrice, shown(FORM_KEY.UNIT_PRICE, majorFromMinor(record.LocalUnitPriceMinor, 100)), { error: fieldErrors.LocalUnitPriceMinor }), { hint: 'بالوحدات الرئيسية', error: fieldErrors.LocalUnitPriceMinor }));
  } else if (type === 'CropPurchaseCarton') {
    // Phase 4B.11 fix — the two references the row already stores are shown as the CURRENT
    // selection of two service-backed dropdowns. `referenceOptionsFor` merges the stored
    // record back into the list (labelled «غير نشطة» when it was deactivated) and never
    // falls back to a default or to the first option, so opening the form cannot silently
    // re-point the movement.
    const companySelected = shown(FORM_KEY.RECEIVING_COMPANY, record.ReceivingCompanyId ?? '');
    const typeSelected = shown(FORM_KEY.CARTON_TYPE, record.CartonTypeId ?? '');
    rows.push(field(FIELD_LABEL.ReceivingCompanyId, FIELD_ID.ReceivingCompanyId, selectInput(
      FIELD_ID.ReceivingCompanyId,
      referenceOptionsFor('ReceivingCompany', { referenceOptions, selected: companySelected }),
      companySelected,
      { error: fieldErrors.ReceivingCompanyId }
    ), { error: fieldErrors.ReceivingCompanyId }));
    rows.push(field(FIELD_LABEL.CartonTypeId, FIELD_ID.CartonTypeId, selectInput(
      FIELD_ID.CartonTypeId,
      referenceOptionsFor('CartonType', { referenceOptions, selected: typeSelected }),
      typeSelected,
      { error: fieldErrors.CartonTypeId }
    ), { error: fieldErrors.CartonTypeId }));
    rows.push(field(FIELD_LABEL.CartonQuantity, FIELD_ID.CartonQuantity, numberInput(FIELD_ID.CartonQuantity, shown(FORM_KEY.CARTON_QUANTITY, majorFromMinor(record.CartonQuantityMilli, 1000)), { error: fieldErrors.CartonQuantityMilli }), { error: fieldErrors.CartonQuantityMilli }));
    rows.push(field(FIELD_LABEL.CartonDiscount, FIELD_ID.CartonDiscount, numberInput(FIELD_ID.CartonDiscount, shown(FORM_KEY.CARTON_DISCOUNT, majorFromMinor(record.CartonDiscountMinor, 100)), { error: fieldErrors.CartonDiscountMinor }), { error: fieldErrors.CartonDiscountMinor }));
    rows.push(field(FIELD_LABEL.CartonPrice, FIELD_ID.CartonPrice, numberInput(FIELD_ID.CartonPrice, shown(FORM_KEY.CARTON_PRICE, majorFromMinor(record.CartonUnitPriceMinor, 100)), { error: fieldErrors.CartonUnitPriceMinor }), { hint: 'بالوحدات الرئيسية', error: fieldErrors.CartonUnitPriceMinor }));
  } else {
    rows.push(field(FIELD_LABEL.Amount, EDIT_AMOUNT_ID, numberInput(EDIT_AMOUNT_ID, shown(FORM_KEY.AMOUNT, majorFromMinor(record.AmountMinor, 100)), { error: fieldErrors.Amount }), { error: fieldErrors.Amount }));
  }

  if (type === 'Settlement' || type === 'GoodsExchange') {
    rows.push(field('اتجاه الحركة', EDIT_DIRECTION_ID, selectInput(EDIT_DIRECTION_ID, DIRECTION_OPTIONS, shown(FORM_KEY.DIRECTION, record.Direction === 'Debit' ? 'Debit' : 'Credit'), { error: fieldErrors.Direction }), { hint: 'الاتجاه بيان صريح محفوظ على الحركة', error: fieldErrors.Direction }));
  }

  rows.push(field(FIELD_LABEL.Date, EDIT_DATE_ID, dateInput(EDIT_DATE_ID, shown(FORM_KEY.DATE, formatText(record.Date) || ''), { error: fieldErrors.Date }), { error: fieldErrors.Date }));
  rows.push(field(FIELD_LABEL.Description, EDIT_DESCRIPTION_ID, textInput(EDIT_DESCRIPTION_ID, shown(FORM_KEY.DESCRIPTION, record.Description ?? ''), { error: fieldErrors.Description }), { error: fieldErrors.Description }));
  rows.push(field('سبب التعديل (إلزامي)', EDIT_REASON_ID, textInput(EDIT_REASON_ID, shown(FORM_KEY.EDIT_REASON, ''), { error: fieldErrors.Reason }), { hint: 'يُحفظ السبب في سجل التدقيق مع القيم قبل التعديل وبعده', error: fieldErrors.Reason }));

  return rows.join('\n');
}

export function renderEditDialog({ record = null, editability = null, fieldErrors = {}, error = null, busy = false, success = null, values = null, referenceOptions = null } = {}) {
  const open = Boolean(record);
  const title = 'تعديل الحركة';
  let body = '';
  if (record) {
    const typeLabel = formatText(record.TransactionType);
    const customerName = formatText(record.CustomerName) || formatText(record.CustomerCode) || EMPTY_VALUE;
    body = `<p class="ledger-note">المعرّف الأصلي للحركة يُحفظ كما هو، ونوع الحركة والعميل لا يتغيران بالتعديل. تعديل النوع أو العميل يتطلب إلغاء الحركة وتسجيل حركة جديدة.</p>
<div class="account-meta">
  <span class="account-meta__item"><span class="account-meta__label">المعرّف</span><span class="account-meta__value">${escapeHtml(String(record.Id))}</span></span>
  <span class="account-meta__item"><span class="account-meta__label">العميل</span><span class="account-meta__value">${escapeHtml(customerName)}</span></span>
  <span class="account-meta__item"><span class="account-meta__label">النوع</span><span class="account-meta__value">${escapeHtml(typeLabel)}</span></span>
</div>
<form id="${escapeHtml(EDIT_FORM_ID)}" class="stack" novalidate data-transaction-id="${escapeHtml(String(record.Id))}">
${renderEditFields({ record, fieldErrors, values, referenceOptions })}
${error ? alert({ tone: 'danger', title: 'تعذّر حفظ التعديل', message: error }) : ''}
${success ? alert({ tone: 'success', title: 'تم حفظ التعديل', message: success }) : ''}
<div class="row">
  <button class="btn btn--primary" type="submit" id="edit-submit"${busy ? ' disabled aria-disabled="true"' : ''}>${busy ? '<span class="spinner" aria-hidden="true"></span><span>جارٍ الحفظ…</span>' : 'حفظ التعديل'}</button>
  <button class="btn btn--outline" type="button" data-action="close-dialog">إلغاء</button>
</div>
</form>`;
  } else if (editability && editability.CanEdit === false) {
    body = alert({ tone: 'info', title: 'التعديل غير متاح', message: formatText(editability.EditReason) || EMPTY_VALUE });
  }
  return `<div class="modal-backdrop" id="${escapeHtml(EDIT_DIALOG_ID)}"${open ? '' : ' hidden'}>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(EDIT_DIALOG_ID)}-title">
    <header class="modal__header"><h3 id="${escapeHtml(EDIT_DIALOG_ID)}-title">${escapeHtml(title)}</h3></header>
    <div class="modal__body">${body}</div>
  </div>
</div>`;
}

export function renderCancelDialog({ record = null, fieldErrors = {}, error = null, busy = false, success = null } = {}) {
  const open = Boolean(record);
  let body = '';
  if (record) {
    body = `<p class="ledger-note">الإلغاء لا يحذف الحركة: تبقى ظاهرة في كشف الحساب بشارة «ملغاة» مع سبب الإلغاء، وتُستبعد من الرصيد ومن كل الإجماليات المالية.</p>
<div class="account-meta">
  <span class="account-meta__item"><span class="account-meta__label">المعرّف</span><span class="account-meta__value">${escapeHtml(String(record.Id))}</span></span>
  <span class="account-meta__item"><span class="account-meta__label">التاريخ</span><span class="account-meta__value">${escapeHtml(formatText(record.Date) || EMPTY_VALUE)}</span></span>
  <span class="account-meta__item"><span class="account-meta__label">المبلغ</span><span class="account-meta__value">${escapeHtml(formatMoneyMinor(record.AmountMinor))}</span></span>
</div>
<form id="${escapeHtml(CANCEL_FORM_ID)}" class="stack" novalidate data-transaction-id="${escapeHtml(String(record.Id))}">
${field('سبب الإلغاء (إلزامي)', CANCEL_REASON_ID, textInput(CANCEL_REASON_ID, '', { error: fieldErrors.Reason }), { hint: 'يُحفظ السبب مع تاريخ ووقت الإلغاء في سجل التدقيق', error: fieldErrors.Reason })}
${alert({ tone: 'warning', title: 'تأكيد مطلوب', message: 'لا يمكن التراجع عن الإلغاء من هذه الشاشة. أكّد الإلغاء للمتابعة.' })}
${error ? alert({ tone: 'danger', title: 'تعذّر إلغاء الحركة', message: error }) : ''}
${success ? alert({ tone: 'success', title: 'تم إلغاء الحركة', message: success }) : ''}
<div class="row">
  <button class="btn btn--primary" type="submit" id="${escapeHtml(CANCEL_CONFIRM_ID)}"${busy ? ' disabled aria-disabled="true"' : ''}>${busy ? '<span class="spinner" aria-hidden="true"></span><span>جارٍ الإلغاء…</span>' : 'تأكيد الإلغاء'}</button>
  <button class="btn btn--outline" type="button" data-action="close-dialog">رجوع</button>
</div>
</form>`;
  }
  return `<div class="modal-backdrop" id="${escapeHtml(CANCEL_DIALOG_ID)}"${open ? '' : ' hidden'}>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(CANCEL_DIALOG_ID)}-title">
    <header class="modal__header"><h3 id="${escapeHtml(CANCEL_DIALOG_ID)}-title">إلغاء الحركة</h3></header>
    <div class="modal__body">${body}</div>
  </div>
</div>`;
}

function snapshotLine(label, snapshot) {
  if (!snapshot) return `<span class="audit-item__value">${EMPTY_VALUE}</span>`;
  const debit = Number.isInteger(snapshot.DebitMinor) && snapshot.DebitMinor > 0 ? formatMoneyMinor(snapshot.DebitMinor) : null;
  const credit = Number.isInteger(snapshot.CreditMinor) && snapshot.CreditMinor > 0 ? formatMoneyMinor(snapshot.CreditMinor) : null;
  const side = debit ? `<span class="${escapeHtml(amountClass('debit'))}">مدين ${escapeHtml(debit)}</span>` : (credit ? `<span class="${escapeHtml(amountClass('credit'))}">دائن ${escapeHtml(credit)}</span>` : EMPTY_VALUE);
  const parts = [
    `التاريخ: ${formatText(snapshot.Date) || EMPTY_VALUE}`,
    `المبلغ: ${Number.isInteger(snapshot.AmountMinor) ? formatMoneyMinor(snapshot.AmountMinor) : EMPTY_VALUE}`,
    `البيان: ${formatText(snapshot.Description) || EMPTY_VALUE}`,
    snapshot.Direction ? `الاتجاه: ${formatText(snapshot.Direction)}` : null,
    snapshot.CancellationReason ? `سبب الإلغاء: ${formatText(snapshot.CancellationReason)}` : null
  ].filter(Boolean);
  return `<span class="audit-item__value">${parts.map((part) => escapeHtml(part)).join(' · ')}</span>
<span class="audit-item__value">${label} ${side}</span>`;
}

export function renderAuditEntry(entry = {}) {
  const label = AUDIT_EVENT_LABEL_AR[entry.EventType] || formatText(entry.EventType) || EMPTY_VALUE;
  return `<div class="audit-item">
  <div class="audit-item__head">
    <span class="badge">${escapeHtml(label)}</span>
    <span class="audit-item__time">${escapeHtml(formatText(entry.OccurredAt) || EMPTY_VALUE)}</span>
  </div>
  <span class="audit-item__reason">السبب: ${escapeHtml(formatText(entry.Reason) || EMPTY_VALUE)}</span>
  ${entry.Previous ? `<div class="audit-item__block"><span class="audit-item__caption">القيم قبل العملية</span>${snapshotLine('الأثر', entry.Previous)}</div>` : ''}
  ${entry.Next ? `<div class="audit-item__block"><span class="audit-item__caption">القيم بعد العملية</span>${snapshotLine('الأثر', entry.Next)}</div>` : ''}
  ${entry.ActorId ? `<span class="audit-item__value">منفّذ العملية: ${escapeHtml(String(entry.ActorId))}</span>` : ''}
</div>`;
}

export function renderAuditTrail({ transactionId = null, entries = [], record = null } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const title = `سجل التدقيق${transactionId ? ` — ${transactionId}` : ''}`;
  if (!list.length) {
    return card({
      title,
      body: `<p class="ledger-note">لا توجد تعديلات أو إلغاءات مسجلة على هذه الحركة. سجل التدقيق يُكتب مرة واحدة عند كل تعديل أو إلغاء ولا يمكن تعديله أو حذفه من الواجهة.</p>`
    });
  }
  const header = record ? `<p class="ledger-note">الحركة: ${escapeHtml(formatText(record.TransactionType) || EMPTY_VALUE)} · ${escapeHtml(formatText(record.Date) || EMPTY_VALUE)} · ${escapeHtml(formatMoneyMinor(record.AmountMinor))}</p>` : '';
  return card({
    title,
    body: `${header}<div class="audit-list">${list.map(renderAuditEntry).join('\n')}</div>
<p class="ledger-note">عدد أحداث سجل التدقيق: ${escapeHtml(formatCount(list.length))}. الأثر المالي معروض كما اشتقه المحرك المالي المعتمد، ولا يمكن تعديل السجل أو حذفه.</p>`
  });
}

// One row's actions. A movement that may not be edited or cancelled simply shows no
// button for it — the reason is explained by the audit trail and the status badge
// rather than by an action that would fail.
export function rowActionsCell(entry = {}) {
  const record = entry || {};
  const id = escapeHtml(String(record.Id ?? ''));
  const actions = [];
  if (record.CanEdit === true) actions.push(`<button class="btn btn--outline btn--sm" type="button" data-action="edit-transaction" data-transaction-id="${id}">تعديل</button>`);
  if (record.CanCancel === true) actions.push(`<button class="btn btn--outline btn--sm" type="button" data-action="cancel-transaction" data-transaction-id="${id}">إلغاء</button>`);
  actions.push(`<button class="btn btn--ghost btn--sm" type="button" data-action="view-audit" data-transaction-id="${id}">سجل التدقيق</button>`);
  return `<div class="row-actions">${actions.join('')}</div>`;
}

export function renderTransactionFeedback({ message = null, tone = 'success' } = {}) {
  if (!message) return '';
  return alert({ tone, title: tone === 'success' ? 'تمت العملية' : 'ملاحظة', message });
}

export function renderBlockedNotice({ editability = null } = {}) {
  if (!editability) return '';
  if (editability.CanEdit === false && editability.CanCancel === false && editability.EditReason) {
    return alert({ tone: 'info', title: 'الإجراءات غير متاحة لهذه الحركة', message: editability.EditReason });
  }
  return '';
}

export function renderLifecycleLegend() {
  return `<p class="ledger-note">التعديل يحافظ على معرّف الحركة الأصلية ويعيد اشتقاق أثرها المالي من المحرك المعتمد. الإلغاء لا يحذف الحركة: يبقى السجل ظاهرًا بشارة «ملغاة» ويُستبعد من الرصيد والإجماليات. كل عملية تُسجَّل في سجل تدقيق دائم لا يمكن تعديله أو حذفه.</p>
${button({ label: 'الإجراءات المتاحة لكل حركة تظهر داخل صفها', variant: 'outline', disabled: true })}`;
}

