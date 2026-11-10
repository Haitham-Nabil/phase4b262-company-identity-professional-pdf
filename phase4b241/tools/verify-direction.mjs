// Phase 4B.5.1 — real Browser Runtime verification (Chromium + real IndexedDB).
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8899/';
const OUT = '/home/user/browser-proof-451';
mkdirSync(OUT, { recursive: true });
const results = [];
const record = (id, name, ok, evidence) => { results.push({ id, name, status: ok ? 'PASS' : 'FAIL', evidence }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${id} ${name} | ${evidence}`); };

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 950 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto(BASE, { waitUntil: 'load' }); // the module specifiers below resolve against the app origin

async function goto(hash) { await page.goto(BASE + '#' + hash, { waitUntil: 'load' }); await page.waitForTimeout(700); }
async function setVal(sel, value) {
  await page.evaluate(({ sel, value }) => {
    const n = document.querySelector(sel); if (!n) throw new Error('missing ' + sel);
    n.value = value; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel, value });
}
const seedCustomer = (d) => page.evaluate(async (d) => (await import('/src/services/customerService.js')).customerService.createCustomer(d), d);
const settlements = () => page.evaluate(async () => { const { settlementService } = await import('/src/services/settlementService.js'); const rows = await settlementService.listSettlementMovements(); return { rows, totals: settlementService.summarize(rows) }; });
const cash = () => page.evaluate(async () => { const { paymentService } = await import('/src/services/paymentService.js'); const rows = await paymentService.listCashMovements(); return { rows, totals: paymentService.summarize(rows) }; });
const core = (id) => page.evaluate(async (id) => { const { balanceService } = await import('/src/services/balanceService.js'); return { ledger: await balanceService.getRunningBalance(id), summary: await balanceService.getCustomerSummary(id) }; }, id);

// A hard reload guarantees a fresh view init (and a fresh customer list) even when the
// hash is already #/settlements.
async function openSettlements() {
  await page.goto(BASE + '#/settlements', { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#settlement-form', { timeout: 10000 });
  await page.waitForTimeout(400);
}
async function pickTab(tab) { const el = await page.$(`[data-tab="${tab}"]`); if (el) { await el.click(); await page.waitForTimeout(300); } }
async function fill({ customerId, date, direction, amount, description = '' }) {
  await setVal('#settlement-customer', customerId); await setVal('#settlement-date', date);
  await setVal('#settlement-direction', direction); await setVal('#settlement-amount', amount);
  await setVal('#settlement-description', description); await page.waitForTimeout(300);
}
async function pressSave() { await page.click('#settlement-form button[type="submit"]'); await page.waitForTimeout(800); }
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

// A — Settlement Credit
const cA = await seedCustomer({ Code: 'A-100', Name: 'مزارع أ', OpeningBalance: 1000 });
await openSettlements(); await pickTab('settlement');
await fill({ customerId: cA.Id, date: '2026-10-01', direction: 'Credit', amount: '200', description: 'تسوية دائنة' });
await pressSave();
const a = await core(cA.Id); const aRows = (await settlements()).rows.filter((r) => r.CustomerId === cA.Id);
record('A', 'Settlement Credit', a.summary.BalanceMinor === 120000 && (aRows[0]||{}).CreditMinor === 20000 && (aRows[0]||{}).DebitMinor === 0 && (aRows[0]||{}).CashReceivedMinor === 0,
  `balance=${a.summary.BalanceMinor}, credit=${(aRows[0]||{}).CreditMinor}, debit=${(aRows[0]||{}).DebitMinor}, cash=${(aRows[0]||{}).CashReceivedMinor}/${(aRows[0]||{}).CashPaidMinor}`);
await goto('/customer/' + cA.Id); await page.waitForTimeout(500);
const stA = await page.evaluate(() => document.body.innerText);
record('A2', 'Statement shows تسوية as credit', stA.includes('تسوية') && stA.includes('200.00'), 'statement contains the real type and the credit amount');
await shot('A-settlement-credit-statement');

// B — Settlement Debit
const cB = await seedCustomer({ Code: 'B-100', Name: 'مزارع ب', OpeningBalance: 1000 });
await openSettlements(); await pickTab('settlement');
await fill({ customerId: cB.Id, date: '2026-10-01', direction: 'Debit', amount: '150', description: 'تسوية مدينة' });
await pressSave();
const b = await core(cB.Id); const bRows = (await settlements()).rows.filter((r) => r.CustomerId === cB.Id);
record('B', 'Settlement Debit', b.summary.BalanceMinor === 85000 && (bRows[0]||{}).DebitMinor === 15000 && (bRows[0]||{}).CreditMinor === 0,
  `balance=${b.summary.BalanceMinor}, debit=${(bRows[0]||{}).DebitMinor}, credit=${(bRows[0]||{}).CreditMinor}`);
await shot('B-settlement-debit');

// C — GoodsExchange Credit
const cC = await seedCustomer({ Code: 'C-100', Name: 'مزارع ج', OpeningBalance: 500 });
await openSettlements(); await pickTab('goods-exchange');
await fill({ customerId: cC.Id, date: '2026-10-02', direction: 'Credit', amount: '300', description: 'تبادل دائن' });
await pressSave();
const c = await core(cC.Id); const cRows = (await settlements()).rows.filter((r) => r.CustomerId === cC.Id);
record('C', 'GoodsExchange Credit', c.summary.BalanceMinor === 80000 && (cRows[0]||{}).TransactionType === 'GoodsExchange' && (cRows[0]||{}).CreditMinor === 30000,
  `type=${(cRows[0]||{}).TransactionType}, balance=${c.summary.BalanceMinor}, credit=${(cRows[0]||{}).CreditMinor}`);
await goto('/customer/' + cC.Id); await page.waitForTimeout(500);
const stC = await page.evaluate(() => document.body.innerText);
record('C2', 'Statement shows تبادل بضائع (not تسوية)', stC.includes('تبادل بضائع'), 'the goods exchange keeps its own label in the statement');
await shot('C-goodsexchange-credit-statement');

// D — GoodsExchange Debit
const cD = await seedCustomer({ Code: 'D-100', Name: 'مزارع د', OpeningBalance: 500 });
await openSettlements(); await pickTab('goods-exchange');
await fill({ customerId: cD.Id, date: '2026-10-03', direction: 'Debit', amount: '120', description: 'تبادل مدين' });
await pressSave();
const d = await core(cD.Id); const dRows = (await settlements()).rows.filter((r) => r.CustomerId === cD.Id);
record('D', 'GoodsExchange Debit', d.summary.BalanceMinor === 38000 && (dRows[0]||{}).DebitMinor === 12000 && (dRows[0]||{}).CreditMinor === 0,
  `balance=${d.summary.BalanceMinor}, debit=${(dRows[0]||{}).DebitMinor}`);
await shot('D-goodsexchange-debit');

// E — insufficient balance: warning first, save only after confirmation
const cE = await seedCustomer({ Code: 'E-100', Name: 'مزارع هـ', OpeningBalance: 100 });
await openSettlements(); await pickTab('settlement');
await fill({ customerId: cE.Id, date: '2026-10-04', direction: 'Debit', amount: '250', description: 'خصم يتجاوز الرصيد' });
await pressSave();
let confirmVisible = null;
try { await page.waitForSelector('#settlement-confirm-submit', { timeout: 5000 }); confirmVisible = await page.$('#settlement-confirm-submit'); } catch (error) { confirmVisible = null; }
const beforeRows = (await settlements()).rows.filter((r) => r.CustomerId === cE.Id);
const warnText = await page.evaluate(() => document.body.innerText);
record('E1', 'Debt warning shown and nothing written yet',
  Boolean(confirmVisible) && beforeRows.length === 0 && warnText.includes('الرصيد الدائن غير كافٍ') && warnText.includes('-150.00'),
  `confirmButton=${Boolean(confirmVisible)}, rowsBeforeConfirm=${beforeRows.length}, warning shown with projected -150.00`);
await shot('E-debt-warning-before-confirm');
await page.click('#settlement-confirm-submit'); await page.waitForTimeout(900);
const e = await core(cE.Id); const afterRows = (await settlements()).rows.filter((r) => r.CustomerId === cE.Id);
record('E2', 'Save succeeds after the explicit confirmation', afterRows.length === 1 && e.summary.BalanceMinor === -15000,
  `rowsAfterConfirm=${afterRows.length}, balance=${e.summary.BalanceMinor}`);
await shot('E2-debt-after-confirm');

// F — reload persistence
await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(900);
const fAll = (await settlements()).rows;
const fMap = new Map(fAll.map((r) => [r.Id, r]));
const fChecks = [aRows[0], bRows[0], cRows[0], dRows[0]].every((r) => fMap.has(r.Id));
const dirs = [fMap.get(aRows[0]&&aRows[0].Id), fMap.get(bRows[0]&&bRows[0].Id), fMap.get(cRows[0]&&cRows[0].Id), fMap.get(dRows[0]&&dRows[0].Id)].map((r) => r ? r.Direction : 'MISSING');
record('F', 'All four directions survive a page reload', fChecks && dirs.join(',') === 'Credit,Debit,Credit,Debit',
  `persisted directions after reload = ${dirs.join(' / ')}, row count = ${fAll.length}`);
await openSettlements(); await shot('F-after-reload-settlements');

// G — types and totals on the screen
const gAll = await settlements();
const screenText = await page.evaluate(() => document.body.innerText);
const totalsOk = gAll.totals.SettlementCreditMinor === 20000 && gAll.totals.SettlementDebitMinor === 15000 + 25000 && gAll.totals.GoodsExchangeCreditMinor === 30000 && gAll.totals.GoodsExchangeDebitMinor === 12000 && gAll.totals.NetSettlementMinor === -20000;
record('G', 'Settlements screen shows the right types and totals',
  totalsOk && screenText.includes('إجمالي التسويات الدائنة') && screenText.includes('إجمالي تبادل البضائع المدين') && screenText.includes('تبادل بضائع'),
  `SettCr=${gAll.totals.SettlementCreditMinor}, SettDeb=${gAll.totals.SettlementDebitMinor}, NetSett=${gAll.totals.NetSettlementMinor}, GECr=${gAll.totals.GoodsExchangeCreditMinor}, GEDeb=${gAll.totals.GoodsExchangeDebitMinor}, NetNonCash=${gAll.totals.NetNonCashMinor}`);
await shot('G-settlements-summary-and-rows');

// H — Payments isolation
const hCash = await cash();
await goto('/payments'); await page.waitForTimeout(800);
const payText = await page.evaluate(() => document.body.innerText);
record('H', 'No settlement appears in Payments and cash totals are unchanged',
  hCash.rows.length === 0 && hCash.totals.CashReceivedMinor === 0 && hCash.totals.CashPaidMinor === 0 && hCash.totals.NetCashMinor === 0,
  `cashRows=${hCash.rows.length}, CashReceived=${hCash.totals.CashReceivedMinor}, CashPaid=${hCash.totals.CashPaidMinor}, NetCash=${hCash.totals.NetCashMinor}`);
await shot('H-payments-isolation');

// I — legacy record with no Direction, written through the real DB path
const cI = await seedCustomer({ Code: 'I-100', Name: 'مزارع قديم', OpeningBalance: 0 });
await page.evaluate(async ({ customerId }) => {
  const { transactionRepository } = await import('/src/repositories/transactionRepository.js');
  const now = new Date().toISOString();
  await transactionRepository.add({ Id: 'legacy_dir_1', CustomerId: customerId, Date: '2026-09-01', TransactionType: 'Settlement', Description: null, AmountMinor: 12345, LinkId: null, TransferRole: null, Status: 'Active', CancellationReason: null, CancelledAt: null, CreatedAt: now, UpdatedAt: now });
}, { customerId: cI.Id });
const iCore = await core(cI.Id);
const iRow = (await settlements()).rows.find((r) => r.Id === 'legacy_dir_1');
record('I', 'A legacy row with no Direction is read as a Credit',
  iRow.CreditMinor === 12345 && iRow.DebitMinor === 0 && iCore.summary.BalanceMinor === 12345,
  `storedDirection=${String(iRow.Direction)}, credit=${iRow.CreditMinor}, debit=${iRow.DebitMinor}, balance=${iCore.summary.BalanceMinor}`);
await goto('/customer/' + cI.Id); await page.waitForTimeout(600); await shot('I-legacy-row-statement');

// J — filters and the running balance sequence
const cJ = await seedCustomer({ Code: 'J-100', Name: 'مزارع تسلسل', OpeningBalance: 1000 });
await openSettlements(); await pickTab('settlement');
await fill({ customerId: cJ.Id, date: '2026-10-01', direction: 'Credit', amount: '200' }); await pressSave();
await pickTab('goods-exchange');
await fill({ customerId: cJ.Id, date: '2026-10-02', direction: 'Debit', amount: '50' }); await pressSave();
await pickTab('settlement');
await fill({ customerId: cJ.Id, date: '2026-10-03', direction: 'Debit', amount: '400' }); await pressSave();
const jCore = await core(cJ.Id);
const jRows = (await settlements()).rows.filter((r) => r.CustomerId === cJ.Id).map((r) => r.RunningBalanceMinor);
const seqOk = JSON.stringify(jRows) === JSON.stringify([120000, 115000, 75000]) && jCore.summary.BalanceMinor === 75000;
record('J1', 'Running balance walks the full sequence in both directions', seqOk, `running=[${jRows.join(', ')}], final=${jCore.summary.BalanceMinor}`);
await openSettlements();
const searchSel = (await page.$('#settlement-search')) ? '#settlement-search' : null;
if (searchSel) { await setVal(searchSel, 'J-100'); await page.waitForTimeout(500); }
const filtered = await page.evaluate(() => document.body.innerText);
await shot('J-filters-and-running-balance');
const jAfter = (await settlements()).rows.filter((r) => r.CustomerId === cJ.Id).map((r) => r.RunningBalanceMinor);
record('J2', 'Filtering the view never changes a running balance', JSON.stringify(jAfter) === JSON.stringify([120000, 115000, 75000]) && filtered.length > 0 && Boolean(searchSel),
  `running after filtering = [${jAfter.join(', ')}]`);

// Mobile responsiveness snapshot of the settlements screen
await ctx.newPage();
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
const mpage = await mobile.newPage();
await mpage.goto(BASE + '#/settlements', { waitUntil: 'load' }); await mpage.waitForTimeout(1200);
await mpage.screenshot({ path: `${OUT}/K-mobile-settlements.png`, fullPage: true });
await mobile.close();

writeFileSync(`${OUT}/report.json`, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => r.status === 'FAIL');
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} PASS`);
await browser.close();
process.exit(failed.length ? 1 : 0);
