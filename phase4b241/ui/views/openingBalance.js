// Phase 4B.14 — opening balance editing UI (dialog + review step).
// Presentation only: this module decides no value, performs no unit conversion and
// keeps no balance. The current value, the new value, the difference and its
// direction all arrive from `openingBalanceService.previewChange()`, and the write
// is a single call to `openingBalanceService.setOpeningBalance()`.
import { alert, field } from '../components/index.js';
import { escapeHtml } from '../components/html.js';
import { formatMoneyMinor } from '../../src/utils/formatting.js';

export const OPENING_BALANCE_REGION_ID = 'opening-balance-region';
export const OPENING_BALANCE_DIALOG_ID = 'dialog-opening-balance';
export const OPENING_BALANCE_FORM_ID = 'opening-balance-form';
export const OPENING_BALANCE_CONFIRM_FORM_ID = 'opening-balance-confirm';
export const OPENING_BALANCE_VALUE_ID = 'opening-balance-new-value';
export const OPENING_BALANCE_REASON_ID = 'opening-balance-reason';
export const OPENING_BALANCE_REVIEW_ID = 'opening-balance-review';
export const OPENING_BALANCE_OPEN_ACTION = 'open-opening-balance';

// Mirrors REASON_MAX_LENGTH in src/validation/customerValidation.js. The attribute is a
// typing aid only; the length rule itself is enforced by the validation layer.
export const OPENING_BALANCE_REASON_MAX = 200;

export const OPENING_BALANCE_STEP = Object.freeze({ FORM: 'form', REVIEW: 'review' });

const UNKNOWN = '—';

export function closedOpeningBalanceState() {
  return {
    open: false,
    step: OPENING_BALANCE_STEP.FORM,
    values: { NewValue: '', Reason: '' },
    preview: null,
    busy: false,
    error: null,
    fieldErrors: {},
    success: null
  };
}

// The label is produced here from values the service already returned; the screen
// never subtracts two balances on its own.
export function openingDeltaLabel(deltaMinor = null, direction = 'None') {
  if (!Number.isInteger(deltaMinor) || direction === 'None') return 'لا يوجد فرق بين القيمتين';
  const amount = formatMoneyMinor(Math.abs(deltaMinor));
  if (direction === 'Increase') return `زيادة بمقدار ${amount}`;
  if (direction === 'Decrease') return `نقصان بمقدار ${amount}`;
  return 'لا يوجد فرق بين القيمتين';
}

function money(minor, fallback = UNKNOWN) {
  return Number.isInteger(minor) ? formatMoneyMinor(minor) : fallback;
}

function metaItem(label, value) {
  return `<span class="account-meta__item"><span class="account-meta__label">${escapeHtml(label)}</span><span class="account-meta__value">${escapeHtml(value)}</span></span>`;
}

function valueControl(value = '', { invalid = false } = {}) {
  return `<input class="input" id="${escapeHtml(OPENING_BALANCE_VALUE_ID)}" name="NewValue" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(value)}"${invalid ? ' aria-invalid="true"' : ''}>`;
}

function reasonControl(value = '', { invalid = false } = {}) {
  return `<input class="input" id="${escapeHtml(OPENING_BALANCE_REASON_ID)}" name="Reason" type="text" maxlength="${OPENING_BALANCE_REASON_MAX}" autocomplete="off" value="${escapeHtml(value)}"${invalid ? ' aria-invalid="true"' : ''}>`;
}

function formStep({ currentMinor, values, fieldErrors, error }) {
  const currentText = money(currentMinor);
  return `<p class="ledger-note">الرصيد الافتتاحي حقل مستقل عن الحركات: تعديله لا ينشئ حركة ولا قيدًا نقديًا ولا تسوية، ويُسجَّل في سجل مستقل.</p>
<div class="account-meta">
${metaItem('الرصيد الافتتاحي الحالي', currentText)}
${metaItem('القيمة المدخلة الآن', String(values.NewValue || '').trim() === '' ? 'لم تُدخل بعد' : String(values.NewValue))}
</div>
<form id="${escapeHtml(OPENING_BALANCE_FORM_ID)}" class="stack" novalidate>
${field({ label: 'الرصيد الافتتاحي الجديد (إلزامي)', controlId: OPENING_BALANCE_VALUE_ID, control: valueControl(values.NewValue, { invalid: Boolean(fieldErrors.NewValue) }), hint: fieldErrors.NewValue || 'يُقبل رقم موجب أو سالب أو صفر، ويُقارن بالقيمة الحالية قبل الحفظ.' })}
${field({ label: 'سبب التعديل (إلزامي)', controlId: OPENING_BALANCE_REASON_ID, control: reasonControl(values.Reason, { invalid: Boolean(fieldErrors.Reason) }), hint: fieldErrors.Reason || `يُحفظ السبب كما أدخلته بعد حذف المسافات الزائدة (حتى ${OPENING_BALANCE_REASON_MAX} حرفًا).` })}
${alert({ tone: 'warning', title: 'مراجعة قبل الحفظ', message: 'لن يُحفظ أي شيء الآن. ستظهر لك مراجعة بالقيمة القديمة والجديدة والفرق والسبب، ويتم الحفظ بعد تأكيدك.' })}
${error ? alert({ tone: 'danger', title: 'تعذّر تجهيز المراجعة', message: error }) : ''}
<div class="row">
  <button class="btn btn--primary" type="submit">مراجعة التعديل</button>
  <button class="btn btn--outline" type="button" data-action="close-opening-balance">إلغاء</button>
</div>
</form>`;
}

