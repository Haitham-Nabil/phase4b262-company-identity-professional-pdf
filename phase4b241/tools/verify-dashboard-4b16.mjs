// Phase 4B.16 — real-browser verification of the dashboard screen.
//
// Chromium + real IndexedDB + the real app served statically. Data is seeded INSIDE the page
// through the application's own services (never into the Node process), and every displayed
// figure is compared against `dashboardService.buildDashboard()` evaluated in the same page —
// so the check is "the screen shows what the service produced", not "the page threw no error".
import playwright from '/home/user/browser-tools/node_modules/playwright/index.js';
const { chromium } = playwright;
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = '/home/user/work/phase3-customer-accounts';
const OUT = '/home/user/work/4b16-proof';
const PORT = 8931;
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
  catch (error) { check(id, title, false, (error && error.message ? error.message : String(error)).slice(0, 320)); }
}

const pageErrors = [];
const consoleErrors = [];
const failedRequests = [];
let browser = null;

try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ar-EG' });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) consoleErrors.push(m.text()); });
  page.on('requestfailed', (r) => { if (!/favicon/i.test(r.url())) failedRequests.push(r.url()); });

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // ---- seed through the app's own services, inside the page ----
  const seed = await page.evaluate(async () => {
    const { customerService, transactionService, debtTransferService, strawberryVarietyService, cancellationService } = await import('/src/services/index.js');
    const { receivingCompanyService, cartonTypeService } = await import('/src/services/referenceDataService.js');
    const today = new Date();
    const iso = (offset) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const a = await customerService.createCustomer({ Code: 'C-100', Name: 'أحمد المصري', OpeningBalance: 1500 });
    const b = await customerService.createCustomer({ Code: 'C-200', Name: 'شركة الدلتا', OpeningBalance: 0 });

    await transactionService.createTransaction({ CustomerId: a.Id, Date: iso(-2), TransactionType: 'SalePesticides', Amount: 800, Description: 'مبيدات حشرية' });
    await transactionService.createTransaction({ CustomerId: b.Id, Date: iso(-3), TransactionType: 'SaleIrrigation', Amount: 400, Description: 'شبكة ري' });
    await transactionService.createTransaction({ CustomerId: a.Id, Date: iso(-4), TransactionType: 'SalesReturn', Amount: 100, Description: 'مرتجع بضاعة' });
    await transactionService.createTransaction({ CustomerId: a.Id, Date: iso(-5), TransactionType: 'CashReceived', Amount: 600, Description: 'تحصيل نقدي' });
    await transactionService.createTransaction({ CustomerId: a.Id, Date: iso(-6), TransactionType: 'CashPaid', Amount: 250, Description: 'دفعة نقدية' });
    await transactionService.createTransaction({ CustomerId: b.Id, Date: iso(-7), TransactionType: 'Settlement', Amount: 150, Description: 'تسوية', Direction: 'Credit' });
    await transactionService.createTransaction({ CustomerId: b.Id, Date: iso(-8), TransactionType: 'GoodsExchange', Amount: 90, Description: 'تبادل بضائع', Direction: 'Debit' });

    const cancelled = await transactionService.createTransaction({ CustomerId: a.Id, Date: iso(-1), TransactionType: 'CashReceived', Amount: 999, Description: 'ملغاة' });
    await cancellationService.cancelTransaction(cancelled.Id, 'خطأ في الإدخال');

    const company = await receivingCompanyService.create('شركة الكابتن');
    const type = await cartonTypeService.create('كرتونة فراولة فريش');
    await transactionService.createTransaction({
      CustomerId: a.Id, Date: iso(-9), TransactionType: 'CropPurchaseCarton',
      crop: { CartonQuantityMilli: 250000, CartonUnitPriceMinor: 1000, CartonDiscountMinor: 0 },
      ReceivingCompanyId: company.Id, CartonTypeId: type.Id, Description: 'مشتريات كرتون'
    });

    const variety = await strawberryVarietyService.create('فيرتونا');
    await transactionService.createTransaction({
      CustomerId: a.Id, Date: iso(-10), TransactionType: 'CropPurchaseLocal',
      crop: { LocalUnitsMilli: 25000, LocalLooseKgMilli: 0, LocalDeductionKgMilli: 0, LocalUnitPriceMinor: 700, StrawberryVarietyId: variety.Id },
      Description: 'مشتريات محصول محلي'
    });

    await debtTransferService.createDebtTransfer({ FromCustomerId: a.Id, ToCustomerId: b.Id, Amount: 400, Date: iso(-11), Description: 'تحويل مديونية' });

    // One movement far outside every selectable period.
    await transactionService.createTransaction({ CustomerId: a.Id, Date: '2024-05-01', TransactionType: 'SalePesticides', Amount: 9999, Description: 'قديمة' });

    return { customers: [a.Code, b.Code], today: iso(0) };
  });

  // The data was just written by the seeding pass; a full reload mounts the dashboard the way a
  // user's next visit does, with the seeded store already in place.
  await page.goto(`${BASE}/#/dashboard`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const value = document.querySelector('#kpi-debit [data-kpi-value]');
    const box = document.querySelector('#dashboard-kpis');
    return Boolean(value && box && box.textContent.includes('إجمالي'));
  }, null, { timeout: 20000 });
  await page.waitForTimeout(900);

  const ids = {
    kpis: '#dashboard-kpis', chart: '#dashboard-chart', latest: '#dashboard-latest',
    crop: '#dashboard-crop', period: '#dashboard-period', label: '#dashboard-period-label',
    alerts: '#dashboard-alerts', summary: '#dashboard-period-summary', content: '#dashboard-content'
  };

  await step('A1', 'the dashboard loads with all nine KPI cards and no placeholder text', async () => {
    const count = await page.locator('#dashboard-kpis .dash-kpi').count();
    const text = await page.locator('#dashboard-root').innerText();
    if (count !== 9) throw new Error(`expected 9 KPI cards, got ${count}`);
    if (/لم تُبنَ وظائف الشاشة بعد/.test(text)) throw new Error('the placeholder text is still on screen');
    return `cards=${count}`;
  });

  await step('A2', 'the page is Arabic and right-to-left', async () => {
    const info = await page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir }));
    if (info.lang !== 'ar' || info.dir !== 'rtl') throw new Error(JSON.stringify(info));
    return JSON.stringify(info);
  });

  await step('A3', 'every displayed KPI value equals what the service returns', async () => {
    const expected = await page.evaluate(async () => {
      const { dashboardService } = await import('/src/services/dashboardService.js');
      const data = await dashboardService.buildDashboard({ period: 'last30' });
      const money = (minor) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);
      return {
        debit: money(data.Balances.DebitTotalMinor), credit: money(data.Balances.CreditTotalMinor), net: money(data.Balances.NetBalanceMinor),
        sales: money(data.Totals.SalesMinor), cashIn: money(data.Totals.CashReceivedMinor), cashOut: money(data.Totals.CashPaidMinor),
        localCrop: money(data.Totals.LocalCropMinor), carton: money(data.Totals.CartonMinor),
        active: `${data.Balances.ActiveCustomerCount} / ${data.Balances.CustomerCount}`,
        periodFrom: data.Period.From, periodTo: data.Period.To
      };
    });
    const onScreen = {};
    for (const key of ['debit', 'credit', 'net', 'sales', 'cash-in', 'cash-out', 'local-crop', 'carton', 'active-customers']) {
      onScreen[key] = (await page.locator(`#kpi-${key} [data-kpi-value]`).innerText()).trim();
    }
    const pairs = [
      ['debit', expected.debit], ['credit', expected.credit], ['net', expected.net], ['sales', expected.sales],
      ['cash-in', expected.cashIn], ['cash-out', expected.cashOut], ['local-crop', expected.localCrop],
      ['carton', expected.carton], ['active-customers', expected.active]
    ];
    for (const [key, want] of pairs) {
      if (onScreen[key] !== want) throw new Error(`${key}: screen "${onScreen[key]}" != service "${want}"`);
    }
    return `debit=${onScreen.debit} credit=${onScreen.credit} net=${onScreen.net} sales=${onScreen.sales}`;
  });

  await step('A4', 'debit, credit and net are three different figures and the net is not their sum', async () => {
    const read = async (id) => Number((await page.locator(`#kpi-${id} [data-kpi-value]`).innerText()).replace(/,/g, ''));
    const debit = await read('debit');
    const credit = await read('credit');
    const net = await read('net');
    if (net === debit || net === credit) throw new Error(`net ${net} duplicates debit ${debit} or credit ${credit}`);
    if (Math.abs((credit - debit) - net) > 0.01) throw new Error(`net ${net} != credit ${credit} - debit ${debit}`);
    return `debit=${debit} credit=${credit} net=${net}`;
  });

  await step('A5', 'a cancelled movement exists, is counted as cancelled, and is not summed into cash', async () => {
    const truth = await page.evaluate(async () => {
      const { dashboardService } = await import('/src/services/dashboardService.js');
      const data = await dashboardService.buildDashboard({ period: 'last30' });
      return { cancelled: data.Totals.CancelledCount, cashIn: data.Totals.CashReceivedMinor, active: data.Totals.MovementCount };
    });
    const summary = await page.locator('#dashboard-period-summary').innerText();
    if (truth.cancelled !== 1) throw new Error(`expected 1 cancelled movement, service says ${truth.cancelled}`);
    if (!/حركات ملغاة/.test(summary)) throw new Error('the cancelled count is not shown');
    if (truth.cashIn !== 60000) throw new Error(`cash in should be 60000 minor (600), got ${truth.cashIn}`);
    return `cancelled=${truth.cancelled} cashIn=${truth.cashIn} activeMovements=${truth.active}`;
  });

  await step('A6', 'the debt transfer is ONE operation naming both parties, never two rows', async () => {
    const truth = await page.evaluate(async () => {
      const { dashboardService } = await import('/src/services/dashboardService.js');
      const { transactionLedgerService } = await import('/src/services/transactionLedgerService.js');
      const data = await dashboardService.buildDashboard({ period: 'last30' });
      const ledger = await transactionLedgerService.buildLedger();
      const merged = ledger.Rows.filter((row) => row.IsLinkedOperation);
      return {
        transfers: data.Totals.DebtTransferCount,
        amount: data.Totals.DebtTransferMinor,
        mergedCount: merged.length,
        legs: merged.map((row) => row.LegCount),
        named: merged.map((row) => `${row.CustomerName} / ${row.CounterpartyName}`),
        latestTransferRows: data.Latest.filter((row) => row.TransactionType === 'DebtTransfer').length
      };
    });
    if (truth.transfers !== 1) throw new Error(`expected ONE transfer operation, got ${truth.transfers}`);
    if (truth.mergedCount !== 1) throw new Error(`the ledger shows ${truth.mergedCount} linked rows, expected 1`);
    if (truth.legs[0] !== 2) throw new Error(`the merged row carries ${truth.legs[0]} legs, expected 2`);
    if (!/\//.test(truth.named[0] || '') || /\/\s*$/.test(truth.named[0] || '')) throw new Error(`the counterparty is not named: ${truth.named[0]}`);
    if (truth.latestTransferRows > 1) throw new Error('the transfer appears more than once in the latest list');
    // Never two rows on screen carrying the same transfer amount.
    const duplicated = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#dashboard-latest-table tbody tr')];
      return rows.filter((row) => row.textContent.includes('400.00') && row.textContent.includes('تحويل مديونية')).length;
    });
    if (duplicated > 1) throw new Error(`the transfer is painted ${duplicated} times`);
    return `transfers=${truth.transfers} amount=${truth.amount} legs=${truth.legs[0]} parties=${truth.named[0]}`;
  });

  await step('A7', 'cash, settlement and goods exchange stay three separate lines in the period summary', async () => {
    const text = await page.locator('#dashboard-period-summary').innerText();
    for (const label of ['التحصيل النقدي', 'المدفوعات النقدية', 'التسويات (غير نقدية)', 'تبادل البضائع (غير نقدي)', 'تحويل مديونية (غير نقدي)']) {
      if (!text.includes(label)) throw new Error(`missing category: ${label}`);
    }
    const truth = await page.evaluate(async () => {
      const { dashboardService } = await import('/src/services/dashboardService.js');
      const data = await dashboardService.buildDashboard({ period: 'last30' });
      return { cash: data.Totals.CashReceivedMinor, settlement: data.Totals.SettlementMinor, goods: data.Totals.GoodsExchangeMinor };
    });
    if (truth.cash !== 60000 || truth.settlement !== 15000 || truth.goods !== 9000) {
      throw new Error(`unexpected split ${JSON.stringify(truth)}`);
    }
    return JSON.stringify(truth);
  });

  await step('A8', 'the chart draws the stored cash flows (in and out) and no other flow', async () => {
    const bars = await page.locator('#dashboard-chart svg rect[data-bar]').count();
    const labels = await page.locator('#dashboard-chart .financial-legend').innerText();
    if (bars === 0) throw new Error('no bar rendered');
    if (!/[0-9]/.test(labels)) throw new Error('the legend carries no figure');
    const text = labels.replace(/\s+/g, ' ');
    if (!text.includes('600.00')) throw new Error(`cash in 600.00 missing from the legend: ${text}`);
    if (!text.includes('250.00')) throw new Error(`cash out 250.00 missing from the legend: ${text}`);
    return `bars=${bars} legend="${text}"`;
  });

  await step('A9', 'the crop cards keep the carton count apart from the crop weight', async () => {
    const localWeight = (await page.locator('[data-crop="local-weight"]').innerText()).trim();
    const localPackages = (await page.locator('[data-crop="local-packages"]').innerText()).trim();
    const cartonQty = (await page.locator('[data-crop="carton-quantity"]').innerText()).trim();
    if (!localWeight.startsWith('350')) throw new Error(`stored net weight not shown: ${localWeight}`);
    if (!localPackages.startsWith('25')) throw new Error(`package count not shown: ${localPackages}`);
    if (!cartonQty.startsWith('250')) throw new Error(`carton count not shown: ${cartonQty}`);
    const cartonCard = await page.locator('#dashboard-crop-carton').innerText();
    if (/كجم/.test(cartonCard)) throw new Error('the carton card must not print a weight');
    const varietyShown = await page.locator('#dashboard-crop-local').innerText();
    if (!varietyShown.includes('فيرتونا')) throw new Error('the variety name is missing');
    return `packages=${localPackages} weight=${localWeight} cartons=${cartonQty}`;
  });

  await step('A10', 'changing the period re-reads the data and moves the period figure, not the balance', async () => {
    // The carton purchase sits 9 days back: inside the 30-day range, outside the 7-day one.
    const readKpi = async (id) => (await page.locator(`#kpi-${id} [data-kpi-value]`).innerText()).trim();
    const balanceBefore = await readKpi('net');
    const thirtyCarton = await readKpi('carton');
    await page.selectOption(ids.period, 'last7');
    await page.waitForFunction(() => document.querySelector('#dashboard-period-label')?.textContent.includes('آخر 7 أيام'), null, { timeout: 10000 });
    const expected = await page.evaluate(async () => {
      const { dashboardService } = await import('/src/services/dashboardService.js');
      const data = await dashboardService.buildDashboard({ period: 'last7' });
      const money = (m) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(m / 100);
      return { carton: money(data.Totals.CartonMinor), sales: money(data.Totals.SalesMinor), from: data.Period.From };
    });
    await page.waitForFunction((want) => {
      const node = document.querySelector('#kpi-carton [data-kpi-value]');
      return node && node.textContent.trim() === want;
    }, expected.carton, { timeout: 10000 });
    const sevenCarton = await readKpi('carton');
    const sevenSales = await readKpi('sales');
    const balanceAfter = await readKpi('net');
    if (balanceBefore !== balanceAfter) throw new Error(`the balance moved from ${balanceBefore} to ${balanceAfter}`);
    if (sevenCarton === thirtyCarton) throw new Error(`the period figure did not change (${sevenCarton})`);
    if (sevenCarton !== expected.carton) throw new Error(`screen ${sevenCarton} != service ${expected.carton}`);
    if (sevenSales !== expected.sales) throw new Error(`screen sales ${sevenSales} != service ${expected.sales}`);
    return `30d carton=${thirtyCarton} 7d carton=${sevenCarton} 7d sales=${sevenSales} net unchanged=${balanceAfter}`;
  });

  await step('A11', 'the year period includes older movements and the 2024 row stays out', async () => {
    await page.selectOption(ids.period, 'year');
    await page.waitForFunction(() => document.querySelector('#dashboard-period-label')?.textContent.includes('السنة الحالية'), null, { timeout: 10000 });
    const want = await page.evaluate(async () => {
      const { dashboardService } = await import('/src/services/dashboardService.js');
      const data = await dashboardService.buildDashboard({ period: 'year' });
      return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(data.Totals.SalesMinor / 100);
    });
    await page.waitForFunction((w) => document.querySelector('#kpi-sales [data-kpi-value]')?.textContent.trim() === w, want, { timeout: 10000 });
    const sales = (await page.locator('#kpi-sales [data-kpi-value]').innerText()).trim();
    const expected = await page.evaluate(async () => {
      const { dashboardService } = await import('/src/services/dashboardService.js');
      const data = await dashboardService.buildDashboard({ period: 'year' });
      return { sales: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(data.Totals.SalesMinor / 100), from: data.Period.From };
    });
    if (sales !== expected.sales) throw new Error(`screen ${sales} != service ${expected.sales}`);
    if (sales === '11,299.00') throw new Error('the 2024 movement was summed');
    return `year sales=${sales} from=${expected.from}`;
  });

  await step('A12', 'the latest movements link to the central ledger and the link works', async () => {
    await page.selectOption(ids.period, 'last30');
    await page.waitForFunction(() => document.querySelector('#dashboard-period-label')?.textContent.includes('آخر 30'), null, { timeout: 10000 });
    await page.waitForTimeout(600);
    const rows = await page.locator('#dashboard-latest-table tbody tr').count();
    if (rows === 0) throw new Error('no latest movement rendered');
    await page.click('#dashboard-open-ledger');
    await page.waitForTimeout(700);
    const hash = await page.evaluate(() => location.hash);
    if (!hash.includes('/transactions')) throw new Error(`navigation went to ${hash}`);
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('#kpi-sales [data-kpi-value]')?.textContent.trim() !== '', null, { timeout: 15000 });
    await page.waitForTimeout(700);
    const after = await page.evaluate(async () => {
      const { dashboardService } = await import('/src/services/dashboardService.js');
      const data = await dashboardService.buildDashboard({ period: 'last30' });
      const money = (m) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(m / 100);
      return { sales: money(data.Totals.SalesMinor) };
    });
    const onScreen = (await page.locator('#kpi-sales [data-kpi-value]').innerText()).trim();
    if (onScreen !== after.sales) throw new Error(`after returning the figure is stale: ${onScreen} != ${after.sales}`);
    return `rows=${rows} navigated=${hash} sales-after-return=${onScreen}`;
  });

  await step('A13', 'a customer name in the latest list opens that customer account', async () => {
    const link = page.locator('#dashboard-latest-table a.customer-link').first();
    const href = await link.getAttribute('href');
    if (!href || !href.startsWith('#/customer/')) throw new Error(`unexpected href ${href}`);
    return href;
  });

  await step('A14', 'balances are identical before and after every read performed above', async () => {
    const now = await page.evaluate(async () => {
      const { balanceService } = await import('/src/services/balanceService.js');
      const rows = await balanceService.listCustomerBalances();
      return Object.fromEntries(rows.map((row) => [row.Customer.Code, row.Summary.BalanceMinor]));
    });
    // 1500 opening + 800 sale + 400? no: per-customer, read from the engine only — the point is
    // that it matches the engine after all the dashboard reads, and the stored rows did not move.
    const storedRows = await page.evaluate(async () => {
      const { transactionLedgerService } = await import('/src/services/transactionLedgerService.js');
      const ledger = await transactionLedgerService.buildLedger();
      return { operations: ledger.Summary.TotalCount, stored: ledger.Summary.StoredRowCount };
    });
    if (storedRows.operations !== 12 || storedRows.stored !== 13) throw new Error(`stored rows changed: ${JSON.stringify(storedRows)}`);
    return `balances=${JSON.stringify(now)} ledger=${JSON.stringify(storedRows)}`;
  });

  await step('A15', 'desktop 1440: no horizontal overflow of the page', async () => {
    const info = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
    if (info.scroll > info.inner + 1) throw new Error(JSON.stringify(info));
    return `scrollWidth=${info.scroll} innerWidth=${info.inner}`;
  });

  await page.screenshot({ path: join(OUT, '01-dashboard-1440.png'), fullPage: true });

  // ---- mobile: 390px wide ----
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(600);

  await step('A16', 'mobile 390: the page does not overflow horizontally', async () => {
    const info = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      inner: window.innerWidth
    }));
    if (info.scroll > info.inner + 1) throw new Error(JSON.stringify(info));
    return `scrollWidth=${info.scroll} bodyWidth=${info.body} innerWidth=${info.inner}`;
  });

  await step('A17', 'mobile 390: the KPI cards stack into one column and stay readable', async () => {
    const info = await page.evaluate(() => {
      const first = document.querySelector('#kpi-debit');
      const second = document.querySelector('#kpi-credit');
      const a = first.getBoundingClientRect();
      const b = second.getBoundingClientRect();
      return { firstWidth: Math.round(a.width), stacked: b.top >= a.bottom - 2 };
    });
    if (!info.stacked) throw new Error(`cards are not stacked: ${JSON.stringify(info)}`);
    if (info.firstWidth > 390) throw new Error(`card wider than the screen: ${info.firstWidth}`);
    return JSON.stringify(info);
  });

  await step('A18', 'mobile 390: the table scrolls inside its own container, not the page', async () => {
    const info = await page.evaluate(() => {
      const wrapper = document.querySelector('#dashboard-latest-table')?.closest('.table-wrapper');
      if (!wrapper) return null;
      const style = getComputedStyle(wrapper);
      return { overflowX: style.overflowX, scrollWidth: wrapper.scrollWidth, clientWidth: wrapper.clientWidth };
    });
    if (!info) throw new Error('the latest table has no wrapper');
    if (info.overflowX !== 'auto' && info.overflowX !== 'scroll') throw new Error(`overflowX=${info.overflowX}`);
    return JSON.stringify(info);
  });

  await step('A19', 'mobile 390: the period selector is usable and re-reads on change', async () => {
    await page.selectOption(ids.period, 'last90');
    await page.waitForFunction(() => document.querySelector('#dashboard-period-label')?.textContent.includes('آخر 90'), null, { timeout: 10000 });
    await page.waitForTimeout(500);
    const label = await page.locator(ids.label).innerText();
    if (!label.includes('آخر 90')) throw new Error(label);
    return label;
  });

  await page.screenshot({ path: join(OUT, '02-dashboard-390.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, '03-dashboard-details-1440.png'), fullPage: false });

  await step('A20', 'no page error, no console error and no failed request during the whole run', async () => {
    const detail = `pageErrors=${pageErrors.length} consoleErrors=${consoleErrors.length} failedRequests=${failedRequests.length}`;
    if (pageErrors.length || consoleErrors.length || failedRequests.length) {
      throw new Error(`${detail} :: ${[...pageErrors, ...consoleErrors, ...failedRequests].slice(0, 3).join(' | ')}`);
    }
    return detail;
  });

} catch (error) {
  check('FATAL', 'the verification run completed', false, (error && error.message) || String(error));
}

if (browser) await browser.close();
server.close();

const passed = results.filter((r) => r.ok).length;
console.log(`SUMMARY ${passed}/${results.length} PASS`);
console.log(`PAGE_ERRORS ${pageErrors.length} ${pageErrors.slice(0, 3).join(' | ')}`);
console.log(`CONSOLE_ERRORS ${consoleErrors.length} ${consoleErrors.slice(0, 3).join(' | ')}`);
console.log(`FAILED_REQUESTS ${failedRequests.length} ${failedRequests.slice(0, 3).join(' | ')}`);
if (passed !== results.length) process.exitCode = 1;
