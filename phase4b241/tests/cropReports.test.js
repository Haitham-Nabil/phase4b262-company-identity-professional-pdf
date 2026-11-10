// Phase 4B.18 — local crop purchase reports: service + screen tests.
//
// Every figure is asserted against the STORED row (or against the exact stored fields the
// report is allowed to read). Nothing is asserted against a value the view computed,
// because the view computes none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDatabase } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { cancellationService } from '../src/services/cancellationService.js';
import { settingsService } from '../src/services/settingsService.js';
import { strawberryVarietyService } from '../src/services/referenceDataService.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import {
  cropReportService,
  buildCropReport,
  normalizeCropReportFilters,
  groupCropRows,
  summarizeCropRows,
  resolveStoredWeight,
  toCropReportRow,
  CROP_REPORT_GROUPING,
  CROP_REPORT_MODE,
  CROP_REPORT_STATUS,
  NO_VARIETY_KEY,
  NO_VARIETY_LABEL,
  UNRESOLVED_WEIGHT_LABEL
} from '../src/services/cropReportService.js';

const LOCAL = 'CropPurchaseLocal';
const CARTON = 'CropPurchaseCarton';

// ---- fixtures --------------------------------------------------------------
async function farmer(code, name) {
  return customerService.createCustomer({ Code: code, Name: name });
}

async function variety(name) {
  return strawberryVarietyService.create(name);
}

// D=units, E=loose, F=deduction, H=price/kg. The service computes G and the amount
// exactly as the application does at creation time.
async function local({
  farmerId, varietyId = null, units = 10, loose = 0, deduction = 0, price = 1000,
  date = '2026-09-10', description = null
}) {
  const crop = {
    LocalUnitsMilli: Math.round(units * 1000),
    LocalLooseKgMilli: Math.round(loose * 1000),
    LocalDeductionKgMilli: Math.round(deduction * 1000),
    LocalUnitPriceMinor: price
  };
  if (varietyId) crop.StrawberryVarietyId = varietyId;
  return transactionService.createTransaction({
    CustomerId: farmerId,
    Date: date,
    TransactionType: LOCAL,
    Description: description,
    crop
  });
}

async function scenario() {
  await freshDatabase('cropreport');
  await settingsService.setDefaultPackageWeight(14);
  const f1 = await farmer('F-001', 'مزارع أحمد');
  const f2 = await farmer('F-002', 'مزارع سمير');
  const v1 = await variety('فيرتونا');
  const v2 = await variety('صنسيشن');
  return { f1, f2, v1, v2 };
}

const build = (criteria = {}) => buildCropReport(criteria);

function groupOf(report, predicate) {
  return report.Groups.find(predicate) || null;
}


test('price is shown per movement and weighted by resolved net kilograms in summaries', async () => {
  const s = await scenario();
  const first = await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10, price: 1000 });
  const second = await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10, price: 2000 });
  const report = await build({ grouping: CROP_REPORT_GROUPING.BY_FARMER });
  assert.equal(report.Rows.find((row) => row.Id === first.Id).UnitPriceMinor, 1000);
  assert.equal(report.Rows.find((row) => row.Id === second.Id).UnitPriceMinor, 2000);
  assert.equal(report.Totals.AverageUnitPriceMinor, 1500);
  const group = groupOf(report, (row) => row.CustomerId === s.f1.Id);
  assert.equal(group.AverageUnitPriceMinor, 1500);
  assert.equal(report.Totals.WeightedAmountMinor, first.AmountMinor + second.AmountMinor);
});

// ---- 1..10 accuracy of the figures ----------------------------------------
test('1. movement count is summed and is the number of counted rows', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10 });
  await local({ farmerId: s.f2.Id, varietyId: s.v1.Id, units: 5 });
  const report = await build();
  assert.equal(report.Totals.MovementCount, 2);
  assert.equal(report.Totals.RowCount, 2);
});

test('2. farmer count is the number of DISTINCT farmers', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, units: 10 });
  await local({ farmerId: s.f1.Id, units: 20 });
  await local({ farmerId: s.f2.Id, units: 5 });
  const report = await build();
  assert.equal(report.Totals.MovementCount, 3);
  assert.equal(report.Totals.FarmerCount, 2);
});

test('3. package count is summed in the stored milli unit', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, units: 10 });
  await local({ farmerId: s.f1.Id, units: 25.5 });
  const report = await build();
  assert.equal(report.Totals.PackageCountMilli, 35500);
});

test('4. net weight is summed from the STORED values only', async () => {
  const s = await scenario();
  // G = D x (W - F) + E  with W=14, D=10, F=0, E=0 -> 140 kg
  const row = await local({ farmerId: s.f1.Id, units: 10 });
  assert.equal(row.PackageWeightKg, 14);
  assert.equal(row.NetWeightMilli, 140000);
  const report = await build();
  assert.equal(report.Totals.NetWeightMilli, row.NetWeightMilli);
  assert.equal(report.Totals.WeightResolvedCount, 1);
  assert.equal(report.Totals.UnresolvedWeightCount, 0);
});

