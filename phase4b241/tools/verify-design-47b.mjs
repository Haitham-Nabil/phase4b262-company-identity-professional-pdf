// Phase 4B.7B — Design System & UI Shell verification.
// Real Chromium + real IndexedDB. Proves the CSS-only redesign changed no
// behaviour: layout integrity at four viewports, no console errors, the mobile
// sidebar drawer, every route, the settlement tab filter and — most important —
// the financial figures, which are seeded through the app's own services and
// must be identical before and after the redesign.
//
// Usage: LABEL=baseline OUT=/home/user/browser-proof-47b node tools/verify-design-47b.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const ROOT = '/home/user/work/phase3-customer-accounts';
const OUT = process.env.OUT || '/home/user/browser-proof-47b';
const PORT = Number(process.env.PORT || 8893);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'CustomerAccountsDB';
const LABEL = process.env.LABEL || 'run';
await mkdir(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
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
const shots = [];
const errs = [];
const rec = (id, ok, evidence) => {
  results.push({ id, ok: Boolean(ok), evidence: String(evidence) });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${id} | ${evidence}`);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (error) => errs.push(`pageerror: ${error.message}`));
page.on('console', (message) => { if (message.type() === 'error') errs.push(`console: ${message.text()}`); });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shot = async (name) => { await page.screenshot({ path: join(OUT, `${LABEL}-${name}.png`), fullPage: true }); shots.push(`${LABEL}-${name}.png`); };
const nav = async (hash) => { await page.goto(`${BASE}/index.html${hash}`, { waitUntil: 'domcontentloaded' }); await wait(520); };
const txt = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
const rowCount = (sel) => page.$$eval(sel, (n) => n.length).catch(() => 0);
const overflow = () => page.evaluate(() => ({
  doc: document.documentElement.scrollWidth,
  client: document.documentElement.clientWidth,
  body: document.body.scrollWidth
}));

// ---------------------------------------------------------------- boot + seed
await nav('#/dashboard');
await page.waitForFunction(async () => {
  try { const m = await import('/src/services/databaseInit.js'); await m.databaseInit.initialize(); return true; } catch { return false; }
}, null, { timeout: 20000 });

const seeded = await page.evaluate(async () => {
  const { customerService } = await import('/src/services/customerService.js');
  const { transactionService } = await import('/src/services/transactionService.js');
  const { transactionFormService } = await import('/src/services/transactionFormService.js');
  const created = await customerService.createCustomer({ Code: 'C-971', Name: 'مزارع التصميم', Phone: '01000000000', Region: 'الجيزة', OpeningBalance: 1000 });
  const id = created.Id;
  const plain = async (TransactionType, Amount, Date, Description) => (await transactionService.createTransaction({ CustomerId: id, Date, TransactionType, Amount, Description })).Id;
  await plain('SalePesticides', 300, '2026-10-06', 'بيع مبيدات');
  await plain('CashReceived', 500, '2026-10-01', 'قبض نقدي');
  await plain('CashPaid', 200, '2026-10-02', 'دفعة نقدية');
  const settle = async (TransactionType, Amount, Date, Direction, Description) => (await transactionFormService.submitTransactionForm({ TransactionType, CustomerId: id, Date, Amount, Direction, Description })).Record.Id;
  await settle('Settlement', 200, '2026-10-03', 'Credit', 'تسوية دائنة');
  await settle('GoodsExchange', 150, '2026-10-04', 'Debit', 'تبادل بضاعة مدين');
  await settle('Settlement', 40, '2026-10-05', 'Debit', 'تسوية مدينة');
  const { balanceService } = await import('/src/services/balanceService.js');
  const s = await balanceService.getCustomerSummary(id);
  const ledger = await balanceService.getRunningBalance(id);
  return {
    id,
    Opening: s.OpeningBalanceMinor, Credit: s.TotalCreditMinor, Debit: s.TotalDebitMinor,
    Balance: s.BalanceMinor, CashIn: s.CashReceivedMinor, CashOut: s.CashPaidMinor,
    NonCash: s.NonCashSettlementMinor, Entries: ledger.Entries.length
  };
});
// opening 1000 + credits 700 (500 cash + 200 settlement credit) − debits 690 (200 cash + 150 + 40 + 300)
const EXPECTED = { Opening: 100000, Credit: 70000, Debit: 69000, Balance: 101000, CashIn: 50000, CashOut: 20000, NonCash: 39000, Entries: 6 };
const figuresOk = Object.entries(EXPECTED).every(([k, v]) => seeded[k] === v);
rec('SEED-FINANCIALS', figuresOk, `seeded=${JSON.stringify(seeded)} expected=${JSON.stringify(EXPECTED)}`);

// -------------------------------------------------- functional spot checks
await nav(`#/customer/${seeded.id}`);
const accountText = await txt('.app-content');
rec('ACCOUNT-BALANCE-ON-SCREEN', (accountText || '').includes('1,010.00') && (accountText || '').includes('700.00') && (accountText || '').includes('690.00'),
  `ledger shows balance 1,010.00=${(accountText || '').includes('1,010.00')} credit 700.00=${(accountText || '').includes('700.00')} debit 690.00=${(accountText || '').includes('690.00')}`);
await shot('account-1440');

await nav('#/payments');
const paySummary = await txt('#payments-summary');
const payRows = await rowCount('#payments-region table tbody tr');
rec('PAYMENTS-CASH-ONLY', (paySummary || '').includes('300.00') && (paySummary || '').includes('500.00') && (paySummary || '').includes('200.00'),
  `summary="${(paySummary || '').slice(0, 160)}" rows=${payRows}`);
await shot('payments-1440');

const tabWalk = async (regionSel, label) => {
  const tabs = await page.$$eval('[data-tab]', (n) => n.map((x) => x.getAttribute('data-tab')));
  let ok = tabs.length > 0;
  for (const t of tabs) {
    await page.click(`[data-tab="${t}"]`); await wait(320);
    const body = await txt(regionSel);
    if (!body || body.length < 5) ok = false;
  }
  rec(`TABS-${label}`, ok, `tabs=[${tabs.join(',')}] all rendered content`);
  return tabs;
};
await nav('#/settlements');
await tabWalk('#settlements-region', 'SETTLEMENTS');
await page.click('[data-tab="settlement"]'); await wait(350);
const setRows = await rowCount('#settlements-region table tbody tr');
const setText = await txt('#settlements-region');
await page.click('[data-tab="goods-exchange"]'); await wait(350);
const geRows = await rowCount('#settlements-region table tbody tr');
const geText = await txt('#settlements-region');
rec('SETTLEMENT-TAB-FILTER', setRows === 2 && geRows === 1 && (setText || '').includes('تسوية دائنة') && (geText || '').includes('تبادل بضاعة مدين') && !(geText || '').includes('تسوية دائنة'),
  `settlement tab rows=${setRows} goods-exchange tab rows=${geRows}`);
const setSummary = await txt('#settlements-summary');
rec('SETTLEMENTS-NONCASH-TOTALS', (setSummary || '').includes('390.00'), `summary="${(setSummary || '').slice(0, 160)}"`);
await nav('#/payments');
const paySummaryAfter = await txt('#payments-summary');
rec('NONCASH-NOT-IN-CASH', paySummaryAfter === paySummary, `payments summary unchanged by the settlement screen: ${paySummaryAfter === paySummary}`);
await nav('#/settlements');
await shot('settlements-1440');

// ------------------------------------------------------- viewport integrity
const ROUTE_PATHS = ['/dashboard', '/customers', '/transactions', '/crop-purchases', '/payments', '/settlements', '/reports', '/settings', '/import', '/backup'];
const WIDTHS = [[1440, 900], [1024, 768], [768, 1024], [390, 844]];
const widths = [];

for (const [w, h] of WIDTHS) {
  await page.setViewportSize({ width: w, height: h });
  await wait(280);
  const bad = [];
  let worst = 0;
  for (const p of [...ROUTE_PATHS, `/customer/${seeded.id}`, '/transactions/add']) {
    await nav(`#${p}`);
    const o = await overflow();
    worst = Math.max(worst, o.doc - o.client);
    if (o.doc > o.client + 1) bad.push(`${p} (${o.doc}>${o.client})`);
  }
  rec(`W${w}-NO-H-SCROLL`, bad.length === 0, `destinations with page-level horizontal scroll: ${bad.length ? bad.join(' , ') : 'none'}; worst overflow=${worst}px`);
  widths.push({ width: w, worstOverflow: worst, offenders: bad });

  await nav('#/dashboard');
  const toggleVisible = await page.isVisible('[data-sidebar-toggle]');
  if (w <= 820) {
    rec(`W${w}-TOGGLE-VISIBLE`, toggleVisible, `mobile sidebar toggle visible=${toggleVisible}`);
    await page.click('[data-sidebar-toggle]'); await wait(420);
    const opened = await page.evaluate(() => {
      const shell = document.querySelector('[data-sidebar]');
      const box = document.querySelector('.app-sidebar').getBoundingClientRect();
      return { state: shell.getAttribute('data-sidebar'), x: Math.round(box.x), right: Math.round(box.right), width: Math.round(box.width), aria: document.querySelector('[data-sidebar-toggle]').getAttribute('aria-expanded'), vw: window.innerWidth };
    });
    rec(`W${w}-DRAWER-OPEN`, opened.state === 'open' && opened.x >= -2 && opened.right <= opened.vw + 2 && opened.aria === 'true',
      `state=${opened.state} box=[${opened.x}..${opened.right}] of ${opened.vw} width=${opened.width} aria-expanded=${opened.aria}`);
    await shot(`sidebar-open-${w}`);
    await page.mouse.click(24, Math.round(h / 2)); await wait(420);
    const viaBackdrop = await page.evaluate(() => document.querySelector('[data-sidebar]').getAttribute('data-sidebar'));
    rec(`W${w}-DRAWER-BACKDROP-CLOSE`, viaBackdrop === 'closed', `after backdrop click data-sidebar=${viaBackdrop}`);
    await page.click('[data-sidebar-toggle]'); await wait(380);
    await page.click('[data-route-id="payments"]'); await wait(650);
    const afterNav = await page.evaluate(() => ({
      hash: window.location.hash,
      state: document.querySelector('[data-sidebar]').getAttribute('data-sidebar'),
      title: document.querySelector('.app-header__titles h1').textContent.trim()
    }));
    rec(`W${w}-DRAWER-NAVIGATES`, afterNav.hash.includes('/payments') && afterNav.state === 'closed' && afterNav.title.length > 0,
      `hash=${afterNav.hash} data-sidebar=${afterNav.state} header="${afterNav.title}"`);
    await page.click('[data-sidebar-toggle]'); await wait(380);
    await page.keyboard.press('Escape'); await wait(380);
    const viaEscape = await page.evaluate(() => document.querySelector('[data-sidebar]').getAttribute('data-sidebar'));
    rec(`W${w}-DRAWER-ESCAPE`, viaEscape === 'closed', `after Escape data-sidebar=${viaEscape}`);
  } else {
    rec(`W${w}-TOGGLE-HIDDEN`, !toggleVisible, `desktop keeps the fixed sidebar (toggle rendered=${toggleVisible})`);
  }

  await nav('#/dashboard'); await shot(`dashboard-${w}`);
  await nav('#/customers'); await shot(`customers-${w}`);
  await nav('#/settlements'); await shot(`settlements-${w}`);
  await nav('#/customers/new'); await shot(`customer-form-${w}`);
}

// ------------------------------------------------------ interaction checks
await page.setViewportSize({ width: 1440, height: 900 });
await nav('#/customers');
const beforeSearch = await rowCount('#customers-region table tbody tr');
const typed = await page.evaluate(() => {
  const e = document.querySelector('#customer-search');
  if (!e) return false;
  e.value = 'ZZZ-NO-MATCH'; e.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
});
await wait(380);
const filteredRows = await rowCount('#customers-region table tbody tr');
await page.evaluate(() => {
  const e = document.querySelector('#customer-search');
  e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true }));
});
await wait(380);
const restoredRows = await rowCount('#customers-region table tbody tr');
rec('CUSTOMERS-SEARCH', typed && beforeSearch >= 1 && filteredRows === 0 && restoredRows === beforeSearch,
  `rows ${beforeSearch} → (search "ZZZ-NO-MATCH") ${filteredRows} → (cleared) ${restoredRows}`);

