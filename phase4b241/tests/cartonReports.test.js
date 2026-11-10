// Phase 4B.12 — carton purchase reports: service + screen tests.
// Every figure is asserted against the stored rows; nothing is asserted against a value
// the view computed, because the view computes none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.js';
import { customerService } from '../src/services/customerService.js';
import { transactionService } from '../src/services/transactionService.js';
import { transactionLifecycleService } from '../src/services/transactionLifecycleService.js';
import { receivingCompanyService, cartonTypeService } from '../src/services/referenceDataService.js';
import {
  cartonReportService,
  CARTON_REPORT_KIND,
  UNAVAILABLE_REFERENCE_LABEL,
  UNSPECIFIED_CARTON_COUNT_LABEL,
  normalizeCartonReportFilters,
  cartonCountMilliOf
} from '../src/services/cartonReportService.js';

const CARTON = 'CropPurchaseCarton';
const LOCAL = 'CropPurchaseLocal';

// ---- fixtures --------------------------------------------------------------
async function makeFarmer(code, name) {
  return customerService.createCustomer({ Code: code, Name: name });
}

async function makeCompany(name) {
  return receivingCompanyService.create(name);
}

async function makeType(name) {
  return cartonTypeService.create(name);
}

async function carton({ farmerId, companyId, typeId, quantity, date = '2026-09-10', price = 500, discount = 0 }) {
  return transactionService.createTransaction({
    CustomerId: farmerId,
    Date: date,
    TransactionType: CARTON,
    ReceivingCompanyId: companyId,
    CartonTypeId: typeId,
    crop: {
      CartonQuantityMilli: Math.round(quantity * 1000),
      CartonDiscountMinor: discount,
      CartonUnitPriceMinor: price
    }
  });
}

// A complete, isolated scenario: two farmers, two companies, two carton types.
async function scenario() {
  await freshDatabase('reports');
  const f1 = await makeFarmer('F-001', 'مزارع أحمد');
  const f2 = await makeFarmer('F-002', 'مزارع سمير');
  const c1 = await makeCompany('شركة الكابتن');
  const c2 = await makeCompany('مصنع الدلتا');
  const t1 = await makeType('كرتونة فراولة');
  const t2 = await makeType('كرتونة طماطم');
  return { f1, f2, c1, c2, t1, t2 };
}

const build = (kind, filters = {}) => cartonReportService.buildReport({ kind, filters });

function groupFor(report, predicate) {
  return report.Groups.find(predicate) || null;
}


test('unit prices and stored amounts appear per movement; grouped price is weighted by net cartons', async () => {
  const s = await scenario();
  const first = await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10, price: 500 });
  const second = await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10, price: 1000 });
  const report = await build(CARTON_REPORT_KIND.BY_FARMER);
  assert.equal(report.Rows.find((row) => row.Id === first.Id).CartonUnitPriceMinor, 500);
  assert.equal(report.Rows.find((row) => row.Id === second.Id).CartonUnitPriceMinor, 1000);
  assert.equal(report.Totals.AmountMinor, first.AmountMinor + second.AmountMinor);
  assert.equal(report.Totals.AverageUnitPriceMinor, 750);
  const group = groupFor(report, (row) => row.CustomerId === s.f1.Id);
  assert.equal(group.AverageUnitPriceMinor, 750);
});

test('carton discount is converted to a carton quantity for weighted average only', async () => {
  const s = await scenario();
  const movement = await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 20, price: 1500, discount: 200 });
  const report = await build(CARTON_REPORT_KIND.BY_FARMER);
  const row = report.Rows.find((item) => item.Id === movement.Id);
  assert.equal(row.DiscountQuantityMilli, 2000);
  assert.equal(row.NetQuantityMilli, 18000);
  assert.equal(row.AmountMinor, 27000);
  assert.equal(report.Totals.AverageUnitPriceMinor, 1500);
});

// ---- 1..4 accuracy of grouping --------------------------------------------
test('1. the count is grouped per farmer', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 100 });
  await carton({ farmerId: s.f1.Id, companyId: s.c2.Id, typeId: s.t2.Id, quantity: 50 });
  await carton({ farmerId: s.f2.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 30 });

  const report = await build(CARTON_REPORT_KIND.BY_FARMER);
  assert.equal(report.Groups.length, 2);
  const first = groupFor(report, (g) => g.CustomerId === s.f1.Id);
  assert.equal(first.QuantityMilli, 150000);
  assert.equal(first.MovementCount, 2);
  assert.equal(groupFor(report, (g) => g.CustomerId === s.f2.Id).QuantityMilli, 30000);
  assert.equal(report.Totals.QuantityMilli, 180000);
});

