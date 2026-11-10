import { AppError, ERROR_CODE } from '../domain/errors.js';
import { STATUS, TRANSACTION_TYPE, DEBT_TRANSFER_ROLE, isCropPurchaseType, isTransactionType } from '../domain/transactionTypes.js';
import { MONEY_FACTOR, QTY_FACTOR, isFiniteNumber, toMinor } from '../domain/money.js';
import { requireIsoDate } from '../domain/dateUtils.js';
import { isDirection, usesExplicitDirection, LEGACY_DIRECTION, DIRECTIONS } from '../domain/financialDirection.js';
import { optionalText, requireText, resolveAmountMinor, assertPositiveInteger } from './commonValidation.js';

// Storage-level crop inputs (integer minor/milli units). Net Weight (G) is NOT
// among them: G is always calculated, never entered and never stored.
const CROP_FIELD_NAMES = [
  'LocalUnitsMilli',
  'LocalLooseKgMilli',
  'LocalDeductionKgMilli',
  'LocalUnitPriceMinor',
  'CartonQuantityMilli',
  'CartonUnitPriceMinor',
  'CartonDiscountMinor'
];

const LOCAL_CROP_FIELDS = ['LocalUnitsMilli', 'LocalLooseKgMilli', 'LocalDeductionKgMilli', 'LocalUnitPriceMinor'];
const CARTON_CROP_FIELDS = ['CartonQuantityMilli', 'CartonUnitPriceMinor', 'CartonDiscountMinor'];

const CROP_FIELD_LABELS = {
  LocalUnitsMilli: 'عدد العبوات (D)',
  LocalLooseKgMilli: 'الكيلو السائب (E)',
  LocalDeductionKgMilli: 'خصم الكيلو (F)',
  LocalUnitPriceMinor: 'سعر الوحدة (H)',
  CartonQuantityMilli: 'الكمية (K)',
  CartonUnitPriceMinor: 'السعر (L)',
  CartonDiscountMinor: 'خصم المبلغ (M)'
};

// The only two fields able to carry a raw operation value.
const EXPLICIT_AMOUNT_FIELDS = ['Amount', 'AmountMinor'];

// Columns the financial engine derives. They are refused as INPUT so the UI can
// never become a second source of a Debit / Credit / cash / settlement figure.
const DERIVED_FINANCIAL_FIELDS = ['CreditMinor', 'DebitMinor', 'SettlementMinor', 'CashReceivedMinor', 'CashPaidMinor'];

export function hasDerivedFinancialField(input) {
  if (!input || typeof input !== 'object') return false;
  return DERIVED_FINANCIAL_FIELDS.some((name) => Object.prototype.hasOwnProperty.call(input, name)
    && input[name] !== undefined
    && input[name] !== null);
}

// Phase 4B.13.1 — the variety is a REFERENCE id, not a number: it is read as text and
// validated separately from the integer crop columns below.
function readVarietyField(input) {
  const crop = (input && input.crop) || {};
  const raw = crop.StrawberryVarietyId;
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  return text === '' ? null : text;
}

function readCropFields(input) {
  const crop = (input && input.crop) || {};
  const pickInteger = (name) => (crop[name] === undefined || crop[name] === null ? null : crop[name]);
  return {
    StrawberryVarietyId: readVarietyField(input),
    LocalUnitsMilli: pickInteger('LocalUnitsMilli'),
    LocalLooseKgMilli: pickInteger('LocalLooseKgMilli'),
    LocalDeductionKgMilli: pickInteger('LocalDeductionKgMilli'),
    LocalUnitPriceMinor: pickInteger('LocalUnitPriceMinor'),
    CartonQuantityMilli: pickInteger('CartonQuantityMilli'),
    CartonUnitPriceMinor: pickInteger('CartonUnitPriceMinor'),
    CartonDiscountMinor: pickInteger('CartonDiscountMinor')
  };
}

// Key-presence test — never truthiness: an explicit 0 must be rejected as well.
function hasExplicitAmountField(input) {
  if (!input || typeof input !== 'object') return false;
  return EXPLICIT_AMOUNT_FIELDS.some((name) => Object.prototype.hasOwnProperty.call(input, name)
    && input[name] !== undefined
    && input[name] !== null);
}

