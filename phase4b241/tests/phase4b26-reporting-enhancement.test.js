import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCropRows, groupCropRows, CROP_REPORT_GROUPING } from '../src/services/cropReportService.js';
import { toReportRow, groupReportRows, totalsOf, CARTON_REPORT_KIND } from '../src/services/cartonReportService.js';
import { cartonReferenceParts, localReferenceParts } from '../src/services/movementNotes.js';
import { cropReportKpisHtml, CROP_REPORT_DETAIL_COLUMNS, CROP_REPORT_SUMMARY_COLUMNS } from '../ui/views/reportCropLocal.js';
import { reportSummaryHtml, REPORT_DETAIL_COLUMNS, REPORT_COLUMNS } from '../ui/views/reports.js';
import { ledgerDetailsHtml } from '../ui/views/transactions.js';
import { ledgerReferenceNote } from '../ui/views/customerAccount.js';
import { buildCsv } from '../ui/views/reportExport.js';

const referenceMaps = {
  customers: new Map([['farmer-1', { Id: 'farmer-1', Name: 'مزارع الاختبار', Code: 'F-1', IsActive: true }]]),
  companies: new Map([['company-1', { Id: 'company-1', Name: 'شركة الاختبار', IsActive: true }]]),
  cartonTypes: new Map([['type-1', { Id: 'type-1', Name: 'فلات', IsActive: true }]])
};

function cartonSource({ id, quantity = 10000, discount = 0, price = 500, amount = 5000 } = {}) {
  return {
    Id: id, Date: '2026-11-01', Status: 'Active', CustomerId: 'farmer-1',
    ReceivingCompanyId: 'company-1', CartonTypeId: 'type-1',
    CartonQuantityMilli: quantity, CartonDiscountMinor: discount,
    CartonUnitPriceMinor: price, AmountMinor: amount
  };
}

test('4B.26 local crop average price is weighted by resolved net weight only', () => {
  const rows = [
    { CustomerId: 'farmer-1', PackageCountMilli: 10000, WeightResolved: true, NetWeightMilli: 140000, AmountMinor: 140000 },
    { CustomerId: 'farmer-1', PackageCountMilli: 10000, WeightResolved: true, NetWeightMilli: 140000, AmountMinor: 280000 },
    { CustomerId: 'farmer-1', PackageCountMilli: 10000, WeightResolved: false, NetWeightMilli: null, AmountMinor: 90000 }
  ];
  const totals = summarizeCropRows(rows);
  const group = groupCropRows(rows, CROP_REPORT_GROUPING.BY_FARMER)[0];
  assert.equal(totals.AverageUnitPriceMinor, 1500);
  assert.equal(group.AverageUnitPriceMinor, 1500);
  assert.equal(totals.UnresolvedWeightCount, 1);
});

test('4B.26 carton report read model carries stored unit price, value and net quantity', () => {
  const row = toReportRow(cartonSource({ id: 'discounted', quantity: 20000, discount: 200, price: 1500, amount: 27000 }), referenceMaps);
  assert.equal(row.CartonUnitPriceMinor, 1500);
  assert.equal(row.AmountMinor, 27000);
  assert.equal(row.DiscountQuantityMilli, 2000);
  assert.equal(row.NetQuantityMilli, 18000);
});

test('4B.26 carton average price is weighted by net cartons, not movement count', () => {
  const rows = [
    toReportRow(cartonSource({ id: 'a', quantity: 10000, price: 500, amount: 5000 }), referenceMaps),
    toReportRow(cartonSource({ id: 'b', quantity: 10000, price: 1000, amount: 10000 }), referenceMaps)
  ];
  const groups = groupReportRows(rows, CARTON_REPORT_KIND.BY_FARMER);
  const totals = totalsOf(groups, rows);
  assert.equal(totals.AmountMinor, 15000);
  assert.equal(totals.AverageUnitPriceMinor, 750);
  assert.equal(groups[0].AverageUnitPriceMinor, 750);
});

test('4B.26 movement descriptions include the correct unit price', () => {
  const local = localReferenceParts({ LocalUnitPriceMinor: 1234 });
  const carton = cartonReferenceParts({ CartonUnitPriceMinor: 875 });
  assert.equal(local.at(-1), 'سعر الكيلو: 12.34 ج');
  assert.equal(carton.at(-1), 'سعر الكرتونة: 8.75 ج');
});

