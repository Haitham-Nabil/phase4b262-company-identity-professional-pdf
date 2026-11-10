import { authService } from '../../src/services/authService.js';
// Add Transaction screen (Phase 4B.3). It collects input and delegates: every
// financial decision — direction, cash / non-cash, crop value and balance — is
// made below the UI. This module never imports the data layer, never contains a
// financial engine and never writes a balance figure of its own.
import { pageHeader, card, alert, attrs } from '../components/index.js';
import { loadingState } from '../components/states.js';
import { escapeHtml } from '../components/html.js';
import { formatMoneyMinor, formatQuantityMinor, formatText } from '../../src/utils/formatting.js';
import { logger } from '../../src/utils/logger.js';
import { customerAccountPath, customerListPath } from '../routes.js';
import { buildHash } from '../router.js';
import {
  transactionFormService,
  TRANSACTION_TYPES,
  TRANSACTION_TYPE_LABELS_AR,
  TRANSACTION_TYPE,
  isCropPurchaseType,
  FORM_KEY,
  emptyForm,
  previewTransfer,
  // Phase 4B.11 — the two reference catalogues, read and created through services only.
  listReferenceOptions,
  createReceivingCompany,
  createCartonType,
  // Phase 4B.13.1 — the strawberry variety catalogue, through the same facade.
  createStrawberryVariety
} from '../../src/services/transactionFormService.js';

export const TRANSACTION_FORM_REGION_ID = 'transaction-form-region';
export const DYNAMIC_FIELDS_ID = 'dynamic-fields';
export const CROP_PREVIEW_ID = 'crop-preview';
export const FORM_ERROR_ID = 'transaction-form-error';
export const SUCCESS_REGION_ID = 'transaction-success';
// Phase 4B.9 — Debt transfer: the read-only two-sided preview and its explicit
// confirmation panel.
export const TRANSFER_PREVIEW_ID = 'transfer-preview';
export const TRANSFER_CONFIRM_ID = 'transfer-confirm';
export const TRANSFER_CONFIRM_SUBMIT_ID = 'transfer-confirm-submit';
// Phase 4B.11 — the inline "add a new reference record" panel used by the carton fields.
export const REFERENCE_PANEL_ID = 'reference-add-panel';
export const REFERENCE_PANEL_INPUT_ID = 'reference-add-name';
export const REFERENCE_PANEL_ERROR_ID = 'reference-add-error';

export const FIELD_ID = Object.freeze({
  TransactionType: 'field-TransactionType',
  CustomerId: 'field-CustomerId',
  CustomerSearch: 'customer-search',
  FromCustomerId: 'field-FromCustomerId',
  ToCustomerId: 'field-ToCustomerId',
  Date: 'field-Date',
  Description: 'field-Description',
  Amount: 'field-Amount',
  Units: 'field-Units',
  LooseKg: 'field-LooseKg',
  DeductionKg: 'field-DeductionKg',
  UnitPrice: 'field-UnitPrice',
  CartonQuantity: 'field-CartonQuantity',
  CartonDiscount: 'field-CartonDiscount',
  CartonPrice: 'field-CartonPrice',
  ReceivingCompanyId: 'field-ReceivingCompanyId',
  CartonTypeId: 'field-CartonTypeId',
  StrawberryVarietyId: 'field-StrawberryVarietyId'
});

export const FIELD_LABEL = Object.freeze({
  CustomerId: 'العميل',
  FromCustomerId: 'العميل الدائن (الطرف الأول)',
  ToCustomerId: 'العميل المدين (الطرف الثاني)',
  Date: 'التاريخ',
  Description: 'البيان (اختياري)',
  Amount: 'المبلغ',
  Units: 'عدد العبوات (D)',
  LooseKg: 'الكيلو السائب (E)',
  DeductionKg: 'خصم الكيلو (F)',
  UnitPrice: 'سعر الكيلو (H)',
  CartonQuantity: 'الكمية (K)',
  CartonDiscount: 'خصم المبلغ (M)',
  CartonPrice: 'السعر (L)',
  ReceivingCompanyId: 'الشركة المستلمة للمحصول',
  CartonTypeId: 'نوع الكرتونة',
  StrawberryVarietyId: 'صنف الفراولة'
});

// Display-only description of the approved meaning of each type. It is copy, not a
// rule: nothing downstream reads it and no direction is derived from it.
export const TYPE_NOTE = Object.freeze({
  [TRANSACTION_TYPE.SALE_PESTICIDES]: 'بيع مبيدات يُسجَّل مدينًا على العميل.',
  [TRANSACTION_TYPE.SALE_IRRIGATION]: 'بيع شبكات ري يُسجَّل مدينًا على العميل.',
  [TRANSACTION_TYPE.SALES_RETURN]: 'مرتجع مبيعات يُسجَّل دائنًا للعميل.',
  [TRANSACTION_TYPE.CROP_PURCHASE_LOCAL]: 'تُحتسب القيمة من بيانات المحصول وإعداد الوزن الافتراضي للعبوة؛ لا يُدخل المبلغ يدويًا. صنف الفراولة بيان مرجعي وصفى بلا أثر مالي.',
  [TRANSACTION_TYPE.CROP_PURCHASE_CARTON]: 'تُحتسب القيمة من عدد الكراتين وسعرها؛ الشركة المستلمة ونوع الكرتونة بيانات مرجعية فقط وبلا أثر مالي.',
  [TRANSACTION_TYPE.CASH_RECEIVED]: 'العميل يدفع نقدية للشركة.',
  [TRANSACTION_TYPE.CASH_PAID]: 'الشركة تدفع نقدية للعميل.',
  [TRANSACTION_TYPE.SETTLEMENT]: 'تسوية غير نقدية؛ لا حركة نقدية معها.',
  [TRANSACTION_TYPE.GOODS_EXCHANGE]: 'تبادل بضائع غير نقدي؛ لا حركة نقدية معه.',
  [TRANSACTION_TYPE.DEBT_TRANSFER]: 'تحويل مديونية بين عميلين؛ لا حركة نقدية معه.'
});