export function validateTransactionDraft(draft, options = {}) {
  const { customerExists = false } = options;
  const input = draft || {};
  const errors = [];
  const push = (code, message, field) => errors.push({ code, message, field });

  const customerId = optionalText(input.CustomerId);
  if (!customerId) push(ERROR_CODE.VALIDATION_ERROR, 'يجب اختيار العميل.', 'CustomerId');
  else if (!customerExists) push(ERROR_CODE.NOT_FOUND, 'العميل غير موجود.', 'CustomerId');

  let date = null;
  try {
    date = requireIsoDate(input.Date, 'التاريخ');
  } catch (error) {
    push(ERROR_CODE.VALIDATION_ERROR, error.message, 'Date');
  }

  const transactionType = input.TransactionType;
  if (!isTransactionType(transactionType)) {
    push(ERROR_CODE.VALIDATION_ERROR, 'نوع الحركة غير معتمد.', 'TransactionType');
  }

  const cropFields = readCropFields(input);
  const isCropPurchase = isTransactionType(transactionType) && isCropPurchaseType(transactionType);

  // The operation value has EXACTLY ONE source per transaction type.
  let amountMinor = null;
  if (isCropPurchase) {
    // Crop purchase: the value is derived from the crop inputs (+ DefaultPackageWeight)
    // only. A caller-supplied Amount / AmountMinor is refused outright so that no
    // second source for the operation value can ever exist.
    if (hasExplicitAmountField(input)) {
      push(
        ERROR_CODE.BUSINESS_RULE_ERROR,
        'لا يمكن تمرير مبلغ صريح لمشتريات المحصول؛ تُحتسب القيمة حصريًا من بيانات المحصول والوزن الافتراضي للعبوة.',
        'Amount'
      );
    }
    // A variety belongs to the LOCAL purchase only: sending one with a carton purchase is
    // refused instead of being silently stored against the wrong type.
    if (transactionType !== TRANSACTION_TYPE.CROP_PURCHASE_LOCAL && cropFields.StrawberryVarietyId !== null) {
      push(ERROR_CODE.BUSINESS_RULE_ERROR, 'صنف الفراولة مسموح فقط في حركة مشتريات المحصول المحلي.', 'StrawberryVarietyId');
    }
    const requiredFields = transactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL ? LOCAL_CROP_FIELDS : CARTON_CROP_FIELDS;
    const supplied = requiredFields.filter((name) => cropFields[name] !== null);
    if (!supplied.length) {
      push(ERROR_CODE.VALIDATION_ERROR, 'بيانات مشتريات المحصول مطلوبة لحساب القيمة.', 'TransactionType');
    }
    for (const name of CROP_FIELD_NAMES) {
      const value = cropFields[name];
      if (value === null) continue;
      if (!Number.isInteger(value)) {
        push(ERROR_CODE.VALIDATION_ERROR, `${CROP_FIELD_LABELS[name]} يجب أن يكون رقمًا صحيحًا.`, name);
      } else if (value < 0) {
        push(ERROR_CODE.VALIDATION_ERROR, `${CROP_FIELD_LABELS[name]} لا يمكن أن يكون سالبًا.`, name);
      }
    }
  } else {
    // Every other type keeps its own single source: the entered amount.
    try {
      amountMinor = resolveAmountMinor(input, 'المبلغ');
    } catch (error) {
      push(ERROR_CODE.VALIDATION_ERROR, error.message, 'Amount');
    }
    const provided = CROP_FIELD_NAMES.filter((name) => cropFields[name] !== null);
    if (cropFields.StrawberryVarietyId !== null) provided.push('StrawberryVarietyId');
    if (provided.length) {
      push(ERROR_CODE.BUSINESS_RULE_ERROR, 'لا يمكن إرسال حقول مشتريات المحصول مع نوع حركة آخر.', 'TransactionType');
    }
    for (const name of CROP_FIELD_NAMES) cropFields[name] = null;
  }

  // Settlement / GoodsExchange: the direction is an explicit, PERSISTED statement.
  // Only the two accepted values are taken. A direction the caller did NOT state is
  // resolved in this exact order (Phase 4B.6 direction-preservation fix):
  //   1. the explicit value the caller stated (when it is valid),
  //   2. the direction ALREADY STORED on the record being edited — an omitted field may
  //      never turn a stored Debit into a Credit,
  //   3. the approved legacy default (Credit), which stays a DERIVATION-time value and
  //      is not written back onto an existing record.
  // No derived financial column may arrive from the caller.
  let direction = null;
  if (usesExplicitDirection(transactionType)) {
    if (hasDerivedFinancialField(input)) {
      push(
        ERROR_CODE.BUSINESS_RULE_ERROR,
        'لا يمكن تمرير قيم مالية مشتقة (مدين/دائن/تسوية/نقدية) من الواجهة؛ يشتقها المحرك المالي من النوع والاتجاه والمبلغ.',
        'Direction'
      );
    }
    const rawDirection = input.Direction;
    const storedDirection = options.previousDirection ?? null;
    if (rawDirection === null || rawDirection === undefined || rawDirection === '') {
      // A missing direction keeps the STORED one on the edit path; only a caller that
      // states nothing about an existing record which has no stored direction falls back
      // to the legacy default (left as a derivation value, never written back).
      direction = options.preserveStoredDirection === true
        ? (isDirection(storedDirection) ? storedDirection : null)
        : LEGACY_DIRECTION;
    }
    else if (!isDirection(rawDirection)) {
      push(ERROR_CODE.VALIDATION_ERROR, `اتجاه الحركة غير صالح؛ القيم المسموحة: ${DIRECTIONS.join(' أو ')}.`, 'Direction');
    } else direction = rawDirection;
  } else if (input.Direction !== null && input.Direction !== undefined && input.Direction !== '') {
    push(ERROR_CODE.BUSINESS_RULE_ERROR, 'حقل الاتجاه مسموح فقط لحركات التسوية وتبادل البضائع.', 'Direction');
  }

  let linkId = null;
  let transferRole = null;
  if (transactionType === TRANSACTION_TYPE.DEBT_TRANSFER) {
    linkId = optionalText(input.LinkId);
    transferRole = input.TransferRole ?? null;
    if (!linkId) push(ERROR_CODE.VALIDATION_ERROR, 'معرّف الربط (LinkId) مطلوب لتحويل المديونية.', 'LinkId');
    if (transferRole !== DEBT_TRANSFER_ROLE.CREDIT_SIDE && transferRole !== DEBT_TRANSFER_ROLE.DEBIT_SIDE) {
      push(ERROR_CODE.VALIDATION_ERROR, 'جهة تحويل المديونية غير صالحة.', 'TransferRole');
    }
  } else if (optionalText(input.LinkId) || input.TransferRole) {
    push(ERROR_CODE.BUSINESS_RULE_ERROR, 'حقول تحويل المديونية مسموحة فقط لنوع تحويل المديونية.', 'LinkId');
  }

  if (input.Status && input.Status !== STATUS.ACTIVE) {
    push(ERROR_CODE.VALIDATION_ERROR, 'لا يمكن إنشاء حركة بحالة ملغاة.', 'Status');
  }

  if (errors.length) return { ok: false, data: null, errors };

  return {
    ok: true,
    errors: [],
    data: {
      CustomerId: customerId,
      Date: date,
      TransactionType: transactionType,
      Description: optionalText(input.Description),
      AmountMinor: amountMinor,
      Direction: direction,
      LinkId: linkId,
      TransferRole: transferRole,
      ...cropFields
    }
  };
}

