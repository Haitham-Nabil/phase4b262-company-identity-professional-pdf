// Phase 4B.16 — Dashboard service + screen tests.
//
// The dashboard is a READ model: every figure it shows must equal the figure an approved
// service already produced. These tests therefore assert against the services themselves
// (balanceService.listCustomerBalances, transactionLedgerService.buildLedger) instead of
// against a number typed into the test — nothing here is derived by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freshDatabase, cartonRefs } from './helpers.js';
import { customerService, transactionService, debtTransferService, balanceService, strawberryVarietyService, cancellationService } from '../src/services/index.js';
import { transactionLedgerService } from '../src/services/transactionLedgerService.js';
import {
  dashboardService, resolvePeriodRange, buildBuckets, summarizePeriod, summarizeCrop,
  summarizeBalances, buildSeries, todayIso, isoAddDays, normalizeDashboardPeriod,
  DASHBOARD_PERIOD, DASHBOARD_ALERT_KIND, DASHBOARD_LATEST_LIMIT
} from '../src/services/dashboardService.js';
import {
  dashboardViewHtml, initDashboardView, kpisHtml, chartHtml, latestRowsHtml, cropHtml,
  alertsHtml, DASHBOARD_ROOT_ID, DASHBOARD_KPI_ID, DASHBOARD_CHART_ID, DASHBOARD_LATEST_ID,
  DASHBOARD_CROP_ID, DASHBOARD_ACTIONS_ABSENT, DASHBOARD_PERIOD_FIELD_ID, DASHBOARD_KPI_HINT
} from '../ui/views/dashboard.js';
import { renderDestinationView } from '../ui/views/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');
const UI_ROOT = join(PROJECT_ROOT, 'ui');

// Fixed "today" so a period never depends on the machine clock.
const TODAY = '2026-10-31';

// ---------------------------------------------------------------------------
// Fixtures — written through the real transaction service (never repository).
// ---------------------------------------------------------------------------
async function seed() {
  const a = await customerService.createCustomer({ Code: 'D-100', Name: 'مزارع النيل', OpeningBalance: 1000 });
  const b = await customerService.createCustomer({ Code: 'D-200', Name: 'شركة الوادي', OpeningBalance: 0 });
  const stock = await transactionService.createTransaction({
    CustomerId: b.Id, Date: TODAY, TransactionType: 'SalePesticides', Amount: 500, Description: 'مبيدات'
  });

  const sales = await transactionService.createTransaction({
    CustomerId: a.Id, Date: TODAY, TransactionType: 'SaleIrrigation', Amount: 300, Description: 'شبكة ري'
  });
  const sales2 = await transactionService.createTransaction({
    CustomerId: a.Id, Date: '2026-10-20', TransactionType: 'SalePesticides', Amount: 200, Description: 'مبيدات قديمة'
  });
  await transactionService.createTransaction({
    CustomerId: a.Id, Date: '2026-10-25', TransactionType: 'SalesReturn', Amount: 50, Description: 'مرتجع'
  });
  await transactionService.createTransaction({
    CustomerId: a.Id, Date: '2026-10-28', TransactionType: 'CashReceived', Amount: 120, Description: 'تحصيل'
  });
  await transactionService.createTransaction({
    CustomerId: a.Id, Date: '2026-10-29', TransactionType: 'CashPaid', Amount: 70, Description: 'دفعة'
  });
  await transactionService.createTransaction({
    CustomerId: b.Id, Date: '2026-10-27', TransactionType: 'Settlement', Amount: 40, Description: 'تسوية', Direction: 'Credit'
  });
  await transactionService.createTransaction({
    CustomerId: b.Id, Date: '2026-10-26', TransactionType: 'GoodsExchange', Amount: 30, Description: 'تبادل', Direction: 'Debit'
  });

  // A cancelled cash receipt: it must be shown as a movement but NEVER summed.
  const cancelled = await transactionService.createTransaction({
    CustomerId: a.Id, Date: '2026-10-30', TransactionType: 'CashReceived', Amount: 999, Description: 'ملغاة'
  });
  await cancellationService.cancelTransaction(cancelled.Id, 'خطأ في الإدخال');

  const refs = await cartonRefs();
  await transactionService.createTransaction({
    CustomerId: a.Id, Date: '2026-10-24', TransactionType: 'CropPurchaseCarton',
    crop: { CartonQuantityMilli: 250000, CartonUnitPriceMinor: 1000, CartonDiscountMinor: 0 },
    ReceivingCompanyId: refs.ReceivingCompanyId, CartonTypeId: refs.CartonTypeId, Description: 'كرتون'
  });

  const variety = await strawberryVarietyService.create('فيرتونا');
  await transactionService.createTransaction({
    CustomerId: a.Id, Date: '2026-10-23', TransactionType: 'CropPurchaseLocal',
    crop: { LocalUnitsMilli: 25000, LocalLooseKgMilli: 0, LocalDeductionKgMilli: 0, LocalUnitPriceMinor: 700, StrawberryVarietyId: variety.Id },
    Description: 'محصول محلي'
  });

  const transfer = await debtTransferService.createDebtTransfer({
    FromCustomerId: a.Id, ToCustomerId: b.Id, Amount: 400, Date: '2026-10-22', Description: 'تحويل'
  });

  // One movement OUTSIDE every period under test.
  await transactionService.createTransaction({
    CustomerId: a.Id, Date: '2025-01-05', TransactionType: 'SalePesticides', Amount: 10000, Description: 'قديمة جدًا'
  });

  return { a, b, sales, sales2, stock, transfer, variety, refs };
}

