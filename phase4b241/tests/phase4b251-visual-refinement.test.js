import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chartHtml, cropHtml } from '../ui/views/dashboard.js';

const sampleSeries = {
  HasCashFlow: true,
  TotalCashInMinor: 125000,
  TotalCashOutMinor: 78000,
  Buckets: [
    { Key: '2026-11-01', Label: '01/11', CashInMinor: 80000, CashOutMinor: 20000 },
    { Key: '2026-11-02', Label: '02/11', CashInMinor: 45000, CashOutMinor: 58000 }
  ]
};

test('Phase 4B.25.1: cash-flow chart exposes readable grid, axis values and distinct cash series', () => {
  const html = chartHtml(sampleSeries);
  assert.match(html, /dash-chart__grid/);
  assert.match(html, /dashCashInGradient/);
  assert.match(html, /dashCashOutGradient/);
  assert.match(html, /التحصيل النقدي/);
  assert.match(html, /المدفوعات النقدية/);
  assert.match(html, /data-bucket="2026-11-01"/);
});

test('Phase 4B.25.1: report selected and pressed controls have explicit high-contrast styles', async () => {
  const css = await readFile(new URL('../ui/styles/components.css', import.meta.url), 'utf8');
  assert.match(css, /button\.btn\[role="tab"\]\[aria-selected="true"\]/);
  assert.match(css, /button\.btn\[aria-pressed="true"\]/);
  assert.match(css, /button\.btn\[role="tab"\]\[aria-selected="false"\]/);
  assert.match(css, /dash-analytics-grid/);
  assert.match(css, /\.toolbar/);
  assert.match(css, /\.table thead th/);
});

test('Phase 4B.25.1: dashboard crop indicators include comparative quantity bars without changing displayed totals', () => {
  const html = cropHtml({ Crop: {
    Local: { MovementCount: 2, PackageCountMilli: 3000, NetWeightMilli: 42000, UnresolvedWeightCount: 0, PackageCountMissingCount: 0, ByVariety: [{ Label: 'فراولة فستيفال', MovementCount: 2, PackageCountMilli: 3000 }] },
    Carton: { MovementCount: 1, CartonQuantityMilli: 1000, MissingQuantityCount: 0, ByCompany: [{ Label: 'شركة التصدير', MovementCount: 1, CartonQuantityMilli: 1000 }], ByCartonType: [{ Label: 'دبل', MovementCount: 1, CartonQuantityMilli: 1000 }] }
  } });
  assert.equal((html.match(/dash-distribution__track/g) || []).length, 3);
  assert.match(html, /فراولة فستيفال/);
  assert.match(html, /شركة التصدير/);
});
