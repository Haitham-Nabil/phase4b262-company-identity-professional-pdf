import { transactionRepository } from '../repositories/transactionRepository.js';
import { validateCancellation } from '../validation/transactionValidation.js';
import { STATUS } from '../domain/transactionTypes.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';
import { nowIso } from '../domain/dateUtils.js';

// Logical cancellation only — NO physical delete, NO reverse transaction (spec §14).
export const cancellationService = {
  async cancelTransaction(transactionId, reason) {
    const { authService } = await import('./authService.js'); authService.assertCanManageData();
    const record = await transactionRepository.getById(transactionId);
    if (!record) throw new AppError(ERROR_CODE.NOT_FOUND, 'الحركة غير موجودة.', { field: 'TransactionId' });
    const text = validateCancellation(record, reason);
    const updated = { ...record, Status: STATUS.CANCELLED, CancellationReason: text, CancelledAt: nowIso(), UpdatedAt: nowIso() };
    await transactionRepository.put(updated);
    return updated;
  },
  async listCancelled() {
    const all = await transactionRepository.getAll();
    return all.filter((row) => row.Status === STATUS.CANCELLED);
  }
};