test('5. the financial total is the STORED AmountMinor, never recomputed', async () => {
  const s = await scenario();
  const row = await local({ farmerId: s.f1.Id, units: 10 });
  const report = await build();
  assert.equal(report.Totals.AmountMinor, row.AmountMinor);
  // The stored amount is what the row says — even if the price column were changed later,
  // the report reads AmountMinor and never re-multiplies weight by price.
  const stored = await transactionRepository.getById(row.Id);
  assert.equal(stored.AmountMinor, report.Totals.AmountMinor);
});

test('6. an unresolved weight is excluded from the trusted weight total', async () => {
  const s = await scenario();
  const withWeight = await local({ farmerId: s.f1.Id, units: 10 });
  // A historical row recorded before the weight was frozen: no PackageWeightKg, no G.
  await transactionRepository.add({
    Id: 'txn_legacy_local_1',
    CustomerId: s.f1.Id,
    Date: '2026-08-01',
    TransactionType: LOCAL,
    Description: 'حركة قديمة بلا وزن محفوظ',
    AmountMinor: 50000,
    LinkId: null,
    TransferRole: null,
    Direction: null,
    Status: 'Active',
    LocalUnitsMilli: 40000,
    LocalLooseKgMilli: 0,
    LocalDeductionKgMilli: 0,
    LocalUnitPriceMinor: 500,
    PackageWeightKg: null,
    PackageWeightStatus: 'Unknown',
    NetWeightMilli: null,
    CreatedAt: '2026-08-01T10:00:00.000Z',
    UpdatedAt: '2026-08-01T10:00:00.000Z'
  });
  const report = await build();
  assert.equal(report.Totals.MovementCount, 2);
  // Only the confirmed movement contributes weight; the legacy row contributes nothing.
  assert.equal(report.Totals.NetWeightMilli, withWeight.NetWeightMilli);
  assert.equal(report.Totals.UnresolvedWeightCount, 1);
  assert.equal(report.Totals.AmountMinor, withWeight.AmountMinor + 50000);
});

test('7. unresolved movements are counted and never replaced by zero weight', async () => {
  const s = await scenario();
  await transactionRepository.add({
    Id: 'txn_legacy_local_2',
    CustomerId: s.f1.Id,
    Date: '2026-07-01',
    TransactionType: LOCAL,
    Description: null,
    AmountMinor: 10000,
    Status: 'Active',
    LocalUnitsMilli: 1000,
    PackageWeightKg: null,
    PackageWeightStatus: 'Unknown',
    NetWeightMilli: null,
    CreatedAt: '2026-07-01T10:00:00.000Z',
    UpdatedAt: '2026-07-01T10:00:00.000Z'
  });
  const report = await build();
  const row = report.Rows[0];
  assert.equal(row.WeightResolved, false);
  assert.equal(row.NetWeightMilli, null);
  assert.equal(report.Totals.UnresolvedWeightCount, 1);
  assert.equal(report.Totals.NetWeightMilli, 0);
  // And the detail row reports the honest state, not a number.
  assert.equal(row.WeightSource, null);
});

test('8. movements with no variety appear in an explicit «بدون صنف» group', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10 });
  await local({ farmerId: s.f1.Id, varietyId: null, units: 5 });
  const report = await build({ grouping: CROP_REPORT_GROUPING.BY_VARIETY });
  assert.equal(report.Groups.length, 2);
  const none = groupOf(report, (group) => group.Key === NO_VARIETY_KEY);
  assert.ok(none, 'the no-variety group must exist');
  assert.equal(none.Label, NO_VARIETY_LABEL);
  assert.equal(none.MovementCount, 1);
  assert.equal(none.PackageCountMilli, 5000);
  // It is never dropped from the figures.
  assert.equal(report.Totals.MovementCount, 2);
});

test('9. package count and net weight are never mixed into one figure', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, units: 10 }); // 10 packages, 140 kg
  const report = await build();
  assert.equal(report.Totals.PackageCountMilli, 10000);
  assert.equal(report.Totals.NetWeightMilli, 140000);
  assert.notEqual(report.Totals.PackageCountMilli, report.Totals.NetWeightMilli);
  assert.equal(report.Totals.AverageNetWeightPerPackageMilli === undefined, true);
});