// ---------------------------------------------------------------------------
// 1 — Period range arithmetic
// ---------------------------------------------------------------------------
test('1 — the four approved periods resolve to inclusive ISO ranges anchored on today', () => {
  assert.equal(normalizeDashboardPeriod(''), DASHBOARD_PERIOD.LAST_30);
  assert.equal(normalizeDashboardPeriod(undefined), DASHBOARD_PERIOD.LAST_30);

  const seven = resolvePeriodRange(DASHBOARD_PERIOD.LAST_7, TODAY);
  assert.equal(seven.To, TODAY);
  assert.equal(seven.From, '2026-10-25');
  assert.equal(seven.Days, 7);

  const thirty = resolvePeriodRange(DASHBOARD_PERIOD.LAST_30, TODAY);
  assert.equal(thirty.From, '2026-10-02');
  assert.equal(thirty.Days, 30);

  const ninety = resolvePeriodRange(DASHBOARD_PERIOD.LAST_90, TODAY);
  assert.equal(ninety.From, '2026-08-03');
  assert.equal(ninety.Days, 90);

  const year = resolvePeriodRange(DASHBOARD_PERIOD.YEAR, TODAY);
  assert.equal(year.From, '2026-01-01');
  assert.equal(year.Days, 304);

  assert.throws(() => resolvePeriodRange('lastX', TODAY), /الفترة المحددة غير معتمدة/);
  assert.throws(() => resolvePeriodRange(DASHBOARD_PERIOD.LAST_7, '31-10-2026'), /YYYY-MM-DD/);

  assert.equal(isoAddDays('2026-03-01', -1), '2026-02-28');
  assert.equal(isoAddDays('2026-12-31', 1), '2027-01-01');
  assert.match(todayIso(new Date(2026, 9, 5)), /^2026-10-05$/);
});

test('2 — chart buckets follow the range length (days, weeks, months) with no gaps or overlap', () => {
  const days = buildBuckets('2026-10-25', '2026-10-31');
  assert.equal(days.length, 7);
  assert.deepEqual(days[0], { From: '2026-10-25', To: '2026-10-25', Key: '2026-10-25', Label: '10-25' });

  // 30 days stays a daily series (one bar per day), never an aggregated week.
  assert.equal(buildBuckets('2026-10-02', '2026-10-31').length, 30);
  const weeks = buildBuckets('2026-09-17', '2026-10-31');
  assert.equal(weeks.length, 7);
  assert.equal(weeks[0].From, '2026-09-17');
  assert.equal(weeks.at(-1).To, '2026-10-31');

  const months = buildBuckets('2026-01-01', '2026-10-31');
  assert.equal(months.length, 10);
  assert.equal(months[0].Key, '2026-01');
  assert.equal(months[9].Key, '2026-10');
  assert.equal(months[9].To, '2026-10-31');
  // Contiguous: each bucket starts the day after the previous one ends.
  for (let index = 1; index < months.length; index += 1) {
    assert.equal(months[index].From, isoAddDays(months[index - 1].To, 1));
  }
});

// ---------------------------------------------------------------------------
// 2..8 — aggregation, cancelled rows, debt transfer, cash separation
// ---------------------------------------------------------------------------
test('3 — dashboard figures equal the approved services, not a second calculation', async () => {
  await freshDatabase('dash');
  await seed();

  const data = await dashboardService.buildDashboard({ period: DASHBOARD_PERIOD.LAST_30, todayIso: TODAY });
  const balances = await balanceService.listCustomerBalances();
  const ledger = await transactionLedgerService.buildLedger();

  // Balances: the dashboard must report exactly what the balance engine reports.
  const expected = summarizeBalances(balances);
  assert.equal(data.Balances.DebitTotalMinor, expected.DebitTotalMinor);
  assert.equal(data.Balances.CreditTotalMinor, expected.CreditTotalMinor);
  assert.equal(data.Balances.NetBalanceMinor, expected.NetBalanceMinor);
  assert.equal(data.Balances.ActiveCustomerCount, 2);
  assert.equal(data.Balances.CustomerCount, 2);

  // Sales = the sum of the two sale rows inside the period, read from the ledger.
  const salesFromLedger = ledger.Rows
    .filter((row) => !row.IsCancelled && (row.TransactionType === 'SalePesticides' || row.TransactionType === 'SaleIrrigation'))
    .filter((row) => row.Date >= data.Period.From && row.Date <= data.Period.To)
    .reduce((total, row) => total + row.AmountMinor, 0);
  assert.equal(data.Totals.SalesMinor, salesFromLedger);
  assert.equal(data.Totals.SalesMinor, 100000); // 300 + 200 + 500, all inside 30 days

  // The 2025 movement lies outside BOTH ranges: it is stored but never summed.
  const year = await dashboardService.buildDashboard({ period: DASHBOARD_PERIOD.YEAR, todayIso: TODAY });
  assert.equal(year.Period.From, '2026-01-01');
  assert.equal(year.Totals.SalesMinor, 100000, 'a movement from 2025 is outside the current year');
  assert.equal(year.DataState.RegisteredStoredRows > year.DataState.PeriodOperations, true);
});

test('4 — a cancelled movement is counted as cancelled and contributes to NO total', async () => {
  await freshDatabase('dash_cancel');
  const a = await customerService.createCustomer({ Code: 'X-1', Name: 'عميل', OpeningBalance: 0 });
  const paid = await transactionService.createTransaction({
    CustomerId: a.Id, Date: TODAY, TransactionType: 'CashReceived', Amount: 500, Description: 'تحصيل'
  });
  const cancelled = await transactionService.createTransaction({
    CustomerId: a.Id, Date: TODAY, TransactionType: 'CashReceived', Amount: 700, Description: 'ملغاة'
  });
  await cancellationService.cancelTransaction(cancelled.Id, 'سبب واضح');

  const data = await dashboardService.buildDashboard({ period: DASHBOARD_PERIOD.LAST_7, todayIso: TODAY });
  assert.equal(data.Totals.CashReceivedMinor, 50000); // only the active one
  assert.equal(data.Totals.CancelledCount, 1);
  assert.equal(data.Totals.MovementCount, 1);
  assert.equal(data.Series.Buckets.at(-1).CashInMinor, 50000);

  // Still visible in the latest list, with a clear state.
  const row = data.Latest.find((entry) => entry.Id === cancelled.Id);
  assert.ok(row, 'the cancelled movement must still be listed');
  assert.equal(row.IsCancelled, true);
  assert.equal(row.StatusLabel, 'ملغاة');
  assert.equal(data.Alerts.some((alert) => alert.Kind === DASHBOARD_ALERT_KIND.CANCELLED_IN_PERIOD), true);
  assert.equal(paid.Status, 'Active');

  // Balance is untouched by the cancelled row: 0 - 500 (credited) ... cash received is a credit.
  const summary = await balanceService.getCustomerSummary(a.Id);
  assert.equal(summary.CashReceivedMinor, 50000);
  assert.equal(summary.BalanceMinor, data.Balances.NetBalanceMinor);
});

