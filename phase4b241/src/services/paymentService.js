// Phase 4B.4 — the single service entry point behind the Payments screen.
//
// It decides NOTHING financially: the direction, the cash / non-cash flag, the
// running balance and the cancellation state of every row come from the approved
// core projection (`balanceService.getRunningBalance`), and the write path is the
// exact same entry point the Add Transaction screen uses
// (`transactionFormService.submitTransactionForm`). The only aggregate it owns is a
// plain SUM of values the core already computed per row — it never derives a value.
import { customerService } from './customerService.js';
import { balanceService } from './balanceService.js';
import { transactionFormService } from './transactionFormService.js';
import { CASH_TYPES } from '../domain/transactionTypes.js';
import { isTransactionType } from '../domain/transactionTypes.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';
import { authService } from './authService.js';

// The Payments screen handles exactly the two real cash movements.
export const CASH_MOVEMENT_TYPES = Object.freeze([...CASH_TYPES]);

function isCashMovement(row) {
  return CASH_TYPES.includes(row && row.TransactionType);
}

// Deterministic, stable order shared by every read of this screen: Date ASC, then
// Id ASC. The running balance stays the one the service produced for the
// customer's full financial sequence, so narrowing the view never shifts it.
function orderMovements(rows) {
  return rows.slice().sort((a, b) => {
    const byDate = String(a.Date).localeCompare(String(b.Date));
    if (byDate !== 0) return byDate;
    return String(a.Id).localeCompare(String(b.Id));
  });
}

export const paymentService = {
  cashTypes() {
    return [...CASH_MOVEMENT_TYPES];
  },

  isCashType(transactionType) {
    return CASH_TYPES.includes(transactionType);
  },

  // Customers offered in the picker: Code + Name, read through the services layer.
  async listSelectableCustomers() {
    return customerService.listCustomers();
  },

  async getCustomer(customerId) {
    return customerService.getCustomer(customerId);
  },

  /**
   * Every real cash movement (CashReceived / CashPaid) across all customers.
   * Non-cash rows (Settlement, GoodsExchange, DebtTransfer) are NOT part of this
   * read model at all. Each row carries the core-computed cash columns, running
   * balance and cancellation state — nothing is recalculated here.
   */
  async listCashMovements() {
    const customers = await customerService.listCustomers();
    const movements = [];
    for (const customer of customers) {
      const ledger = await balanceService.getRunningBalance(customer.Id);
      for (const entry of ledger.Entries) {
        if (!isCashMovement(entry)) continue;
        movements.push({
          Id: entry.Id,
          CustomerId: customer.Id,
          Code: customer.Code ?? null,
          Name: customer.Name ?? null,
          Phone: customer.Phone ?? null,
          Region: customer.Region ?? null,
          IsActiveCustomer: customer.IsActive === true,
          Date: entry.Date,
          TransactionType: entry.TransactionType,
          Description: entry.Description ?? null,
          AmountMinor: entry.DebitMinor || entry.CreditMinor,
          CashReceivedMinor: entry.CashReceivedMinor,
          CashPaidMinor: entry.CashPaidMinor,
          RunningBalanceMinor: entry.RunningBalanceMinor,
          Status: entry.Status,
          IsCancelled: entry.IsCancelled === true,
          CancellationReason: entry.CancellationReason ?? null
        });
      }
    }
    return orderMovements(movements);
  },

  /**
   * Plain sum of the rows the screen is currently showing. Every per-row value is
   * the core value; this method only adds them up (cancelled rows are excluded from
   * the totals, exactly as the core excludes them from every balance).
   */
  summarize(rows) {
    const list = Array.isArray(rows) ? rows : [];
    let CashReceivedMinor = 0;
    let CashPaidMinor = 0;
    let Count = 0;
    let CancelledCount = 0;
    for (const row of list) {
      if (row && row.IsCancelled === true) {
        CancelledCount += 1;
        continue;
      }
      CashReceivedMinor += Number(row && row.CashReceivedMinor) || 0;
      CashPaidMinor += Number(row && row.CashPaidMinor) || 0;
      Count += 1;
    }
    return {
      CashReceivedMinor,
      CashPaidMinor,
      NetCashMinor: CashReceivedMinor - CashPaidMinor,
      Count,
      CancelledCount
    };
  },

  /**
   * One user action -> exactly one write, through the approved Add Transaction
   * service. Only the two cash types are accepted here: the screen can never create
   * a non-cash row, and the UI never builds a financial record itself.
   */
  async createCashMovement(form = {}) {
    authService.assertCanAdd();
    const transactionType = form.TransactionType;
    if (!isTransactionType(transactionType) || !CASH_TYPES.includes(transactionType)) {
      throw new AppError(
        ERROR_CODE.BUSINESS_RULE_ERROR,
        'شاشة المدفوعات تُسجّل الحركات النقدية فقط (استلام نقدية أو دفعة نقدية).',
        { field: 'TransactionType' }
      );
    }
    return transactionFormService.submitTransactionForm({ ...form, TransactionType: transactionType });
  }
};