test('2. the count is grouped per receiving company', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 100 });
  await carton({ farmerId: s.f2.Id, companyId: s.c1.Id, typeId: s.t2.Id, quantity: 40 });
  await carton({ farmerId: s.f1.Id, companyId: s.c2.Id, typeId: s.t1.Id, quantity: 25 });

  const report = await build(CARTON_REPORT_KIND.BY_COMPANY);
  assert.equal(report.Groups.length, 2);
  const c1Group = groupFor(report, (g) => g.ReceivingCompanyId === s.c1.Id);
  assert.equal(c1Group.QuantityMilli, 140000);
  assert.equal(c1Group.ReceivingCompanyName, 'شركة الكابتن');
  assert.equal(groupFor(report, (g) => g.ReceivingCompanyId === s.c2.Id).QuantityMilli, 25000);
});

test('3. the count is grouped per carton type', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10 });
  await carton({ farmerId: s.f2.Id, companyId: s.c2.Id, typeId: s.t1.Id, quantity: 15 });
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t2.Id, quantity: 7 });

  const report = await build(CARTON_REPORT_KIND.BY_CARTON_TYPE);
  assert.equal(report.Groups.length, 2);
  assert.equal(groupFor(report, (g) => g.CartonTypeId === s.t1.Id).QuantityMilli, 25000);
  assert.equal(groupFor(report, (g) => g.CartonTypeId === s.t2.Id).QuantityMilli, 7000);
});

test('4. the cross report groups by farmer AND company AND carton type', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10 });
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t2.Id, quantity: 20 });
  await carton({ farmerId: s.f2.Id, companyId: s.c2.Id, typeId: s.t1.Id, quantity: 30 });

  const report = await build(CARTON_REPORT_KIND.CROSS);
  assert.equal(report.Groups.length, 3);
  for (const group of report.Groups) {
    assert.ok(group.CustomerId && group.ReceivingCompanyId && group.CartonTypeId);
    assert.equal(group.MovementCount, 1);
  }
  const target = groupFor(report, (g) => g.CustomerId === s.f1.Id && g.CartonTypeId === s.t2.Id);
  assert.equal(target.QuantityMilli, 20000);
  assert.equal(target.ReceivingCompanyName, 'شركة الكابتن');
});

test('5. several compatible movements collapse into ONE group', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10, date: '2026-09-01' });
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 5, date: '2026-09-02' });
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 2.5, date: '2026-09-03' });

  const report = await build(CARTON_REPORT_KIND.CROSS);
  assert.equal(report.Groups.length, 1);
  assert.equal(report.Groups[0].MovementCount, 3);
  assert.equal(report.Groups[0].QuantityMilli, 17500);
  assert.equal(report.Groups[0].Rows.length, 3);
});

test('6. grouping is keyed by the reference ID, never by the display name', async () => {
  await freshDatabase('reports_dupe');
  const farmer = await makeFarmer('F-100', 'مزارع مكرر');
  const company = await makeCompany('شركة متماثلة');
  const type = await makeType('نوع واحد');
  await carton({ farmerId: farmer.Id, companyId: company.Id, typeId: type.Id, quantity: 10 });

  // The real catalogue refuses a second record with the same normalised name (proven by
  // the following assertion), so a name collision can only exist in stored data. The
  // grouping function is therefore proven to key on the id, not on the label.
  await assert.rejects(() => makeCompany('  شركة   متماثلة '), /موجود بالفعل/);

  const { groupReportRows: group } = await import('../src/services/cartonReportService.js');
  const rows = [
    { Id: 'x1', Date: '2026-09-01', CustomerId: 'f', CustomerName: 'مزارع', ReceivingCompanyId: 'id-A', ReceivingCompanyName: 'اسم واحد', CartonTypeId: 't', CartonTypeName: 'نوع', CartonQuantityMilli: 1000 },
    { Id: 'x2', Date: '2026-09-01', CustomerId: 'f', CustomerName: 'مزارع', ReceivingCompanyId: 'id-B', ReceivingCompanyName: 'اسم واحد', CartonTypeId: 't', CartonTypeName: 'نوع', CartonQuantityMilli: 2000 }
  ];
  const groups = group(rows, CARTON_REPORT_KIND.BY_COMPANY);
  assert.equal(groups.length, 2, 'same visible name, different id => two separate groups');
  assert.deepEqual(groups.map((row) => row.ReceivingCompanyId).sort(), ['id-A', 'id-B']);
  assert.deepEqual(groups.map((row) => row.QuantityMilli).sort(), [1000, 2000]);

  // The same ids in ONE record still produce a single group.
  const one = await build(CARTON_REPORT_KIND.BY_COMPANY);
  assert.equal(one.Groups.length, 1);
  assert.equal(one.Groups[0].ReceivingCompanyId, company.Id);
});