export function validateCancellation(record, reason) {
  if (!record) throw new AppError(ERROR_CODE.NOT_FOUND, 'الحركة غير موجودة.', { field: 'TransactionId' });
  if (record.Status === STATUS.CANCELLED) {
    throw new AppError(ERROR_CODE.BUSINESS_RULE_ERROR, 'الحركة ملغاة بالفعل.', { field: 'Status' });
  }
  return requireText(reason, 'CancellationReason', 'سبب إلغاء الحركة مطلوب.');
}

export function validateDebtTransferInput(input) {
  const errors = [];
  const from = optionalText(input?.FromCustomerId);
  const to = optionalText(input?.ToCustomerId);
  if (!from) errors.push({ code: ERROR_CODE.VALIDATION_ERROR, message: 'يجب تحديد العميل الدائن (الطرف الأول).', field: 'FromCustomerId' });
  if (!to) errors.push({ code: ERROR_CODE.VALIDATION_ERROR, message: 'يجب تحديد العميل المدين (الطرف الثاني).', field: 'ToCustomerId' });
  if (from && to && from === to) errors.push({ code: ERROR_CODE.BUSINESS_RULE_ERROR, message: 'لا يمكن تحويل المديونية إلى نفس العميل.', field: 'ToCustomerId' });
  let amountMinor = null;
  try {
    amountMinor = resolveAmountMinor({ Amount: input?.Amount, AmountMinor: input?.AmountMinor }, 'مبلغ التحويل');
  } catch (error) {
    errors.push({ code: ERROR_CODE.VALIDATION_ERROR, message: error.message, field: 'Amount' });
  }
  let date = null;
  try {
    date = requireIsoDate(input?.Date, 'تاريخ التحويل');
  } catch (error) {
    errors.push({ code: ERROR_CODE.VALIDATION_ERROR, message: error.message, field: 'Date' });
  }
  if (errors.length) return { ok: false, data: null, errors };
  return { ok: true, errors: [], data: { FromCustomerId: from, ToCustomerId: to, AmountMinor: amountMinor, Date: date, Description: optionalText(input.Description) } };
}

