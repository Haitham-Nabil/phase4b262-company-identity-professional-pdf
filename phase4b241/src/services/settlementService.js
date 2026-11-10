// Phase 4B.5 / 4B.5.1 — the single service entry point behind the Settlements screen.
//
// It decides NOTHING financially of its own. Settlement and GoodsExchange are both
// NON-CASH movements that may go in EITHER direction: their derived Debit / Credit
// columns, their zero cash columns, their non-cash value and their running balance all
// come from the approved core projection (`balanceService.getRunningBalance` ->
// `deriveFinancials`), and the write path is the exact same entry point the Add
// Transaction screen uses (`transactionFormService.submitTransactionForm`).
//
// The direction is an explicit statement the user makes (Credit = added to the farmer
// balance, Debit = deducted from it). It is persisted on the record and read back from
// it; it is never a DebitMinor / CreditMinor figure and never a second balance engine.
// The only aggregates this facade owns are plain sums of values the core already
// derived per row.
import { customerService } from './customerService.js';
import { balanceService, projectBalanceMinor } from './balanceService.js';
import { transactionFormService } from './transactionFormService.js';
import { deriveFinancials, DIRECTION } from '../domain/financialDirection.js';
import { hasDerivedFinancialField } from '../validation/transactionValidation.js';
import { TRANSACTION_TYPE, STATUS } from '../domain/transactionTypes.js';
import { normalizeMoneyInput } from '../validation/commonValidation.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';

// The Settlements screen handles exactly these two non-cash types. DebtTransfer is
// deliberately NOT part of this list: it is a separate operation for a later phase,
// even though the core also classifies it as non-cash.
export const SETTLEMENT_MOVEMENT_TYPES = Object.freeze([
  TRANSACTION_TYPE.SETTLEMENT,
  TRANSACTION_TYPE.GOODS_EXCHANGE
]);

function isSettlementMovement(row) {
  return SETTLEMENT_MOVEMENT_TYPES.includes(row && row.TransactionType);
}

// Deterministic, stable order shared by every read of this screen: Date ASC, then
// Id ASC. The running balance stays the one the service produced over the
// customer's FULL financial sequence, so narrowing the view never shifts it.
function orderMovements(rows) {
  return rows.slice().sort((a, b) => {
    const byDate = String(a.Date).localeCompare(String(b.Date));
    if (byDate !== 0) return byDate;
    return String(a.Id).localeCompare(String(b.Id));
  });
}