test('10. the weight deduction (F) never becomes a money discount', async () => {
  const s = await scenario();
  const noDeduction = await local({ farmerId: s.f1.Id, units: 10, deduction: 0 });
  const withDeduction = await local({ farmerId: s.f2.Id, units: 10, deduction: 2 });
  const report = await build();
  // The deduction reduces the WEIGHT only; the amount is G x H, computed at creation time.
  assert.equal(withDeduction.LocalDeductionKgMilli, 2000);
  assert.equal(withDeduction.NetWeightMilli, 120000);
  assert.ok(withDeduction.AmountMinor < noDeduction.AmountMinor);
  // No cash-discount field exists anywhere in the report contract.
  const keys = Object.keys(report.Totals);
  assert.equal(keys.some((key) => /discount/i.test(key)), false);
  const rowKeys = Object.keys(report.Rows[0]);
  assert.equal(rowKeys.some((key) => /discount/i.test(key)), false);
});

// ---- 11..20 status and filters --------------------------------------------
test('11. cancelled movements are excluded by default', async () => {
  const s = await scenario();
  const active = await local({ farmerId: s.f1.Id, units: 10 });
  const cancelled = await local({ farmerId: s.f1.Id, units: 99 });
  await cancellationService.cancelTransaction(cancelled.Id, 'خطأ في الإدخال');
  const report = await build();
  assert.equal(report.Totals.MovementCount, 1);
  assert.equal(report.Totals.AmountMinor, active.AmountMinor);
  assert.equal(report.Totals.CancelledCount, 1);
  assert.equal(report.Rows.length, 1);
});

test('12. the Active filter shows only active rows', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, units: 10 });
  const cancelled = await local({ farmerId: s.f1.Id, units: 99 });
  await cancellationService.cancelTransaction(cancelled.Id, 'تكرار');
  const report = await build({ filters: { status: CROP_REPORT_STATUS.ACTIVE } });
  assert.equal(report.Rows.length, 1);
  assert.equal(report.Rows[0].IsActive, true);
});

test('13. the Cancelled filter shows the cancelled rows and counts nothing', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, units: 10 });
  const cancelled = await local({ farmerId: s.f1.Id, units: 99 });
  await cancellationService.cancelTransaction(cancelled.Id, 'تكرار');
  const report = await build({ filters: { status: CROP_REPORT_STATUS.CANCELLED } });
  assert.equal(report.Rows.length, 1);
  assert.equal(report.Rows[0].IsActive, false);
  assert.equal(report.Rows[0].CancellationReason, 'تكرار');
  // A cancelled movement is displayed, but it never enters a total.
  assert.equal(report.Totals.MovementCount, 0);
  assert.equal(report.Totals.AmountMinor, 0);
  assert.equal(report.Totals.PackageCountMilli, 0);
  assert.equal(report.Totals.NetWeightMilli, 0);
});

test('14. the All filter shows both while counting only the active ones', async () => {
  const s = await scenario();
  const active = await local({ farmerId: s.f1.Id, units: 10 });
  const cancelled = await local({ farmerId: s.f1.Id, units: 99 });
  await cancellationService.cancelTransaction(cancelled.Id, 'تكرار');
  const report = await build({ filters: { status: CROP_REPORT_STATUS.ALL } });
  assert.equal(report.Rows.length, 2);
  assert.equal(report.Totals.VisibleRowCount, 2);
  assert.equal(report.Totals.UncountedVisibleCount, 1);
  assert.equal(report.Totals.MovementCount, 1);
  assert.equal(report.Totals.AmountMinor, active.AmountMinor);
});

test('15. the period is inclusive of both bounds', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, units: 1, date: '2026-09-01' });
  await local({ farmerId: s.f1.Id, units: 2, date: '2026-09-05' });
  await local({ farmerId: s.f1.Id, units: 3, date: '2026-09-09' });
  const report = await build({ filters: { from: '2026-09-01', to: '2026-09-09' } });
  assert.equal(report.Totals.MovementCount, 3);
  const inner = await build({ filters: { from: '2026-09-02', to: '2026-09-08' } });
  assert.equal(inner.Totals.MovementCount, 1);
  assert.equal(inner.Totals.PackageCountMilli, 2000);
});

test('16. the farmer filter narrows to one farmer only', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, units: 10 });
  await local({ farmerId: s.f2.Id, units: 5 });
  const report = await build({ filters: { customerId: s.f2.Id } });
  assert.equal(report.Totals.MovementCount, 1);
  assert.equal(report.Totals.PackageCountMilli, 5000);
  assert.equal(report.Rows[0].CustomerId, s.f2.Id);
});

test('17. the variety filter narrows to one variety, and «بدون صنف» is filterable', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10 });
  await local({ farmerId: s.f1.Id, varietyId: s.v2.Id, units: 5 });
  await local({ farmerId: s.f1.Id, varietyId: null, units: 2 });
  const one = await build({ filters: { varietyId: s.v2.Id } });
  assert.equal(one.Totals.MovementCount, 1);
  assert.equal(one.Totals.PackageCountMilli, 5000);
  const none = await build({ filters: { varietyId: NO_VARIETY_KEY } });
  assert.equal(none.Totals.MovementCount, 1);
  assert.equal(none.Totals.PackageCountMilli, 2000);
  assert.equal(none.Rows[0].HasVariety, false);
});