test('5 — a debt transfer is ONE operation: never two rows, never counted twice', async () => {
  await freshDatabase('dash_transfer');
  const a = await customerService.createCustomer({ Code: 'T-1', Name: 'الطرف الأول', OpeningBalance: 0 });
  const b = await customerService.createCustomer({ Code: 'T-2', Name: 'الطرف الثاني', OpeningBalance: 0 });
  await debtTransferService.createDebtTransfer({ FromCustomerId: a.Id, ToCustomerId: b.Id, Amount: 400, Date: TODAY });

  const data = await dashboardService.buildDashboard({ period: DASHBOARD_PERIOD.LAST_7, todayIso: TODAY });
  assert.equal(data.Totals.DebtTransferCount, 1);
  assert.equal(data.Totals.DebtTransferMinor, 40000);
  assert.equal(data.Totals.MovementCount, 1);
  assert.equal(data.Latest.length, 1);
  assert.equal(data.Latest[0].IsLinkedOperation, true);
  assert.equal(data.Latest[0].AmountMinor, 40000);
  assert.match(data.Latest[0].CounterpartyName, /الطرف/);
  // A transfer is not cash and is not a sale.
  assert.equal(data.Totals.CashReceivedMinor, 0);
  assert.equal(data.Totals.CashPaidMinor, 0);
  assert.equal(data.Totals.SalesMinor, 0);
  assert.equal(data.Series.HasCashFlow, false);
});

test('6 — cash, settlement and goods exchange stay three separate figures', async () => {
  await freshDatabase('dash_cash');
  const a = await customerService.createCustomer({ Code: 'C-1', Name: 'عميل', OpeningBalance: 0 });
  await transactionService.createTransaction({ CustomerId: a.Id, Date: TODAY, TransactionType: 'CashReceived', Amount: 100 });
  await transactionService.createTransaction({ CustomerId: a.Id, Date: TODAY, TransactionType: 'CashPaid', Amount: 40 });
  await transactionService.createTransaction({ CustomerId: a.Id, Date: TODAY, TransactionType: 'Settlement', Amount: 30, Direction: 'Credit' });
  await transactionService.createTransaction({ CustomerId: a.Id, Date: TODAY, TransactionType: 'GoodsExchange', Amount: 20, Direction: 'Debit' });

  const data = await dashboardService.buildDashboard({ period: DASHBOARD_PERIOD.LAST_7, todayIso: TODAY });
  assert.equal(data.Totals.CashReceivedMinor, 10000);
  assert.equal(data.Totals.CashPaidMinor, 4000);
  assert.equal(data.Totals.SettlementMinor, 3000);
  assert.equal(data.Totals.GoodsExchangeMinor, 2000);
  // No merging: the cash figure is exactly the cash receipt.
  assert.notEqual(data.Totals.CashReceivedMinor, 10000 + 3000 + 2000);
  // Only the two cash rows enter the cash series.
  assert.equal(data.Series.TotalCashInMinor, 10000);
  assert.equal(data.Series.TotalCashOutMinor, 4000);
  assert.equal(data.Series.HasCashFlow, true);
});

test('7 — period boundaries are inclusive on both ends', async () => {
  await freshDatabase('dash_bounds');
  const a = await customerService.createCustomer({ Code: 'B-1', Name: 'عميل', OpeningBalance: 0 });
  const range = resolvePeriodRange(DASHBOARD_PERIOD.LAST_7, TODAY);
  await transactionService.createTransaction({ CustomerId: a.Id, Date: isoAddDays(range.From, -1), TransactionType: 'CashReceived', Amount: 1 });
  await transactionService.createTransaction({ CustomerId: a.Id, Date: range.From, TransactionType: 'CashReceived', Amount: 2 });
  await transactionService.createTransaction({ CustomerId: a.Id, Date: range.To, TransactionType: 'CashReceived', Amount: 3 });

  const data = await dashboardService.buildDashboard({ period: DASHBOARD_PERIOD.LAST_7, todayIso: TODAY });
  assert.equal(data.Period.From, range.From);
  assert.equal(data.Totals.MovementCount, 2, 'both boundary days count, the day before does not');
  assert.equal(data.Totals.CashReceivedMinor, 500);
});

test('8 — an empty database yields zeros and explicit empty states, never a fabricated figure', async () => {
  await freshDatabase('dash_empty');
  const data = await dashboardService.buildDashboard({ period: DASHBOARD_PERIOD.LAST_30, todayIso: TODAY });

  assert.equal(data.Balances.CustomerCount, 0);
  assert.equal(data.Balances.NetBalanceMinor, 0);
  assert.equal(data.Totals.MovementCount, 0);
  assert.equal(data.Totals.SalesMinor, 0);
  assert.equal(data.Latest.length, 0);
  assert.equal(data.Crop.Local.MovementCount, 0);
  assert.equal(data.Crop.Carton.MovementCount, 0);
  assert.equal(data.Series.HasData, false);
  assert.equal(data.DataState.HaveAnyTransaction, false);
  assert.deepEqual(data.Alerts, []);
  // The screen shows an empty state, not a chart of zeroes.
  assert.match(chartHtml(data.Series), /لا توجد تدفقات نقدية/);
  assert.match(latestRowsHtml(data), /لا توجد حركات مسجّلة/);
});

