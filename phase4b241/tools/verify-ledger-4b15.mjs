// Phase 4B.15 — real-browser verification of the central ledger screen.
//
// Chromium + real IndexedDB + the real app served statically. Data is seeded INSIDE the
// page through the application's own services (never into the Node process), so what the
// browser reads is what was actually written to the browser's database.
import playwright from '/home/user/browser-tools/node_modules/playwright/index.js';
const { chromium } = playwright;
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = '/home/user/work/phase3-customer-accounts';
const OUT = '/home/user/work/4b15-proof';
const PORT = 8921;
const BASE = `http://127.0.0.1:${PORT}`;
await mkdir(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, BASE).pathname);
  const target = path === '/' ? '/index.html' : path;
  try {
    const body = await readFile(join(ROOT, target));
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((resolve) => server.listen(PORT, resolve));

const results = [];
const check = (id, title, ok, detail = '') => {
  results.push({ id, title, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${title}${detail ? ` :: ${detail}` : ''}`);
};
async function step(id, title, fn) {
  try { const detail = await fn(); check(id, title, true, typeof detail === 'string' ? detail : ''); }
  catch (error) { check(id, title, false, (error && error.message ? error.message : String(error)).slice(0, 300)); }
}

const pageErrors = [];
const consoleErrors = [];
const failedRequests = [];
let browser = null;

try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'ar-EG' });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) consoleErrors.push(m.text()); });
  page.on('requestfailed', (r) => { if (!/favicon/i.test(r.url())) failedRequests.push(r.url()); });

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // ---- seed through the app's own services, inside the page ----
  const seed = await page.evaluate(async () => {
    const { customerService } = await import('/src/services/customerService.js');
    const { transactionService } = await import('/src/services/transactionService.js');
    const { debtTransferService } = await import('/src/services/debtTransferService.js');
    const { cancellationService } = await import('/src/services/cancellationService.js');
    const { receivingCompanyService, cartonTypeService, strawberryVarietyService } = await import('/src/services/referenceDataService.js');
    const { settingsService } = await import('/src/services/settingsService.js');

    const existing = await customerService.listCustomers();
    if (existing.length) return { skipped: true, customers: existing.length };

    const a = await customerService.createCustomer({ Code: 'C-100', Name: 'أحمد المصري', OpeningBalance: 1000 });
    const b = await customerService.createCustomer({ Code: 'C-200', Name: 'شركة الدلتا', OpeningBalance: 0 });
    const D = '2026-09-10';
    const mk = (over) => transactionService.createTransaction({ CustomerId: a.Id, Date: D, ...over });

    await mk({ TransactionType: 'SalePesticides', Amount: 500, Description: 'مبيدات حشرية' });
    await mk({ TransactionType: 'SaleIrrigation', Amount: 300, Description: 'شبكة ري' });
    await transactionService.createTransaction({ CustomerId: b.Id, Date: D, TransactionType: 'SalesReturn', Amount: 100, Description: 'مرتجع بضاعة' });
    await mk({ TransactionType: 'CashReceived', Amount: 200, Description: 'استلام نقدية' });
    await mk({ TransactionType: 'CashPaid', Amount: 150, Description: 'دفعة نقدية' });
    await transactionService.createTransaction({ CustomerId: b.Id, Date: D, TransactionType: 'Settlement', Amount: 120, Direction: 'Credit', Description: 'تسوية جزئية' });
    await transactionService.createTransaction({ CustomerId: b.Id, Date: D, TransactionType: 'GoodsExchange', Amount: 80, Direction: 'Debit', Description: 'تبادل بضائع' });

    const company = await receivingCompanyService.create('شركة الكابتن');
    const cartonType = await cartonTypeService.create('كرتونة فراولة فريش');
    await transactionService.createTransaction({
      CustomerId: a.Id, Date: '2026-09-18', TransactionType: 'CropPurchaseCarton',
      Description: 'مشتريات كرتون', ReceivingCompanyId: company.Id, CartonTypeId: cartonType.Id,
      crop: { CartonQuantityMilli: 250000, CartonUnitPriceMinor: 1000, CartonDiscountMinor: 0 }
    });
    const variety = await strawberryVarietyService.create('فيرتونا');
    await transactionService.createTransaction({
      CustomerId: a.Id, Date: '2026-09-19', TransactionType: 'CropPurchaseLocal',
      Description: 'مشتريات محصول محلي',
      crop: { StrawberryVarietyId: variety.Id, LocalUnitsMilli: 25000, LocalLooseKgMilli: 0, LocalDeductionKgMilli: 0, LocalUnitPriceMinor: 700 }
    });
    const cancelled = await mk({ TransactionType: 'CashReceived', Amount: 70, Description: 'استلام ملغى' });
    await cancellationService.cancelTransaction(cancelled.Id, 'خطأ في الإدخال');
    const transfer = await debtTransferService.createDebtTransfer({ FromCustomerId: a.Id, ToCustomerId: b.Id, Amount: 400, Date: '2026-09-17', Description: 'تحويل مديونية' });

    const { balanceService } = await import('/src/services/balanceService.js');
    const balances = {};
    for (const c of await customerService.listCustomers()) balances[c.Code] = (await balanceService.getCustomerSummary(c.Id)).BalanceMinor;
    const weight = await settingsService.getDefaultPackageWeight();
    return { skipped: false, aId: a.Id, bId: b.Id, linkId: transfer.LinkId, balances, weight };
  });
  console.log(`SEED=${JSON.stringify(seed)}`);

  await page.goto(`${BASE}/#/transactions`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const box = document.querySelector('#ledger-results');
    return box && !box.querySelector('.spinner') && box.querySelector('table');
  }, null, { timeout: 25000 });
  await page.waitForTimeout(400);

  const bodyRows = () => page.locator('#ledger-results tbody tr').count();
  const totals = () => page.locator('#ledger-totals-line').innerText();
  const settle = () => page.waitForTimeout(420);

  await step('A1', 'الشاشة تُحمَّل وتعرض كل الحركات', async () => {
    const count = await bodyRows();
    if (count !== 11) throw new Error(`expected 11 ledger rows, got ${count}`);
    const text = await totals();
    if (!text.includes('11')) throw new Error(text);
    return `${count} صفًا · ${text.trim()}`;
  });
  await step('A2', 'الصفحة عربية RTL والحقول عربية', async () => {
    const info = await page.evaluate(() => ({ dir: document.documentElement.getAttribute('dir'), lang: document.documentElement.getAttribute('lang') }));
    if (info.dir !== 'rtl' || info.lang !== 'ar') throw new Error(JSON.stringify(info));
    return 'lang=ar dir=rtl';
  });
  await step('A3', 'كل أنواع الحركات العشرة موجودة في السجل', async () => {
    const types = await page.locator('#ledger-results tbody tr td:nth-child(2)').allInnerTexts();
    const wanted = ['بيع مبيدات', 'بيع شبكات ري', 'مرتجع مبيعات', 'مشتريات محصول محلي', 'مشتريات كرتون', 'استلام نقدية', 'دفعة نقدية', 'تسوية', 'تبادل بضائع', 'تحويل مديونية'];
    const unique = new Set(types.map((t) => t.trim()));
    for (const label of wanted) if (!unique.has(label)) throw new Error(`missing ${label} in ${[...unique].join('|')}`);
    return `${unique.size} نوعًا`;
  });
  await step('A4', 'تحويل المديونية يظهر مرة واحدة ويسمّي الطرفين', async () => {
    const rows = page.locator('#ledger-results tbody tr', { hasText: 'تحويل مديونية' });
    const count = await rows.count();
    if (count !== 1) throw new Error(`expected 1 transfer row, got ${count}`);
    const text = await rows.first().innerText();
    if (!text.includes('أحمد') || !text.includes('الدلتا')) throw new Error(text.replace(/\s+/g, ' '));
    if (!text.includes('الطرفان')) throw new Error('no parties line');
    return text.replace(/\s+/g, ' ').slice(0, 100);
  });
  await step('A5', 'البحث باسم العميل يصفّي فورًا', async () => {
    await page.fill('#ledger-search', 'الدلتا');
    await settle();
    const count = await bodyRows();
    if (count !== 4) throw new Error(`expected 4 rows, got ${count}`);
    return `${count} صفوف`;
  });
  await step('A6', 'البحث بكود العميل يعمل', async () => {
    await page.fill('#ledger-search', 'C-100');
    await settle();
    const count = await bodyRows();
    // 6 standalone rows of C-100 + the single transfer row, which names C-100 as a party.
    // 7 standalone rows of C-100 + the single transfer row naming C-100 as a party.
    if (count !== 8) throw new Error(`expected 8 rows, got ${count}`);
    return `${count} صفوف`;
  });
  await step('A7', 'البحث في البيان يعمل', async () => {
    await page.fill('#ledger-search', 'مرتجع');
    await settle();
    const count = await bodyRows();
    if (count !== 1) throw new Error(`expected 1 row, got ${count}`);
    const text = await page.locator('#ledger-results tbody tr').first().innerText();
    if (!text.includes('مرتجع بضاعة')) throw new Error(text.replace(/\s+/g, ' '));
    return `1 صف — ${text.replace(/\s+/g, ' ').slice(0, 60)}`;
  });
  await step('A8', 'فلتر النوع يعمل', async () => {
    await page.fill('#ledger-search', '');
    await settle();
    await page.selectOption('#ledger-type', 'CropPurchaseCarton');
    await settle();
    const count = await bodyRows();
    if (count !== 1) throw new Error(`expected 1 row, got ${count}`);
    return '1 صف كرتون';
  });
  await step('A9', 'فلتر الحالة يعرض الملغاة فقط', async () => {
    await page.selectOption('#ledger-type', '');
    await settle();
    await page.selectOption('#ledger-status', 'Cancelled');
    await settle();
    const count = await bodyRows();
    if (count !== 1) throw new Error(`expected 1 row, got ${count}`);
    const text = await page.locator('#ledger-results tbody tr').first().innerText();
    if (!text.includes('ملغاة')) throw new Error(text.replace(/\s+/g, ' '));
    return '1 صف ملغى';
  });
  await step('A10', 'فلتر التاريخ شامل للطرفين ويرفض النطاق المعكوس', async () => {
    await page.selectOption('#ledger-status', 'all');
    await settle();
    await page.fill('#ledger-from', '2026-09-01');
    await page.fill('#ledger-to', '2026-09-10');
    await settle();
    const count = await bodyRows();
    if (count !== 8) throw new Error(`expected 8 rows in range, got ${count}`);
    await page.fill('#ledger-from', '2026-09-30');
    await page.fill('#ledger-to', '2026-09-01');
    await settle();
    const errorText = await page.locator('#ledger-filter-error').innerText();
    if (!errorText.includes('تاريخ البداية')) throw new Error(`no refusal: ${errorText}`);
    return '8 صفوف ثم رفض النطاق المعكوس';
  });
  await step('A11', 'مسح الفلاتر يعيد كامل السجل', async () => {
    await page.click('[data-ledger-action="reset"]');
    await page.waitForTimeout(650);
    const count = await bodyRows();
    if (count !== 11) throw new Error(`expected 11 rows after reset, got ${count}`);
    if ((await page.inputValue('#ledger-from')) !== '') throw new Error('from not cleared');
    if ((await page.inputValue('#ledger-search')) !== '') throw new Error('search not cleared');
    return '11 صفًا';
  });
  await step('A12', 'تفاصيل حركة محصول محلي تعرض الصنف والعبوات والوزن المحفوظ', async () => {
    await page.selectOption('#ledger-type', 'CropPurchaseLocal');
    await settle();
    await page.locator('#ledger-results tbody tr [data-ledger-action="details"]').first().click();
    await page.waitForTimeout(250);
    if (!(await page.locator('#ledger-details-dialog').isVisible())) throw new Error('dialog not visible');
    const body = (await page.locator('#ledger-details-body').innerText()).replace(/\s+/g, ' ');
    for (const expected of ['فيرتونا', 'عدد العبوات', 'الوزن الصافي', 'وزن العبوة المحفوظ']) {
      if (!body.includes(expected)) throw new Error(`missing "${expected}" :: ${body.slice(0, 200)}`);
    }
    await page.screenshot({ path: join(OUT, '04-details-local-1440.png') });
    await page.click('[data-ledger-action="close-details"]');
    await page.waitForTimeout(200);
    if (await page.locator('#ledger-details-dialog').isVisible()) throw new Error('dialog did not close');
    return body.slice(0, 150);
  });
  await step('A13', 'تفاصيل حركة كرتون تعرض الشركة والنوع والعدد', async () => {
    await page.selectOption('#ledger-type', 'CropPurchaseCarton');
    await settle();
    await page.locator('#ledger-results tbody tr [data-ledger-action="details"]').first().click();
    await page.waitForTimeout(250);
    const body = (await page.locator('#ledger-details-body').innerText()).replace(/\s+/g, ' ');
    for (const expected of ['الشركة المستلمة', 'شركة الكابتن', 'نوع الكرتونة', 'كرتونة فراولة فريش', 'عدد الكراتين', '250 كرتونة']) {
      if (!body.includes(expected)) throw new Error(`missing "${expected}" :: ${body.slice(0, 220)}`);
    }
    await page.click('[data-ledger-action="close-details"]');
    await page.selectOption('#ledger-type', '');
    await settle();
    return body.slice(0, 150);
  });
  await step('A14', 'الرصيد بعد كل عمليات العرض لم يتغيّر', async () => {
    const after = await page.evaluate(async () => {
      const { balanceService } = await import('/src/services/balanceService.js');
      const { customerService } = await import('/src/services/customerService.js');
      const out = {};
      for (const c of await customerService.listCustomers()) out[c.Code] = (await balanceService.getCustomerSummary(c.Id)).BalanceMinor;
      return out;
    });
    const before = seed.balances;
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    return `قبل=${JSON.stringify(before)} بعد=${JSON.stringify(after)}`;
  });
  await step('A15', 'عدد الحركات المخزنة لم يتغيّر بالعرض أو التصفية', async () => {
    const counts = await page.evaluate(async () => {
      const { transactionRepository } = await import('/src/repositories/transactionRepository.js');
      return transactionRepository.count();
    });
    if (counts !== 12) throw new Error(`expected 12 stored rows, got ${counts}`);
    return `${counts} صفًا مخزّنًا (تحويلان = صف واحد معروض)`;
  });
  await step('A16', 'لا تجاوز أفقي على سطح المكتب', async () => {
    const box = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
    if (box.doc > box.win + 1) throw new Error(JSON.stringify(box));
    return `scrollWidth=${box.doc} innerWidth=${box.win}`;
  });
  await page.screenshot({ path: join(OUT, '01-ledger-1440.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await step('A17', 'شاشة 390px بلا تمرير أفقي', async () => {
    const box = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
    if (box.doc > box.win + 1) throw new Error(JSON.stringify(box));
    return `scrollWidth=${box.doc} innerWidth=${box.win}`;
  });
  await step('A18', 'الجدول يلتف داخل حاويته على 390px', async () => {
    const box = await page.evaluate(() => {
      const el = document.querySelector('#ledger-results .table-wrapper');
      return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: getComputedStyle(el).overflowX } : null;
    });
    if (!box) throw new Error('no table wrapper');
    if (box.overflowX !== 'auto') throw new Error(JSON.stringify(box));
    return JSON.stringify(box);
  });
  await page.screenshot({ path: join(OUT, '02-ledger-390.png'), fullPage: true });
  // The 390px check opens the dialog from the unfiltered first row, exactly the path the
  // desktop checks already proved, then measures its geometry on the narrow screen.
  await page.selectOption('#ledger-type', 'CropPurchaseCarton');
  await settle();
  await page.locator('#ledger-results tbody tr [data-ledger-action="details"]').first().click();
  await page.waitForFunction(() => {
    const d = document.querySelector('#ledger-details-dialog');
    return d && !d.hasAttribute('hidden');
  }, null, { timeout: 8000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(OUT, '03-details-390.png') });
  await step('A19', 'الحوار داخل شاشة 390px', async () => {
    if (!(await page.locator('#ledger-details-dialog').isVisible())) {
      const diag = await page.evaluate(() => {
        const d = document.querySelector('#ledger-details-dialog');
        return { hidden: d ? d.hasAttribute('hidden') : 'missing', rows: document.querySelectorAll('#ledger-results tbody tr').length, body: (document.querySelector('#ledger-details-body') || {}).innerHTML ? 'has-body' : 'empty' };
      });
      throw new Error(`dialog not visible :: ${JSON.stringify(diag)}`);
    }
    const box = await page.locator('#ledger-details-dialog .modal').boundingBox();
    if (!box || box.width > 390) throw new Error(JSON.stringify(box));
    return `width=${Math.round(box.width)} height=${Math.round(box.height)}`;
  });
  await page.click('[data-ledger-action="close-details"]');
  await page.waitForTimeout(200);

  await step('A20', 'لا أخطاء JavaScript ولا موارد مفقودة', async () => {
    if (pageErrors.length) throw new Error(`pageerror: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length) throw new Error(`console: ${consoleErrors.join(' | ')}`);
    if (failedRequests.length) throw new Error(`requests: ${failedRequests.join(' | ')}`);
    return '0 خطأ صفحة · 0 خطأ console · 0 مورد مفقود';
  });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nSUMMARY ${passed}/${results.length} PASS`);
} finally {
  if (browser) await browser.close();
  server.close();
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
