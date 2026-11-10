import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHyperlinkSheetName, isSheetNameMatchingCode, MAIN_SHEET_MAP, CUSTOMER_SHEET_MAP, EXCEL_DATA_START_ROW } from '../src/import/excelMapping.js';
import { buildCustomerDraftFromMainRow, verifyCustomerSheetLink, mapRowToTransactionDrafts } from '../src/import/importModels.js';

// The hyperlink is the official customer <-> sheet link (verified against the real workbook).
test('Hyperlink locations resolve to the linked customer sheet name', () => {
  assert.equal(normalizeHyperlinkSheetName("'1'!A1"), '1');
  assert.equal(normalizeHyperlinkSheetName("'26'!A1"), '26');
  assert.equal(normalizeHyperlinkSheetName('Sheet1!A1'), 'Sheet1');
  assert.equal(normalizeHyperlinkSheetName(null), null);
});

test('Sheet name is verified against the code without inventing the relationship', () => {
  assert.equal(isSheetNameMatchingCode('1', '1'), true);
  assert.equal(isSheetNameMatchingCode(13, '13'), true);
  assert.equal(isSheetNameMatchingCode('1', '2'), false);
  const check = verifyCustomerSheetLink('26', '26');
  assert.equal(check.matches, true);
});

test('Main sheet row maps to code, name and the hyperlinked sheet with opening balance zero', () => {
  const draft = buildCustomerDraftFromMainRow({ code: 13, name: 'مزرعة الشركه(علي أبوعجيله)', hyperlinkLocation: "'13'!A1" });
  assert.equal(draft.Code, '13');
  assert.equal(draft.Name, 'مزرعة الشركه(علي أبوعجيله)');
  assert.equal(draft.SheetName, '13');
  assert.equal(draft.OpeningBalance, 0);
});

test('A name of 0 becomes a null (nameless) customer name', () => {
  const draft = buildCustomerDraftFromMainRow({ code: 26, name: 0, hyperlinkLocation: "'26'!A1" });
  assert.equal(draft.Name, null);
  assert.equal(draft.SheetName, '26');
});

test('Columns A is a serial and is never used as a transaction identity', () => {
  assert.equal(CUSTOMER_SHEET_MAP.SERIAL, 'A');
  assert.equal(MAIN_SHEET_MAP.CODE, 'A');
  assert.equal(EXCEL_DATA_START_ROW, 15);
});

test('Row mapping produces one draft per independent movement', () => {
  const row = { B: new Date(2026, 8, 1), P: 1000, Q: 2000, S: 300, U: 500, V: 400, W: 250, AB: 'يوم واحد' };
  const { drafts, notes } = mapRowToTransactionDrafts(row);
  assert.equal(drafts.length, 6);
  assert.deepEqual(drafts.map((d) => d.TransactionType), ['SalePesticides', 'SaleIrrigation', 'SalesReturn', 'CashReceived', 'CashPaid', 'Settlement']);
  assert.equal(drafts[0].Amount, 1000);
  assert.equal(notes.length, 0);
});

test('Blank amounts produce no drafts and a description-only row is flagged, never invented', () => {
  const blank = mapRowToTransactionDrafts({ B: new Date(2026, 8, 1) });
  assert.equal(blank.drafts.length, 0);
  assert.equal(blank.notes.length, 0);

  const descriptionOnly = mapRowToTransactionDrafts({ B: new Date(2026, 8, 7), AB: 'تسوية حساب المبيدات' });
  assert.equal(descriptionOnly.drafts.length, 0);
  assert.equal(descriptionOnly.notes[0].kind, 'DescriptionOnly');
});

test('A row without a valid date is flagged rather than given a fabricated date', () => {
  const { notes } = mapRowToTransactionDrafts({ P: 500 });
  assert.ok(notes.some((n) => n.kind === 'MissingDate'));
});

test('A negative amount is flagged, never silently converted', () => {
  const { drafts, notes } = mapRowToTransactionDrafts({ B: new Date(2026, 8, 1), P: -500 });
  assert.equal(drafts.length, 0);
  assert.equal(notes.some((n) => n.kind === 'NegativeAmount'), true);
});