// ---------------------------------------------------------------------------
// 9..12 — crop indicators
// ---------------------------------------------------------------------------
test('9 — local crop uses the STORED package weight and stored net weight, never today setting', async () => {
  await freshDatabase('dash_local');
  const a = await customerService.createCustomer({ Code: 'L-1', Name: 'مزارع', OpeningBalance: 0 });
  const variety = await strawberryVarietyService.create('فيرتونا');
  await transactionService.createTransaction({
    CustomerId: a.Id, Date: TODAY, TransactionType: 'CropPurchaseLocal',
    crop: { LocalUnitsMilli: 25000, LocalLooseKgMilli: 0, LocalDeductionKgMilli: 0, LocalUnitPriceMinor: 700, StrawberryVarietyId: variety.Id }
  });

  const before = await dashboardService.buildDashboard({ period: DASHBOARD_PERIOD.LAST_30, todayIso: TODAY });
  assert.equal(before.Crop.Local.MovementCount, 1);
  assert.equal(before.Crop.Local.PackageCountMilli, 25000);
  assert.equal(before.Crop.Local.NetWeightMilli, 350000); // 25 × 14 kg, from the stored weight
  assert.equal(before.Crop.Local.WeightResolvedCount, 1);
  assert.equal(before.Crop.Local.UnresolvedWeightCount, 0);
  assert.equal(before.Crop.Local.ByVariety.length, 1);
  assert.equal(before.Crop.Local.ByVariety[0].Label, 'فيرتونا');

  // Changing the setting afterwards must not rewrite the historical weight.
  const { settingsService } = await import('../src/services/settingsService.js');
  const today = await settingsService.getDefaultPackageWeight();
  await settingsService.setDefaultPackageWeight(today + 5);
  const after = await dashboardService.buildDashboard({ period: DASHBOARD_PERIOD.LAST_30, todayIso: TODAY });
  assert.equal(after.Crop.Local.NetWeightMilli, before.Crop.Local.NetWeightMilli);
});

test('10 — a local movement without a stored weight is reported unresolved, never zero', () => {
  const crop = summarizeCrop([
    { TransactionType: 'CropPurchaseLocal', IsCancelled: false, PackageCountMilli: 25000, CropNetWeightMilli: null, CropWeightResolved: false, StrawberryVarietyId: 'v1', StrawberryVarietyName: 'صنف' },
    { TransactionType: 'CropPurchaseLocal', IsCancelled: false, PackageCountMilli: 10000, CropNetWeightMilli: 140000, CropWeightResolved: true, StrawberryVarietyId: null, StrawberryVarietyName: null }
  ]);
  assert.equal(crop.Local.MovementCount, 2);
  assert.equal(crop.Local.PackageCountMilli, 35000);
  assert.equal(crop.Local.NetWeightMilli, 140000, 'only the resolved weight is summed');
  assert.equal(crop.Local.UnresolvedWeightCount, 1);
  assert.equal(crop.Local.ByVariety.length, 2);
  const none = crop.Local.ByVariety.find((entry) => entry.Id === null);
  assert.equal(none.Label, 'غير محدد', 'a movement with no variety is unspecified, never invented');
});

test('11 — carton counts never mix with crop weight, and a missing count is not zero', async () => {
  await freshDatabase('dash_carton');
  const a = await customerService.createCustomer({ Code: 'K-1', Name: 'مزارع', OpeningBalance: 0 });
  const refs = await cartonRefs();
  await transactionService.createTransaction({
    CustomerId: a.Id, Date: TODAY, TransactionType: 'CropPurchaseCarton',
    crop: { CartonQuantityMilli: 250000, CartonUnitPriceMinor: 1000, CartonDiscountMinor: 0 },
    ReceivingCompanyId: refs.ReceivingCompanyId, CartonTypeId: refs.CartonTypeId
  });

  const data = await dashboardService.buildDashboard({ period: DASHBOARD_PERIOD.LAST_30, todayIso: TODAY });
  assert.equal(data.Crop.Carton.MovementCount, 1);
  assert.equal(data.Crop.Carton.CartonQuantityMilli, 250000);
  assert.equal(data.Crop.Carton.ByCompany.length, 1);
  assert.equal(data.Crop.Carton.ByCartonType.length, 1);
  // The carton side must never populate a weight.
  assert.equal(data.Crop.Local.MovementCount, 0);
  assert.equal(data.Crop.Local.NetWeightMilli, 0);

  const missing = summarizeCrop([{ TransactionType: 'CropPurchaseCarton', IsCancelled: false, CartonQuantityMilli: null, ReceivingCompanyId: 'c1', ReceivingCompanyName: 'شركة' }]);
  assert.equal(missing.Carton.MissingQuantityCount, 1);
  assert.equal(missing.Carton.CartonQuantityMilli, 0);
  assert.equal(missing.Carton.QuantityResolvedCount, 0);
});

test('12 — an unresolvable reference is labelled unavailable, not invented', () => {
  const crop = summarizeCrop([{
    TransactionType: 'CropPurchaseCarton', IsCancelled: false, CartonQuantityMilli: 1000,
    ReceivingCompanyId: 'ghost', ReceivingCompanyName: null, ReceivingCompanyActive: null,
    CartonTypeId: null, CartonTypeName: null
  }]);
  assert.equal(crop.Carton.ByCompany[0].Label, 'سجل غير متاح');
  assert.equal(crop.Carton.ByCartonType[0].Label, 'غير محدد');
});

// ---------------------------------------------------------------------------
// 13..16 — read-only behaviour and guards
// ---------------------------------------------------------------------------
test('13 — opening the dashboard and switching periods changes no balance and adds no row', async () => {
  await freshDatabase('dash_readonly');
  const { a, b } = await seed();
  const beforeA = await balanceService.getCustomerSummary(a.Id);
  const beforeB = await balanceService.getCustomerSummary(b.Id);
  const ledgerBefore = await transactionLedgerService.buildLedger();

  for (const period of Object.values(DASHBOARD_PERIOD)) {
    await dashboardService.buildDashboard({ period, todayIso: TODAY });
  }
  const html = dashboardViewHtml(new Set());
  assert.equal(typeof html, 'string');

  const afterA = await balanceService.getCustomerSummary(a.Id);
  const afterB = await balanceService.getCustomerSummary(b.Id);
  const ledgerAfter = await transactionLedgerService.buildLedger();

  assert.deepEqual(afterA, beforeA);
  assert.deepEqual(afterB, beforeB);
  assert.equal(ledgerAfter.Summary.TotalCount, ledgerBefore.Summary.TotalCount);
  assert.equal(ledgerAfter.Summary.StoredRowCount, ledgerBefore.Summary.StoredRowCount);
});

test('14 — the latest list is capped, newest first, and uses the ledger order', async () => {
  await freshDatabase('dash_latest');
  const a = await customerService.createCustomer({ Code: 'N-1', Name: 'عميل', OpeningBalance: 0 });
  for (let index = 1; index <= DASHBOARD_LATEST_LIMIT + 4; index += 1) {
    await transactionService.createTransaction({
      CustomerId: a.Id, Date: `2026-10-${String(index).padStart(2, '0')}`, TransactionType: 'CashReceived', Amount: index
    });
  }
  const data = await dashboardService.buildDashboard({ period: DASHBOARD_PERIOD.LAST_30, todayIso: TODAY });
  assert.equal(data.Latest.length, DASHBOARD_LATEST_LIMIT);
  for (let index = 1; index < data.Latest.length; index += 1) {
    assert.equal(String(data.Latest[index - 1].Date) >= String(data.Latest[index].Date), true);
  }
});

