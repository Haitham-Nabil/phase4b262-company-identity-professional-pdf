import { ERROR_CODE, AppError } from './errors.js';

// Money is stored as integer minor units (scale 2). Quantities/weights use scale 3.
export const MONEY_SCALE = 2;
export const MONEY_FACTOR = 100;
export const QTY_SCALE = 3;
export const QTY_FACTOR = 1000;

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireNumber(value, field) {
  if (!isFiniteNumber(value)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, `${field} يجب أن يكون رقمًا صالحًا.`, { field });
  }
  return value;
}

// Integer division rounded half away from zero (no floating point drift).
export function divRoundHalfUp(numerator, denominator) {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator === 0) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'عملية حسابية غير صالحة على القيم المالية.');
  }
  const negative = (numerator < 0) !== (denominator < 0);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const quotient = Math.floor(n / d);
  const remainder = n % d;
  const rounded = remainder * 2 >= d ? quotient + 1 : quotient;
  return negative ? -rounded : rounded;
}

export function toMinor(value, factor = MONEY_FACTOR, field = 'القيمة') {
  requireNumber(value, field);
  const scaled = value * factor;
  return scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
}

export function fromMinor(minor, factor = MONEY_FACTOR) {
  if (!Number.isInteger(minor)) {
    throw new AppError(ERROR_CODE.STORAGE_ERROR, 'قيمة مخزنة غير صالحة (يجب أن تكون بوحدات صغرى صحيحة).');
  }
  return minor / factor;
}

export function sumMinor(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function toQtyMilli(quantity, field = 'الكمية') {
  return toMinor(quantity, QTY_FACTOR, field);
}

export function fromQtyMilli(milli) {
  return fromMinor(milli, QTY_FACTOR);
}

// Net Weight (G) = D * (DefaultPackageWeight - F) + E   [Excel formula preserved]
export function netWeightMilli({ units = 0, looseKg = 0, deductionKg = 0, packageWeightKg }) {
  const d = toMinor(units, QTY_FACTOR, 'عدد العبوات');
  const e = toMinor(looseKg, QTY_FACTOR, 'الكيلو السائب');
  const f = toMinor(deductionKg, QTY_FACTOR, 'خصم الكيلو');
  const w = toMinor(packageWeightKg, QTY_FACTOR, 'الوزن الافتراضي للعبوة');
  return divRoundHalfUp(d * (w - f), QTY_FACTOR) + e;
}

// Local Total = G * H
export function weightTimesPriceMinor(weightMilli, unitPriceMinor) {
  return divRoundHalfUp(weightMilli * unitPriceMinor, QTY_FACTOR);
}

// Carton Total = (K - M) * L
export function cartonTotalMinor({ quantity = 0, discount = 0, unitPrice = 0 }) {
  const k = toMinor(quantity, QTY_FACTOR, 'الكمية');
  const m = toMinor(discount, QTY_FACTOR, 'خصم المبلغ');
  const l = toMinor(unitPrice, MONEY_FACTOR, 'السعر');
  return divRoundHalfUp((k - m) * l, QTY_FACTOR);
}

export function formatMoneyMinor(minor) {
  return fromMinor(minor).toFixed(2);
}