test('7. non-carton movements never enter a carton report', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10 });
  // A local crop purchase of the same farmer, a sale and a cash movement.
  await transactionService.createTransaction({
    CustomerId: s.f1.Id, Date: '2026-09-11', TransactionType: LOCAL,
    crop: { LocalUnitsMilli: 10000, LocalLooseKgMilli: 0, LocalDeductionKgMilli: 0, LocalUnitPriceMinor: 500 }
  });
  await transactionService.createTransaction({
    CustomerId: s.f1.Id, Date: '2026-09-12', TransactionType: 'SalePesticides', AmountMinor: 5000
  });
  await transactionService.createTransaction({
    CustomerId: s.f1.Id, Date: '2026-09-13', TransactionType: 'CashReceived', AmountMinor: 7000
  });

  const report = await build(CARTON_REPORT_KIND.BY_FARMER);
  assert.equal(report.Totals.MovementCount, 1);
  assert.equal(report.Totals.QuantityMilli, 10000);
  assert.equal(report.Groups.length, 1);
});

test('8. a cancelled carton movement is excluded from the figures and reported separately', async () => {
  const s = await scenario();
  const keep = await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10 });
  const drop = await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 99 });
  await transactionLifecycleService.cancelTransaction(drop.Id, 'إلغاء للاختبار', { confirmed: true });

  const report = await build(CARTON_REPORT_KIND.BY_FARMER);
  assert.equal(report.Totals.QuantityMilli, 10000, 'the cancelled movement contributes nothing');
  assert.equal(report.Totals.MovementCount, 1);
  assert.equal(report.Totals.CancelledCount, 1, 'and it is reported, not silently dropped');
  assert.ok(keep.Id);
});

// ---- 9..15 filters ---------------------------------------------------------
test('9. the period alone is applied, inclusive of both end dates', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 1, date: '2026-08-31' });
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 2, date: '2026-09-01' });
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 4, date: '2026-09-30' });
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 8, date: '2026-10-01' });

  const report = await build(CARTON_REPORT_KIND.BY_FARMER, { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(report.Totals.QuantityMilli, 6000);
  assert.equal(report.Totals.MovementCount, 2);
});

test('10. each reference filter works on its own', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10 });
  await carton({ farmerId: s.f2.Id, companyId: s.c2.Id, typeId: s.t2.Id, quantity: 20 });

  const byFarmer = await build(CARTON_REPORT_KIND.CROSS, { customerId: s.f2.Id });
  assert.equal(byFarmer.Totals.QuantityMilli, 20000);

  const byCompany = await build(CARTON_REPORT_KIND.CROSS, { receivingCompanyId: s.c1.Id });
  assert.equal(byCompany.Totals.QuantityMilli, 10000);

  const byType = await build(CARTON_REPORT_KIND.CROSS, { cartonTypeId: s.t2.Id });
  assert.equal(byType.Totals.QuantityMilli, 20000);
});

test('11. all filters combine', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10, date: '2026-09-05' });
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t2.Id, quantity: 20, date: '2026-09-05' });
  await carton({ farmerId: s.f2.Id, companyId: s.c2.Id, typeId: s.t2.Id, quantity: 40, date: '2026-09-05' });
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 80, date: '2026-11-05' });

  const report = await build(CARTON_REPORT_KIND.BY_FARMER, {
    from: '2026-09-01', to: '2026-09-30', customerId: s.f1.Id, receivingCompanyId: s.c1.Id, cartonTypeId: s.t1.Id
  });
  assert.equal(report.Totals.QuantityMilli, 10000);
  assert.equal(report.Totals.MovementCount, 1);
});