test('4B.26 crop report summary and detail schemas expose average and per-movement price', () => {
  assert.ok(CROP_REPORT_DETAIL_COLUMNS.some((column) => column.label === 'سعر الكيلو'));
  assert.ok(CROP_REPORT_SUMMARY_COLUMNS.byFarmer.some((column) => column.label === 'متوسط سعر الكيلو'));
  const html = cropReportKpisHtml({ Totals: {
    MovementCount: 2, FarmerCount: 1, PackageCountMilli: 20000, NetWeightMilli: 280000,
    UnresolvedWeightCount: 0, AmountMinor: 420000, AverageUnitPriceMinor: 1500
  } });
  assert.match(html, /متوسط سعر الكيلو المرجح/);
  assert.match(html, /15\.00 ج/);
  assert.match(html, /dash-kpi/);
});

test('4B.26 carton report summary and all four grouping schemas expose price and value', () => {
  for (const columns of Object.values(REPORT_COLUMNS)) {
    assert.ok(columns.some((column) => column.label === 'متوسط سعر الكرتونة'));
    assert.ok(columns.some((column) => column.label === 'القيمة الإجمالية'));
  }
  assert.ok(REPORT_DETAIL_COLUMNS.some((column) => column.label === 'سعر الكرتونة'));
  const html = reportSummaryHtml({ Totals: {
    QuantityMilli: 10000, NetQuantityMilli: 9000, DiscountQuantityMilli: 1000,
    AmountMinor: 90000, AverageUnitPriceMinor: 10000, MovementCount: 1, GroupCount: 1,
    MissingQuantityCount: 0, CancelledCount: 0
  } });
  assert.match(html, /متوسط سعر الكرتونة المرجح/);
  assert.match(html, /100\.00 ج/);
  assert.match(html, /dash-kpi/);
});

test('4B.26 central ledger movement details display the correct crop unit price', () => {
  const html = ledgerDetailsHtml({
    Id: 'local-1', Date: '2026-11-01', TypeLabel: 'مشتريات محصول محلي',
    TransactionType: 'CropPurchaseLocal', CustomerName: 'مزارع الاختبار', CustomerCode: 'F-1',
    AmountMinor: 140000, Direction: 'Credit', DirectionLabel: 'دائن', IsCancelled: false,
    LocalUnitPriceMinor: 1250, PackageCountMilli: 10000, CropWeightResolved: true,
    CropNetWeightMilli: 140000, PackageWeightKg: 14, StrawberryVarietyName: 'فيستيفال'
  });
  assert.match(html, /سعر الكيلو/);
  assert.match(html, /12\.50 ج/);
  const statement = ledgerReferenceNote({ TransactionType: 'CropPurchaseLocal', LocalUnitPriceMinor: 1250, StrawberryVarietyName: 'فيستيفال', StrawberryVarietyId: 'v1', PackageCountMilli: 10000, CropWeightResolved: true, CropNetWeightMilli: 140000 });
  assert.match(statement, /سعر الكيلو: 12\.50 ج/);
  const cartonHtml = ledgerDetailsHtml({ Id: 'carton-1', Date: '2026-11-01', TypeLabel: 'مشتريات كرتون', TransactionType: 'CropPurchaseCarton', CustomerName: 'مزارع الاختبار', CustomerCode: 'F-1', AmountMinor: 12000, Direction: 'Credit', DirectionLabel: 'دائن', IsCancelled: false, CartonUnitPriceMinor: 1200, CartonQuantityMilli: 10000, ReceivingCompanyName: 'شركة الاختبار', CartonTypeName: 'فلات' });
  assert.match(cartonHtml, /سعر الكرتونة/);
  assert.match(cartonHtml, /12\.00 ج/);
});

test('4B.26 CSV exports unit price and report totals as independent numeric columns', () => {
  const csv = buildCsv([{ title: 'مشتريات كرتون', headers: ['سعر الكرتونة', 'القيمة الإجمالية'], rows: [['12.50 ج', '250.00 ج']] }]);
  assert.match(csv, /سعر الكرتونة;القيمة الإجمالية/);
  assert.match(csv, /12\.5;250/);
});