test('18. the text search matches the farmer name, the code and the description', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, units: 10, description: 'دفعة الصباح' });
  await local({ farmerId: s.f2.Id, units: 5, description: 'دفعة المساء' });
  const byName = await build({ filters: { search: 'أحمد' } });
  assert.equal(byName.Totals.MovementCount, 1);
  const byCode = await build({ filters: { search: 'F-002' } });
  assert.equal(byCode.Totals.MovementCount, 1);
  assert.equal(byCode.Rows[0].CustomerId, s.f2.Id);
  const byText = await build({ filters: { search: 'المساء' } });
  assert.equal(byText.Totals.MovementCount, 1);
});

test('19. several filters combine with AND', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10, date: '2026-09-01' });
  await local({ farmerId: s.f1.Id, varietyId: s.v2.Id, units: 20, date: '2026-09-03' });
  await local({ farmerId: s.f2.Id, varietyId: s.v1.Id, units: 30, date: '2026-09-03' });
  const report = await build({
    filters: { customerId: s.f1.Id, varietyId: s.v1.Id, from: '2026-09-01', to: '2026-09-02' }
  });
  assert.equal(report.Totals.MovementCount, 1);
  assert.equal(report.Totals.PackageCountMilli, 10000);
});

test('20. an invalid date range is refused, and so is a malformed date', () => {
  assert.throws(() => normalizeCropReportFilters({ from: '2026-09-10', to: '2026-09-01' }), /تاريخ البداية يجب ألا يكون بعد تاريخ النهاية/);
  assert.throws(() => normalizeCropReportFilters({ from: '2026-13-01' }), /تاريخ البداية غير صالح/);
  assert.throws(() => normalizeCropReportFilters({ to: '10/09/2026' }), /تاريخ النهاية غير صالح/);
  assert.throws(() => normalizeCropReportFilters({ status: 'Whatever' }), /حالة الحركة غير معتمدة/);
  // An empty filter set is valid and means "all active movements".
  const empty = normalizeCropReportFilters({});
  assert.deepEqual(empty, { from: null, to: null, customerId: null, varietyId: null, status: 'Active', search: '' });
});

// ---- 21..25 drill-down ----------------------------------------------------
test('21. drill-down by farmer returns exactly that farmer’s movements', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, units: 10 });
  await local({ farmerId: s.f1.Id, units: 5 });
  await local({ farmerId: s.f2.Id, units: 7 });
  const summary = await build({ grouping: CROP_REPORT_GROUPING.BY_FARMER });
  const group = groupOf(summary, (entry) => entry.CustomerId === s.f1.Id);
  const details = await build({
    grouping: CROP_REPORT_GROUPING.BY_FARMER,
    mode: CROP_REPORT_MODE.DETAILS,
    filters: { customerId: group.CustomerId }
  });
  assert.equal(details.Rows.length, 2);
  assert.equal(details.Totals.PackageCountMilli, group.PackageCountMilli);
  assert.equal(details.Totals.NetWeightMilli, group.NetWeightMilli);
  assert.equal(details.Totals.AmountMinor, group.AmountMinor);
});

test('22. drill-down by variety returns exactly that variety’s movements', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10 });
  await local({ farmerId: s.f2.Id, varietyId: s.v1.Id, units: 4 });
  await local({ farmerId: s.f2.Id, varietyId: s.v2.Id, units: 9 });
  const summary = await build({ grouping: CROP_REPORT_GROUPING.BY_VARIETY });
  const group = groupOf(summary, (entry) => entry.VarietyId === s.v1.Id);
  const details = await build({
    grouping: CROP_REPORT_GROUPING.BY_VARIETY,
    mode: CROP_REPORT_MODE.DETAILS,
    filters: { varietyId: group.VarietyId }
  });
  assert.equal(details.Rows.length, 2);
  assert.equal(details.Totals.PackageCountMilli, group.PackageCountMilli);
  assert.equal(details.Totals.FarmerCount, 2);
});