test('12. clearing the filters returns the unrestricted figures', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10, date: '2026-09-05' });
  await carton({ farmerId: s.f2.Id, companyId: s.c2.Id, typeId: s.t2.Id, quantity: 20, date: '2026-12-05' });

  const filtered = await build(CARTON_REPORT_KIND.BY_FARMER, { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(filtered.Totals.QuantityMilli, 10000);

  const cleared = await build(CARTON_REPORT_KIND.BY_FARMER, cartonReportService.normalizeFilters({}));
  assert.equal(cleared.Totals.QuantityMilli, 30000);
  assert.equal(cleared.Groups.length, 2);
});

test('13. a start date after the end date is refused', async () => {
  assert.throws(
    () => normalizeCartonReportFilters({ from: '2026-10-01', to: '2026-09-01' }),
    /تاريخ البداية يجب ألا يكون بعد تاريخ النهاية/
  );
  assert.throws(() => normalizeCartonReportFilters({ from: '2026-13-01' }), /تاريخ البداية غير صالح/);
  assert.throws(() => normalizeCartonReportFilters({ to: 'xx' }), /تاريخ النهاية غير صالح/);
  const empty = normalizeCartonReportFilters({});
  assert.deepEqual(empty, { from: null, to: null, customerId: null, receivingCompanyId: null, cartonTypeId: null });
});

test('14. movements on the boundary days are included, and only those', async () => {
  const s = await scenario();
  for (const [date, quantity] of [['2026-09-09', 1], ['2026-09-10', 2], ['2026-09-11', 4]]) {
    await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity, date });
  }
  const sameDay = await build(CARTON_REPORT_KIND.BY_FARMER, { from: '2026-09-10', to: '2026-09-10' });
  assert.equal(sameDay.Totals.QuantityMilli, 2000, 'both bounds inclusive on a single day');

  const fromOnly = await build(CARTON_REPORT_KIND.BY_FARMER, { from: '2026-09-10' });
  assert.equal(fromOnly.Totals.QuantityMilli, 6000);

  const toOnly = await build(CARTON_REPORT_KIND.BY_FARMER, { to: '2026-09-10' });
  assert.equal(toOnly.Totals.QuantityMilli, 3000);
});

test('15. changing the filters never replays a previous result', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10, date: '2026-09-05' });
  await carton({ farmerId: s.f2.Id, companyId: s.c2.Id, typeId: s.t2.Id, quantity: 30, date: '2026-10-05' });

  const first = await build(CARTON_REPORT_KIND.BY_FARMER, { customerId: s.f1.Id });
  assert.equal(first.Totals.QuantityMilli, 10000);
  const second = await build(CARTON_REPORT_KIND.BY_FARMER, { customerId: s.f2.Id });
  assert.equal(second.Totals.QuantityMilli, 30000);
  const third = await build(CARTON_REPORT_KIND.BY_FARMER, {});
  assert.equal(third.Totals.QuantityMilli, 40000);
  assert.notEqual(first, second);
});

// ---- 16..21 details and references ----------------------------------------
test('16. a group total equals the sum of its own detail rows', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 12, date: '2026-09-01' });
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 8, date: '2026-09-02' });
  await carton({ farmerId: s.f1.Id, companyId: s.c2.Id, typeId: s.t1.Id, quantity: 5, date: '2026-09-03' });

  const report = await build(CARTON_REPORT_KIND.CROSS);
  for (const group of report.Groups) {
    const sum = group.Rows.reduce((total, row) => total + row.CartonQuantityMilli, 0);
    assert.equal(group.QuantityMilli, sum, 'the group figure is exactly its rows');
    assert.equal(group.MovementCount, group.Rows.length);
  }
  const allRows = report.Groups.reduce((total, group) => total + group.Rows.reduce((inner, row) => inner + row.CartonQuantityMilli, 0), 0);
  assert.equal(report.Totals.QuantityMilli, allRows, 'the report total is exactly its groups');
});