// Phase 4B.9 — Debt transfer: the two parties, a read-only preview filled by the
// services layer, and one explicit confirmation when the receiving side would go
// negative. The screen prints the values the service returned; it computes none.
export const TRANSFER_ROLE_LABEL_AR = Object.freeze({ CreditSide: 'دائن', DebitSide: 'مدين' });
export const SAME_CUSTOMER_MESSAGE = 'لا يمكن اختيار العميل نفسه في الطرفين؛ اختر عميلين مختلفين.';
export const TRANSFER_CONFIRM_MESSAGE = 'رصيد العميل المحوّل إليه لا يكفي لتغطية التحويل؛ سيصبح رصيده سالبًا. أكّد المتابعة للحفظ.';

export function isTransferType(transactionType) {
  return transactionType === TRANSACTION_TYPE.DEBT_TRANSFER;
}

function textOf(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

// The two parties of a transfer, read straight from the form values.
export function transferParties(values = {}) {
  const from = textOf(values[FORM_KEY.FROM_CUSTOMER]);
  const to = textOf(values[FORM_KEY.TO_CUSTOMER]);
  return { FromCustomerId: from, ToCustomerId: to, Same: Boolean(from) && from === to };
}

function moneyCell(value) {
  return Number.isInteger(value) ? formatMoneyMinor(value) : EMPTY_VALUE;
}

function transferPartyLabel(party) {
  const parts = [formatText(party && party.Code), formatText(party && party.Name)].filter(Boolean);
  return parts.length ? parts.join(' — ') : EMPTY_VALUE;
}

function transferPreviewItem(label, value) {
  return `<span class="preview-item"><span class="preview-item__label">${escapeHtml(label)}</span><span class="preview-item__value">${escapeHtml(value)}</span></span>`;
}

// Presentation of the preview the service returned. Nothing is derived here: the
// current and the projected balance of both sides, the amount and the cash impact
// are all values read back from the services layer.
export function renderTransferPreview({ preview = null, awaitingConfirm = false } = {}) {
  const items = [];
  let warning = '';
  let panel = '';
  if (!preview) {
    items.push(transferPreviewItem('الحالة', 'اختر الطرفين وأدخل المبلغ والتاريخ لعرض معاينة الأثر على الحسابين.'));
  } else if (preview.Valid !== true) {
    items.push(transferPreviewItem('الحالة', preview.Message || 'تعذّر إعداد المعاينة.'));
  } else {
    items.push(transferPreviewItem('العميل المحوّل منه', transferPartyLabel(preview.From)));
    items.push(transferPreviewItem('رصيده الحالي', moneyCell(preview.From.CurrentBalanceMinor)));
    items.push(transferPreviewItem('رصيده المتوقع بعد التحويل', moneyCell(preview.From.ProjectedBalanceMinor)));
    items.push(transferPreviewItem('العميل المحوّل إليه', transferPartyLabel(preview.To)));
    items.push(transferPreviewItem('رصيده الحالي', moneyCell(preview.To.CurrentBalanceMinor)));
    items.push(transferPreviewItem('رصيده المتوقع بعد التحويل', moneyCell(preview.To.ProjectedBalanceMinor)));
    items.push(transferPreviewItem('مبلغ التحويل', moneyCell(preview.AmountMinor)));
    items.push(transferPreviewItem('الأثر النقدي', moneyCell(preview.CashImpactMinor)));
    if (preview.Insufficient === true) {
      warning = alert({ tone: 'warning', title: 'تحذير: الرصيد غير كافٍ', message: TRANSFER_CONFIRM_MESSAGE });
      panel = awaitingConfirm
        ? `<div class="confirm-panel" id="${TRANSFER_CONFIRM_ID}"><button class="btn btn--primary" type="button" id="${TRANSFER_CONFIRM_SUBMIT_ID}" data-action="confirm-transfer">تأكيد الحفظ</button><button class="btn btn--outline" type="button" data-action="dismiss-confirm">رجوع</button></div>`
        : `<div class="confirm-panel" id="${TRANSFER_CONFIRM_ID}"></div>`;
    }
  }
  return card({
    title: 'معاينة التحويل (عرض فقط)',
    body: `<p class="text-sm text-muted">الأرصدة المعروضة تقرأها الشاشة من طبقة الخدمات؛ لا تُحسب هنا ولا يمكن تعديلها من النموذج.</p>
<div class="preview-grid">${items.join('')}</div>${warning}${panel}`
  });
}

const BALANCE_SIDE_TEXT = Object.freeze({
  Credit: 'رصيد لصالح العميل',
  Debit: 'رصيد على العميل',
  Zero: 'رصيد متعادل'
});

const EMPTY_VALUE = '—';

export function customerLabel(customer) {
  const code = formatText(customer && customer.Code);
  const name = formatText(customer && customer.Name);
  const parts = [code, name].filter(Boolean);
  return parts.length ? parts.join(' — ') : `عميل ${EMPTY_VALUE}`;
}

function controlIdFor(key) {
  return FIELD_ID[key] || `field-${key}`;
}

function textControl({ key, value, invalid = false, hintId = null, type = 'text', inputmode = null, step = null, min = null }) {
  return `<input class="input" ${attrs({
    id: controlIdFor(key),
    type,
    value: value === '' || value === null || value === undefined ? null : value,
    inputmode,
    step,
    min,
    'aria-invalid': invalid ? 'true' : null,
    'aria-describedby': hintId
  })}>`;
}

function numberControl({ key, value, invalid = false, hintId = null }) {
  return textControl({ key, value, invalid, hintId, type: 'number', inputmode: 'decimal', step: 'any', min: '0' });
}

function selectControl({ key, options, selected = null, disabled = false, invalid = false, hintId = null }) {
  return `<select class="select" ${attrs({ id: controlIdFor(key), disabled, 'aria-invalid': invalid ? 'true' : null, 'aria-describedby': hintId })}>${
    options.map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')
  }</select>`;
}

// One labelled field. A validation error is bound to its control through
// aria-describedby, so it is announced and not merely coloured.
export function fieldBlock({ key, label = null, control, hint = null, error = null }) {
  const id = controlIdFor(key);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  let bound = control;
  if (describedBy && typeof bound === 'string' && !bound.includes('aria-describedby')) {
    bound = bound.replace('<input', `<input aria-describedby="${describedBy}"`).replace('<select', `<select aria-describedby="${describedBy}"`);
  }
  return `<div class="field">
  <label class="field__label" for="${escapeHtml(id)}">${escapeHtml(label || FIELD_LABEL[key] || key)}</label>
  ${bound}
  ${hint ? `<span class="field__hint" id="${escapeHtml(hintId)}">${escapeHtml(hint)}</span>` : ''}
  ${error ? `<span class="field__error" id="${escapeHtml(errorId)}">${escapeHtml(error)}</span>` : ''}
</div>`;
}

export function transactionTypeOptions() {
  return TRANSACTION_TYPES.map((type) => ({ value: type, label: TRANSACTION_TYPE_LABELS_AR[type] || type }));
}

export function customerOptions(customers = []) {
  return [{ value: '', label: '— اختر العميل —' }].concat(
    customers.map((customer) => ({ value: customer.Id, label: customerLabel(customer) }))
  );
}

export function typeNote(transactionType) {
  return TYPE_NOTE[transactionType] || null;
}

// Phase 4B.11 — the two reference choices of a carton purchase. Both lists show the
// ACTIVE records only (an inactive record cannot enter a new movement) plus the value the
// form already carries, so an existing choice is never silently dropped. The screen only
// prints what the services returned.
export function referenceOptionsFor(kind, { referenceOptions = null, selected = null } = {}) {
  const source = referenceOptions || {};
  const rows = kind === 'ReceivingCompany'
    ? source.ReceivingCompanies
    : (kind === 'StrawberryVariety' ? source.StrawberryVarieties : source.CartonTypes);
  const list = Array.isArray(rows) ? rows : [];
  const options = [{ value: '', label: '— غير محدد —' }];
  for (const row of list) {
    if (row.IsActive === false && row.Id !== selected) continue;
    const suffix = row.IsActive === false ? ' (غير نشطة)' : '';
    options.push({ value: row.Id, label: `${row.Name}${suffix}` });
  }
  if (selected && !options.some((option) => option.value === selected)) {
    options.push({ value: selected, label: 'سجل غير متاح (غير نشط أو محذوف)' });
  }
  return options;
}

const ADD_LABEL = Object.freeze({
  ReceivingCompany: 'إضافة شركة مستلمة جديدة',
  CartonType: 'إضافة نوع كرتونة جديد',
  StrawberryVariety: 'إضافة صنف فراولة جديد'
});

const ADD_ACTION = Object.freeze({
  ReceivingCompany: 'add-receiving-company',
  CartonType: 'add-carton-type',
  StrawberryVariety: 'add-strawberry-variety'
});

function referenceAddButton(kind) {
  return `<button class="btn btn--outline btn--small" type="button" data-action="${ADD_ACTION[kind]}" data-reference-kind="${kind}">${escapeHtml(ADD_LABEL[kind])}</button>`;
}

// The inline add panel. It writes ONE reference record through the services layer and
// never creates a movement, an amount or a balance.
export function renderReferenceAddPanel({ panel = null } = {}) {
  if (!panel || !panel.kind) return '';
  const label = panel.kind === 'ReceivingCompany'
    ? 'اسم الشركة المستلمة'
    : (panel.kind === 'StrawberryVariety' ? 'اسم صنف الفراولة' : 'اسم نوع الكرتونة');
  const error = panel.error ? `<span class="field__error" id="${REFERENCE_PANEL_ERROR_ID}">${escapeHtml(panel.error)}</span>` : '';
  const busy = panel.busy === true;
  return `<div class="reference-add" id="${REFERENCE_PANEL_ID}" data-reference-kind="${escapeHtml(panel.kind)}">
  <label class="field__label" for="${REFERENCE_PANEL_INPUT_ID}">${escapeHtml(label)}</label>
  <div class="row">
    <input class="input" id="${REFERENCE_PANEL_INPUT_ID}" type="text" value="${escapeHtml(panel.name || '')}" ${busy ? 'disabled' : ''} aria-describedby="${REFERENCE_PANEL_ERROR_ID}">
    <button class="btn btn--primary btn--small" type="button" data-action="save-reference"${busy ? ' disabled aria-disabled="true"' : ''}>حفظ</button>
    <button class="btn btn--outline btn--small" type="button" data-action="cancel-reference"${busy ? ' disabled aria-disabled="true"' : ''}>إلغاء</button>
  </div>
  ${error}
</div>`;
}

// Dynamic fields for one type (spec §7, §25): only the fields that type needs.
// No crop purchase ever renders an Amount control; the crop value is derived.
export function renderDynamicFields({
  transactionType = '',
  values = null,
  fieldErrors = {},
  preview = null,
  awaitingConfirm = false,
  referenceOptions = null,
  referencePanel = null
} = {}) {
  if (!transactionType) {
    return '<p class="text-sm text-muted">اختر نوع الحركة لعرض الحقول المطلوبة.</p>';
  }
  const form = values || emptyForm({ transactionType });
  const errorFor = (key) => fieldErrors[key] || null;
  const keys = transactionFormService.formFields(transactionType);
  const blocks = [];
  for (const key of keys) {
    if (key === FORM_KEY.CUSTOMER || key === FORM_KEY.FROM_CUSTOMER || key === FORM_KEY.TO_CUSTOMER || key === FORM_KEY.DATE) continue;
    if (key === FORM_KEY.DESCRIPTION) {
      blocks.push(fieldBlock({ key, control: textControl({ key, value: form[key], invalid: Boolean(errorFor(key)) }), error: errorFor(key) }));
      continue;
    }
    // Phase 4B.11 / 4B.13.1 — the reference choices, each with its own "add new" action:
    // the carton pairs and the strawberry variety of a local purchase.
    if (key === FORM_KEY.RECEIVING_COMPANY || key === FORM_KEY.CARTON_TYPE || key === FORM_KEY.STRAWBERRY_VARIETY) {
      const kind = key === FORM_KEY.RECEIVING_COMPANY
        ? 'ReceivingCompany'
        : (key === FORM_KEY.STRAWBERRY_VARIETY ? 'StrawberryVariety' : 'CartonType');
      const control = `${selectControl({
        key,
        options: referenceOptionsFor(kind, { referenceOptions, selected: form[key] }),
        selected: form[key] || '',
        invalid: Boolean(errorFor(key))
      })}<div class="row row--wrap reference-actions">${referenceAddButton(kind)}</div>`;
      blocks.push(fieldBlock({ key, control, error: errorFor(key) }));
      continue;
    }
    if (key === FORM_KEY.AMOUNT) {
      blocks.push(fieldBlock({ key, control: numberControl({ key, value: form[key], invalid: Boolean(errorFor(key)) }), error: errorFor(key) }));
      continue;
    }
    const isPrice = key === FORM_KEY.UNIT_PRICE || key === FORM_KEY.CARTON_DISCOUNT || key === FORM_KEY.CARTON_PRICE;
    blocks.push(fieldBlock({
      key,
      control: numberControl({ key, value: form[key], invalid: Boolean(errorFor(key)) }),
      hint: isPrice ? 'القيمة بالوحدات الرئيسية (مثال: 12.50).' : 'القيمة بالوحدات الرئيسية (مثال: 10.5).',
      error: errorFor(key)
    }));
  }
  const cropPreview = isCropPurchaseType(transactionType)
    ? `<div class="page-section" id="${CROP_PREVIEW_ID}">${renderCropPreview({ transactionType, preview })}</div>`
    : '';
  const transferPreview = isTransferType(transactionType)
    ? `<div class="page-section" id="${TRANSFER_PREVIEW_ID}">${renderTransferPreview({ preview, awaitingConfirm })}</div>`
    : '';
  return `<div class="grid grid--cols-2">${blocks.join('\n')}</div>${renderReferenceAddPanel({ panel: referencePanel })}${cropPreview}${transferPreview}`;
}

// Preview only: the numbers come from the approved calculator through the service
// layer. Nothing here is stored, and the user cannot edit the total.
export function renderCropPreview({ transactionType = '', preview = null } = {}) {
  const rows = [];
  if (preview) {
    if (preview.PackageWeightKg !== null && preview.PackageWeightKg !== undefined) {
      rows.push(`<li>الوزن الافتراضي للعبوة: ${escapeHtml(String(preview.PackageWeightKg))} كجم</li>`);
    }
    if (preview.NetWeightMilli !== null && preview.NetWeightMilli !== undefined) {
      rows.push(`<li>صافي الوزن المحسوب: ${escapeHtml(formatQuantityMinor(preview.NetWeightMilli))} كجم</li>`);
    }
    if (preview.AmountMinor !== null && preview.AmountMinor !== undefined) {
      rows.push(`<li>القيمة المحسوبة: ${escapeHtml(formatMoneyMinor(preview.AmountMinor))}</li>`);
    }
  }
  const body = rows.length
    ? `<ul class="preview-list">${rows.join('')}</ul>`
    : '<p class="text-sm text-muted">تُعرض القيمة المحسوبة هنا بعد إدخال بيانات المحصول. الحساب النهائي يتم في النظام عند الحفظ.</p>';
  return card({
    title: 'معاينة الحساب (عرض فقط)',
    body: `<p class="text-sm text-muted">هذه معاينة للعرض فقط، ولا تُخزَّن ولا يمكن تعديلها.</p>${body}`
  });
}

export function renderFormError({ error = null } = {}) {
  if (!error) return '';
  return alert({
    tone: 'danger',
    title: 'تعذّر تسجيل الحركة',
    message: error.message || 'حدث خطأ غير متوقع.'
  });
}

// Success panel. The balance is the value the service read back; the UI only
// formats it and offers the link to the customer statement.
export function renderTransactionSuccess({ result = {}, transactionType = null } = {}) {
  const source = result.Record || (Array.isArray(result.Records) ? result.Records[0] : null) || {};
  const type = transactionType || source.TransactionType || null;
  const customer = result.Customer || {};
  const lines = [
    `<li>نوع الحركة: ${escapeHtml(TRANSACTION_TYPE_LABELS_AR[type] || type || EMPTY_VALUE)}</li>`,
    `<li>المبلغ: ${escapeHtml(formatMoneyMinor(source.AmountMinor))}</li>`,
    `<li>العميل: ${escapeHtml(customerLabel(customer))}</li>`
  ];
  if (Number.isInteger(result.NewBalanceMinor)) {
    const side = BALANCE_SIDE_TEXT[result.NewBalanceSide] || null;
    lines.push(`<li>الرصيد الحالي بعد العملية: ${escapeHtml(formatMoneyMinor(result.NewBalanceMinor))}${side ? ` (${escapeHtml(side)})` : ''}</li>`);
  }
  if (result.Counterparty) lines.push(`<li>الطرف الثاني: ${escapeHtml(customerLabel(result.Counterparty))}</li>`);
  const accountId = result.CustomerId || null;
  const accountLink = accountId && (!authService.isEnforced() || authService.isAdmin())
    ? `<a class="btn btn--primary" data-action="view-account" data-id="${escapeHtml(accountId)}" href="${escapeHtml(buildHash(customerAccountPath(accountId)))}">عرض كشف الحساب</a>`
    : '';
  return `<div class="page-section" id="${SUCCESS_REGION_ID}" role="status" data-transaction-type="${escapeHtml(type || '')}">
${card({
    title: 'تم تسجيل الحركة بنجاح',
    body: `<ul class="result-list">${lines.join('')}</ul>`,
    footer: `<div class="row">${accountLink}<button class="btn btn--outline" type="button" data-action="new-transaction">تسجيل حركة أخرى</button></div>`
  })}
</div>`;
}

// The complete form body, rendered once the services answered.
export function renderTransactionForm({
  customers = [],
  customerLoadError = null,
  transactionType = '',
  lockedCustomerId = null,
  values = null,
  fieldErrors = {},
  error = null,
  packageWeightKg = null,
  cropPreview = null,
  awaitingConfirm = false,
  referenceOptions = null,
  referencePanel = null
} = {}) {
  const form = values || emptyForm({ transactionType, date: transactionFormService.currentIsoDate() });
  const activeType = form.TransactionType || transactionType;
  const errorFor = (key) => fieldErrors[key] || null;
  const locked = Boolean(lockedCustomerId);
  const customerError = customerLoadError ? 'تعذّر تحميل قائمة العملاء.' : errorFor(FORM_KEY.CUSTOMER);
  const isTransfer = activeType === TRANSACTION_TYPE.DEBT_TRANSFER;

  const headerBlocks = [
    fieldBlock({
      key: FORM_KEY.TransactionType,
      label: 'نوع الحركة',
      control: selectControl({ key: FORM_KEY.TransactionType, options: [{ value: '', label: '— اختر نوع الحركة —' }].concat(transactionTypeOptions()), selected: activeType }),
      error: errorFor('TransactionType')
    }),
    fieldBlock({ key: FORM_KEY.DATE, control: textControl({ key: FORM_KEY.DATE, type: 'date', value: form[FORM_KEY.DATE], invalid: Boolean(errorFor(FORM_KEY.DATE)) }), error: errorFor(FORM_KEY.DATE) })
  ];

  if (isTransfer) {
    headerBlocks.push(
      fieldBlock({
        key: FORM_KEY.FROM_CUSTOMER,
        control: selectControl({ key: FORM_KEY.FROM_CUSTOMER, options: customerOptions(customers), selected: form[FORM_KEY.FROM_CUSTOMER], invalid: Boolean(errorFor(FORM_KEY.FROM_CUSTOMER)) }),
        error: errorFor(FORM_KEY.FROM_CUSTOMER)
      }),
      fieldBlock({
        key: FORM_KEY.TO_CUSTOMER,
        control: selectControl({ key: FORM_KEY.TO_CUSTOMER, options: customerOptions(customers), selected: form[FORM_KEY.TO_CUSTOMER], invalid: Boolean(errorFor(FORM_KEY.TO_CUSTOMER)) }),
        error: errorFor(FORM_KEY.TO_CUSTOMER)
      })
    );
  } else if (locked) {
    headerBlocks.push(fieldBlock({
      key: FORM_KEY.CUSTOMER,
      control: selectControl({ key: FORM_KEY.CUSTOMER, options: customerOptions(customers.filter((customer) => customer.Id === lockedCustomerId)), selected: lockedCustomerId, disabled: true, invalid: Boolean(customerError) }),
      hint: 'تم تحديد العميل مسبقًا ولا يمكن تغييره من هذه الشاشة.',
      error: customerError
    }));
  } else {
    headerBlocks.push(fieldBlock({
      key: FORM_KEY.CUSTOMER,
      control: `<input class="input" id="${FIELD_ID.CustomerSearch}" type="search" placeholder="ابحث بالكود أو الاسم" aria-label="بحث عن عميل">${
        selectControl({ key: FORM_KEY.CUSTOMER, options: customerOptions(customers), selected: form[FORM_KEY.CUSTOMER], invalid: Boolean(customerError) })
      }`,
      hint: 'البحث بالكود أو الاسم؛ المعرّف المستخدم داخليًا هو معرّف العميل.',
      error: customerError
    }));
  }

  const note = typeNote(activeType);
  return [
    `<div id="${FORM_ERROR_ID}">${renderFormError({ error })}</div>`,
    '<form id="transaction-form" class="page-section" novalidate>',
    card({
      title: 'بيانات الحركة',
      body: `${note ? `<p class="text-sm text-muted">${escapeHtml(note)}</p>` : ''}<div class="grid grid--cols-2">${headerBlocks.join('\n')}</div>`,
      footer: `<div class="row row--between">
  <span class="text-sm text-muted">${packageWeightKg === null || packageWeightKg === undefined ? 'الوزن الافتراضي للعبوة: —' : `الوزن الافتراضي للعبوة: ${escapeHtml(String(packageWeightKg))} كجم`}</span>
  <div class="row">
    <a class="btn btn--outline" href="${escapeHtml(buildHash(customerListPath()))}">إلغاء</a>
    <button class="btn btn--primary" type="submit" id="submit-transaction" data-action="submit-transaction"><span>حفظ الحركة</span></button>
  </div>
</div>`
    }),
    `<div class="page-section" id="${DYNAMIC_FIELDS_ID}">${renderDynamicFields({ transactionType: activeType, values: form, fieldErrors, preview: cropPreview, awaitingConfirm, referenceOptions, referencePanel })}</div>`,
    '</form>'
  ].join('\n');
}

// Shell painted before the first read resolves: a visible loading state, no value.
export function transactionFormShellHtml({ lockedCustomerId = null, transactionType = '' } = {}) {
  return [
    pageHeader({
      title: 'تسجيل حركة مالية',
      description: 'اختر العميل ونوع الحركة، ثم أدخل البيانات المطلوبة. النظام هو الذي يحدد الأثر المالي والرصيد.',
      actions: `<a class="btn btn--outline" href="${escapeHtml(buildHash(customerListPath()))}">العودة إلى العملاء</a>`
    }),
    `<div class="page-section" id="${TRANSACTION_FORM_REGION_ID}" aria-busy="true"${attrs({ 'data-locked-customer': lockedCustomerId, 'data-transaction-type': transactionType || null })}>${
      loadingState({ message: 'جارٍ تحميل شاشة تسجيل الحركة…' })
    }</div>`
  ].join('\n');
}

export function transactionFormViewHtml({ lockedCustomerId = null, transactionType = '' } = {}) {
  return transactionFormShellHtml({ lockedCustomerId, transactionType });
}

// Screen controller. It reads through the services layer, keeps the entered values
// while a save is pending or rejected (a failed form is never auto-cleared), guards
// against a double submit and always leaves the loading state.
export function initTransactionFormView({
  container,
  lockedCustomerId = null,
  transactionType = '',
  navigate = null,
  services = transactionFormService,
  autoLoad = true
} = {}) {
  if (!container) return null;
  const state = {
    customers: [],
    customerLoadError: null,
    packageWeightKg: null,
    values: emptyForm({ transactionType, date: services.currentIsoDate() }),
    fieldErrors: {},
    error: null,
    busy: false,
    preview: null,
    lastResult: null,
    formClosed: false,
    // The type the dynamic fields were last rendered from. A type switch is applied
    // exactly once, no matter how many events the browser dispatches for one choice.
    renderedType: null,
    // The user has explicitly confirmed a transfer whose receiving side would go
    // negative. Any new value in the form invalidates it.
    awaitingConfirm: false,
    // Phase 4B.11 — the reference catalogues and the inline add panel's own state.
    referenceOptions: null,
    referencePanel: null
  };
  const region = () => (typeof container.querySelector === 'function' ? container.querySelector(`#${TRANSACTION_FORM_REGION_ID}`) : null);
  // The transfer preview is a services-layer call. A caller may inject it (the
  // controller tests do); otherwise the approved named service export is used. Either
  // way this screen computes no balance and decides no direction itself.
  const previewFn = typeof services.previewTransfer === 'function' ? services.previewTransfer : previewTransfer;

  function fieldErrorsFrom(error) {
    const list = error && error.details && Array.isArray(error.details.errors) ? error.details.errors : [];
    const map = {};
    for (const entry of list) if (entry && entry.field) map[entry.field] = entry.message;
    if (error && error.field && !map[error.field]) map[error.field] = error.message;
    return map;
  }

  // Reads the current control values; the entered data survives a failed save.
  function readFormValues() {
    const target = region();
    if (!target || typeof target.querySelector !== 'function') return state.values;
    const read = (key, fallback) => {
      const control = target.querySelector(`#${controlIdFor(key)}`);
      return control ? control.value : fallback;
    };
    const next = { ...state.values };
    for (const key of Object.values(FORM_KEY)) next[key] = read(key, state.values[key] ?? '');
    next.TransactionType = read(FORM_KEY.TransactionType, state.values.TransactionType) || state.values.TransactionType;
    return next;
  }

  function paint() {
    const target = region();
    if (!target) return;
    target.innerHTML = renderTransactionForm({
      customers: state.customers,
      customerLoadError: state.customerLoadError,
      transactionType: state.values.TransactionType,
      lockedCustomerId,
      values: state.values,
      fieldErrors: state.fieldErrors,
      error: state.error,
      packageWeightKg: state.packageWeightKg,
      cropPreview: state.preview,
      awaitingConfirm: state.awaitingConfirm,
      referenceOptions: state.referenceOptions,
      referencePanel: state.referencePanel
    });
    state.renderedType = state.values.TransactionType || '';
    target.setAttribute('aria-busy', 'false');
  }

  // Only the preview box is repainted here, so typing in a field never rebuilds the
  // form around it (the caret and the entered values stay exactly where they are).
  function paintPreview() {
    const target = region();
    if (!target || typeof target.querySelector !== 'function') return;
    const type = state.values.TransactionType;
    const box = target.querySelector(`#${isTransferType(type) ? TRANSFER_PREVIEW_ID : CROP_PREVIEW_ID}`);
    if (!box) return;
    box.innerHTML = isTransferType(type)
      ? renderTransferPreview({ preview: state.preview, awaitingConfirm: state.awaitingConfirm })
      : renderCropPreview({ transactionType: type, preview: state.preview });
  }

  async function refreshPreview() {
    const type = state.values.TransactionType;
    state.awaitingConfirm = false; // any new value invalidates a previous confirmation
    if (isTransferType(type)) {
      if (transferParties(state.values).Same) {
        // Refused with a clear Arabic message and without calling any service.
        state.preview = { Valid: false, Message: SAME_CUSTOMER_MESSAGE };
        const blocked = { ...state.fieldErrors };
        blocked[FORM_KEY.TO_CUSTOMER] = SAME_CUSTOMER_MESSAGE;
        state.fieldErrors = blocked;
        paintPreview();
        return;
      }
      const cleared = { ...state.fieldErrors };
      delete cleared[FORM_KEY.TO_CUSTOMER];
      state.fieldErrors = cleared;
      try {
        state.preview = await previewFn(state.values);
      } catch (error) {
        logger.error('transfer preview failed', { message: error && error.message ? String(error.message) : null });
        state.preview = { Valid: false, Message: 'تعذّر تحميل معاينة التحويل من طبقة الخدمات.' };
      }
      paintPreview();
      return;
    }
    if (!isCropPurchaseType(type)) return;
    state.preview = await services.previewCrop(state.values);
    paintPreview();
  }

  function setBusy(isBusy) {
    state.busy = isBusy;
    const target = region();
    if (!target) return;
    target.setAttribute('aria-busy', isBusy ? 'true' : 'false');
    const submitButton = typeof target.querySelector === 'function' ? target.querySelector('#submit-transaction') : null;
    if (submitButton) {
      submitButton.disabled = isBusy;
      submitButton.setAttribute('aria-disabled', isBusy ? 'true' : 'false');
      submitButton.innerHTML = isBusy
        ? '<span class="spinner" aria-hidden="true"></span><span>جارٍ الحفظ…</span>'
        : '<span>حفظ الحركة</span>';
    }
  }

  // A type switch is a pure UI act: it re-renders the fields for the new type right
  // away and decides nothing financially. Customer, Date and Description are carried
  // over; the previous type's values (including any Amount) are dropped, never moved
  // into another field. No validation runs and nothing is submitted.
  function handleTypeChange(nextType) {
    if (!nextType || nextType === state.renderedType) return false; // already rendered: idempotent
    const carried = {
      [FORM_KEY.CUSTOMER]: lockedCustomerId || state.values[FORM_KEY.CUSTOMER] || '',
      [FORM_KEY.DESCRIPTION]: state.values[FORM_KEY.DESCRIPTION] || ''
    };
    state.values = { ...emptyForm({ transactionType: nextType, date: state.values[FORM_KEY.DATE] }), ...carried };
    state.error = null;
    state.fieldErrors = {};
    state.preview = null;
    state.awaitingConfirm = false;
    paint(); // renderDynamicFields() runs here, immediately
    if (isCropPurchaseType(nextType) || isTransferType(nextType)) void refreshPreview();
    return true;
  }

  async function load() {
    try {
      const [customers, packageWeightKg, referenceOptions] = await Promise.all([
        services.listSelectableCustomers(),
        services.getDefaultPackageWeight(),
        // A reference-catalogue read failure must not block the whole screen: the
        // movement itself does not depend on it.
        (typeof services.listReferenceOptions === 'function' ? services.listReferenceOptions : listReferenceOptions)()
          .catch(() => null)
      ]);
      state.referenceOptions = referenceOptions || null;
      state.customers = Array.isArray(customers) ? customers : [];
      state.packageWeightKg = Number.isFinite(Number(packageWeightKg)) ? Number(packageWeightKg) : null;
      state.customerLoadError = null;
      if (lockedCustomerId) state.values[FORM_KEY.CUSTOMER] = lockedCustomerId;
    } catch (error) {
      logger.error('add transaction load failed', {
        code: error && error.code ? String(error.code) : null,
        message: error && error.message ? String(error.message) : null
      });
      state.customerLoadError = error;
      state.error = error;
    }
    paint();
    // A directly opened crop-purchase form gets its service-derived preview immediately.
    if (isCropPurchaseType(state.values.TransactionType) && !state.customerLoadError) await refreshPreview();
    return state;
  }

  function errorOutcome(error, message) {
    logger.error(message, {
      code: error && error.code ? String(error.code) : null,
      message: error && error.message ? String(error.message) : null
    });
    state.error = error;
    state.fieldErrors = fieldErrorsFrom(error);
    paint(); // every entered value is kept; nothing is cleared on failure
  }

  // Saves one reference record and refreshes the corresponding dropdown in place. The
  // form's own values are untouched and nothing financial is recalculated.
  async function saveReference() {
    const panel = state.referencePanel;
    if (!panel || panel.busy) return null;
    const input = region() && region().querySelector(`#${REFERENCE_PANEL_INPUT_ID}`);
    const name = input ? String(input.value || '').trim() : '';
    if (!name) {
      state.referencePanel = { ...panel, error: 'الاسم مطلوب ولا يمكن أن يكون فارغًا.' };
      paint();
      return null;
    }
    state.referencePanel = { ...panel, name, busy: true, error: null };
    paint();
    try {
      const created = panel.kind === 'CartonType'
        ? await (services.createCartonType || createCartonType)(name)
        : (panel.kind === 'StrawberryVariety'
          ? await (services.createStrawberryVariety || createStrawberryVariety)(name)
          : await (services.createReceivingCompany || createReceivingCompany)(name));
      // The catalogue is re-read from the services layer, so the dropdown shows the record
      // that was just created without a page reload and without any local bookkeeping.
      const readOptions = typeof services.listReferenceOptions === 'function'
        ? services.listReferenceOptions
        : listReferenceOptions;
      state.referenceOptions = (await readOptions()) || state.referenceOptions;
      // The new record is selected straight away, so the user does not have to pick it.
      const key = panel.kind === 'CartonType'
        ? FORM_KEY.CARTON_TYPE
        : (panel.kind === 'StrawberryVariety' ? FORM_KEY.STRAWBERRY_VARIETY : FORM_KEY.RECEIVING_COMPANY);
      state.values[key] = created.Id;
      state.referencePanel = null;
      state.error = null;
      paint();
      return created;
    } catch (error) {
      logger.error('reference create failed', { message: error && error.message ? String(error.message) : null });
      state.referencePanel = {
        ...panel, name, busy: false,
        error: (error && error.message) || 'تعذّر حفظ السجل المرجعي.'
      };
      paint();
      return null;
    }
  }

  async function submit() {
    // Two independent guards: a repeated click while saving, and a form that has
    // already been closed by a successful save. Neither can create a second row.
    if (state.busy || state.formClosed) return null;
    const current = region();
    if (!current || (typeof current.querySelector === 'function' && !current.querySelector('#transaction-form'))) {
      return null; // the form is gone (success panel shown): there is nothing to submit
    }
    state.values = readFormValues();
    state.error = null;
    state.fieldErrors = {};
    const activeType = state.values.TransactionType;
    // A transfer between the SAME party on both sides is refused before any service
    // call: no request is made, nothing is written, and the reason is shown in Arabic.
    if (isTransferType(activeType) && transferParties(state.values).Same) {
      state.fieldErrors = { [FORM_KEY.TO_CUSTOMER]: SAME_CUSTOMER_MESSAGE };
      paint();
      return null;
    }
    setBusy(true);
    try {
      // The preview is re-read from the values being submitted, so a save can never
      // ride on a stale preview. A receiving side that would go negative is accepted
      // only after the explicit confirmation below has been given.
      if (isTransferType(activeType)) {
        const fresh = await previewFn(state.values);
        state.preview = fresh || null;
        if (!fresh || fresh.Valid !== true) {
          throw {
            code: 'VALIDATION_ERROR',
            message: (fresh && fresh.Message) || 'تعذّر التحقق من بيانات التحويل.',
            field: (fresh && fresh.Field) || null
          };
        }
        if (fresh.Insufficient === true && state.awaitingConfirm !== true) {
          state.awaitingConfirm = true;
          paintPreview();
          return null;
        }
      }
      const result = await services.submitTransactionForm(state.values);
      state.lastResult = result;
      state.formClosed = true; // this form press has been consumed
      const target = region();
      if (target) target.innerHTML = renderTransactionSuccess({ result, transactionType: state.values.TransactionType });
      return result;
    } catch (error) {
      errorOutcome(error, 'add transaction submit failed');
      return null;
    } finally {
      setBusy(false); // loading always ends: success and failure alike
    }
  }

  container.addEventListener('change', (event) => {
    const target = event.target;
    const id = target && target.getAttribute ? target.getAttribute('id') : null;
    if (!id) return;
    if (id === FIELD_ID.TransactionType) {
      handleTypeChange(target.value);
      return;
    }
    for (const key of Object.values(FORM_KEY)) if (id === controlIdFor(key)) state.values[key] = target.value;
    if (isCropPurchaseType(state.values.TransactionType) || isTransferType(state.values.TransactionType)) void refreshPreview();
  });

  container.addEventListener('input', (event) => {
    const target = event.target;
    const id = target && target.getAttribute ? target.getAttribute('id') : null;
    if (!id) return;
    if (id === FIELD_ID.TransactionType) {
      // A real <select> fires `input` and THEN `change` for one selection. The switch
      // is applied here, and the later `change` becomes a no-op because the rendered
      // type already matches. Treating this id as a plain value field is what used to
      // advance the state without re-rendering the dynamic fields.
      handleTypeChange(target.value);
      return;
    }
    if (id === FIELD_ID.CustomerSearch) {
      const term = String(target.value || '').trim().toLowerCase();
      const target2 = region();
      const select = target2 && typeof target2.querySelector === 'function' ? target2.querySelector(`#${FIELD_ID.CustomerId}`) : null;
      if (!select) return;
      const selected = select.value;
      const options = customerOptions(state.customers).filter((option) => option.value === '' || option.label.toLowerCase().includes(term));
      select.innerHTML = options.map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
      return;
    }
    for (const key of Object.values(FORM_KEY)) if (id === controlIdFor(key)) state.values[key] = target.value;
    if (isCropPurchaseType(state.values.TransactionType) || isTransferType(state.values.TransactionType)) void refreshPreview();
  });

  container.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });

  container.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    if (target.closest('[data-action="confirm-transfer"]')) {
      // Explicit confirmation for a transfer that would push the receiving side
      // below zero. The values are re-validated by submit() before anything is saved.
      state.awaitingConfirm = true;
      void submit();
      return;
    }
    if (target.closest('[data-action="dismiss-confirm"]')) {
      state.awaitingConfirm = false;
      paintPreview();
      return;
    }
    if (target.closest('[data-action="new-transaction"]')) {
      state.values = emptyForm({ transactionType: '', date: services.currentIsoDate() });
      state.error = null;
      state.fieldErrors = {};
      state.preview = null;
      state.lastResult = null;
      state.formClosed = false;
      paint();
      return;
    }
    // Phase 4B.11 — open / save / cancel the inline reference panel. Saving writes ONE
    // reference row through the services layer: no movement, no amount, no balance.
    const addButton = target.closest('[data-action="add-receiving-company"], [data-action="add-carton-type"], [data-action="add-strawberry-variety"]');
    if (addButton) {
      state.referencePanel = {
        kind: addButton.getAttribute('data-reference-kind') || 'ReceivingCompany',
        name: '', error: null, busy: false
      };
      paint();
      const input = region() && region().querySelector(`#${REFERENCE_PANEL_INPUT_ID}`);
      if (input && typeof input.focus === 'function') input.focus();
      return;
    }
    if (target.closest('[data-action="cancel-reference"]')) {
      state.referencePanel = null;
      paint();
      return;
    }
    if (target.closest('[data-action="save-reference"]')) {
      void saveReference();
      return;
    }
    if (target.closest('[data-action="retry"]')) { void load(); return; }
    const account = target.closest('[data-action="view-account"]');
    if (account && navigate) {
      navigate(customerAccountPath(account.getAttribute('data-id') || (state.lastResult && state.lastResult.CustomerId)));
    }
  });

  if (autoLoad) void load();
  return {
    reload: load,
    submit,
    saveReference,
    state: () => ({ ...state, values: { ...state.values } }),
    regionId: TRANSACTION_FORM_REGION_ID
  };
}
