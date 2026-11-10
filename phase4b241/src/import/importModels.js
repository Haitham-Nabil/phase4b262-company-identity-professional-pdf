import { MAIN_SHEET_MAP, CUSTOMER_SHEET_MAP, isSheetNameMatchingCode } from './excelMapping.js';
import { TRANSACTION_TYPE } from '../domain/transactionTypes.js';
import { MONEY_FACTOR, QTY_FACTOR, isFiniteNumber, toMinor } from '../domain/money.js';
import { toIsoDate } from '../domain/dateUtils.js';

// Pure mapping helpers prepared for the Excel import phase.
// They produce drafts only — no persistence, no UI.

export function buildCustomerDraftFromMainRow({ code, name, sheetName = null, hyperlinkLocation = null }) {
  const linkSheet = sheetName || (hyperlinkLocation ? String(hyperlinkLocation).replace(/^'/, '').split('!')[0].replace(/'$/, '') : null);
  return {
    Code: code === null || code === undefined ? null : String(code).trim(),
    Name: name === null || name === undefined || String(name).trim() === '0' ? null : String(name).trim(),
    SheetName: linkSheet,
    OpeningBalance: 0, // Excel history always starts at zero (spec §44)
    IsActive: true
  };
}

export function verifyCustomerSheetLink(code, sheetName) {
  return { code: String(code), sheetName, matches: isSheetNameMatchingCode(code, sheetName) };
}

// Maps one spreadsheet row to zero or more transaction drafts.
// Blank amounts produce NO draft. Rows with only a description are reported as
// "needs decision" — they are never silently turned into a transaction.
export function mapRowToTransactionDrafts(row, { defaultDescription = null } = {}) {
  const drafts = [];
  const notes = [];
  const date = toIsoDate(row[CUSTOMER_SHEET_MAP.DATE]);
  if (!date) notes.push({ kind: 'MissingDate', row });
  const description = row[CUSTOMER_SHEET_MAP.DESCRIPTION] ?? defaultDescription;

  const push = (TransactionType, amount, extra = {}) => {
    if (!isFiniteNumber(amount) || amount === 0) return;
    if (amount < 0) { notes.push({ kind: 'NegativeAmount', field: TransactionType, amount }); return; }
    drafts.push({ TransactionType, Date: date, Amount: amount, Description: description, ...extra });
  };

  push(TRANSACTION_TYPE.SALE_PESTICIDES, row[CUSTOMER_SHEET_MAP.SALE_PESTICIDES]);
  push(TRANSACTION_TYPE.SALE_IRRIGATION, row[CUSTOMER_SHEET_MAP.SALE_IRRIGATION]);
  push(TRANSACTION_TYPE.SALES_RETURN, row[CUSTOMER_SHEET_MAP.SALES_RETURN]);
  push(TRANSACTION_TYPE.CASH_RECEIVED, row[CUSTOMER_SHEET_MAP.CASH_RECEIVED]);
  push(TRANSACTION_TYPE.CASH_PAID, row[CUSTOMER_SHEET_MAP.CASH_PAID]);
  push(TRANSACTION_TYPE.SETTLEMENT, row[CUSTOMER_SHEET_MAP.SETTLEMENT]);

  if (drafts.length === 0 && description) notes.push({ kind: 'DescriptionOnly', row, description });
  return { drafts, notes };
}

export function toMilli(quantity) { return toMinor(quantity, QTY_FACTOR, 'الكمية'); }
export function toMinorMoney(amount) { return toMinor(amount, MONEY_FACTOR, 'المبلغ'); }
