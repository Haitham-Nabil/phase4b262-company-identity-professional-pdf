// Central error taxonomy. Never let raw storage/runtime errors reach the UI.
export const ERROR_CODE = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BUSINESS_RULE_ERROR: 'BUSINESS_RULE_ERROR',
  STORAGE_ERROR: 'STORAGE_ERROR',
  IMPORT_ERROR: 'IMPORT_ERROR',
  BACKUP_ERROR: 'BACKUP_ERROR',
  RESTORE_ERROR: 'RESTORE_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR'
});

export class AppError extends Error {
  constructor(code, message, { field = null, details = null, cause = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.field = field;
    this.details = details;
    this.cause = cause;
  }
  toJSON() {
    return { code: this.code, message: this.message, field: this.field, details: this.details };
  }
}

export function appError(code, message, options) {
  return new AppError(code, message, options);
}

export function validationError(message, field = null, details = null) {
  return new AppError(ERROR_CODE.VALIDATION_ERROR, message, { field, details });
}

export function businessRuleError(message, field = null, details = null) {
  return new AppError(ERROR_CODE.BUSINESS_RULE_ERROR, message, { field, details });
}

export function notFoundError(message, field = null) {
  return new AppError(ERROR_CODE.NOT_FOUND, message, { field });
}

export function conflictError(message, field = null) {
  return new AppError(ERROR_CODE.CONFLICT, message, { field });
}
