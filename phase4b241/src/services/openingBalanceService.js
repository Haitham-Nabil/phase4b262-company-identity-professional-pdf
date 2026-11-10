import { authService } from './authService.js';
import { customerRepository } from '../repositories/customerRepository.js';
import { openingBalanceRepository } from '../repositories/openingBalanceRepository.js';
import { runTransaction } from '../storage/db.js';
import { STORE } from '../storage/schema.js';
import { validateOpeningBalanceChange } from '../validation/customerValidation.js';
import { balanceService } from './balanceService.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';
import { createId, ID_PREFIX } from '../utils/id.js';
import { nowIso } from '../domain/dateUtils.js';

// Opening balance is NOT a transaction, NOT cash, NOT a settlement (spec §13).
export const openingBalanceService = {
  async setOpeningBalance(customerId, { newValue, reason }) {
    authService.assertCanManageData();
    const validation = validateOpeningBalanceChange({ newValue, reason });
    if (!validation.ok) {
      const first = validation.errors[0];
      throw new AppError(first.code, first.message, { field: first.field, details: { errors: validation.errors } });
    }
    const now = nowIso();
    let unchanged = false;
    const history = {
      Id: createId(ID_PREFIX.OPENING_HISTORY),
      CustomerId: customerId,
      OldValueMinor: null,
      NewValueMinor: validation.data.NewValueMinor,
      ChangedAt: now,
      Reason: validation.data.Reason
    };
    await runTransaction([STORE.CUSTOMERS, STORE.OPENING_BALANCE_HISTORY], 'readwrite', async (stores) => {
      const customer = await new Promise((resolve, reject) => {
        const request = stores[STORE.CUSTOMERS].get(customerId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(new AppError(ERROR_CODE.STORAGE_ERROR, 'تعذر قراءة العميل.', { cause: request.error }));
      });
      if (!customer) throw new AppError(ERROR_CODE.NOT_FOUND, 'العميل غير موجود.', { field: 'CustomerId' });
      const currentMinor = customer.OpeningBalanceMinor || 0;
      // Phase 4B.14 — the smallest necessary service fix: saving the value that is already
      // stored used to append a history row whose OldValue equals NewValue, which reads as a
      // change that never happened. Nothing is written now; the caller is told Unchanged.
      if (currentMinor === validation.data.NewValueMinor) {
        unchanged = true;
        return false;
      }
      history.OldValueMinor = currentMinor;
      await new Promise((resolve, reject) => {
        const request = stores[STORE.CUSTOMERS].put({ ...customer, OpeningBalanceMinor: validation.data.NewValueMinor, UpdatedAt: now });
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(new AppError(ERROR_CODE.STORAGE_ERROR, 'تعذر تحديث الرصيد الافتتاحي.', { cause: request.error }));
      });
      await new Promise((resolve, reject) => {
        const request = stores[STORE.OPENING_BALANCE_HISTORY].put(history);
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(new AppError(ERROR_CODE.STORAGE_ERROR, 'تعذر تسجيل تعديل الرصيد الافتتاحي.', { cause: request.error }));
      });
      return true;
    });
    const summary = await balanceService.getCustomerSummary(customerId);
    if (unchanged) return { History: null, Summary: summary, Unchanged: true };
    return { History: history, Summary: summary, Unchanged: false };
  },

  // Phase 4B.14 — a read-only summary for the review step. It reuses the same
  // validation as the write path, and it reads the current value from the customer
  // record; it never writes, never rounds differently and never decides a balance.
  async previewChange(customerId, { newValue, reason } = {}) {
    const validation = validateOpeningBalanceChange({ newValue, reason });
    if (!validation.ok) {
      const first = validation.errors[0];
      throw new AppError(first.code, first.message, { field: first.field, details: { errors: validation.errors } });
    }
    const customer = await customerRepository.getById(customerId);
    if (!customer) throw new AppError(ERROR_CODE.NOT_FOUND, 'العميل غير موجود.', { field: 'CustomerId' });
    const currentMinor = Number.isInteger(customer.OpeningBalanceMinor) ? customer.OpeningBalanceMinor : 0;
    const nextMinor = validation.data.NewValueMinor;
    const deltaMinor = nextMinor - currentMinor;
    return {
      CustomerId: customerId,
      CustomerName: customer.Name || null,
      CustomerCode: customer.Code || null,
      CurrentMinor: currentMinor,
      NewValueMinor: nextMinor,
      DeltaMinor: deltaMinor,
      Direction: deltaMinor > 0 ? 'Increase' : (deltaMinor < 0 ? 'Decrease' : 'None'),
      // The service reports "nothing would change" instead of writing a misleading log row.
      NoChange: deltaMinor === 0,
      Reason: validation.data.Reason
    };
  },

  async listHistory(customerId) {
    const rows = await openingBalanceRepository.listByCustomer(customerId);
    return rows.slice().sort((a, b) => String(a.ChangedAt).localeCompare(String(b.ChangedAt)));
  }
};
