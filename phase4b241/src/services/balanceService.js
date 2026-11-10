import { authService } from './authService.js';
import { cropPurchaseService } from './cropPurchaseService.js';
import { cartonReferenceParts, localReferenceParts } from './movementNotes.js';
import { customerRepository } from '../repositories/customerRepository.js';
import { transactionRepository } from '../repositories/transactionRepository.js';
import { deriveFinancials } from '../domain/financialDirection.js';
import { STATUS, TRANSACTION_TYPE, DEBT_TRANSFER_ROLE, CASH_TYPES, NON_CASH_TYPES } from '../domain/transactionTypes.js';
import { canEditTransaction, canCancelTransaction } from '../domain/transactionLifecycle.js';
import { receivingCompanyRepository } from '../repositories/receivingCompanyRepository.js';
import { cartonTypeRepository } from '../repositories/cartonTypeRepository.js';
import { strawberryVarietyRepository } from '../repositories/strawberryVarietyRepository.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';

export const BALANCE_SIDES = Object.freeze({ POSITIVE: 'Credit', NEGATIVE: 'Debit', ZERO: 'Zero' });

export function balanceSide(balanceMinor) {
  if (balanceMinor > 0) return BALANCE_SIDES.POSITIVE;
  if (balanceMinor < 0) return BALANCE_SIDES.NEGATIVE;
  return BALANCE_SIDES.ZERO;
}

// Forward projection used by the settlement preview: the SAME approved formula
// (Balance = Opening + Credits - Debits), evaluated one movement ahead. It adds no
// rule of its own — the debit / credit figures it consumes come from deriveFinancials.
export function projectBalanceMinor(currentBalanceMinor, financials) {
  return currentBalanceMinor + financials.CreditMinor - financials.DebitMinor;
}

// Deterministic ordering: Date ASC, then CreatedAt, then Id (spec §48).
export function orderTransactions(rows) {
  return rows.slice().sort((a, b) => {
    const byDate = String(a.Date).localeCompare(String(b.Date));
    if (byDate !== 0) return byDate;
    const byCreated = String(a.CreatedAt || '').localeCompare(String(b.CreatedAt || ''));
    if (byCreated !== 0) return byCreated;
    return String(a.Id).localeCompare(String(b.Id));
  });
}

// Balance = OpeningBalance + Credits - Debits (single canonical formula).
export function summarize(rows, openingBalanceMinor = 0) {
  const totals = {
    OpeningBalanceMinor: openingBalanceMinor,
    TotalDebitMinor: 0, TotalCreditMinor: 0,
    CashReceivedMinor: 0, CashPaidMinor: 0,
    NonCashSettlementMinor: 0,
    ByType: {}
  };
  for (const row of rows) {
    const f = deriveFinancials(row);
    if (!f.isActive) continue;
    totals.TotalDebitMinor += f.DebitMinor;
    totals.TotalCreditMinor += f.CreditMinor;
    totals.CashReceivedMinor += f.CashReceivedMinor;
    totals.CashPaidMinor += f.CashPaidMinor;
    const bucket = totals.ByType[row.TransactionType] || { DebitMinor: 0, CreditMinor: 0, AmountMinor: 0 };
    bucket.DebitMinor += f.DebitMinor;
    bucket.CreditMinor += f.CreditMinor;
    bucket.AmountMinor += row.AmountMinor;
    totals.ByType[row.TransactionType] = bucket;
    // Debt transfer: one operation = two rows; the non-cash aggregate counts it ONCE.
    if (row.TransactionType === TRANSACTION_TYPE.DEBT_TRANSFER) {
      if (row.TransferRole !== DEBT_TRANSFER_ROLE.DEBIT_SIDE) totals.NonCashSettlementMinor += row.AmountMinor;
    } else {
      totals.NonCashSettlementMinor += f.SettlementMinor;
    }
  }
  totals.BalanceMinor = totals.OpeningBalanceMinor + totals.TotalCreditMinor - totals.TotalDebitMinor;
  totals.BalanceSide = balanceSide(totals.BalanceMinor);
  return totals;
}