test('15 — the dashboard UI reaches no storage layer and exposes no write action', () => {
  const source = readFileSync(join(UI_ROOT, 'views', 'dashboard.js'), 'utf8');
  for (const forbidden of ['indexedDB', 'IDBKeyRange', 'runTransaction', 'repositories/', 'storage/db', 'storage/schema', 'deriveFinancials', 'transactionService', 'createTransaction', 'editTransaction', 'cancelTransaction']) {
    assert.equal(source.includes(forbidden), false, `dashboard.js must not reference ${forbidden}`);
  }
  // Imports from src are limited to services and utils.
  const imports = [...source.matchAll(/from '([^']*src\/[^']*)'/g)].map((match) => match[1]);
  assert.equal(imports.length > 0, true);
  for (const specifier of imports) {
    assert.match(specifier, /src\/(services|utils)\//);
  }
  assert.deepEqual([...DASHBOARD_ACTIONS_ABSENT], ['create', 'edit', 'delete', 'cancel']);
});

test('16 — the route now renders the real dashboard shell instead of the placeholder', () => {
  const html = renderDestinationView({ route: { id: 'dashboard', title: 'لوحة التحكم', subtitle: 'نظرة', group: 'نظرة عامة' } });
  assert.match(html, new RegExp(`id="${DASHBOARD_ROOT_ID}"`));
  assert.doesNotMatch(html, /لم تُبنَ وظائف الشاشة بعد/);
  assert.match(html, new RegExp(`id="${DASHBOARD_PERIOD_FIELD_ID}"`));
  for (const id of [DASHBOARD_KPI_ID, DASHBOARD_CHART_ID, DASHBOARD_LATEST_ID, DASHBOARD_CROP_ID]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // The period selector offers the four approved ranges.
  for (const value of Object.values(DASHBOARD_PERIOD)) assert.match(html, new RegExp(`value="${value}"`));
  // The shell states the scope rule: balances are current, totals are of the period.
  assert.match(html, /لا تتأثر بالفترة/);
  assert.match(html, /محسوبة على الحركات الواقعة داخل الفترة/);
});

// ---------------------------------------------------------------------------
// 17..20 — rendered HTML from a fixture read model
// ---------------------------------------------------------------------------
function fixtureData(overrides = {}) {
  return {
    Period: { Period: 'last30', Label: 'آخر 30 يومًا', From: '2026-10-02', To: TODAY, Days: 30 },
    GeneratedAt: '2026-10-31T10:00:00.000Z',
    Balances: { CustomerCount: 3, ActiveCustomerCount: 2, NamelessCustomerCount: 1, InactiveCustomerCount: 1, DebitTotalMinor: 150000, DebitCount: 1, CreditTotalMinor: 130000, CreditCount: 1, ZeroCount: 1, NonZeroCount: 2, NetBalanceMinor: -20000 },
    Totals: {
      MovementCount: 4, CancelledCount: 1, MissingAmountCount: 0,
      SalesMinor: 50000, SalesReturnMinor: 10000, CashReceivedMinor: 20000, CashPaidMinor: 15000,
      SettlementMinor: 12000, GoodsExchangeMinor: 8000, DebtTransferMinor: 40000, DebtTransferCount: 1,
      LocalCropMinor: 175000, CartonMinor: 250000,
      ByType: [
        { TransactionType: 'CashReceived', Label: 'استلام نقدية', MovementCount: 1, AmountMinor: 20000, MissingAmountCount: 0, CashReceivedMinor: 20000, CashPaidMinor: 0 },
        { TransactionType: 'SalesReturn', Label: 'مرتجع مبيعات', MovementCount: 1, AmountMinor: 10000, MissingAmountCount: 0, CashReceivedMinor: 0, CashPaidMinor: 0 }
      ]
    },
    Series: {
      Buckets: [{ From: '2026-10-30', To: '2026-10-30', Key: '2026-10-30', Label: '10-30', CashInMinor: 20000, CashOutMinor: 15000, MovementCount: 2 }],
      HasData: true, HasCashFlow: true, TotalCashInMinor: 20000, TotalCashOutMinor: 15000
    },
    Crop: {
      Local: { MovementCount: 1, PackageCountMilli: 25000, PackageCountMissingCount: 0, NetWeightMilli: 350000, WeightResolvedCount: 1, UnresolvedWeightCount: 0, ByVariety: [{ Id: 'v1', Label: 'فيرتونا', MovementCount: 1, PackageCountMilli: 25000, NetWeightMilli: 350000 }] },
      Carton: { MovementCount: 1, CartonQuantityMilli: 250000, QuantityResolvedCount: 1, MissingQuantityCount: 0, ByCompany: [{ Id: 'c1', Label: 'الكابتن', MovementCount: 1, CartonQuantityMilli: 250000 }], ByCartonType: [{ Id: 't1', Label: 'كرتونة فراولة فريش', MovementCount: 1, CartonQuantityMilli: 250000 }] }
    },
    Latest: [
      { RowKey: 'r1', Id: 'r1', Date: '2026-10-30', TransactionType: 'CashReceived', TypeLabel: 'استلام نقدية', CustomerId: 'cus_1', CustomerName: 'أحمد المصري', CustomerCode: 'C-100', Description: 'تحصيل', AmountMinor: 20000, StatusLabel: 'نشطة', IsCancelled: false, IsLinkedOperation: false, CounterpartyName: null, ReferenceParts: null },
      { RowKey: 'r2', Id: 'r2', Date: '2026-10-29', TransactionType: 'CashPaid', TypeLabel: 'دفعة نقدية', CustomerId: 'cus_1', CustomerName: 'أحمد المصري', CustomerCode: 'C-100', Description: 'دفعة', AmountMinor: 15000, StatusLabel: 'ملغاة', IsCancelled: true, IsLinkedOperation: false, CounterpartyName: null, ReferenceParts: null }
    ],
    Alerts: [
      { Kind: 'nonZeroBalance', Label: 'عملاء لديهم رصيد غير صفري', Count: 2, Tone: 'info' },
      { Kind: 'namelessCustomer', Label: 'عملاء بلا اسم مسجّل', Count: 1, Tone: 'warning' }
    ],
    DataState: { RegisteredOperations: 5, RegisteredStoredRows: 6, PeriodOperations: 5, PeriodActiveOperations: 4, HaveAnyTransaction: true, HavePeriodData: true, ...overrides }
  };
}

test('17 — the KPI cards print the service figures with a scope badge on every one', () => {
  const html = kpisHtml(fixtureData());
  // Money is rendered from minor units by the shared formatter: 150000 minor = 1,500.00.
  assert.match(html, /1,500\.00/);
  assert.match(html, /1,300\.00/);
  assert.match(html, /-200\.00/);
  assert.match(html, /id="kpi-active-customers"[\s\S]*2 \/ 3/);
  assert.match(html, /id="kpi-sales"[\s\S]*500\.00/);
  assert.match(html, /id="kpi-cash-in"[\s\S]*200\.00/);
  assert.match(html, /id="kpi-cash-out"[\s\S]*150\.00/);
  assert.match(html, /id="kpi-local-crop"[\s\S]*1,750\.00/);
  assert.match(html, /id="kpi-carton"[\s\S]*2,500\.00/);
  // Every card carries exactly one scope badge, and the debit figure is not the credit one.
  assert.equal((html.match(/>رصيد حالي</g) || []).length, 3);
  assert.equal((html.match(/>خلال الفترة</g) || []).length, 5);
  assert.equal((html.match(/>عدد حالي</g) || []).length, 1);
  assert.notEqual(html.match(/id="kpi-debit"[\s\S]*?data-kpi-value>([^<]+)/)[1], html.match(/id="kpi-credit"[\s\S]*?data-kpi-value>([^<]+)/)[1]);
});

test('18 — the chart draws stored cash flows only, and an empty state when there is none', () => {
  const data = fixtureData();
  const html = chartHtml(data.Series);
  assert.match(html, /<svg/);
  assert.match(html, /data-bar="in"/);
  assert.match(html, /data-bar="out"/);
  assert.match(html, /تحصيل نقدي: 200\.00/);
  assert.match(html, /مدفوعات نقدية: 150\.00/);

  const noCash = chartHtml({ Buckets: [{ From: '2026-10-31', To: '2026-10-31', Key: 'x', Label: '10-31', CashInMinor: 0, CashOutMinor: 0, MovementCount: 3 }], HasData: true, HasCashFlow: false, TotalCashInMinor: 0, TotalCashOutMinor: 0 });
  assert.match(noCash, /لا توجد تدفقات نقدية/);
  assert.doesNotMatch(noCash, /<svg/);
});

test('19 — the latest table prints stored values, marks cancelled rows and links the customer', () => {
  const html = latestRowsHtml(fixtureData());
  assert.match(html, /2026-10-30/);
  assert.match(html, /استلام نقدية/);
  assert.match(html, /أحمد المصري/);
  assert.match(html, /href="#\/customer\/cus_1"/, 'the customer account link is built from the stored id');
  assert.match(html, /200\.00/);
  assert.match(html, /ملغاة/);
  assert.match(html, /نشطة/);
  // A cancelled row is visibly distinguished, not hidden.
  assert.match(html, /ledger-row--cancelled/);
});

test('20 — the crop cards keep counts and weights apart and show distributions', () => {
  const html = cropHtml(fixtureData());
  assert.match(html, /id="dashboard-crop-local"/);
  assert.match(html, /id="dashboard-crop-carton"/);
  assert.match(html, /data-crop="local-packages"[\s\S]*25/);
  assert.match(html, /data-crop="local-weight"[\s\S]*350[^<]*كجم/);
  assert.match(html, /فيرتونا/);
  assert.match(html, /data-crop="carton-quantity"[\s\S]*250[^<]*كرتونة/);
  assert.match(html, /الكابتن/);
  assert.match(html, /كرتونة فراولة فريش/);
  // The carton card never prints a weight.
  const cartonPart = html.slice(html.indexOf('dashboard-crop-carton'));
  assert.doesNotMatch(cartonPart, /كجم/);
  // Alerts render their own count and never call a balance overdue.
  const alerts = alertsHtml(fixtureData());
  assert.match(alerts, /data-alert="nonZeroBalance"/);
  assert.doesNotMatch(alerts, /متعثر|متأخر/);
});

// ---------------------------------------------------------------------------
// 21 — the controller: period change re-reads, loading and error states
// ---------------------------------------------------------------------------
test('21 — changing the period re-reads the data and never leaves a stale figure', async () => {
  await freshDatabase('dash_ui');
  await seed();
  const container = makeContainer(dashboardViewHtml());
  const view = initDashboardView({ container, autoLoad: false });
  await view.load();
  const seven = container.querySelector('#dashboard-period-label').textContent;
  assert.match(seven, /آخر 30 يومًا/);
  assert.equal(container.querySelector('#dashboard-content').hidden, false);

  const select = container.querySelector(`#${DASHBOARD_PERIOD_FIELD_ID}`);
  select.value = DASHBOARD_PERIOD.LAST_7;
  container.emit('change', select);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.match(container.querySelector('#dashboard-period-label').textContent, /آخر 7 أيام/);
  // The KPI block was repainted from the new read, not left as it was.
  assert.match(container.querySelector(`#${DASHBOARD_KPI_ID}`).innerHTML, /id="kpi-sales"/);

  // A rejected period surfaces an error state and no figure.
  view.state.period = 'nope';
  await view.load();
  assert.match(container.querySelector('#dashboard-state').innerHTML, /الفترة المحددة غير معتمدة/);
});

function makeContainer(html) {
  const nodes = new Map();
  const re = /id="([^"]+)"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    if (!nodes.has(match[1])) nodes.set(match[1], {
      id: match[1], innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      removeAttribute(name) { delete this.attributes[name]; },
      getAttribute(name) { return this.attributes[name] ?? null; }
    });
  }
  const handlers = new Map();
  return {
    innerHTML: html,
    nodes,
    querySelector(selector) {
      if (!selector.startsWith('#')) return null;
      return nodes.get(selector.slice(1)) || null;
    },
    querySelectorAll() { return []; },
    addEventListener(type, handler) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(handler);
    },
    emit(type, target) { for (const handler of handlers.get(type) || []) handler({ target, preventDefault() {} }); }
  };
}

