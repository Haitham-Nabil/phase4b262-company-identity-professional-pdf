import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCsv } from '../ui/views/reportExport.js';

test('CSV export starts with UTF-8 BOM and uses semicolon-delimited columns and CRLF rows', () => {
  const csv = buildCsv([{ headers: ['التاريخ', 'البيان', 'مدين'], rows: [['2026-11-01', 'شراء مبيدات', '1,250.00']] }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /التاريخ;البيان;مدين/);
  assert.match(csv, /2026-11-01;شراء مبيدات;1250/);
  assert.ok(csv.includes('\r\n'));
});

test('CSV export quotes delimiters, quotes and line breaks without breaking columns', () => {
  const csv = buildCsv([{ headers: ['البيان', 'القيمة'], rows: [['صنف; ممتاز "أ"', '20.00']] }]);
  assert.match(csv, /"صنف; ممتاز ""أ""";20/);
});

test('CSV export neutralizes formula-like text but keeps numeric negative values numeric', () => {
  const csv = buildCsv([{ headers: ['البيان', 'رصيد'], rows: [['=1+1', '-125.50']] }]);
  assert.match(csv, /'=1\+1;-125\.5/);
});

test('all four report families expose independent CSV and browser-print actions', async () => {
  const [{ reportsViewHtml }, { cropReportViewHtml }, { generalReportViewHtml }, { customerReportViewHtml }] = await Promise.all([
    import('../ui/views/reports.js'),
    import('../ui/views/reportCropLocal.js'),
    import('../ui/views/reportGeneral.js'),
    import('../ui/views/reportCustomers.js')
  ]);
  for (const html of [reportsViewHtml(), cropReportViewHtml(), generalReportViewHtml(), customerReportViewHtml()]) {
    assert.match(html, /data-report-export-action="csv"/);
    assert.match(html, /data-report-export-action="print"/);
  }
});