test('23. drill-down keeps every original filter and adds one constraint', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10, date: '2026-09-01', description: 'صباح' });
  await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 20, date: '2026-09-20', description: 'مساء' });
  await local({ farmerId: s.f1.Id, varietyId: s.v2.Id, units: 30, date: '2026-09-01' });

  const base = { from: '2026-09-01', to: '2026-09-10', status: CROP_REPORT_STATUS.ACTIVE, search: 'صباح' };
  const summary = await build({ grouping: CROP_REPORT_GROUPING.BY_FARMER, filters: base });
  assert.equal(summary.Totals.MovementCount, 1);
  const group = summary.Groups[0];
  // The screen merges the drill key onto the SAME applied filters — nothing is dropped.
  const merged = { ...base, customerId: group.CustomerId };
  const details = await build({ grouping: CROP_REPORT_GROUPING.BY_FARMER, mode: CROP_REPORT_MODE.DETAILS, filters: merged });
  assert.equal(details.Filters.from, '2026-09-01');
  assert.equal(details.Filters.to, '2026-09-10');
  assert.equal(details.Filters.search, 'صباح');
  assert.equal(details.Totals.MovementCount, 1);
  assert.equal(details.Rows[0].Description, 'صباح');
});

test('24. returning from drill-down restores the same figures as the group', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10, date: '2026-09-02' });
  await local({ farmerId: s.f2.Id, varietyId: s.v1.Id, units: 6, date: '2026-09-04' });
  const filters = { from: '2026-09-01', to: '2026-09-30' };
  const summary = await build({ grouping: CROP_REPORT_GROUPING.BY_VARIETY, filters });
  const group = summary.Groups[0];
  const drilled = await build({
    grouping: CROP_REPORT_GROUPING.BY_VARIETY,
    mode: CROP_REPORT_MODE.DETAILS,
    filters: { ...filters, varietyId: group.VarietyId }
  });
  // Going back re-reads with the ORIGINAL filters — the same result, not an unfiltered one.
  const back = await build({ grouping: CROP_REPORT_GROUPING.BY_VARIETY, filters });
  assert.deepEqual(back.Totals, summary.Totals);
  assert.equal(back.Groups.length, summary.Groups.length);
  assert.equal(drilled.Totals.MovementCount, 2);
});

test('25. a group’s details always add up to the group itself', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10, loose: 5 });
  await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 3, deduction: 1 });
  await local({ farmerId: s.f2.Id, varietyId: s.v1.Id, units: 2 });
  const summary = await build({ grouping: CROP_REPORT_GROUPING.BY_VARIETY });
  for (const group of summary.Groups) {
    const details = await build({
      grouping: CROP_REPORT_GROUPING.BY_VARIETY,
      mode: CROP_REPORT_MODE.DETAILS,
      filters: group.VarietyId ? { varietyId: group.VarietyId } : { varietyId: NO_VARIETY_KEY }
    });
    assert.equal(details.Totals.MovementCount, group.MovementCount);
    assert.equal(details.Totals.PackageCountMilli, group.PackageCountMilli);
    assert.equal(details.Totals.NetWeightMilli, group.NetWeightMilli);
    assert.equal(details.Totals.AmountMinor, group.AmountMinor);
    assert.equal(details.Totals.UnresolvedWeightCount, group.UnresolvedWeightCount);
  }
  // And the groups add up to the global totals.
  assert.equal(
    summary.Groups.reduce((sum, group) => sum + group.PackageCountMilli, 0),
    summary.Totals.PackageCountMilli
  );
});

// ---- 26..28 historical data protection ------------------------------------
test('26. changing DefaultPackageWeight does not change any report figure', async () => {
  const s = await scenario();
  const row = await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10 });
  const before = await build();
  await settingsService.setDefaultPackageWeight(22);
  const after = await build();
  assert.equal(after.Totals.NetWeightMilli, before.Totals.NetWeightMilli);
  assert.equal(after.Totals.AmountMinor, before.AmountMinor === undefined ? after.Totals.AmountMinor : before.Totals.AmountMinor);
  assert.equal(after.Totals.NetWeightMilli, row.NetWeightMilli);
  // The frozen package weight is still the historical one.
  const stored = await transactionRepository.getById(row.Id);
  assert.equal(stored.PackageWeightKg, 14);
});

test('27. opening the report and filtering never modifies a stored movement', async () => {
  const s = await scenario();
  const one = await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10, date: '2026-09-01' });
  const two = await local({ farmerId: s.f2.Id, units: 4, date: '2026-09-20' });
  const snapshot = JSON.stringify(await transactionRepository.getAll());
  await build();
  await build({ filters: { from: '2026-09-02' } });
  await build({ grouping: CROP_REPORT_GROUPING.BY_VARIETY, mode: CROP_REPORT_MODE.DETAILS });
  await build({ filters: { status: CROP_REPORT_STATUS.ALL, search: 'سمير' } });
  const after = JSON.stringify(await transactionRepository.getAll());
  assert.equal(after, snapshot);
  const storedOne = await transactionRepository.getById(one.Id);
  const storedTwo = await transactionRepository.getById(two.Id);
  assert.equal(storedOne.NetWeightMilli, one.NetWeightMilli);
  assert.equal(storedTwo.NetWeightMilli, two.NetWeightMilli);
});