function reviewStep({ customerLabel, preview, busy, error, success }) {
  const current = money(preview.CurrentMinor);
  const next = money(preview.NewValueMinor);
  const noChange = preview.NoChange === true;
  return `<div id="${escapeHtml(OPENING_BALANCE_REVIEW_ID)}">
<p class="ledger-note">راجع القيم التالية قبل الحفظ. الحفظ لا يعدّل أي حركة سابقة ولا يضيف حركة جديدة.</p>
<div class="account-meta">
${metaItem('العميل', customerLabel)}
${metaItem('الرصيد الافتتاحي القديم', current)}
${metaItem('الرصيد الافتتاحي الجديد', next)}
${metaItem('الفرق', openingDeltaLabel(preview.DeltaMinor, preview.Direction))}
</div>
<div class="account-meta">${metaItem('سبب التعديل', String(preview.Reason || ''))}</div>
${noChange ? alert({ tone: 'warning', title: 'لا يوجد تغيير', message: 'القيمة الجديدة مطابقة للقيمة الحالية، ولن يُنشأ سجل تعديل. أدخل قيمة مختلفة أو ألغِ العملية.' }) : ''}
${error ? alert({ tone: 'danger', title: 'تعذّر حفظ التعديل', message: error }) : ''}
${success ? alert({ tone: 'success', title: 'تم الحفظ', message: success }) : ''}
<form id="${escapeHtml(OPENING_BALANCE_CONFIRM_FORM_ID)}" class="stack" novalidate>
<div class="row">
  <button class="btn btn--primary" type="submit"${noChange || busy ? ' disabled aria-disabled="true"' : ''}>${busy ? '<span class="spinner" aria-hidden="true"></span><span>جارٍ الحفظ…</span>' : 'تأكيد الحفظ'}</button>
  <button class="btn btn--outline" type="button" data-action="back-opening-balance">رجوع للتعديل</button>
  <button class="btn btn--outline" type="button" data-action="close-opening-balance">إلغاء بدون حفظ</button>
</div>
</form>
</div>`;
}

export function renderOpeningBalanceDialog(state = {}) {
  const current = state || {};
  const open = current.open === true;
  const step = current.step === OPENING_BALANCE_STEP.REVIEW ? OPENING_BALANCE_STEP.REVIEW : OPENING_BALANCE_STEP.FORM;
  const values = current.values || {};
  const fieldErrors = current.fieldErrors || {};
  let body = '';
  if (open && step === OPENING_BALANCE_STEP.REVIEW && current.preview) {
    body = reviewStep({
      customerLabel: current.customerLabel || UNKNOWN,
      preview: current.preview,
      busy: current.busy === true,
      error: current.error || null,
      success: current.success || null
    });
  } else if (open) {
    body = formStep({ currentMinor: current.currentMinor, values, fieldErrors, error: current.error || null });
  }
  const title = step === OPENING_BALANCE_STEP.REVIEW && open ? 'مراجعة تعديل الرصيد الافتتاحي' : 'تعديل الرصيد الافتتاحي';
  return `<div class="modal-backdrop" id="${escapeHtml(OPENING_BALANCE_DIALOG_ID)}"${open ? '' : ' hidden'}>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(OPENING_BALANCE_DIALOG_ID)}-title">
    <header class="modal__header"><h3 id="${escapeHtml(OPENING_BALANCE_DIALOG_ID)}-title">${escapeHtml(title)}</h3></header>
    <div class="modal__body">${body}</div>
  </div>
</div>`;
}

// One region holds the log of the separate field it belongs to plus the dialog that
// edits it, so a repaint can never leave a stale dialog behind.
export function renderOpeningBalanceSection({ rows = [], canEdit = true, dialog = null } = {}) {
  const open = dialog || {};
  const label = OPENING_BALANCE_OPEN_ACTION;
  const button = canEdit && open.open !== true
    ? `<div class="row"><button class="btn btn--primary" type="button" id="${label}" data-action="${label}">تعديل الرصيد الافتتاحي</button></div>`
    : '';
  return { rows, button, dialogHtml: renderOpeningBalanceDialog({ ...open, customerLabel: open.customerLabel || '', currentMinor: open.currentMinor }) };
}

export default { renderOpeningBalanceDialog, renderOpeningBalanceSection, openingDeltaLabel, closedOpeningBalanceState };
