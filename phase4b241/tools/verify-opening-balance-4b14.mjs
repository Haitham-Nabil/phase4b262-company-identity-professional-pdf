// Phase 4B.14 — real-browser verification of the opening balance flow.
// Chromium + real IndexedDB + the real app bundle served statically. No mocks: every
// check reads either the rendered DOM or the database through the app's own services.
import { chromium } from '/home/user/browser-tools/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = '/home/user/work/phase3-customer-accounts';
const OUT = '/home/user/browser-proof-4b14';
const PORT = 8901;
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
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((resolve) => server.listen(PORT, resolve));

const results = [];
const shots = [];
const pageErrors = [];
const check = (id, title, ok, detail = '') => {
  results.push({ id, title, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${title}${detail ? ` :: ${detail}` : ''}`);
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'ar-EG' });
const page = await context.newPage();
page.on('pageerror', (error) => pageErrors.push(String(error && error.message)));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) pageErrors.push(`console: ${m.text()}`); });

const shot = async (name) => { await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true }); shots.push(`${name}.png`); };

// Seed through the application's own service layer inside the page.
async function seed() {
  return page.evaluate(async () => {
    const { customerService } = await import('/src/services/customerService.js');
    const { transactionService } = await import('/src/services/transactionService.js');
    const customers = await customerService.listCustomers();
    if (customers.length) return customers[0].Id;
    const customer = await customerService.createCustomer({ Code: 'OB-BROWSER', Name: 'مزارع الفراولة', Phone: '01001234567', Region: 'المنوفية', OpeningBalance: 1000 });
    await transactionService.createTransaction({ CustomerId: customer.Id, Date: '2026-09-01', TransactionType: 'CashReceived', Amount: 500, Description: 'دفعة نقدية' });
    return customer.Id;
  });
}

const readDb = () => page.evaluate(async () => {
  const { customerService } = await import('/src/services/customerService.js');
  const { balanceService } = await import('/src/services/balanceService.js');
  const { openingBalanceRepository } = await import('/src/repositories/openingBalanceRepository.js');
  const customers = await customerService.listCustomers();
  const customer = customers[0];
  const history = await customerService.listOpeningBalanceHistory(customer.Id);
  const summary = await balanceService.getCustomerSummary(customer.Id);
  return {
    opening: customer.OpeningBalanceMinor,
    balance: summary.BalanceMinor,
    credit: summary.TotalCreditMinor,
    debit: summary.TotalDebitMinor,
    historyCount: history.length,
    history: history.map((row) => ({ old: row.OldValueMinor, next: row.NewValueMinor, reason: row.Reason, at: row.ChangedAt })),
    total: await openingBalanceRepository.count()
  };
});

try {
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#app .app-shell, #app .page-header', { timeout: 15000 });

  const customerId = await seed();
  const before = await readDb();
  check('A1', 'the database starts with the seeded opening balance and one movement', before.opening === 100000 && before.historyCount === 0, `opening=${before.opening} history=${before.historyCount}`);

  await page.evaluate((id) => { window.location.hash = `#/customer/${id}`; }, customerId);
  await page.waitForSelector('[data-action="open-opening-balance"]', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('#account-region[aria-busy="true"]'), null, { timeout: 15000 });

  const entryPoints = await page.locator('[data-action="open-opening-balance"]').count();
  check('A2', 'an entry point to the opening balance editor is on the customer page', entryPoints >= 2, `count=${entryPoints}`);

  const dir = await page.getAttribute('html', 'dir');
  check('A3', 'the page is still RTL Arabic', dir === 'rtl', `dir=${dir}`);

  await page.locator('#account-region [data-action="open-opening-balance"]').first().click();
  await page.waitForSelector('#dialog-opening-balance:not([hidden])', { timeout: 5000 });
  const dialogText = await page.locator('#dialog-opening-balance').innerText();
  check('A4', 'the dialog opens showing the current opening balance', dialogText.includes('1,000.00'), dialogText.replace(/\s+/g, ' ').slice(0, 120));
  await shot('01-dialog-open-1440');

  // --- empty reason is refused, nothing written ---
  await page.fill('#opening-balance-new-value', '1500');
  await page.fill('#opening-balance-reason', '   ');
  await page.click('#opening-balance-form button[type="submit"]');
  await page.waitForTimeout(400);
  const afterBadReason = await readDb();
  const badReasonText = await page.locator('#dialog-opening-balance').innerText();
  check('A5', 'a whitespace-only reason is refused and nothing is written', afterBadReason.opening === 100000 && afterBadReason.total === 0 && badReasonText.includes('سبب تعديل'), `opening=${afterBadReason.opening} rows=${afterBadReason.total}`);

  // --- review step, then cancel without saving ---
  await page.fill('#opening-balance-reason', 'تصحيح بعد الجرد');
  await page.click('#opening-balance-form button[type="submit"]');
  await page.waitForSelector('#opening-balance-review', { timeout: 5000 });
  const reviewText = await page.locator('#opening-balance-review').innerText();
  const reviewOk = reviewText.includes('1,000.00') && reviewText.includes('1,500.00') && reviewText.includes('زيادة بمقدار 500.00') && reviewText.includes('تصحيح بعد الجرد');
  check('A6', 'the review shows the old value, the new value, the delta and the reason', reviewOk, reviewText.replace(/\s+/g, ' ').slice(0, 200));
  await shot('02-review-1440');

  await page.click('[data-action="close-opening-balance"]');
  await page.waitForTimeout(300);
  const afterCancel = await readDb();
  check('A7', 'cancelling before the confirmation changes nothing', afterCancel.opening === 100000 && afterCancel.total === 0, `opening=${afterCancel.opening} rows=${afterCancel.total}`);

  // --- confirm a real save ---
  await page.locator('#account-region [data-action="open-opening-balance"]').first().click();
  await page.waitForSelector('#dialog-opening-balance:not([hidden])');
  await page.fill('#opening-balance-new-value', '1500');
  await page.fill('#opening-balance-reason', 'تصحيح بعد الجرد');
  await page.click('#opening-balance-form button[type="submit"]');
  await page.waitForSelector('#opening-balance-review');
  await page.click('#opening-balance-confirm button[type="submit"]');
  await page.waitForSelector('.alert--success', { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('#account-region[aria-busy="true"]'), null, { timeout: 10000 });

  const afterSave = await readDb();
  const successText = await page.locator('.alert--success').first().innerText();
  check('A8', 'a confirmed save writes one history row and the new opening balance', afterSave.opening === 150000 && afterSave.total === 1 && afterSave.history[0].old === 100000 && afterSave.history[0].next === 150000, `opening=${afterSave.opening} rows=${afterSave.total} old=${afterSave.history[0] && afterSave.history[0].old}`);
  check('A9', 'success is reported only after the service answered', successText.includes('تم حفظ الرصيد الافتتاحي'), successText.replace(/\s+/g, ' ').slice(0, 90));

  const identityOk = afterSave.balance === afterSave.opening + afterSave.credit - afterSave.debit;
  const deltaOk = afterSave.balance - before.balance === 50000;
  check('A10', 'the balance moved by exactly the delta once and still matches opening + credit − debit', identityOk && deltaOk, `before=${before.balance} after=${afterSave.balance} identity=${identityOk}`);

  const cardText = await page.locator('#account-region').innerText();
  const stampOk = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(cardText);
  check('A11', 'the log shows the old value, the new value, the reason and the date with the time', cardText.includes('1,000.00') && cardText.includes('1,500.00') && cardText.includes('تصحيح بعد الجرد') && stampOk, `stampShown=${stampOk}`);
  await shot('03-saved-log-1440');

  // --- reload: the stored value and the stored log come back ---
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-action="open-opening-balance"]', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('#account-region[aria-busy="true"]'));
  const afterReload = await readDb();
  const reloadText = await page.locator('#account-region').innerText();
  check('A12', 'after a reload the saved value and log are the ones stored', afterReload.opening === 150000 && afterReload.total === 1 && reloadText.includes('1,500.00') && reloadText.includes('تصحيح بعد الجرد'), `opening=${afterReload.opening} rows=${afterReload.total}`);

  // --- saving the same value again must not add a row ---
  await page.locator('#account-region [data-action="open-opening-balance"]').first().click();
  await page.waitForSelector('#dialog-opening-balance:not([hidden])');
  await page.fill('#opening-balance-new-value', '1500');
  await page.fill('#opening-balance-reason', 'نفس القيمة');
  await page.click('#opening-balance-form button[type="submit"]');
  await page.waitForSelector('#opening-balance-review');
  const noChangeText = await page.locator('#opening-balance-review').innerText();
  const confirmDisabled = await page.locator('#opening-balance-confirm button[type="submit"]').isDisabled();
  await page.waitForTimeout(200);
  const afterNoChange = await readDb();
  check('A13', 'the same value is reported as no change, with the confirm disabled and no new row', noChangeText.includes('لا يوجد تغيير') && confirmDisabled && afterNoChange.total === 1, `disabled=${confirmDisabled} rows=${afterNoChange.total}`);
  await page.click('[data-action="close-opening-balance"]');

  // --- narrow screen ---
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await shot('04-log-390');
  const narrow = await page.evaluate(() => {
    const doc = document.documentElement;
    const region = document.querySelector('#account-region');
    return { overflow: doc.scrollWidth - doc.clientWidth, regionOverflow: region ? region.scrollWidth - region.clientWidth : 0 };
  });
  check('A14', 'the log does not overflow a 390px screen', narrow.overflow <= 1 && narrow.regionOverflow <= 1, `page=${narrow.overflow} region=${narrow.regionOverflow}`);

  await page.locator('#account-region [data-action="open-opening-balance"]').first().click();
  await page.waitForSelector('#dialog-opening-balance:not([hidden])');
  await page.waitForTimeout(300);
  await shot('05-dialog-390');
  const modalBox = await page.evaluate(() => {
    const modal = document.querySelector('#dialog-opening-balance .modal');
    const rect = modal.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: window.innerWidth, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  const modalInside = modalBox.left >= -1 && modalBox.right <= modalBox.width + 1;
  check('A15', 'the dialog stays inside a 390px screen and does not create a horizontal scroll', modalInside && modalBox.overflowX <= 1, `left=${Math.round(modalBox.left)} right=${Math.round(modalBox.right)} vw=${modalBox.width} overflow=${modalBox.overflowX}`);

  const reasonInputRtl = await page.evaluate(() => {
    const input = document.querySelector('#opening-balance-reason');
    const style = getComputedStyle(input);
    return { direction: style.direction, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  check('A16', 'the inputs follow the RTL direction on the narrow screen', reasonInputRtl.direction === 'rtl' && reasonInputRtl.overflow <= 1, `direction=${reasonInputRtl.direction} overflow=${reasonInputRtl.overflow}`);
  await page.click('[data-action="close-opening-balance"]');

  check('A17', 'no uncaught page error and no console error during the whole run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (error) {
  check('A0', 'the scenario ran to completion', false, String(error && error.message));
} finally {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nSUMMARY ${passed}/${results.length} PASS · shots: ${shots.join(', ')}`);
  await browser.close();
  server.close();
  if (passed !== results.length) process.exitCode = 1;
}