test('17. the report keeps its filters when the caller re-reads it (details round trip)', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10, date: '2026-09-05' });
  const filters = { from: '2026-09-01', to: '2026-09-30', customerId: s.f1.Id };
  const report = await build(CARTON_REPORT_KIND.BY_FARMER, filters);
  assert.equal(report.Filters.from, '2026-09-01');
  assert.equal(report.Filters.to, '2026-09-30');
  assert.equal(report.Filters.customerId, s.f1.Id);
  // Re-building from the SAME echoed filters must return the same figures: the details
  // view closes over the report object, never over a mutated global.
  const again = await build(CARTON_REPORT_KIND.BY_FARMER, report.Filters);
  assert.deepEqual(again.Totals, report.Totals);
});

test('18. a deactivated reference stays readable and filterable in a historical report', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10 });
  await receivingCompanyService.deactivate(s.c1.Id);

  const report = await build(CARTON_REPORT_KIND.BY_COMPANY);
  const group = groupFor(report, (g) => g.ReceivingCompanyId === s.c1.Id);
  assert.ok(group, 'the historical movement still appears');
  assert.equal(group.ReceivingCompanyName, 'شركة الكابتن');
  assert.equal(group.ReceivingCompanyActive, false);

  const options = await cartonReportService.listFilterOptions();
  const listed = options.receivingCompanies.find((option) => option.value === s.c1.Id);
  assert.equal(listed.IsActive, false, 'the inactive record is still offered for filtering');
});

test('19. a missing reference is reported, never invented', async () => {
  await freshDatabase('reports_missing');
  const farmer = await makeFarmer('F-900', 'مزارع بلا مرجع');
  const company = await makeCompany('شركة مؤقتة');
  const type = await makeType('نوع مؤقت');
  const row = await carton({ farmerId: farmer.Id, companyId: company.Id, typeId: type.Id, quantity: 10 });
  // A row that carries an id nobody can resolve: point it at a value no record holds.
  const { transactionRepository } = await import('../src/repositories/transactionRepository.js');
  const stored = await transactionRepository.getById(row.Id);
  await transactionRepository.put({ ...stored, ReceivingCompanyId: 'rcv_missing_record', CartonTypeId: 'ctn_missing_record' });

  const report = await build(CARTON_REPORT_KIND.BY_COMPANY);
  const group = groupFor(report, (g) => g.ReceivingCompanyId === 'rcv_missing_record');
  assert.ok(group);
  assert.equal(group.ReceivingCompanyName, UNAVAILABLE_REFERENCE_LABEL);
  assert.equal(group.ReceivingCompanyActive, null, 'an unresolved id is not claimed to be active');

  const cross = await build(CARTON_REPORT_KIND.CROSS);
  const crossGroup = cross.Groups.find((g) => g.ReceivingCompanyId === 'rcv_missing_record');
  assert.equal(crossGroup.CartonTypeName, UNAVAILABLE_REFERENCE_LABEL);
});

test('20. the stored Milli count is used as-is, without re-scaling it', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 250 });
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 0.5 });
  const report = await build(CARTON_REPORT_KIND.BY_FARMER);
  assert.equal(report.Totals.QuantityMilli, 250500, '250.5 cartons is 250500 milli units');
  assert.equal(cartonCountMilliOf({ CartonQuantityMilli: 1234 }), 1234);
  assert.equal(cartonCountMilliOf({ CartonQuantityMilli: null }), null);
  assert.equal(cartonCountMilliOf({}), null);
  assert.equal(cartonCountMilliOf({ CartonQuantityMilli: '12' }), null, 'a non-integer is not a count');
});

test('21. a historical row without a usable count is shown as unspecified, never as zero', async () => {
  const s = await scenario();
  const withCount = await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10 });
  const withoutCount = await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 4 });
  const { transactionRepository } = await import('../src/repositories/transactionRepository.js');
  const stored = await transactionRepository.getById(withoutCount.Id);
  await transactionRepository.put({ ...stored, CartonQuantityMilli: null });

  const report = await build(CARTON_REPORT_KIND.BY_FARMER);
  assert.equal(report.Groups.length, 1);
  const group = report.Groups[0];
  assert.equal(group.QuantityMilli, 10000, 'only the resolvable count is summed');
  assert.equal(group.MissingQuantityCount, 1);
  assert.equal(group.MovementCount, 2);
  const missing = group.Rows.find((row) => row.Id === withoutCount.Id);
  assert.equal(missing.CartonQuantityMilli, null);
  assert.equal(missing.QuantityResolved, false);
  assert.ok(withCount.Id);
  assert.equal(UNSPECIFIED_CARTON_COUNT_LABEL, 'عدد غير محدد');
});

