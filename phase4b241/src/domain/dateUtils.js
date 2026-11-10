import { ERROR_CODE, AppError } from './errors.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Internal fixed date format: ISO 'YYYY-MM-DD' (sortable, timezone independent).
export function isValidIsoDate(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

export function isValidIsoDateTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return !Number.isNaN(Date.parse(value));
}

// Spreadsheet dates are wall-clock dates -> convert with local components.
export function toIsoDate(value) {
  if (isValidIsoDate(value)) return value.trim();
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return null;
}

export function requireIsoDate(value, field = 'التاريخ') {
  const iso = toIsoDate(value);
  if (!iso) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, `${field} غير صالح؛ يجب أن يكون بصيغة YYYY-MM-DD.`, { field });
  }
  return iso;
}

export function nowIso() {
  return new Date().toISOString();
}

export function compareStrings(a, b) {
  const left = a === null || a === undefined ? '' : String(a);
  const right = b === null || b === undefined ? '' : String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