// Phase 4B.6 — validation of an EDIT of an existing movement.
//
// It reuses the approved creation validator for every business field, so an edit can
// never introduce a value the creation path would have refused (an explicit amount on a
// crop purchase, an unknown direction, an unknown type, a missing customer). On top of
// that it enforces the two lifecycle rules of an edit: the identity of the movement is
// fixed (the type and the customer come from the stored row, not from the caller) and a
// reason for the change is mandatory.
export function validateTransactionEdit(input, previous, options = {}) {
  const errors = [];
  const source = input || {};
  if (!previous) {
    return { ok: false, data: null, errors: [{ code: ERROR_CODE.NOT_FOUND, message: 'الحركة غير موجودة.', field: 'TransactionId' }] };
  }

  // No derived financial column may ever arrive from the caller.
  if (hasDerivedFinancialField(source)) {
    errors.push({
      code: ERROR_CODE.BUSINESS_RULE_ERROR,
      message: 'لا يمكن تمرير قيم مالية مشتقة (مدين/دائن/تسوية/نقدية) من الواجهة؛ يشتقها المحرك المالي من النوع والاتجاه والمبلغ.',
      field: 'Amount'
    });
  }
  // A lifecycle change is not an edit: cancelling has its own dedicated operation.
  if (source.Status !== undefined && source.Status !== null && source.Status !== previous.Status) {
    errors.push({ code: ERROR_CODE.BUSINESS_RULE_ERROR, message: 'لا يمكن تغيير حالة الحركة من شاشة التعديل؛ لإلغائها استخدم إجراء الإلغاء.', field: 'Status' });
  }

  // Type and customer are read from the STORED row: an ordinary edit may not move the
  // movement to another type or another customer.
  const merged = {
    ...source,
    TransactionType: previous.TransactionType,
    CustomerId: previous.CustomerId,
    LinkId: previous.LinkId ?? null,
    TransferRole: previous.TransferRole ?? null
  };
  // Phase 4B.6 direction-preservation fix: the STORED direction of the row is handed to
  // the draft validator, so an omitted Direction can never flip a stored Debit to Credit.
  const base = validateTransactionDraft(merged, {
    ...options,
    preserveStoredDirection: true,
    previousDirection: previous.Direction ?? null
  });
  if (!base.ok) return { ok: false, data: null, errors: base.errors };

  let reason = null;
  try {
    reason = requireText(source.EditReason, 'EditReason', 'سبب تعديل الحركة مطلوب.');
  } catch (error) {
    errors.push({ code: ERROR_CODE.VALIDATION_ERROR, message: error.message, field: 'Reason' });
  }

  if (errors.length) return { ok: false, data: null, errors };
  return { ok: true, errors: [], data: { ...base.data, EditReason: reason } };
}

export { MONEY_FACTOR, QTY_FACTOR, isFiniteNumber, toMinor, assertPositiveInteger };
