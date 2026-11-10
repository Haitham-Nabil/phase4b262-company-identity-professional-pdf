import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Phase 4B.26.2 stores company name as an additive setting without schema migration', async () => {
  const defaults = await read('src/storage/defaults.js');
  const schema = await read('src/storage/schema.js');
  const service = await read('src/services/settingsService.js');
  assert.match(defaults, /COMPANY_NAME:\s*'CompanyName'/);
  assert.match(defaults, /Key:\s*SETTING_KEYS\.COMPANY_NAME/);
  assert.match(service, /async getCompanyName\(/);
  assert.match(service, /async setCompanyName\(/);
  assert.match(service, /اسم الشركة مطلوب/);
  assert.match(schema, /DB_VERSION = 5/);
});

test('Phase 4B.26.2 exposes company name in settings and sidebar', async () => {
  const settings = await read('ui/views/settings.js');
  const app = await read('ui/app.js');
  assert.match(settings, /settings-company-form/);
  assert.match(settings, /سيظهر الاسم أعلى القائمة الجانبية وفي التقارير المطبوعة/);
  assert.match(app, /companyName/);
  assert.match(app, /app-sidebar__title strong/);
});

test('Phase 4B.26.2 print output uses company identity and statement-specific columns', async () => {
  const exporter = await read('ui/views/reportExport.js');
  const reports = await read('ui/views/reportCustomers.js');
  const css = await read('ui/styles/base.css');
  for (const token of ['report-print-company', 'report-print-title', 'report-print-info', 'settingsService.getCompanyName']) assert.ok(exporter.includes(token));
  for (const token of ['رقم / معرّف الحركة', 'التصنيف', 'الطرف', 'الرصيد', 'customerStatementPrintBlock']) assert.ok(reports.includes(token));
  assert.match(css, /@page \{ size: A4 landscape/);
  assert.match(css, /table-header-group/);
  assert.match(css, /page-break-inside: avoid/);
});
