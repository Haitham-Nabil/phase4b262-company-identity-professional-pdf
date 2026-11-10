import { ERROR_CODE, AppError } from './errors.js';

// Result pattern: { ok, data, errors }. Services never throw across the UI boundary.
export function ok(data = null) {
  return { ok: true, data, errors: [] };
}

export function fail(errors, data = null) {
  const list = Array.isArray(errors) ? errors : [errors];
  return { ok: false, data, errors: list.map(describeError) };
}

export function describeError(error) {
  if (error instanceof AppError) return error.toJSON();
  if (error && typeof error === 'object' && error.code && error.message) {
    return { code: error.code, message: String(error.message), field: error.field ?? null, details: error.details ?? null };
  }
  return {
    code: ERROR_CODE.UNEXPECTED_ERROR,
    message: error && error.message ? String(error.message) : String(error),
    field: null,
    details: null
  };
}

export const Result = { ok, fail, describeError };