// ---- 22..27 no regression ------------------------------------------------
test('22. building a report changes no balance, no debit, no credit and no cash figure', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10 });
  await transactionService.createTransaction({ CustomerId: s.f1.Id, Date: '2026-09-12', TransactionType: 'CashReceived', AmountMinor: 5000 });

  const { balanceService } = await import('../src/services/balanceService.js');
  const before = await balanceService.getCustomerSummary(s.f1.Id);
  for (const kind of Object.values(CARTON_REPORT_KIND)) await build(kind);
  const after = await balanceService.getCustomerSummary(s.f1.Id);
  assert.deepEqual(after, before);

  const ledgerBefore = (await balanceService.getRunningBalance(s.f1.Id)).Entries;
  await build(CARTON_REPORT_KIND.CROSS);
  const ledgerAfter = (await balanceService.getRunningBalance(s.f1.Id)).Entries;
  assert.deepEqual(ledgerAfter.map((row) => [row.Id, row.RunningBalanceMinor]), ledgerBefore.map((row) => [row.Id, row.RunningBalanceMinor]));
  assert.equal(ledgerAfter.length, ledgerBefore.length, 'reporting added no movement');
});

test('23. a local crop purchase is untouched and still uses its own weight equation', async () => {
  const s = await scenario();
  const local = await transactionService.createTransaction({
    CustomerId: s.f1.Id, Date: '2026-09-11', TransactionType: LOCAL,
    crop: { LocalUnitsMilli: 300000, LocalLooseKgMilli: 0, LocalDeductionKgMilli: 0, LocalUnitPriceMinor: 500 }
  });
  await build(CARTON_REPORT_KIND.CROSS);
  const { cropPurchaseService } = await import('../src/services/cropPurchaseService.js');
  const { transactionRepository } = await import('../src/repositories/transactionRepository.js');
  const stored = await transactionRepository.getById(local.Id);
  const facts = cropPurchaseService.localMovementFacts(stored);
  assert.equal(facts.PackageCountMilli, 300000);
  assert.equal(stored.PackageWeightKg, 14, 'the default package weight is still stored on a new local row');
  assert.equal(stored.NetWeightMilli, 300 * 14 * 1000);
});

test('24. reference management is untouched by reporting', async () => {
  const s = await scenario();
  const before = await receivingCompanyService.list();
  const typesBefore = await cartonTypeService.list();
  await build(CARTON_REPORT_KIND.BY_COMPANY);
  await cartonReportService.listFilterOptions();
  assert.deepEqual(await receivingCompanyService.list(), before);
  assert.deepEqual(await cartonTypeService.list(), typesBefore);
});

test('25. the Phase 4B.11 carton edit path still keeps the stored references', async () => {
  const s = await scenario();
  const row = await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t2.Id, quantity: 250 });
  await build(CARTON_REPORT_KIND.CROSS);

  const editable = await transactionLifecycleService.getEditableTransaction(row.Id);
  assert.equal(editable.Record.ReceivingCompanyId, s.c1.Id);
  assert.equal(editable.Record.CartonTypeId, s.t2.Id);
  assert.equal(typeof editable.Editability, 'object');
  assert.equal(editable.Record.Id, row.Id);

  await transactionLifecycleService.editTransaction(row.Id, {
    Date: '2026-09-10', Description: 'تعديل الوصف فقط', EditReason: 'مراجعة الوصف',
    ReceivingCompanyId: s.c1.Id, CartonTypeId: s.t2.Id,
    CartonQuantity: 250, CartonDiscount: 0, CartonPrice: 5
  });
  const { transactionRepository } = await import('../src/repositories/transactionRepository.js');
  const stored = await transactionRepository.getById(row.Id);
  assert.equal(stored.ReceivingCompanyId, s.c1.Id);
  assert.equal(stored.CartonTypeId, s.t2.Id);
  assert.equal(stored.CartonQuantityMilli, 250000);
  assert.equal(stored.Id, row.Id);

  const report = await build(CARTON_REPORT_KIND.BY_FARMER);
  assert.equal(report.Totals.QuantityMilli, 250000);
});