// Single projection used by the customer read models below. It computes nothing
// on its own: it exposes the canonical summary produced by summarize().
function toCustomerRow(customer, rows) {
  const s = summarize(rows, customer.OpeningBalanceMinor || 0);
  return {
    Customer: customer,
    Summary: {
      OpeningBalanceMinor: s.OpeningBalanceMinor,
      TotalDebitMinor: s.TotalDebitMinor,
      TotalCreditMinor: s.TotalCreditMinor,
      CashReceivedMinor: s.CashReceivedMinor,
      CashPaidMinor: s.CashPaidMinor,
      NonCashSettlementMinor: s.NonCashSettlementMinor,
      BalanceMinor: s.BalanceMinor,
      BalanceSide: s.BalanceSide
    }
  };
}

// Phase 4B.9 — read-only enrichment: a linked debt-transfer row is displayed together
// with its opposite leg, so the statement can name the counterparty and its role. No
// storage field is added and no figure is computed here: LinkId is read back from the
// row and the sibling leg is fetched through the approved repository read.
async function resolveCounterparties(rows) {
  const out = new Map();
  const linkIds = [...new Set(rows.map((row) => row.LinkId).filter(Boolean))];
  if (!linkIds.length) return out;
  const customerCache = new Map();
  for (const linkId of linkIds) {
    const legs = await transactionRepository.listByLinkId(linkId);
    for (const row of rows) {
      if (row.LinkId !== linkId) continue;
      const other = legs.find((leg) => leg.Id !== row.Id) || null;
      if (!other) continue;
      if (!customerCache.has(other.CustomerId)) customerCache.set(other.CustomerId, await customerRepository.getById(other.CustomerId));
      const otherCustomer = customerCache.get(other.CustomerId) || null;
      out.set(row.Id, {
        CustomerId: other.CustomerId,
        Code: otherCustomer ? otherCustomer.Code : null,
        Name: otherCustomer ? otherCustomer.Name : null,
        TransferRole: other.TransferRole ?? null
      });
    }
  }
  return out;
}

// Phase 4B.11 — a carton row is displayed with the NAMES of the two reference records it
// stored, read back by their ids. A record that is now inactive (or that a pre-4B.11 row
// never had) simply resolves to null: the statement shows "غير محدد", never a guess.
async function resolveReferenceNames(rows) {
  const wanted = (key) => [...new Set(rows.map((row) => row[key]).filter(Boolean))];
  const companyIds = wanted('ReceivingCompanyId');
  const typeIds = wanted('CartonTypeId');
  // Phase 4B.13.1 — the strawberry variety of a local purchase is resolved here too, so
  // the statement can name it without the view ever reading storage.
  const varietyIds = wanted('StrawberryVarietyId');
  const companies = new Map();
  const types = new Map();
  const varieties = new Map();
  for (const id of companyIds) companies.set(id, await receivingCompanyRepository.getById(id));
  for (const id of typeIds) types.set(id, await cartonTypeRepository.getById(id));
  for (const id of varietyIds) varieties.set(id, await strawberryVarietyRepository.getById(id));
  return { companies, types, varieties };
}

