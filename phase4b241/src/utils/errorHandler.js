import { AppError, ERROR_CODE } from '../domain/errors.js';
import { fail } from '../domain/result.js';
import { logger } from './logger.js';

// Central place that converts anything into a typed AppError.
export function toAppError(error, fallbackCode = ERROR_CODE.UNEXPECTED_ERROR) {
  if (error instanceof AppError) return error;
  const message = error && error.message ? String(error.message) : 'حدث خطأ غير متوقع.';
  return new AppError(fallbackCode, message, {
    details: { name: error && error.name ? String(error.name) : null },
    cause: error
  });
}

// Wraps a service function so it always returns a Result (never throws).
export function guard(fn, fallbackCode = ERROR_CODE.UNEXPECTED_ERROR) {
  return async function guarded(...args) {
    try {
      const data = await fn.apply(this, args);
      return { ok: true, data, errors: [] };
    } catch (error) {
      const appError = toAppError(error, fallbackCode);
      logger.error(`[${appError.code}] ${appError.message}`, {
        field: appError.field,
        details: appError.details
      });
      return fail([appError]);
    }
  };
}

// Re-throws the first error of a failed Result so internal composition stays clean.
export function unwrap(result, fallbackMessage = 'فشلت العملية.') {
  if (result && result.ok) return result.data;
  const first = result && result.errors && result.errors.length ? result.errors[0] : null;
  throw new AppError(
    first ? first.code : ERROR_CODE.UNEXPECTED_ERROR,
    first ? first.message : fallbackMessage,
    { field: first ? first.field : null, details: first ? first.details : null }
  );
}