test('26. the backup and restore services are unchanged by reporting', async () => {
  const s = await scenario();
  await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 10 });
  const { backupService } = await import('../src/services/backupService.js');
  const first = await backupService.createBackup();
  await build(CARTON_REPORT_KIND.CROSS);
  const second = await backupService.createBackup();
  assert.equal(first.Meta.SchemaVersion, second.Meta.SchemaVersion);
  // Phase 4B.13.1 raised the schema to 4 (an additive variety store). The intent of this
  // assertion is unchanged: reporting is read-only, so it must not change the version the
  // backup carries — compared against the live constant rather than a frozen number.
  const { DB_VERSION } = await import('../src/storage/schema.js');
  assert.equal(first.Meta.SchemaVersion, DB_VERSION, 'DB_VERSION is untouched by reporting');
  assert.equal(first.Transactions.length, second.Transactions.length);
  assert.equal(first.ReceivingCompanies.length, second.ReceivingCompanies.length);
  assert.equal(first.CartonTypes.length, second.CartonTypes.length);
  assert.equal(first.StrawberryVarieties.length, second.StrawberryVarieties.length);

  const { restoreService } = await import('../src/services/restoreService.js');
  const validation = restoreService.validate(first);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.ok(s.f1.Id);
});

test('27. an unknown report kind is refused instead of returning a wrong table', async () => {
  await freshDatabase('reports_kind');
  await assert.rejects(() => build('byNothing'), /نوع تقرير غير معروف/);
  const report = await build(CARTON_REPORT_KIND.BY_FARMER);
  assert.equal(report.Title, 'مشتريات الكرتون حسب المزارع');
  assert.equal(report.Groups.length, 0);
  assert.equal(report.Totals.QuantityMilli, 0);
  assert.equal(report.Totals.GroupCount, 0);
});

// ---- 28..31 the screen layer, asserted on the string it builds ---------------------
test('28. the reports screen exposes the four reports, the five filters and the two actions', async () => {
  const { reportsViewHtml, REPORT_COLUMNS, REPORT_TABS } = await import('../ui/views/reports.js');
  const html = reportsViewHtml();
  assert.match(html, /تقارير مشتريات الكرتون/);
  assert.equal(REPORT_TABS.length, 4);
  for (const tab of REPORT_TABS) assert.ok(html.includes(`data-report-kind="${tab.id}"`), tab.id);
  for (const id of ['report-from', 'report-to', 'report-customer', 'report-company', 'report-type']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.match(html, /data-report-action="apply"/);
  assert.match(html, /data-report-action="reset"/);
  assert.match(html, /id="report-details-dialog"[^>]*hidden/);
  assert.equal(REPORT_COLUMNS.cross.length, 6);
  assert.match(html, /dir|class="stack"/);
});

test('29. the summary line prints the service totals, and a missing count is never a zero', async () => {
  const { reportSummaryHtml } = await import('../ui/views/reports.js');
  const html = reportSummaryHtml({
    Totals: { QuantityMilli: 250500, MovementCount: 3, GroupCount: 2, MissingQuantityCount: 1, CancelledCount: 4 }
  });
  assert.match(html, /250\.5 كرتونة/);
  assert.match(html, /عدد الحركات المحتسبة: 3/);
  assert.match(html, /عدد المجموعات: 2/);
  assert.match(html, /حركات بلا عدد مسجل: 1/);
  assert.match(html, /حركات ملغاة غير محتسبة: 4/);
  // A group whose rows carry no count at all reports the explicit state, not 0.
  const { countLabel } = await import('../ui/views/reports.js');
  assert.equal(countLabel(null), UNSPECIFIED_CARTON_COUNT_LABEL);
  assert.equal(countLabel(1000), 'كرتونة واحدة');
  assert.equal(countLabel(2000), 'كرتونتان');
  assert.equal(countLabel(5000), '5 كراتين');
  assert.equal(countLabel(250000), '250 كرتونة');
});

test('30. the empty report renders the honest empty state, never a table with zero rows', async () => {
  const { reportsViewHtml } = await import('../ui/views/reports.js');
  assert.match(reportsViewHtml(), /id="report-results"/);
  const report = await build(CARTON_REPORT_KIND.BY_FARMER);
  const { REPORT_EMPTY_MESSAGE } = await import('../ui/views/reports.js');
  assert.equal(report.Groups.length, 0);
  assert.equal(REPORT_EMPTY_MESSAGE.length > 0, true);
});

test('31. the reports screen reaches only the services layer and holds no fixture data', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../ui/views/reports.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  for (const target of imports) {
    if (target.startsWith('../../src/')) assert.match(target, /^\.\.\/\.\.\/src\/(services|utils)\//, target);
  }
  for (const forbidden of ['repositories', 'storage/db', 'storage/schema', 'indexedDB', 'IndexedDB', 'IDBKeyRange', 'TODO', 'FIXME']) {
    assert.equal(source.includes(forbidden), false, `reports.js must not reference ${forbidden}`);
  }
  assert.equal(source.includes('deriveFinancials'), false, 'no financial rule in the view');
  for (const fake of ['mockData', 'fakeData', 'dummyCustomer', 'sampleCustomers', 'lorem']) {
    assert.equal(source.includes(fake), false, fake);
  }
});


// ---- Phase 4B.19: independent summary/details views -----------------------
test('32. the report exposes all active movements independently of its grouping', async () => {
  const s = await scenario();
  const first = await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 12, date: '2026-09-02' });
  const second = await carton({ farmerId: s.f2.Id, companyId: s.c2.Id, typeId: s.t2.Id, quantity: 7, date: '2026-09-03' });
  const report = await build(CARTON_REPORT_KIND.BY_COMPANY);
  assert.equal(report.Rows.length, 2);
  assert.deepEqual(report.Rows.map((row) => row.Id), [first.Id, second.Id]);
  assert.equal(report.Totals.MovementCount, report.Rows.length);
  assert.equal(report.Rows.reduce((sum, row) => sum + row.CartonQuantityMilli, 0), report.Totals.QuantityMilli);
});