// ---------------------------------------------------------------------------
// 22 — protection of the earlier phases
// ---------------------------------------------------------------------------
test('22 — the dashboard changes no schema, no DB_VERSION and no financial engine', () => {
  const schema = readFileSync(join(PROJECT_ROOT, 'src', 'storage', 'schema.js'), 'utf8');
  assert.match(schema, /export const DB_VERSION = 4;/);
  const financial = readFileSync(join(PROJECT_ROOT, 'src', 'domain', 'financialDirection.js'), 'utf8');
  assert.match(financial, /export function deriveFinancials/);
  // The dashboard source contains no financial formula of its own.
  const source = readFileSync(join(PROJECT_ROOT, 'src', 'services', 'dashboardService.js'), 'utf8');
  for (const forbidden of ['DebitMinor +=', 'CreditMinor +=', '* MONEY_FACTOR', 'toMinor(']) {
    assert.equal(source.includes(forbidden), false, `dashboardService must not compute money: ${forbidden}`);
  }
  // No TODO / FIXME / silent catch anywhere in the new files.
  for (const file of ['src/services/dashboardService.js', join('ui', 'views', 'dashboard.js')]) {
    const text = readFileSync(join(PROJECT_ROOT, file), 'utf8');
    assert.doesNotMatch(text, /TODO|FIXME/);
    assert.doesNotMatch(text, /catch\s*\([^)]*\)\s*\{\s*\}/);
  }
});