export const settlementService = {
  movementTypes() {
    return [...SETTLEMENT_MOVEMENT_TYPES];
  },

  isSettlementType(transactionType) {
    return SETTLEMENT_MOVEMENT_TYPES.includes(transactionType);
  },

  // Customers offered in the picker: Code + Name, read through the services layer.
  async listSelectableCustomers() {
    return customerService.listCustomers();
  },

  async getCustomer(customerId) {
    return customerService.getCustomer(customerId);
  },

  /**
   * Every Settlement / GoodsExchange row across all customers. Each row carries the
   * core-derived Debit and Credit columns (whichever side the persisted direction
   * selected), the core non-cash value, the core cash columns (always 0 for these two
   * types) and the core running balance — nothing is recalculated here. Cash movements
   * are NOT part of this read model at all.
   */
  async listSettlementMovements() {
    const customers = await customerService.listCustomers();
    const movements = [];
    for (const customer of customers) {
      const ledger = await balanceService.getRunningBalance(customer.Id);
      for (const entry of ledger.Entries) {
        if (!isSettlementMovement(entry)) continue;
        movements.push({
          Id: entry.Id,
          CustomerId: customer.Id,
          Code: customer.Code ?? null,
          Name: customer.Name ?? null,
          Phone: customer.Phone ?? null,
          Region: customer.Region ?? null,
          IsActiveCustomer: customer.IsActive === true,
          Date: entry.Date,
          Description: entry.Description ?? null,
          TransactionType: entry.TransactionType,
          // The core put the whole value on exactly one side; that side is the amount.
          Direction: entry.Direction ?? null,
          AmountMinor: entry.CreditMinor > 0 ? entry.CreditMinor : entry.DebitMinor,
          CreditMinor: entry.CreditMinor,
          DebitMinor: entry.DebitMinor,
          SettlementMinor: entry.SettlementMinor,
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
   * Plain sum of the rows the screen is currently showing. Every per-row value is the
   * core value; this method only adds them up, and it keeps the CREDIT total, the
   * DEBIT total and the NET impact apart so a movement total can never be mistaken for
   * a net effect. Cancelled rows are excluded, exactly as the core excludes them from
   * every balance. No total here is a cash total.
   */
  summarize(rows) {
    const list = Array.isArray(rows) ? rows : [];
    let SettlementCreditMinor = 0;
    let SettlementDebitMinor = 0;
    let GoodsExchangeCreditMinor = 0;
    let GoodsExchangeDebitMinor = 0;
    let Count = 0;
    let CancelledCount = 0;
    for (const row of list) {
      if (row && row.IsCancelled === true) {
        CancelledCount += 1;
        continue;
      }
      const credit = Number(row && row.CreditMinor) || 0;
      const debit = Number(row && row.DebitMinor) || 0;
      if (row.TransactionType === TRANSACTION_TYPE.SETTLEMENT) {
        SettlementCreditMinor += credit;
        SettlementDebitMinor += debit;
      } else if (row.TransactionType === TRANSACTION_TYPE.GOODS_EXCHANGE) {
        GoodsExchangeCreditMinor += credit;
        GoodsExchangeDebitMinor += debit;
      }
      Count += 1;
    }
    const TotalSettlementMinor = SettlementCreditMinor + SettlementDebitMinor;
    const TotalGoodsExchangeMinor = GoodsExchangeCreditMinor + GoodsExchangeDebitMinor;
    const NetSettlementMinor = SettlementCreditMinor - SettlementDebitMinor;
    const NetGoodsExchangeMinor = GoodsExchangeCreditMinor - GoodsExchangeDebitMinor;
    return {
      SettlementCreditMinor,
      SettlementDebitMinor,
      NetSettlementMinor,
      GoodsExchangeCreditMinor,
      GoodsExchangeDebitMinor,
      NetGoodsExchangeMinor,
      TotalSettlementMinor,
      TotalGoodsExchangeMinor,
      TotalNonCashMinor: TotalSettlementMinor + TotalGoodsExchangeMinor,
      NetNonCashMinor: NetSettlementMinor + NetGoodsExchangeMinor,
      Count,
      CancelledCount
    };
  },

  /**
   * Preview of ONE movement that has not been written yet. It is a projection, not a
   * rule: the debit / credit figures come from the core engine (`deriveFinancials`)
   * and the projected balance is the SAME approved formula evaluated one movement
   * ahead (`balanceService.projectBalanceMinor`). Nothing here is stored, and an
   * incomplete or invalid input simply yields no preview.
   *
   * `Insufficient` marks a Debit that would turn the balance negative; it is a warning
   * the user must confirm, never a refusal. `IncreasesDebt` marks a Debit that leaves
   * the account in debt (already negative, or negative afterwards).
   */
  async previewMovement(form = {}) {
    const transactionType = form.TransactionType;
    if (!SETTLEMENT_MOVEMENT_TYPES.includes(transactionType)) return null;
    const customerId = form.CustomerId === null || form.CustomerId === undefined ? '' : String(form.CustomerId).trim();
    if (!customerId) return null;

    let amountMinor = null;
    try {
      amountMinor = normalizeMoneyInput(Number(form.Amount), 'المبلغ');
    } catch (error) {
      return null;
    }

    let financials = null;
    try {
      financials = deriveFinancials({
        TransactionType: transactionType,
        Direction: form.Direction ?? null,
        AmountMinor: amountMinor,
        Status: STATUS.ACTIVE
      });
    } catch (error) {
      return null;
    }

    let summary = null;
    try {
      summary = await balanceService.getCustomerSummary(customerId);
    } catch (error) {
      return null;
    }

    const ProjectedBalanceMinor = projectBalanceMinor(summary.BalanceMinor, financials);
    const isDebit = financials.direction === DIRECTION.DEBIT;
    return {
      CustomerId: customerId,
      Code: summary.Code ?? null,
      Name: summary.Name ?? null,
      TransactionType: transactionType,
      Direction: financials.direction,
      AmountMinor: amountMinor,
      CreditMinor: financials.CreditMinor,
      DebitMinor: financials.DebitMinor,
      CurrentBalanceMinor: summary.BalanceMinor,
      ProjectedBalanceMinor,
      Insufficient: isDebit && ProjectedBalanceMinor < 0,
      IncreasesDebt: isDebit && (summary.BalanceMinor < 0 || ProjectedBalanceMinor < 0)
    };
  },

  /**
   * One user action -> exactly one write, through the approved Add Transaction
   * service. Only the two non-cash types are accepted here: the screen can never
   * create a cash row, and the UI never builds a financial record itself.
   */
  async createSettlementMovement(form = {}) {
    const { authService } = await import('./authService.js'); authService.assertCanAdd();
    const transactionType = form.TransactionType;
    if (!SETTLEMENT_MOVEMENT_TYPES.includes(transactionType)) {
      throw new AppError(
        ERROR_CODE.BUSINESS_RULE_ERROR,
        'شاشة التسويات تُسجّل الحركات غير النقدية فقط (تسوية أو تبادل بضائع).',
        { field: 'TransactionType' }
      );
    }
    // The caller may never hand in a derived financial column: Debit / Credit / cash /
    // settlement values are the core engine's output, not an input. This is a facade
    // guard only — it adds no financial rule of its own.
    if (hasDerivedFinancialField(form)) {
      throw new AppError(
        ERROR_CODE.BUSINESS_RULE_ERROR,
        'لا يمكن تمرير قيم مالية مشتقة (مدين/دائن/تسوية/نقدية) من الواجهة؛ يشتقها المحرك المالي من النوع والاتجاه والمبلغ.',
        { field: 'Direction' }
      );
    }
    return transactionFormService.submitTransactionForm({ ...form, TransactionType: transactionType });
  }
};