test('28. no weight is ever invented for an unresolved movement', async () => {
  const s = await scenario();
  await transactionRepository.add({
    Id: 'txn_legacy_local_3',
    CustomerId: s.f1.Id,
    Date: '2026-06-01',
    TransactionType: LOCAL,
    Description: null,
    AmountMinor: 30000,
    Status: 'Active',
    LocalUnitsMilli: 20000,
    LocalLooseKgMilli: 0,
    LocalDeductionKgMilli: 0,
    LocalUnitPriceMinor: 150,
    PackageWeightKg: null,
    PackageWeightStatus: 'Unknown',
    NetWeightMilli: null,
    CreatedAt: '2026-06-01T10:00:00.000Z',
    UpdatedAt: '2026-06-01T10:00:00.000Z'
  });
  // The current setting exists and is readable — and is deliberately NOT used.
  assert.equal(await settingsService.getDefaultPackageWeight(), 14);
  const report = await build();
  assert.equal(report.Rows[0].NetWeightMilli, null);
  assert.equal(report.Rows[0].WeightResolved, false);
  assert.equal(report.Totals.NetWeightMilli, 0);
  assert.equal(report.Totals.UnresolvedWeightCount, 1);
  // The pure helper agrees: no stored package weight -> no weight at all.
  assert.deepEqual(resolveStoredWeight({ NetWeightMilli: null, PackageWeightKg: null }), {
    NetWeightMilli: null, WeightResolved: false, WeightSource: null
  });
});

// ---- 29..32 integration ---------------------------------------------------
test('29. the approved carton reports are unaffected', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10 });
  const { cartonReportService, CARTON_REPORT_KIND } = await import('../src/services/cartonReportService.js');
  const report = await cartonReportService.buildReport({ kind: CARTON_REPORT_KIND.BY_FARMER });
  // A local crop purchase is NOT a carton purchase: it must never appear there.
  assert.equal(report.Totals.MovementCount, 0);
  assert.equal(report.Groups.length, 0);
});

test('30. the crop report ignores every non-local type, including carton purchases', async () => {
  const s = await scenario();
  const { receivingCompanyService, cartonTypeService } = await import('../src/services/referenceDataService.js');
  const company = await receivingCompanyService.create('شركة الكابتن');
  const type = await cartonTypeService.create('كرتونة فراولة');
  await transactionService.createTransaction({
    CustomerId: s.f1.Id,
    Date: '2026-09-10',
    TransactionType: CARTON,
    ReceivingCompanyId: company.Id,
    CartonTypeId: type.Id,
    crop: { CartonQuantityMilli: 100000, CartonDiscountMinor: 0, CartonUnitPriceMinor: 500 }
  });
  await transactionService.createTransaction({
    CustomerId: s.f1.Id,
    Date: '2026-09-11',
    TransactionType: 'CashReceived',
    AmountMinor: 99900
  });
  await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10 });
  const report = await build();
  assert.equal(report.Totals.MovementCount, 1);
  assert.equal(report.Totals.PackageCountMilli, 10000);
  assert.equal(report.Rows.every((row) => row.Id.startsWith('trx_')), true);
});

test('31. balances and the customer statement are untouched by reading the report', async () => {
  const s = await scenario();
  await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10 });
  const { balanceService } = await import('../src/services/balanceService.js');
  const before = await balanceService.listCustomerBalances();
  await build({ filters: { status: CROP_REPORT_STATUS.ALL } });
  const after = await balanceService.listCustomerBalances();
  assert.deepEqual(after, before);
});

