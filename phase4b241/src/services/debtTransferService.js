import { authService } from './authService.js';
import { transactionRepository } from '../repositories/transactionRepository.js';
import { customerRepository } from '../repositories/customerRepository.js';
import { balanceService, projectBalanceMinor } from './balanceService.js';
import { runTransaction } from '../storage/db.js';
import { STORE } from '../storage/schema.js';
import { validateDebtTransferInput } from '../validation/transactionValidation.js';
import { TRANSACTION_TYPE, STATUS, DEBT_TRANSFER_ROLE } from '../domain/transactionTypes.js';
import { deriveFinancials } from '../domain/financialDirection.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';
import { createId, ID_PREFIX } from '../utils/id.js';
import { nowIso } from '../domain/dateUtils.js';

// One user operation -> TWO linked rows sharing one LinkId (spec §15).
// Customer A = Credit side (balance up), Customer B = Debit side (balance down). Cash impact = 0.
export const debtTransferService = {
  async createDebtTransfer(input) {
    authService.assertCanAdd();
    const validation = validateDebtTransferInput(input);
    if (!validation.ok) {
      const first = validation.errors[0];
      throw new AppError(first.code, first.message, { field: first.field, details: { errors: validation.errors } });
    }
    const { FromCustomerId, ToCustomerId, AmountMinor, Date, Description } = validation.data;
    const creditCustomer = await customerRepository.getById(FromCustomerId);
    if (!creditCustomer) throw new AppError(ERROR_CODE.NOT_FOUND, 'العميل الدائن غير موجود.', { field: 'FromCustomerId' });
    const debitCustomer = await customerRepository.getById(ToCustomerId);
    if (!debitCustomer) throw new AppError(ERROR_CODE.NOT_FOUND, 'العميل المدين غير موجود.', { field: 'ToCustomerId' });

    const linkId = createId(ID_PREFIX.LINK);
    const now = nowIso();
    const base = {
      Date, TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER, Description, AmountMinor, LinkId: linkId,
      Status: STATUS.ACTIVE, CancellationReason: null, CancelledAt: null, CreatedAt: now, UpdatedAt: now
    };
    const creditRow = { ...base, Id: createId(ID_PREFIX.TRANSACTION), CustomerId: FromCustomerId, TransferRole: DEBT_TRANSFER_ROLE.CREDIT_SIDE };
    const debitRow = { ...base, Id: createId(ID_PREFIX.TRANSACTION), CustomerId: ToCustomerId, TransferRole: DEBT_TRANSFER_ROLE.DEBIT_SIDE };
    deriveFinancials(creditRow); deriveFinancials(debitRow);

    // Both rows are written inside ONE transaction => all-or-nothing.
    await runTransaction(STORE.TRANSACTIONS, 'readwrite', async (stores) => {
      for (const row of [creditRow, debitRow]) {
        await new Promise((resolve, reject) => {
          const request = stores[STORE.TRANSACTIONS].add(row);
          request.onsuccess = () => resolve(true);
          request.onerror = () => reject(new AppError(ERROR_CODE.STORAGE_ERROR, 'تعذر حفظ حركة تحويل المديونية.', { cause: request.error }));
        });
      }
      return true;
    });
    return { LinkId: linkId, CreditRow: creditRow, DebitRow: debitRow, CashImpactMinor: 0 };
  },

  /**
   * Phase 4B.9 — read-only preview of one transfer, used by the Add Transaction
   * screen. Both projected balances come from the SAME approved engine the write
   * path uses (deriveFinancials + projectBalanceMinor), so the preview cannot drift
   * from the saved result. Nothing is written and no balance is read for effect.
   */
  async previewTransfer(input) {
    const validation = validateDebtTransferInput(input);
    if (!validation.ok) {
      const first = validation.errors[0];
      return {
        Valid: false,
        Message: first.message,
        Field: first.field ?? null,
        SameCustomer: String(first.message).includes('نفس العميل')
      };
    }
    const { FromCustomerId, ToCustomerId, AmountMinor, Date, Description } = validation.data;
    const creditCustomer = await customerRepository.getById(FromCustomerId);
    if (!creditCustomer) return { Valid: false, Message: 'العميل الدائن غير موجود.', Field: 'FromCustomerId' };
    const debitCustomer = await customerRepository.getById(ToCustomerId);
    if (!debitCustomer) return { Valid: false, Message: 'العميل المدين غير موجود.', Field: 'ToCustomerId' };

    if (authService.isAuthenticated() && !authService.isAdmin()) {
      return { Valid: true, Message: null, Field: null, SameCustomer: false, AmountMinor, Date, Description,
        From: { CustomerId: creditCustomer.Id, Code: creditCustomer.Code, Name: creditCustomer.Name },
        To: { CustomerId: debitCustomer.Id, Code: debitCustomer.Code, Name: debitCustomer.Name }, CashImpactMinor: 0 };
    }
    const creditSummary = await balanceService.getCustomerSummary(FromCustomerId);
    const debitSummary = await balanceService.getCustomerSummary(ToCustomerId);
    const base = { TransactionType: TRANSACTION_TYPE.DEBT_TRANSFER, AmountMinor, Status: STATUS.ACTIVE };
    const creditFinancials = deriveFinancials({ ...base, TransferRole: DEBT_TRANSFER_ROLE.CREDIT_SIDE });
    const debitFinancials = deriveFinancials({ ...base, TransferRole: DEBT_TRANSFER_ROLE.DEBIT_SIDE });

    const From = {
      CustomerId: creditSummary.CustomerId, Code: creditSummary.Code ?? null, Name: creditSummary.Name ?? null,
      CurrentBalanceMinor: creditSummary.BalanceMinor,
      ProjectedBalanceMinor: projectBalanceMinor(creditSummary.BalanceMinor, creditFinancials),
      CreditMinor: creditFinancials.CreditMinor, DebitMinor: creditFinancials.DebitMinor
    };
    const To = {
      CustomerId: debitSummary.CustomerId, Code: debitSummary.Code ?? null, Name: debitSummary.Name ?? null,
      CurrentBalanceMinor: debitSummary.BalanceMinor,
      ProjectedBalanceMinor: projectBalanceMinor(debitSummary.BalanceMinor, debitFinancials),
      CreditMinor: debitFinancials.CreditMinor, DebitMinor: debitFinancials.DebitMinor
    };

    if (authService.isAuthenticated() && !authService.isAdmin()) {
      return { Valid: true, Message: null, Field: null, SameCustomer: false, AmountMinor, Date, Description,
        From: { CustomerId: From.CustomerId, Code: From.Code, Name: From.Name },
        To: { CustomerId: To.CustomerId, Code: To.Code, Name: To.Name }, CashImpactMinor: 0 };
    }
    return {
      Valid: true, Message: null, Field: null, SameCustomer: false,
      AmountMinor, Date, Description,
      From, To,
      CashImpactMinor: 0,
      Insufficient: To.ProjectedBalanceMinor < 0,
      TotalBefore: From.CurrentBalanceMinor + To.CurrentBalanceMinor,
      TotalAfter: From.ProjectedBalanceMinor + To.ProjectedBalanceMinor
    };
  },

  async getTransfer(linkId) {
    authService.assertCanManageData();
    const rows = await transactionRepository.listByLinkId(linkId);
    if (!rows.length) throw new AppError(ERROR_CODE.NOT_FOUND, 'عملية التحويل غير موجودة.', { field: 'LinkId' });
    return { LinkId: linkId, Rows: rows, CashImpactMinor: 0 };
  }
};