export const balanceService = {
  async getCustomerSummary(customerId) {
    authService.assertCanManageData();
    const customer = await customerRepository.getById(customerId);
    if (!customer) throw new AppError(ERROR_CODE.NOT_FOUND, 'العميل غير موجود.', { field: 'CustomerId' });
    const rows = await transactionRepository.listByCustomer(customerId);
    const totals = summarize(rows, customer.OpeningBalanceMinor || 0);
    return { CustomerId: customer.Id, Code: customer.Code, Name: customer.Name, ...totals };
  },

  // Running balance per ledger row. Cancelled rows are shown but never change the balance.
  async getRunningBalance(customerId) {
    authService.assertCanManageData();
    const customer = await customerRepository.getById(customerId);
    if (!customer) throw new AppError(ERROR_CODE.NOT_FOUND, 'العميل غير موجود.', { field: 'CustomerId' });
    const rows = orderTransactions(await transactionRepository.listByCustomer(customerId));
    const counterparties = await resolveCounterparties(rows);
    const references = await resolveReferenceNames(rows);
    let running = customer.OpeningBalanceMinor || 0;
    const ledger = rows.map((source) => {
      const f = deriveFinancials(source);
      // The weight facts are decoration for the statement only: they never enter the
      // balance, the debit, the credit or the cash figures computed below.
      const row = {
        ...source,
        CropFacts: source.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL
          ? cropPurchaseService.localMovementFacts(source)
          : null
      };
      if (f.isActive) running = running + f.CreditMinor - f.DebitMinor;
      // Phase 4B.6 — the statement row also carries whether the movement may be
      // edited or cancelled. This is a lifecycle answer produced by the domain, not a
      // financial figure: no balance, debit, credit or cash value is decided here.
      const editGate = canEditTransaction(row);
      const cancelGate = canCancelTransaction(row);
      return {
        Id: row.Id, Date: row.Date, TransactionType: row.TransactionType, Description: row.Description, Direction: row.Direction ?? null,
        DebitMinor: f.DebitMinor, CreditMinor: f.CreditMinor,
        CashReceivedMinor: f.CashReceivedMinor, CashPaidMinor: f.CashPaidMinor, SettlementMinor: f.SettlementMinor,
        Status: row.Status, IsCancelled: !f.isActive, CancellationReason: row.CancellationReason ?? null,
        CancelledAt: row.CancelledAt ?? null,
        CanEdit: editGate.allowed, EditBlockReason: editGate.reason,
        CanCancel: cancelGate.allowed, CancelBlockReason: cancelGate.reason,
        // Phase 4B.9 — a linked transfer leg is shown with the party and the role of
        // its opposite leg, read back from the same approved services layer.
        LinkId: row.LinkId ?? null,
        TransferRole: row.TransferRole ?? null,
        CounterpartyId: counterparties.get(row.Id) ? counterparties.get(row.Id).CustomerId : null,
        CounterpartyCode: counterparties.get(row.Id) ? counterparties.get(row.Id).Code : null,
        CounterpartyName: counterparties.get(row.Id) ? counterparties.get(row.Id).Name : null,
        CounterpartyTransferRole: counterparties.get(row.Id) ? counterparties.get(row.Id).TransferRole : null,
        // Phase 4B.11 — the stored reference ids and the names they currently resolve to.
        ReceivingCompanyId: row.ReceivingCompanyId ?? null,
        ReceivingCompanyName: references.companies.get(row.ReceivingCompanyId) ? references.companies.get(row.ReceivingCompanyId).Name : null,
        ReceivingCompanyActive: references.companies.get(row.ReceivingCompanyId) ? references.companies.get(row.ReceivingCompanyId).IsActive === true : null,
        CartonTypeId: row.CartonTypeId ?? null,
        CartonTypeName: references.types.get(row.CartonTypeId) ? references.types.get(row.CartonTypeId).Name : null,
        CartonTypeActive: references.types.get(row.CartonTypeId) ? references.types.get(row.CartonTypeId).IsActive === true : null,
        // Phase 4B.11 fix — the STORED carton count (K) is part of the statement contract: the
        // view prints it and never derives it from a weight. Null on a row that has none.
        CartonQuantityMilli: Number.isInteger(row.CartonQuantityMilli) ? row.CartonQuantityMilli : null,
        CartonUnitPriceMinor: Number.isInteger(row.CartonUnitPriceMinor) ? row.CartonUnitPriceMinor : null,
        LocalUnitPriceMinor: Number.isInteger(row.LocalUnitPriceMinor) ? row.LocalUnitPriceMinor : null,
        // The reference description of a carton movement is completed HERE, in the layer that
        // already resolved the names: company · carton type · stored count with its Arabic unit.
        ReferenceParts: row.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_CARTON
          ? cartonReferenceParts({
            ReceivingCompanyId: row.ReceivingCompanyId ?? null,
            ReceivingCompanyName: references.companies.get(row.ReceivingCompanyId) ? references.companies.get(row.ReceivingCompanyId).Name : null,
            ReceivingCompanyActive: references.companies.get(row.ReceivingCompanyId) ? references.companies.get(row.ReceivingCompanyId).IsActive === true : null,
            CartonTypeId: row.CartonTypeId ?? null,
            CartonTypeName: references.types.get(row.CartonTypeId) ? references.types.get(row.CartonTypeId).Name : null,
            CartonTypeActive: references.types.get(row.CartonTypeId) ? references.types.get(row.CartonTypeId).IsActive === true : null,
            CartonQuantityMilli: row.CartonQuantityMilli ?? null,
            CartonUnitPriceMinor: Number.isInteger(row.CartonUnitPriceMinor) ? row.CartonUnitPriceMinor : null
          })
          : (row.TransactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL
            // Phase 4B.13.1 — variety · package count · net weight, produced by the ONE
            // wording module from the values stored on this row.
            ? localReferenceParts({
              StrawberryVarietyId: row.StrawberryVarietyId ?? null,
              StrawberryVarietyName: references.varieties.get(row.StrawberryVarietyId) ? references.varieties.get(row.StrawberryVarietyId).Name : null,
              StrawberryVarietyActive: references.varieties.get(row.StrawberryVarietyId) ? references.varieties.get(row.StrawberryVarietyId).IsActive === true : null,
              PackageCountMilli: row.CropFacts ? row.CropFacts.PackageCountMilli : null,
              CropNetWeightMilli: row.CropFacts ? row.CropFacts.NetWeightMilli : null,
              CropWeightResolved: row.CropFacts ? row.CropFacts.Resolved : null,
              LocalUnitPriceMinor: Number.isInteger(row.LocalUnitPriceMinor) ? row.LocalUnitPriceMinor : null
            })
            : null),
        // Phase 4B.13.1 — the stored variety id and the name it resolves to today. The
        // id is what was recorded; the name is only a description.
        StrawberryVarietyId: row.StrawberryVarietyId ?? null,
        StrawberryVarietyName: references.varieties.get(row.StrawberryVarietyId) ? references.varieties.get(row.StrawberryVarietyId).Name : null,
        StrawberryVarietyActive: references.varieties.get(row.StrawberryVarietyId) ? references.varieties.get(row.StrawberryVarietyId).IsActive === true : null,
        // The historical package weight of a local purchase, exactly as stored on the row.
        PackageWeightKg: row.PackageWeightKg ?? null,
        PackageWeightStatus: row.PackageWeightStatus ?? null,
        NetWeightMilli: row.NetWeightMilli ?? null,
        // Phase 4B.11 — the display facts of a local crop purchase, produced by the ONE
        // weight service from the values stored on this row (never from the setting).
        PackageCountMilli: row.CropFacts ? row.CropFacts.PackageCountMilli : null,
        CropNetWeightMilli: row.CropFacts ? row.CropFacts.NetWeightMilli : null,
        CropWeightResolved: row.CropFacts ? row.CropFacts.Resolved : null,
        RunningBalanceMinor: running
      };
    });
    return { OpeningBalanceMinor: customer.OpeningBalanceMinor || 0, BalanceMinor: running, BalanceSide: balanceSide(running), Entries: ledger };
  },

  async getCurrentBalanceMinor(customerId) {
    authService.assertCanManageData();
    return (await balanceService.getCustomerSummary(customerId)).BalanceMinor;
  },

  async getBalancesForCustomers(customerIds) {
    authService.assertCanManageData();
    const out = [];
    for (const customerId of customerIds) out.push(await balanceService.getCustomerSummary(customerId));
    return out;
  },

  // Read model for the Customers screen: every customer with the balance produced
  // by the one canonical engine above. Used to paint the list in a single pass.
  async listCustomerBalances() {
    authService.assertCanManageData();
    const customers = await customerRepository.getAll();
    const transactions = await transactionRepository.getAll();
    const byCustomer = new Map();
    for (const transaction of transactions) {
      if (!byCustomer.has(transaction.CustomerId)) byCustomer.set(transaction.CustomerId, []);
      byCustomer.get(transaction.CustomerId).push(transaction);
    }
    return customers.map((customer) => toCustomerRow(customer, byCustomer.get(customer.Id) || []));
  },

  // Same projection for a single customer, used when a screen needs one row.
  async getCustomerBalanceRow(customerId) {
    authService.assertCanManageData();
    const customer = await customerRepository.getById(customerId);
    if (!customer) throw new AppError(ERROR_CODE.NOT_FOUND, 'العميل غير موجود.', { field: 'CustomerId' });
    return toCustomerRow(customer, await transactionRepository.listByCustomer(customerId));
  },

  // Portfolio totals. Cash is reported strictly separately from non-cash.
  // Debt transfers net to zero across customers and are counted once per operation.
  async getPortfolioSummary() {
    authService.assertCanManageData();
    const customers = await customerRepository.getAll();
    const transactions = await transactionRepository.getAll();
    const byCustomer = new Map();
    for (const t of transactions) {
      if (!byCustomer.has(t.CustomerId)) byCustomer.set(t.CustomerId, []);
      byCustomer.get(t.CustomerId).push(t);
    }
    const totals = {
      CustomerCount: customers.length,
      ActiveCustomerCount: customers.filter((c) => c.IsActive).length,
      NamelessCustomerCount: customers.filter((c) => c.Name === null || c.Name === undefined).length,
      TotalOpeningBalanceMinor: 0, TotalDebitMinor: 0, TotalCreditMinor: 0,
      TotalBalanceMinor: 0, CashReceivedMinor: 0, CashPaidMinor: 0,
      NonCashSettlementMinor: 0, ByType: {}, PositiveBalanceCount: 0, NegativeBalanceCount: 0
    };
    for (const customer of customers) {
      const s = summarize(byCustomer.get(customer.Id) || [], customer.OpeningBalanceMinor || 0);
      totals.TotalOpeningBalanceMinor += s.OpeningBalanceMinor;
      totals.TotalDebitMinor += s.TotalDebitMinor;
      totals.TotalCreditMinor += s.TotalCreditMinor;
      totals.TotalBalanceMinor += s.BalanceMinor;
      totals.CashReceivedMinor += s.CashReceivedMinor;
      totals.CashPaidMinor += s.CashPaidMinor;
      totals.NonCashSettlementMinor += s.NonCashSettlementMinor;
      if (s.BalanceSide === BALANCE_SIDES.POSITIVE) totals.PositiveBalanceCount += 1;
      if (s.BalanceSide === BALANCE_SIDES.NEGATIVE) totals.NegativeBalanceCount += 1;
    }
    // By-type aggregates on the portfolio level count a debt transfer ONCE per operation.
    for (const row of transactions) {
      const f = deriveFinancials(row);
      if (!f.isActive) continue;
      if (row.TransactionType === TRANSACTION_TYPE.DEBT_TRANSFER && row.TransferRole === DEBT_TRANSFER_ROLE.DEBIT_SIDE) continue;
      const acc = totals.ByType[row.TransactionType] || { DebitMinor: 0, CreditMinor: 0, AmountMinor: 0 };
      acc.DebitMinor += f.DebitMinor;
      acc.CreditMinor += f.CreditMinor;
      acc.AmountMinor += row.AmountMinor;
      totals.ByType[row.TransactionType] = acc;
    }
    return totals;
  }
};

export { CASH_TYPES, NON_CASH_TYPES, STATUS };
// Additive (Phase 4B.2): the approved type catalogue and its Arabic labels are
// re-exported here so the UI reads them through the services layer only.
export { TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS_AR, TRANSACTION_TYPE } from '../domain/transactionTypes.js';