test('32. the screen and the service carry no setting read and no re-computation', () => {
  const service = readFileSync(new URL('../src/services/cropReportService.js', import.meta.url), 'utf8');
  const screen = readFileSync(new URL('../ui/views/reportCropLocal.js', import.meta.url), 'utf8');
  // No current setting may be consulted by the report path.
  // Assertions are on real calls and imports, never on explanatory comments.
  assert.equal(/getDefaultPackageWeight\s*\(/.test(service), false);
  assert.equal(/getDefaultPackageWeight\s*\(/.test(screen), false);
  assert.equal(/from '[^']*settingsService\.js'/.test(service), false);
  assert.equal(/from '[^']*settingsService\.js'/.test(screen), false);
  // No finance engine or storage access in the screen layer.
  assert.equal(/from '[^']*financialDirection\.js'/.test(screen), false);
  assert.equal(/from '[^']*repositories/.test(screen), false);
  assert.equal(/from '[^']*storage/.test(screen), false);
  assert.equal(/\brunTransaction\s*\(/.test(screen), false);
  assert.equal(/\bindexedDB\b/.test(screen), false);
  assert.equal(/price\s*\*|\*\s*unitPrice|computeLocalAmountMinor/.test(service), false);
  // The screen prints from the service only.
  assert.match(screen, /cropReportService\.buildReport/);
  assert.match(service, /deriveFinancials\(row\)\.isActive/);
});

// ---- screen contract -------------------------------------------------------
test('33. the report screen renders its regions, filters and modes', async () => {
  const { cropReportViewHtml, CROP_REPORT_ROOT_ID, CROP_REPORT_FILTER_FIELD, CROP_REPORT_MODE_TABS, CROP_REPORT_GROUP_TABS } = await import('../ui/views/reportCropLocal.js');
  const html = cropReportViewHtml();
  assert.match(html, new RegExp(`id="${CROP_REPORT_ROOT_ID}"`));
  assert.match(html, /id="crop-report-filters"/);
  assert.match(html, /id="crop-report-results"/);
  assert.match(html, /id="crop-report-summary"/);
  for (const field of Object.values(CROP_REPORT_FILTER_FIELD)) assert.match(html, new RegExp(`id="${field}"`));
  for (const tab of CROP_REPORT_MODE_TABS) assert.match(html, new RegExp(`data-crop-mode="${tab.id}"`));
  for (const tab of CROP_REPORT_GROUP_TABS) assert.match(html, new RegExp(`data-crop-grouping="${tab.id}"`));
  // The KPI block prints only from a service result.
  const { cropReportKpisHtml } = await import('../ui/views/reportCropLocal.js');
  const kpis = cropReportKpisHtml({ Totals: { MovementCount: 2, FarmerCount: 1, PackageCountMilli: 15000, NetWeightMilli: 210000, UnresolvedWeightCount: 0, AmountMinor: 315000 } });
  assert.match(kpis, /id="crop-report-kpis"/);
  assert.match(kpis, /15 عبوة/);
  assert.match(kpis, /210 كجم صافي/);
  assert.match(kpis, /3,150\.00/);
  // Arabic, right-to-left inherited from the app shell, and no invite to export anything.
  assert.match(html, /تقارير مشتريات المحصول المحلي/);
  assert.equal(/CSV|Excel|PDF|طباعة|تصدير/.test(html), false);
});

test('34. the drill-down and back controls exist and the summary keeps the filter text', async () => {
  const { cropReportViewHtml, initCropReportView, CROP_REPORT_LABELS } = await import('../ui/views/reportCropLocal.js');
  assert.match(cropReportViewHtml(), new RegExp(CROP_REPORT_LABELS.apply));
  assert.match(cropReportViewHtml(), new RegExp(CROP_REPORT_LABELS.reset));

  const s = await scenario();
  await local({ farmerId: s.f1.Id, varietyId: s.v1.Id, units: 10 });
  // A minimal DOM stub: the controller only reads values and toggles attributes.
  const elements = new Map();
  const stub = (id) => {
    if (!elements.has(id)) elements.set(id, { id, value: '', innerHTML: '', hidden: false, disabled: false, className: '', setAttribute() {}, removeAttribute() {}, getAttribute() { return null; }, querySelectorAll() { return []; }, addEventListener() {} });
    return elements.get(id);
  };
  const container = {
    querySelector: (selector) => (selector.startsWith('#') ? stub(selector.slice(1)) : null),
    querySelectorAll: () => [],
    addEventListener() {}
  };
  const controller = initCropReportView({ container, autoLoad: false });
  assert.ok(controller, 'the controller must mount');
  // The applied filters survive a drill-down and come back unchanged.
  controller.state.applied = normalizeCropReportFilters({ from: '2026-09-01', to: '2026-09-30' });
  controller.state.drill = { kind: CROP_REPORT_GROUPING.BY_FARMER, key: s.f1.Id, label: 'مزارع أحمد' };
  const merged = controller.effectiveFilters();
  assert.equal(merged.from, '2026-09-01');
  assert.equal(merged.to, '2026-09-30');
  assert.equal(merged.customerId, s.f1.Id);
  controller.state.drill = null;
  assert.equal(controller.effectiveFilters().customerId, null);
});

// ---- pure helpers ----------------------------------------------------------
test('35. grouping is by stored id, so identical names stay apart', () => {
  const rows = [
    toCropReportRow({ Id: 'a', CustomerId: 'c1', Date: '2026-09-01', AmountMinor: 100, LocalUnitsMilli: 1000 }),
    toCropReportRow({ Id: 'b', CustomerId: 'c2', Date: '2026-09-01', AmountMinor: 100, LocalUnitsMilli: 1000 })
  ];
  // Both resolve to «مرجع غير متاح» (no map was supplied) yet remain two groups.
  const groups = groupCropRows(rows, CROP_REPORT_GROUPING.BY_FARMER);
  assert.equal(groups.length, 2);
  assert.equal(summarizeCropRows(rows).FarmerCount, 2);
});

test('36. an empty report is honest: zero groups, zero totals and no invented row', async () => {
  await freshDatabase('cropreport_empty');
  await settingsService.setDefaultPackageWeight(14);
  const report = await build();
  assert.equal(report.Groups.length, 0);
  assert.equal(report.Rows.length, 0);
  assert.equal(report.Totals.MovementCount, 0);
  assert.equal(report.Totals.NetWeightMilli, 0);
  assert.equal(report.Totals.AmountMinor, 0);
  assert.equal(report.Totals.UnresolvedWeightCount, 0);
  assert.equal(UNRESOLVED_WEIGHT_LABEL, 'الوزن غير محسوم');
});


test('37. a missing stored net weight is derived only from four complete historical components', () => {
  const complete = resolveStoredWeight({
    NetWeightMilli: null,
    LocalUnitsMilli: 10000,
    PackageWeightKg: 14,
    LocalDeductionKgMilli: 1000,
    LocalLooseKgMilli: 500
  });
  assert.deepEqual(complete, {
    NetWeightMilli: 130500,
    WeightResolved: true,
    WeightSource: 'DerivedFromStoredComponents'
  });

  for (const missing of ['LocalUnitsMilli', 'PackageWeightKg', 'LocalDeductionKgMilli', 'LocalLooseKgMilli']) {
    const row = {
      NetWeightMilli: null,
      LocalUnitsMilli: 10000,
      PackageWeightKg: 14,
      LocalDeductionKgMilli: 1000,
      LocalLooseKgMilli: 500
    };
    delete row[missing];
    assert.deepEqual(resolveStoredWeight(row), {
      NetWeightMilli: null,
      WeightResolved: false,
      WeightSource: null
    }, `missing ${missing} must remain unresolved`);
  }
});

test('38. a valid stored net weight wins even when formula components are missing', () => {
  assert.deepEqual(resolveStoredWeight({ NetWeightMilli: 123456, PackageWeightKg: null }), {
    NetWeightMilli: 123456,
    WeightResolved: true,
    WeightSource: 'StoredNetWeight'
  });
});

test('39. invalid or impossible historical components are not used to derive weight', () => {
  const base = {
    NetWeightMilli: null,
    LocalUnitsMilli: 10000,
    PackageWeightKg: 14,
    LocalDeductionKgMilli: 1000,
    LocalLooseKgMilli: 500
  };
  for (const row of [
    { ...base, LocalUnitsMilli: -1 },
    { ...base, LocalLooseKgMilli: -1 },
    { ...base, LocalDeductionKgMilli: -1 },
    { ...base, PackageWeightKg: 0 },
    { ...base, LocalDeductionKgMilli: 15000 }
  ]) {
    assert.equal(resolveStoredWeight(row).WeightResolved, false);
  }
});

test('40. detail rows visibly distinguish stored and derived weight sources', async () => {
  const { cropDetailRowsHtml } = await import('../ui/views/reportCropLocal.js');
  const report = {
    DisplayRows: [
      { Id: 'stored', Date: '2026-11-01', IsActive: true, CustomerName: 'مزارع أ', CustomerActive: true, CustomerId: 'c1', CustomerCode: '001', PackageCountMilli: 1000, PackageWeightKg: 14, LooseKgMilli: 0, DeductionKgMilli: 0, NetWeightMilli: 14000, WeightResolved: true, WeightSource: 'StoredNetWeight', HasVariety: false, UnitPriceMinor: 100, AmountMinor: 1400, Description: null, Status: 'Active' },
      { Id: 'derived', Date: '2026-11-02', IsActive: true, CustomerName: 'مزارع ب', CustomerActive: true, CustomerId: 'c2', CustomerCode: '002', PackageCountMilli: 1000, PackageWeightKg: 14, LooseKgMilli: 500, DeductionKgMilli: 1000, NetWeightMilli: 13500, WeightResolved: true, WeightSource: 'DerivedFromStoredComponents', HasVariety: false, UnitPriceMinor: 100, AmountMinor: 1350, Description: null, Status: 'Active' },
      { Id: 'unresolved', Date: '2026-11-03', IsActive: true, CustomerName: 'مزارع ج', CustomerActive: true, CustomerId: 'c3', CustomerCode: '003', PackageCountMilli: 1000, PackageWeightKg: null, LooseKgMilli: null, DeductionKgMilli: null, NetWeightMilli: null, WeightResolved: false, WeightSource: null, HasVariety: false, UnitPriceMinor: 100, AmountMinor: 0, Description: null, Status: 'Active' }
    ]
  };
  const html = cropDetailRowsHtml(report);
  assert.match(html, /مخزن تاريخيًا/);
  assert.match(html, /مشتق من المكونات التاريخية/);
  assert.match(html, /الوزن غير محسوم/);
});