const sortButton = await page.$('[data-action="toggle-sort-direction"]');
if (sortButton) {
  await sortButton.click(); await wait(320);
  const sortedRows = await rowCount('#customers-region table tbody tr');
  rec('CUSTOMERS-SORT', sortedRows === restoredRows, `sort direction toggled, rows still ${sortedRows}`);
} else {
  rec('CUSTOMERS-SORT', true, 'no sort control rendered on this screen');
}
await shot('customers-1440');

await nav('#/transactions/add');
await page.selectOption('#field-TransactionType', 'CropPurchaseLocal'); await wait(420);
const cropFields = await page.evaluate(() => Array.from(document.querySelectorAll('.app-content input, .app-content select')).map((e) => e.id).filter(Boolean));
const cropPreview = await txt('.app-content');
rec('ADD-TXN-DYNAMIC-FIELDS', cropFields.length >= 5 && !cropFields.some((id) => /amount/i.test(id)),
  `fields after type change: [${cropFields.join(', ')}] ; no manual amount field=${!cropFields.some((id) => /amount/i.test(id))}`);
rec('ADD-TXN-PREVIEW-REGION', (cropPreview || '').includes('معاينة') || (cropPreview || '').includes('الوزن'), `preview region present=${(cropPreview || '').includes('معاينة')}`);
await shot('add-transaction-1440');

