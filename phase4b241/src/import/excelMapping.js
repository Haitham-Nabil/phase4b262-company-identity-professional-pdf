// Excel mapping constants (Phase 2 v1.2 FINAL §18). No parsing here — Phase 4.
export const WORKBOOK = Object.freeze({
  MAIN_SHEET: 'الصفحة الرئيسيه',
  CUSTOMER_SHEET_PREFIX: null, // customer sheets are named by their own number/text
  REFERENCES_SHEET: 'مراجع',
  STATEMENT_SHEET: 'كشف حساب'
});

export const MAIN_SHEET_MAP = Object.freeze({
  CODE: 'A',
  NAME: 'B',
  HYPERLINK: 'B' // the hyperlink lives on the name cell and points to the customer's sheet
});

export const CUSTOMER_SHEET_MAP = Object.freeze({
  SERIAL: 'A',       // serial only — never a transaction identity
  DATE: 'B',
  CROP_LOCAL: 'C-I',
  CROP_CARTON: 'J-N',
  SALE_PESTICIDES: 'P',
  SALE_IRRIGATION: 'Q',
  SALES_RETURN: 'S',
  CASH_RECEIVED: 'U',
  CASH_PAID: 'V',
  SETTLEMENT: 'W',
  DESCRIPTION: 'AB'
});

export const CROP_LOCAL_COLUMNS = Object.freeze({ UNITS: 'D', LOOSE_KG: 'E', DEDUCTION_KG: 'F', NET_WEIGHT: 'G', UNIT_PRICE: 'H', TOTAL: 'I' });
export const CROP_CARTON_COLUMNS = Object.freeze({ QUANTITY: 'K', UNIT_PRICE: 'L', DISCOUNT: 'M', TOTAL: 'N' });
export const EXCEL_DATA_START_ROW = 15;
export const EXCEL_DATA_LAST_ROW = 314;
export const FORBIDDEN_REFERENCES = Object.freeze(['K6', 'MasterFormulas', 'SummaryFormulas']);

// The hyperlink is the OFFICIAL customer <-> sheet link (spec §41).
export function normalizeHyperlinkSheetName(location) {
  if (typeof location !== 'string') return null;
  const match = /^'?([^'!]+)'?![A-Z]+\d+$/.exec(location.trim());
  return match ? match[1] : null;
}

export function isSheetNameMatchingCode(code, sheetName) {
  if (sheetName === null || sheetName === undefined) return false;
  const left = String(code).trim();
  const right = String(sheetName).trim();
  if (left === right) return true;
  const asNumber = Number(left);
  if (Number.isFinite(asNumber) && Number.isFinite(Number(right)) && asNumber === Number(right)) return true;
  return false;
}
