import { AppError, ERROR_CODE } from '../domain/errors.js';
import { MONEY_FACTOR, isFiniteNumber, toMinor } from '../domain/money.js';
import { optionalText, requireText, assertBoolean } from './commonValidation.js';

export const CUSTOMER_SOURCE = Object.freeze({ MANUAL: 'Manual', IMPORTED: 'Imported' });

// Code: required + unique. Name: required for manual creation AND whenever the
// stored record already has a name; empty is allowed only for imported/nameless rows.
export function validateCustomerDraft(draft, options = {}) {
  const { existingCodes = new Set(), originalCode = null, nameRequired = true } = options;
  const input = draft || {};
  const errors = [];

  const code = optionalText(input.Code);
  if (!code) {
    errors.push({ code: ERROR_CODE.VALIDATION_ERROR, message: 'كود العميل مطلوب.', field: 'Code' });
  } else if (existingCodes.has(code) && code !== originalCode) {
    errors.push({ code: ERROR_CODE.CONFLICT, message: 'كود العميل مستخدم بالفعل لعميل آخر.', field: 'Code' });
  }

  const rawName = input.Name === null || input.Name === undefined ? null : String(input.Name).trim();
  const name = rawName === null || rawName === '' || rawName === '0' ? null : rawName;
  if (nameRequired && !name) {
    errors.push({ code: ERROR_CODE.VALIDATION_ERROR, message: 'اسم العميل مطلوب.', field: 'Name' });
  }

  let openingBalanceMinor = 0;
  if (input.OpeningBalance !== undefined && input.OpeningBalance !== null) {
    if (!isFiniteNumber(input.OpeningBalance)) {
      errors.push({ code: ERROR_CODE.VALIDATION_ERROR, message: 'الرصيد الافتتاحي يجب أن يكون رقمًا صالحًا.', field: 'OpeningBalance' });
    } else {
      openingBalanceMinor = toMinor(input.OpeningBalance, MONEY_FACTOR, 'الرصيد الافتتاحي');
    }
  }

  if (errors.length) {
    return { ok: false, data: null, errors };
  }
  return {
    ok: true,
    errors: [],
    data: {
      Code: code,
      Name: name,
      Phone: optionalText(input.Phone),
      Region: optionalText(input.Region),
      Notes: optionalText(input.Notes),
      OpeningBalanceMinor: openingBalanceMinor,
      IsActive: input.IsActive === undefined ? true : assertBoolean(input.IsActive, 'IsActive')
    }
  };
}

// Phase 4B.14 — the reason is stored trimmed and capped; the limit lives here (the one
// place both the dialog and the service read) and the UI only mirrors it as maxlength.
export const OPENING_BALANCE_REASON_MAX_LENGTH = 200;

export function validateOpeningBalanceChange({ newValue, reason } = {}) {
  const errors = [];
  const text = optionalText(reason);
  if (!text) errors.push({ code: ERROR_CODE.VALIDATION_ERROR, message: 'سبب تعديل الرصيد الافتتاحي مطلوب.', field: 'Reason' });
  else if (text.length > OPENING_BALANCE_REASON_MAX_LENGTH) {
    errors.push({ code: ERROR_CODE.VALIDATION_ERROR, message: `سبب تعديل الرصيد الافتتاحي يجب ألا يتجاوز ${OPENING_BALANCE_REASON_MAX_LENGTH} حرفًا.`, field: 'Reason' });
  }
  if (!isFiniteNumber(newValue)) {
    errors.push({ code: ERROR_CODE.VALIDATION_ERROR, message: 'قيمة الرصيد الافتتاحي الجديد يجب أن تكون رقمًا صالحًا.', field: 'NewValue' });
  }
  if (errors.length) return { ok: false, data: null, errors };
  return { ok: true, errors: [], data: { Reason: text, NewValueMinor: toMinor(newValue, MONEY_FACTOR, 'الرصيد الافتتاحي') } };
}
