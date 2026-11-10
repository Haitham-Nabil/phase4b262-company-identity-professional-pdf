import { AppError, ERROR_CODE } from '../domain/errors.js';
import { MONEY_FACTOR, isFiniteNumber, toMinor } from '../domain/money.js';
import { isValidIsoDate, isValidIsoDateTime } from '../domain/dateUtils.js';

export function optionalText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

export function requireText(value, field, message) {
  const text = optionalText(value);
  if (!text) throw new AppError(ERROR_CODE.VALIDATION_ERROR, message, { field });
  return text;
}

export function assertIsoDate(value, field = 'التاريخ', message = null) {
  if (!isValidIsoDate(value)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, message || `${field} غير صالح؛ يجب أن يكون بصيغة YYYY-MM-DD.`, { field });
  }
  return value;
}

export function assertIsoDateTime(value, field) {
  if (!isValidIsoDateTime(value)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, `${field} غير صالح.`, { field });
  }
  return value;
}

export function assertBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, `${field} يجب أن يكون قيمة منطقية (نعم/لا).`, { field });
  }
  return value;
}

export function assertPositiveInteger(value, field, message) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, message || `${field} يجب أن يكون أكبر من صفر.`, { field });
  }
  return value;
}

// Money input (major units) -> integer minor units. Negative values are rejected
// for transaction amounts; the customer balance itself may be negative.
export function normalizeMoneyInput(value, field = 'المبلغ') {
  if (!isFiniteNumber(value)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, `${field} يجب أن يكون رقمًا صالحًا.`, { field });
  }
  const minor = toMinor(value, MONEY_FACTOR, field);
  assertPositiveInteger(minor, field, `${field} يجب أن يكون أكبر من صفر.`);
  return minor;
}

export function resolveAmountMinor(input, field = 'المبلغ') {
  if (input && Number.isInteger(input.AmountMinor)) {
    assertPositiveInteger(input.AmountMinor, field, `${field} يجب أن يكون أكبر من صفر.`);
    return input.AmountMinor;
  }
  return normalizeMoneyInput(input ? input.Amount : undefined, field);
}