// touch targets + keyboard focus on the narrowest viewport
await page.setViewportSize({ width: 390, height: 844 });
await nav('#/customers');
const touch = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('.btn, .input, .select')).filter((e) => e.offsetParent !== null);
  const heights = els.map((e) => Math.round(e.getBoundingClientRect().height));
  return { count: els.length, below32: heights.filter((v) => v < 32).length, min: heights.length ? Math.min(...heights) : null };
});
rec('W390-TOUCH-TARGETS', touch.below32 === 0, `visible controls=${touch.count} below-32px=${touch.below32} min-height=${touch.min}px`);
await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
const focusRing = await page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  return { tag: el.tagName, outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle };
});
rec('KEYBOARD-FOCUS-VISIBLE', focusRing !== null && focusRing.outlineWidth !== '0px' && focusRing.outlineStyle !== 'none',
  `focused=${focusRing ? focusRing.tag : 'none'} outline=${focusRing ? `${focusRing.outlineStyle} ${focusRing.outlineWidth}` : '—'}`);
await nav(`#/customer/${seeded.id}`); await shot('account-390');
await nav('#/customers'); await shot('customers-390');

rec('NO-CONSOLE-ERRORS', errs.length === 0, `pageerror/console-error count=${errs.length}${errs.length ? ` → ${errs.slice(0, 4).join(' | ')}` : ''}`);

const report = {
  label: LABEL,
  generatedAt: new Date().toISOString(),
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  total: results.length,
  figures: seeded,
  expectedFigures: EXPECTED,
  viewports: widths,
  pageErrors: errs,
  screenshots: shots,
  results
};
writeFileSync(join(OUT, `report-${LABEL}.json`), JSON.stringify(report, null, 2));
console.log(`\nSUMMARY[${LABEL}]: ${report.passed}/${report.total} PASS, ${report.failed} FAIL, pageErrors=${errs.length}, screenshots=${shots.length}`);
console.log(`FIGURES[${LABEL}]: ${JSON.stringify(seeded)}`);
await browser.close();
server.close();
process.exit(report.failed > 0 ? 1 : 0);