test('23 — buildSeries buckets a cash row into the right bucket and skips cancelled rows', () => {
  const range = resolvePeriodRange(DASHBOARD_PERIOD.LAST_7, TODAY);
  const series = buildSeries([
    { Date: TODAY, IsCancelled: false, CashReceivedMinor: 500, CashPaidMinor: 0 },
    { Date: TODAY, IsCancelled: true, CashReceivedMinor: 900, CashPaidMinor: 0 },
    { Date: isoAddDays(TODAY, -6), IsCancelled: false, CashReceivedMinor: 0, CashPaidMinor: 300 }
  ], range);
  assert.equal(series.Buckets.length, 7);
  assert.equal(series.Buckets.at(-1).CashInMinor, 500);
  assert.equal(series.Buckets[0].CashOutMinor, 300);
  assert.equal(series.TotalCashInMinor, 500);
  assert.equal(series.TotalCashOutMinor, 300);
  assert.equal(series.Buckets.at(-1).MovementCount, 1);
});

test('24 — period totals keep every category in its own field and never net them together', () => {
  const totals = summarizePeriod([
    { TransactionType: 'SalePesticides', IsCancelled: false, AmountMinor: 1000, CashReceivedMinor: 0, CashPaidMinor: 0 },
    { TransactionType: 'CashReceived', IsCancelled: false, AmountMinor: 400, CashReceivedMinor: 400, CashPaidMinor: 0 },
    { TransactionType: 'Settlement', IsCancelled: false, AmountMinor: 300, CashReceivedMinor: 0, CashPaidMinor: 0 },
    { TransactionType: 'DebtTransfer', IsCancelled: false, AmountMinor: 200, CashReceivedMinor: 0, CashPaidMinor: 0 },
    { TransactionType: 'CashPaid', IsCancelled: true, AmountMinor: 999, CashReceivedMinor: 0, CashPaidMinor: 999 }
  ]);
  assert.equal(totals.SalesMinor, 1000);
  assert.equal(totals.CashReceivedMinor, 400);
  assert.equal(totals.SettlementMinor, 300);
  assert.equal(totals.DebtTransferMinor, 200);
  assert.equal(totals.DebtTransferCount, 1);
  assert.equal(totals.CashPaidMinor, 0, 'a cancelled cash payment is never summed');
  assert.equal(totals.CancelledCount, 1);
  assert.equal(totals.MovementCount, 4);
  // The categories are additive but never collapsed into one another.
  assert.equal(totals.CashReceivedMinor + totals.SettlementMinor, 700);
  assert.notEqual(totals.CashReceivedMinor, 400 + 300);
});


// ---------------------------------------------------------------------------
// Phase 4B.16 corrections — the three limited fixes.
// ---------------------------------------------------------------------------

test('25 — the net-balance hint states the real equation (credit minus debit)', async () => {
  await freshDatabase('fix_net_hint');
  // The sign the approved engine produces: a customer who owes us has a NEGATIVE balance,
  // a customer we owe has a POSITIVE one. Net therefore equals credits minus debits, and the
  // hint must say so — the reversed wording is what this correction removed.
  const debtor = await customerService.createCustomer({ Code: 'F-1', Name: 'مدين', OpeningBalance: 0 });
  await transactionService.createTransaction({
    CustomerId: debtor.Id, Date: TODAY, TransactionType: 'SalePesticides', Amount: 300, Description: 'بيع'
  });
  const creditor = await customerService.createCustomer({ Code: 'F-2', Name: 'دائن', OpeningBalance: 0 });
  await transactionService.createTransaction({
    CustomerId: creditor.Id, Date: TODAY, TransactionType: 'CashReceived', Amount: 100, Description: 'دفعة مقدمة'
  });

  const balances = await balanceService.listCustomerBalances();
  // The service row is { Customer, Summary } — the balance lives in Summary.BalanceMinor.
  const netFromService = balances.reduce((total, row) => total + row.Summary.BalanceMinor, 0);
  const data = await dashboardService.buildDashboard({ period: DASHBOARD_PERIOD.LAST_30, todayIso: TODAY });

  assert.equal(data.Balances.NetBalanceMinor, netFromService);
  // Net is credits minus debits — never the sum of the two magnitudes.
  assert.equal(data.Balances.NetBalanceMinor, data.Balances.CreditTotalMinor - data.Balances.DebitTotalMinor);
  assert.equal(DASHBOARD_KPI_HINT.NET.startsWith('الدائن مطروحًا منه المدين'), true);
  assert.equal(DASHBOARD_KPI_HINT.NET.includes('المدين مطروحًا منه الدائن'), false);

  // The hint reaches the rendered card, so the screen and the constant cannot drift apart.
  const html = kpisHtml(data);
  assert.match(html, /الدائن مطروحًا منه المدين/);
  assert.doesNotMatch(html, /المدين مطروحًا منه الدائن/);
});