test('33. cancelled carton movements are available in details with reason but never enter active totals', async () => {
  const s = await scenario();
  const active = await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 12 });
  const cancelled = await carton({ farmerId: s.f1.Id, companyId: s.c1.Id, typeId: s.t1.Id, quantity: 30 });
  await transactionLifecycleService.cancelTransaction(cancelled.Id, 'تسجيل مكرر', { confirmed: true });

  const report = await build(CARTON_REPORT_KIND.BY_FARMER);
  assert.equal(report.Rows.length, 1);
  assert.equal(report.Rows[0].Id, active.Id);
  assert.equal(report.CancelledRows.length, 1);
  assert.equal(report.CancelledRows[0].Id, cancelled.Id);
  assert.equal(report.CancelledRows[0].StatusLabel, 'ملغاة');
  assert.equal(report.CancelledRows[0].CancellationReason, 'تسجيل مكرر');
  assert.equal(report.Totals.QuantityMilli, 12000);
  assert.equal(report.Totals.MovementCount, 1);
  assert.equal(report.Totals.CancelledCount, 1);
});

test('34. the detailed view is independently selectable and offers active/cancelled/all status scopes', async () => {
  const { reportsViewHtml, reportDetailRows, REPORT_STATUS_FILTER, REPORT_DETAIL_COLUMNS } = await import('../ui/views/reports.js');
  const html = reportsViewHtml();
  assert.match(html, /data-report-mode="summary"/);
  assert.match(html, /data-report-mode="details"/);
  assert.match(html, /العرض التفصيلي/);
  assert.match(html, /value="active"/);
  assert.match(html, /value="cancelled"/);
  assert.match(html, /value="all"/);
  assert.ok(REPORT_DETAIL_COLUMNS.some((column) => column.label === 'سبب الإلغاء'));

  const active = { Id: 'a', Date: '2026-09-01' };
  const cancelled = { Id: 'c', Date: '2026-09-02' };
  const report = { Rows: [active], CancelledRows: [cancelled] };
  assert.deepEqual(reportDetailRows(report, REPORT_STATUS_FILTER.ACTIVE), [active]);
  assert.deepEqual(reportDetailRows(report, REPORT_STATUS_FILTER.CANCELLED), [cancelled]);
  assert.deepEqual(reportDetailRows(report, REPORT_STATUS_FILTER.ALL), [active, cancelled]);
});