test('26 — the latest ten come from the whole ledger and do not move with the period', async () => {
  await freshDatabase('dash_latest_period');
  const a = await customerService.createCustomer({ Code: 'L-1', Name: 'مزارع النيل', OpeningBalance: 0 });
  const b = await customerService.createCustomer({ Code: 'L-2', Name: 'شركة الوادي', OpeningBalance: 0 });

  // Two movements inside the last 7 days, three older ones that a short period drops.
  await transactionService.createTransaction({ CustomerId: a.Id, Date: '2026-10-31', TransactionType: 'SalePesticides', Amount: 500, Description: 'حديث 1' });
  await transactionService.createTransaction({ CustomerId: a.Id, Date: '2026-10-30', TransactionType: 'CashReceived', Amount: 200, Description: 'حديث 2' });
  await transactionService.createTransaction({ CustomerId: a.Id, Date: '2026-06-15', TransactionType: 'SaleIrrigation', Amount: 700, Description: 'قديم 1' });
  await transactionService.createTransaction({ CustomerId: b.Id, Date: '2026-03-01', TransactionType: 'SalePesticides', Amount: 900, Description: 'قديم 2' });
  const cancelled = await transactionService.createTransaction({ CustomerId: a.Id, Date: '2026-02-01', TransactionType: 'CashPaid', Amount: 60, Description: 'ملغاة' });
  await cancellationService.cancelTransaction(cancelled.Id, 'خطأ في الإدخال');
  // A debt transfer represented by two stored legs but ONE ledger operation.
  await debtTransferService.createDebtTransfer({ FromCustomerId: a.Id, ToCustomerId: b.Id, Amount: 400, Date: '2026-01-20' });

  const ledger = await transactionLedgerService.buildLedger();
  const expected = ledger.Rows.slice(0, DASHBOARD_LATEST_LIMIT).map((row) => row.Id);

  const seen = {};
  for (const period of [DASHBOARD_PERIOD.LAST_7, DASHBOARD_PERIOD.LAST_30, DASHBOARD_PERIOD.LAST_90, DASHBOARD_PERIOD.YEAR]) {
    const data = await dashboardService.buildDashboard({ period, todayIso: TODAY });
    seen[period] = data.Latest.map((row) => row.Id);
    // The same newest rows under every period, in the ledger's own order.
    assert.deepEqual(data.Latest.map((row) => row.Id), expected, `latest changed for ${period}`);
    // The list still carries the ledger's own reading of every row.
    assert.equal(data.Latest.length, Math.min(ledger.Rows.length, DASHBOARD_LATEST_LIMIT));
    const transfer = data.Latest.filter((row) => row.IsLinkedOperation);
    assert.equal(data.Latest.filter((row) => row.TransactionType === 'DebtTransfer').length <= 1, true, 'a transfer is one row');
    if (rowById(ledger.Rows, cancelled.Id)) {
      const cancelledRow = data.Latest.find((row) => row.Id === cancelled.Id);
      if (cancelledRow) assert.equal(cancelledRow.IsCancelled, true, 'a cancelled movement keeps its status');
    }
    assert.equal(transfer.length >= 0, true);
  }
  // Identical across the four periods — the period narrows the figures, never this list.
  assert.deepEqual(seen.last7, seen.last30);
  assert.deepEqual(seen.last30, seen.last90);
  assert.deepEqual(seen.last90, seen.year);

  // ...while the period numbers themselves DO respond to the chosen range.
  const seven = await dashboardService.buildDashboard({ period: DASHBOARD_PERIOD.LAST_7, todayIso: TODAY });
  const year = await dashboardService.buildDashboard({ period: DASHBOARD_PERIOD.YEAR, todayIso: TODAY });
  assert.notEqual(seven.Totals.MovementCount, year.Totals.MovementCount);
  assert.equal(seven.Totals.MovementCount < year.Totals.MovementCount, true);
  // The transfer is one operation inside the year totals, never two.
  const transferRows = year.Latest.filter((row) => row.TransactionType === 'DebtTransfer');
  assert.equal(transferRows.length, 1);
  const ledgerTransferRows = ledger.Rows.filter((row) => row.TransactionType === 'DebtTransfer');
  assert.equal(ledgerTransferRows.length, 1);
});

test('27 — the account-route breadcrumb is styled, so the header keeps its normal height', () => {
  // The regression was a missing rule, not an oversized header: `.app-breadcrumb` had no
  // declaration anywhere, so the three fragment lines wrapped and grew the 68px header.
  const layout = readFileSync(join(UI_ROOT, 'styles', 'layout.css'), 'utf8');
  const rule = layout.slice(layout.indexOf('.app-breadcrumb {'));
  assert.notEqual(rule, layout, '.app-breadcrumb must have a rule in layout.css');
  assert.match(layout, /\.app-breadcrumb \{[^}]*display: flex;/);
  assert.match(layout, /\.app-breadcrumb__link,\s*\n\.app-breadcrumb__current \{[^}]*text-overflow: ellipsis/s);
  assert.match(layout, /\.app-breadcrumb \{[^}]*white-space: nowrap/);
  // The one height adjustment is scoped to a header that actually carries a breadcrumb, so a
  // top-level screen (dashboard, customers, settings) keeps the untouched padding.
  assert.match(layout, /\.app-header:has\(\.app-breadcrumb\) \{ padding-block: var\(--space-1\); \}/);
  const headerBlock = layout.slice(layout.indexOf('.app-header {'), layout.indexOf('}', layout.indexOf('.app-header {')));
  assert.match(headerBlock, /min-height: var\(--header-height\)/, 'the header keeps its approved min-height');
  assert.equal(/(?<!min-)(?<!max-)\bheight:/.test(headerBlock), false, 'no fixed height is forced on the header');
  // Nothing is hidden to make the height fit.
  assert.equal(/\.app-breadcrumb[^{]*\{[^}]*display:\s*none/.test(layout), false);
});

function rowById(rows, id) {
  return Array.isArray(rows) ? rows.find((row) => row.Id === id) || null : null;
}
