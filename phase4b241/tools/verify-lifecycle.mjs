// Phase 4B.6 — browser runtime verification (scenarios A–L) against real Chromium and
// real IndexedDB. Every assertion reads either the rendered DOM of the running app or
// the database through the application's own services.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const ROOT = '/home/user/work/phase3-customer-accounts';
const OUT = '/home/user/browser-proof-46-review';
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
await mkdir(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
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
const check = (id, title, ok, detail) => { results.push({ id, title, ok: Boolean(ok), detail: String(detail === undefined ? '' : detail) }); };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 950 } });
page.on('pageerror', (error) => pageErrors.push(String(error && error.message)));
page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`); });

const shot = async (name) => { await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true }); shots.push(`${name}.png`); };

// ---------------------------------------------------------------- helpers
async function boot() {
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(async () => {
    try {
      const mod = await import('/src/services/databaseInit.js');
      await mod.databaseInit.initialize();
      return true;
    } catch { return false; }
  }, null, { timeout: 20000 });
}

async function newCustomer(code, opening) {
  return page.evaluate(async (args) => {
    const { customerService } = await import('/src/services/customerService.js');
    const created = await customerService.createCustomer({ Code: args.code, Name: `عميل ${args.code}`, Phone: '01000000000', Region: 'الجيزة', OpeningBalance: args.opening });
    return created.Id;
  }, { code, opening });
}

async function newTransaction(customerId, transactionType, amount, date, description) {
  return page.evaluate(async (args) => {
    const { transactionService } = await import('/src/services/transactionService.js');
    const record = await transactionService.createTransaction({ CustomerId: args.customerId, Date: args.date, TransactionType: args.transactionType, Amount: args.amount, Description: args.description });
    return record.Id;
  }, { customerId, transactionType, amount, date, description });
}

async function newCropPurchase(customerId, units, unitPrice) {
  return page.evaluate(async (args) => {
    const { transactionFormService } = await import('/src/services/transactionFormService.js');
    const result = await transactionFormService.submitTransactionForm({ TransactionType: 'CropPurchaseLocal', CustomerId: args.customerId, Date: '2026-09-02', Units: args.units, LooseKg: 0, DeductionKg: 0, UnitPrice: args.unitPrice });
    return { id: result.Record.Id, amount: result.Record.AmountMinor };
  }, { customerId, units, unitPrice });
}

async function newSettlement(customerId, amount, direction) {
  return page.evaluate(async (args) => {
    const { transactionFormService } = await import('/src/services/transactionFormService.js');
    const result = await transactionFormService.submitTransactionForm({ TransactionType: 'Settlement', CustomerId: args.customerId, Date: '2026-09-03', Amount: args.amount, Direction: args.direction });
    return { id: result.Record.Id, direction: result.Record.Direction };
  }, { customerId, amount, direction });
}

async function readState(customerId) {
  return page.evaluate(async (id) => {
    const { balanceService } = await import('/src/services/balanceService.js');
    const summary = await balanceService.getCustomerSummary(id);
    const ledger = await balanceService.getRunningBalance(id);
    return {
      balance: summary.BalanceMinor,
      opening: summary.OpeningBalanceMinor,
      debit: summary.TotalDebitMinor,
      credit: summary.TotalCreditMinor,
      cashReceived: summary.CashReceivedMinor,
      nonCash: summary.NonCashSettlementMinor,
      entries: ledger.Entries.map((entry) => ({
        id: entry.Id, running: entry.RunningBalanceMinor, debit: entry.DebitMinor, credit: entry.CreditMinor,
        cancelled: entry.IsCancelled === true, reason: entry.CancellationReason, canEdit: entry.CanEdit, canCancel: entry.CanCancel
      }))
    };
  }, customerId);
}

async function readAudit(transactionId) {
  return page.evaluate(async (id) => {
    const { transactionLifecycleService } = await import('/src/services/transactionLifecycleService.js');
    const entries = await transactionLifecycleService.listAuditTrail(id);
    return entries.map((entry) => ({ id: entry.Id, event: entry.EventType, reason: entry.Reason, previousAmount: entry.Previous && entry.Previous.AmountMinor, nextAmount: entry.Next && entry.Next.AmountMinor, previousDirection: entry.Previous && entry.Previous.Direction, nextDirection: entry.Next && entry.Next.Direction }));
  }, transactionId);
}

async function readRecord(transactionId) {
  return page.evaluate(async (id) => {
    const { transactionService } = await import('/src/services/transactionService.js');
    const record = await transactionService.getTransaction(id);
    return { id: record.Id, amount: record.AmountMinor, direction: record.Direction ?? null, status: record.Status, reason: record.CancellationReason, date: record.Date, description: record.Description };
  }, transactionId);
}

async function openAccount(customerId) {
  await page.goto(`${BASE}/index.html#/customer/${encodeURIComponent(customerId)}`, { waitUntil: 'load' });
  await page.waitForSelector('#account-ledger', { timeout: 20000 });
  await page.waitForFunction(() => {
    const region = document.querySelector('#account-region');
    return Boolean(region) && region.getAttribute('aria-busy') === 'false';
  }, null, { timeout: 20000 });
}

async function openEditDialog(transactionId) {
  await page.click(`[data-action="edit-transaction"][data-transaction-id="${transactionId}"]`);
  await page.waitForSelector('#dialog-edit-transaction:not([hidden]) #edit-transaction-form', { timeout: 15000 });
}

async function submitEdit(values = {}) {
  if (values.amount !== undefined) await page.fill('#edit-amount', String(values.amount));
  if (values.units !== undefined) await page.fill('#field-Units', String(values.units));
  if (values.unitPrice !== undefined) await page.fill('#field-UnitPrice', String(values.unitPrice));
  if (values.date) await page.fill('#edit-date', values.date);
  if (values.description !== undefined) await page.fill('#edit-description', values.description);
  if (values.direction) await page.selectOption('#edit-direction', values.direction);
  await page.fill('#edit-reason', values.reason || 'سبب التعديل للاختبار');
  await page.click('#edit-submit');
  await page.waitForFunction(() => {
    const dialog = document.querySelector('#dialog-edit-transaction');
    if (!dialog || dialog.hasAttribute('hidden')) return true;
    return !dialog.querySelector('#edit-transaction-form') || Boolean(dialog.querySelector('[role="alert"]'));
  }, null, { timeout: 20000 });
}

async function openCancelDialog(transactionId) {
  await page.click(`[data-action="cancel-transaction"][data-transaction-id="${transactionId}"]`);
  await page.waitForSelector('#dialog-cancel-transaction:not([hidden]) #cancel-transaction-form', { timeout: 15000 });
}

async function submitCancel(reason) {
  await page.fill('#cancel-reason', reason || '');
  await page.click('#cancel-confirm');
}

async function waitForCancelSuccess() {
  await page.waitForFunction(() => {
    const dialog = document.querySelector('#dialog-cancel-transaction');
    if (!dialog || dialog.hasAttribute('hidden')) return true;
    return !dialog.querySelector('#cancel-transaction-form') || Boolean(dialog.querySelector('[role="alert"]'));
  }, null, { timeout: 20000 });
}

const accountHtml = () => page.$eval('#account-region', (node) => node.innerHTML);

async function run(id, title, fn) {
  try {
    const detail = await fn();
    check(id, title, detail.ok, detail.detail);
  } catch (error) {
    check(id, title, false, `EXCEPTION: ${error && error.message}`);
  }
}

await boot();

// ---------------------------------------------------------------- A
await run('A', 'تعديل حركة بيع والتحقق من الرصيد الجديد', async () => {
  const customerId = await newCustomer('B-1001', 1000);
  const txId = await newTransaction(customerId, 'SalePesticides', 300, '2026-09-01', 'بيع مبيدات');
  await openAccount(customerId);
  const before = await readState(customerId);
  await openEditDialog(txId);
  await shot('A1-edit-dialog-open');
  await submitEdit({ amount: 450, reason: 'تصحيح مبلغ البيع' });
  const after = await readState(customerId);
  const record = await readRecord(txId);
  await shot('A2-after-edit');
  const html = await accountHtml();
  return {
    ok: before.balance === 70000 && after.balance === 55000 && record.amount === 45000 && /450\.00/.test(html) && /تم حفظ تعديل الحركة/.test(html),
    detail: `الرصيد قبل=${before.balance} بعده=${after.balance} المبلغ المحفوظ=${record.amount}`
  };
});

// ---------------------------------------------------------------- B
await run('B', 'تعديل مشتريات محصول والتحقق من إعادة الحساب من الحقول المصدرية', async () => {
  const customerId = await newCustomer('B-1002', 0);
  const created = await newCropPurchase(customerId, 10, 5);
  await openAccount(customerId);
  await openEditDialog(created.id);
  const noAmountField = (await page.$('#edit-amount')) === null;
  await submitEdit({ units: 20, unitPrice: 5, reason: 'تصحيح عدد العبوات' });
  const record = await readRecord(created.id);
  const html = await accountHtml();
  await shot('B-crop-recomputed');
  return {
    ok: created.amount === 70000 && record.amount === 140000 && noAmountField && /1,400\.00/.test(html),
    detail: `قبل=${created.amount} بعد=${record.amount} حقل مبلغ يدوي موجود؟=${!noAmountField}`
  };
});

// ---------------------------------------------------------------- C
await run('C', 'تعديل Settlement مع الحفاظ على اتجاهها', async () => {
  const customerId = await newCustomer('B-1003', 5000);
  const settlement = await newSettlement(customerId, 200, 'Credit');
  await openAccount(customerId);
  await openEditDialog(settlement.id);
  await page.selectOption('#edit-direction', 'Credit');
  await submitEdit({ amount: 250, direction: 'Credit', reason: 'تعديل مبلغ التسوية' });
  const keptCredit = await readRecord(settlement.id);
  const stateAfterCredit = await readState(customerId);
  await openEditDialog(settlement.id);
  await submitEdit({ amount: 250, direction: 'Debit', reason: 'تحويل التسوية إلى خصم' });
  const switched = await readRecord(settlement.id);
  const stateAfterDebit = await readState(customerId);
  await shot('C-settlement-direction');
  return {
    ok: keptCredit.direction === 'Credit' && stateAfterCredit.credit === 25000 && switched.direction === 'Debit' && stateAfterDebit.debit === 25000 && stateAfterDebit.cashReceived === 0,
    detail: `الاتجاه المحفوظ=${keptCredit.direction} ثم ${switched.direction} دائن=${stateAfterCredit.credit} مدين=${stateAfterDebit.debit} نقدية=${stateAfterDebit.cashReceived}`
  };
});

// ---------------------------------------------------------------- D
await run('D', 'محاولة تعديل حركة ملغاة والتحقق من رفض العملية', async () => {
  const customerId = await newCustomer('B-1004', 0);
  const txId = await newTransaction(customerId, 'SalePesticides', 300, '2026-09-01', 'حركة ستُلغى');
  await openAccount(customerId);
  await openCancelDialog(txId);
  await submitCancel('إلغاء لاختبار الحماية');
  await waitForCancelSuccess();
  const buttons = await page.$$(`[data-action="edit-transaction"][data-transaction-id="${txId}"]`);
  const state = await readState(customerId);
  const serviceRefusal = await page.evaluate(async (id) => {
    const { transactionLifecycleService } = await import('/src/services/transactionLifecycleService.js');
    try { await transactionLifecycleService.editTransaction(id, { Amount: 999, EditReason: 'محاولة تعديل ملغاة' }); return 'NO-ERROR'; } catch (error) { return error.message; }
  }, txId);
  const html = await accountHtml();
  await shot('D-cancelled-row-protected');
  return {
    ok: buttons.length === 0 && /ملغاة — إلغاء لاختبار الحماية/.test(html) && serviceRefusal === 'لا يمكن تعديل حركة ملغاة.' && state.entries[0].canEdit === false,
    detail: `أزرار التعديل=${buttons.length} رسالة الخدمة=${serviceRefusal}`
  };
});

// ---------------------------------------------------------------- E
await run('E', 'محاولة إلغاء حركة دون سبب والتحقق من منعها', async () => {
  const customerId = await newCustomer('B-1005', 1000);
  const txId = await newTransaction(customerId, 'SalePesticides', 300, '2026-09-01', 'حركة بلا سبب إلغاء');
  await openAccount(customerId);
  await openCancelDialog(txId);
  await submitCancel('');
  await page.waitForFunction(() => {
    const dialog = document.querySelector('#dialog-cancel-transaction');
    return Boolean(dialog) && /سبب إلغاء الحركة مطلوب/.test(dialog.innerHTML);
  }, null, { timeout: 15000 });
  const record = await readRecord(txId);
  const audit = await readAudit(txId);
  const dialogHtml = await page.$eval('#dialog-cancel-transaction', (node) => node.innerHTML);
  await shot('E-cancel-without-reason-blocked');
  return {
    ok: /role="alert"/.test(dialogHtml) && record.status !== 'Cancelled' && audit.length === 0,
    detail: `الحالة=${record.status} أحداث التدقيق=${audit.length} الرسالة ظاهرة=${/سبب إلغاء الحركة مطلوب/.test(dialogHtml)}`
  };
});

// ---------------------------------------------------------------- F
await run('F', 'إلغاء حركة مع سبب والتحقق من بقائها ظاهرة وعدم تأثيرها على الرصيد', async () => {
  const customerId = await newCustomer('B-1006', 1000);
  const txId = await newTransaction(customerId, 'SalePesticides', 300, '2026-09-01', 'حركة ستُلغى بسبب');
  await openAccount(customerId);
  const before = await readState(customerId);
  await openCancelDialog(txId);
  await submitCancel('فاتورة مكررة');
  await waitForCancelSuccess();
  const after = await readState(customerId);
  const record = await readRecord(txId);
  const html = await accountHtml();
  await shot('F-cancelled-row-visible');
  return {
    ok: before.balance === 70000 && after.balance === 100000 && record.status === 'Cancelled' && record.reason === 'فاتورة مكررة' && after.entries.length === 1 && /ملغاة — فاتورة مكررة/.test(html) && /ledger-row--cancelled/.test(html),
    detail: `الرصيد قبل=${before.balance} بعده=${after.balance} الحالة=${record.status} السبب=${record.reason} الصفوف=${after.entries.length}`
  };
});

// ---------------------------------------------------------------- G
await run('G', 'إعادة تحميل الصفحة والتحقق من استمرار سجل التدقيق', async () => {
  const customerId = await newCustomer('B-1007', 1000);
  const txId = await newTransaction(customerId, 'SalePesticides', 300, '2026-09-01', 'حركة سجل التدقيق');
  await openAccount(customerId);
  await openEditDialog(txId);
  await submitEdit({ amount: 400, reason: 'تعديل قبل إعادة التحميل' });
  const beforeReload = await readAudit(txId);
  await openAccount(customerId);
  const afterReload = await readAudit(txId);
  await page.click(`[data-action="view-audit"][data-transaction-id="${txId}"]`);
  await page.waitForFunction(() => /تعديل حركة/.test(document.querySelector('#account-region').innerHTML), null, { timeout: 15000 });
  const html = await accountHtml();
  await shot('G-audit-after-reload');
  return {
    ok: beforeReload.length === 1 && afterReload.length === 1 && afterReload[0].reason === 'تعديل قبل إعادة التحميل' && /تعديل قبل إعادة التحميل/.test(html),
    detail: `قبل=${beforeReload.length} بعد=${afterReload.length} السبب=${afterReload[0] && afterReload[0].reason}`
  };
});

// ---------------------------------------------------------------- H
await run('H', 'إجراء تعديلين على الحركة نفسها والتحقق من وجود سجلين منفصلين', async () => {
  const customerId = await newCustomer('B-1008', 1000);
  const txId = await newTransaction(customerId, 'SalePesticides', 100, '2026-09-01', 'حركة تعديلين');
  await openAccount(customerId);
  await openEditDialog(txId);
  await submitEdit({ amount: 200, reason: 'التعديل الأول' });
  await openEditDialog(txId);
  await submitEdit({ amount: 300, reason: 'التعديل الثاني' });
  const audit = await readAudit(txId);
  await page.click(`[data-action="view-audit"][data-transaction-id="${txId}"]`);
  await page.waitForFunction(() => /التعديل الثاني/.test(document.querySelector('#account-region').innerHTML), null, { timeout: 15000 });
  const html = await accountHtml();
  await shot('H-two-audit-events');
  return {
    ok: audit.length === 2 && audit[0].id !== audit[1].id && audit[0].reason === 'التعديل الأول' && audit[1].reason === 'التعديل الثاني' && audit[1].previousAmount === 20000 && audit[1].nextAmount === 30000 && /التعديل الأول/.test(html) && /التعديل الثاني/.test(html),
    detail: `الأحداث=${audit.length} الأول=${audit[0] && audit[0].reason} الثاني=${audit[1] && audit[1].reason} قبل=${audit[1] && audit[1].previousAmount} بعد=${audit[1] && audit[1].nextAmount}`
  };
});

// ---------------------------------------------------------------- I
await run('I', 'محاولة تعديل أو إلغاء طرف واحد من DebtTransfer والتحقق من الحماية', async () => {
  const fromId = await newCustomer('B-1009', 5000);
  const toId = await newCustomer('B-1010', 0);
  const transfer = await page.evaluate(async (args) => {
    const { debtTransferService } = await import('/src/services/debtTransferService.js');
    const result = await debtTransferService.createDebtTransfer({ FromCustomerId: args.fromId, ToCustomerId: args.toId, Amount: 400, Date: '2026-09-05', Description: 'تحويل مديونية' });
    return { creditId: result.CreditRow.Id, debitId: result.DebitRow.Id };
  }, { fromId, toId });
  await openAccount(fromId);
  const creditButtons = await page.$$(`[data-action="edit-transaction"][data-transaction-id="${transfer.creditId}"]`);
  const cancelButtons = await page.$$(`[data-action="cancel-transaction"][data-transaction-id="${transfer.creditId}"]`);
  // The real rendered row of the linked leg, read from the live DOM.
  const renderedRow = await page.evaluate((id) => {
    const rows = Array.from(document.querySelectorAll('#account-ledger tbody tr'));
    const row = rows.find((candidate) => candidate.innerHTML.includes(id));
    if (!row) return null;
    const cells = Array.from(row.querySelectorAll('td'));
    return { count: cells.length, type: cells[1].textContent.trim(), status: cells[9].textContent.trim(), statusHtml: cells[9].innerHTML };
  }, transfer.creditId);
  // The real dialog markup the screen renders when the action is requested: the block
  // reason is shown there (no action button is offered in the row at all).
  const dialogEvidence = await page.evaluate(async (ids) => {
    const actions = await import('/ui/views/transactionActions.js');
    const { transactionLifecycleService } = await import('/src/services/transactionLifecycleService.js');
    const loaded = await transactionLifecycleService.getEditableTransaction(ids.creditId);
    const dialog = actions.renderEditDialog({ record: loaded.Record, editability: loaded.Editability });
    return {
      blocked: dialog.includes('التعديل غير متاح'),
      reasonShown: dialog.includes('مرتبطة بحركة أخرى'),
      offersForm: dialog.includes('edit-transaction-form'),
      canEdit: loaded.Editability.CanEdit,
      canCancel: loaded.Editability.CanCancel,
      type: loaded.Record.TransactionType,
      amount: loaded.Record.AmountMinor
    };
  }, transfer);
  const refusals = await page.evaluate(async (ids) => {
    const { transactionLifecycleService } = await import('/src/services/transactionLifecycleService.js');
    const out = {};
    try { await transactionLifecycleService.editTransaction(ids.creditId, { Amount: 999, EditReason: 'محاولة' }); out.edit = 'NO-ERROR'; } catch (error) { out.edit = error.message; }
    try { await transactionLifecycleService.cancelTransaction(ids.debitId, 'محاولة إلغاء طرف', { confirmed: true }); out.cancel = 'NO-ERROR'; } catch (error) { out.cancel = error.message; }
    return out;
  }, transfer);
  const state = await readState(fromId);
  const html = await accountHtml();
  await shot('I-linked-leg-protected');
  const message = 'هذه الحركة مرتبطة بحركة أخرى (تحويل مديونية بين طرفين)؛ العملية تُعالَج كاملة ولا يمكن تعديل أو إلغاء طرف واحد منها.';
  const rowClean = Boolean(renderedRow)
    && renderedRow.statusHtml.includes('view-audit')
    && !renderedRow.statusHtml.includes('edit-transaction')
    && !renderedRow.statusHtml.includes('cancel-transaction');
  const everyLegBlocked = state.entries.length > 0 && state.entries.every((entry) => entry.canEdit === false && entry.canCancel === false);
  return {
    ok: creditButtons.length === 0 && cancelButtons.length === 0
      && refusals.edit === message && refusals.cancel === message
      && Boolean(renderedRow) && renderedRow.count === 10 && renderedRow.type.length > 0 && renderedRow.status.includes('نشطة')
      && dialogEvidence.type === 'DebtTransfer' && dialogEvidence.amount === 40000
      && rowClean
      && dialogEvidence.canEdit === false && dialogEvidence.canCancel === false && everyLegBlocked,
    detail: `أزرار=${creditButtons.length + cancelButtons.length} | الصف المرسوم: أعمدة=${renderedRow && renderedRow.count} النوع=${renderedRow && renderedRow.type} الحالة=${renderedRow && renderedRow.status} | سجل التدقيق ظاهر=${Boolean(renderedRow) && renderedRow.statusHtml.includes('view-audit')} | النافذة: غير متاح=${dialogEvidence.blocked} السبب=${dialogEvidence.reasonShown} نموذج=${dialogEvidence.offersForm} | النوع المخزَّن=${dialogEvidence.type} المبلغ=${dialogEvidence.amount} | CanEdit=${dialogEvidence.canEdit} CanCancel=${dialogEvidence.canCancel} | رسالة التعديل=${refusals.edit} | رسالة الإلغاء=${refusals.cancel}`
  };
});

// ---------------------------------------------------------------- J
await run('J', 'التحقق من عدم تغير إجماليات Payments بسبب حركة غير نقدية', async () => {
  const customerId = await newCustomer('B-1011', 0);
  const before = await page.evaluate(async () => {
    const { paymentService } = await import('/src/services/paymentService.js');
    const totals = paymentService.summarize(await paymentService.listCashMovements());
    return { received: totals.CashReceivedMinor, paid: totals.CashPaidMinor, count: totals.Count };
  });
  await newSettlement(customerId, 900, 'Credit');
  await newTransaction(customerId, 'SalePesticides', 500, '2026-09-04', 'بيع غير نقدي');
  const after = await page.evaluate(async () => {
    const { paymentService } = await import('/src/services/paymentService.js');
    const rows = await paymentService.listCashMovements();
    const totals = paymentService.summarize(rows);
    return { received: totals.CashReceivedMinor, paid: totals.CashPaidMinor, count: totals.Count, types: rows.map((row) => row.TransactionType) };
  });
  await openAccount(customerId);
  await shot('J-noncash-not-in-payments');
  return {
    ok: before.received === after.received && before.paid === after.paid && after.count === before.count && !after.types.includes('Settlement'),
    detail: `قبل: وارد=${before.received} منصرف=${before.paid} عدد=${before.count} | بعد: وارد=${after.received} منصرف=${after.paid} عدد=${after.count} الأنواع=${after.types.join(',') || '—'}`
  };
});

// ---------------------------------------------------------------- K
await run('K', 'تطبيق فلتر على كشف الحساب والتحقق من عدم تغير الرصيد الجاري الأصلي', async () => {
  const customerId = await newCustomer('B-1012', 1000);
  await newTransaction(customerId, 'SalePesticides', 200, '2026-09-01', 'بيع أول');
  await newTransaction(customerId, 'CashReceived', 100, '2026-09-02', 'دفعة نقدية');
  const cashId = (await readState(customerId)).entries.find((entry) => entry.debit === 0 && entry.credit === 10000).id;
  await openAccount(customerId);
  await openCancelDialog(cashId);
  await submitCancel('إلغاء لاختبار الفلترة');
  await waitForCancelSuccess();
  const state = await readState(customerId);
  const expectedRunning = state.entries[state.entries.length - 1].running;
  await page.selectOption('#ledger-filter', 'cancelled');
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('#account-ledger tbody tr');
    return rows.length === 1;
  }, null, { timeout: 15000 });
  const shownRunning = await page.$eval('#account-ledger tbody tr', (row) => {
    const cells = row.querySelectorAll('td');
    return cells[8].textContent.trim();
  });
  const summaryBalance = await page.$eval('#account-region', (node) => node.textContent);
  await shot('K-filter-keeps-running-balance');
  return {
    ok: state.entries.length === 2 && shownRunning === '800.00' && expectedRunning === 80000 && /800\.00/.test(summaryBalance),
    detail: `الرصيد الجاري للملصفوفة الظاهرة=${shownRunning} الرصيد الجاري على التسلسل الكامل=${expectedRunning}`
  };
});

// ---------------------------------------------------------------- L
await run('L', 'التحقق من عرض أسباب التعديل والإلغاء بصورة صحيحة', async () => {
  const customerId = await newCustomer('B-1013', 1000);
  const txId = await newTransaction(customerId, 'SalePesticides', 300, '2026-09-01', 'حركة الأسباب');
  await openAccount(customerId);
  await openEditDialog(txId);
  await submitEdit({ amount: 350, reason: 'سبب التعديل الظاهر' });
  await openCancelDialog(txId);
  await submitCancel('سبب الإلغاء الظاهر');
  await waitForCancelSuccess();
  await page.click(`[data-action="view-audit"][data-transaction-id="${txId}"]`);
  await page.waitForFunction(() => /سبب الإلغاء الظاهر/.test(document.querySelector('#account-region').innerHTML), null, { timeout: 15000 });
  const html = await accountHtml();
  const audit = await readAudit(txId);
  await shot('L-audit-reasons');
  return {
    ok: audit.length === 2 && /سبب التعديل الظاهر/.test(html) && /سبب الإلغاء الظاهر/.test(html) && /تعديل حركة/.test(html) && /إلغاء حركة/.test(html) && /ملغاة — سبب الإلغاء الظاهر/.test(html),
    detail: `الأحداث=${audit.length} (${audit.map((entry) => `${entry.event}:${entry.reason}`).join(' | ')}) وكلاهما ظاهر في سجل التدقيق`
  };
});

// ---------------------------------------------------------------- M
await run('M', 'عرض الجوال: فتح وإغلاق القائمة الجانبية والوصول إلى إجراءات الحركة', async () => {
  const customerId = await newCustomer('B-1014', 1000);
  const txId = await newTransaction(customerId, 'SalePesticides', 300, '2026-09-01', 'حركة عرض الجوال');
  await page.setViewportSize({ width: 390, height: 844 });
  await openAccount(customerId);
  // Everything is read from the live DOM: the shell state attribute, the toggle's
  // aria-expanded, the sidebar geometry and any overlay node the app renders.
  const readShell = () => page.evaluate(() => {
    const shell = document.querySelector('[data-sidebar]');
    const toggle = document.querySelector('[data-sidebar-toggle]');
    const sidebar = document.querySelector('#app-sidebar');
    const box = sidebar ? sidebar.getBoundingClientRect() : null;
    return {
      state: shell ? (shell.getAttribute('data-sidebar') || '') : '',
      aria: toggle ? toggle.getAttribute('aria-expanded') : null,
      sidebarLeft: box ? Math.round(box.left) : null,
      sidebarWidth: box ? Math.round(box.width) : null,
      overlay: Boolean(document.querySelector('[data-sidebar-backdrop], .app-backdrop, .sidebar-backdrop, .backdrop'))
    };
  });
  const closed0 = await readShell();
  await page.click('[data-sidebar-toggle]');
  await page.waitForTimeout(300);
  const opened = await readShell();
  const editButtons = (await page.$$(`[data-action="edit-transaction"][data-transaction-id="${txId}"]`)).length;
  const horizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await shot('M-mobile-account-with-actions');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const closed1 = await readShell();
  await page.setViewportSize({ width: 1366, height: 950 });
  return {
    ok: closed0.aria === 'false' && opened.aria === 'true' && closed1.aria === 'false'
      && opened.state === 'open' && closed1.state === 'closed'
      && editButtons === 1 && horizontalScroll === 0,
    detail: `aria-expanded: ${closed0.aria} → ${opened.aria} → ${closed1.aria} | data-sidebar: ${closed0.state || '—'} → ${opened.state} → ${closed1.state} | موضع القائمة x: ${closed0.sidebarLeft} → ${opened.sidebarLeft} → ${closed1.sidebarLeft} (عرض ${opened.sidebarWidth}) | عنصر خلفية منفصل موجود=${opened.overlay} | زر التعديل ظاهر في الجوال=${editButtons} | تجاوز العرض الأفقي=${horizontalScroll}px`
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  passed: results.filter((row) => row.ok).length,
  failed: results.filter((row) => !row.ok).length,
  results,
  screenshots: shots,
  pageErrors
};
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));

console.log(JSON.stringify({ passed: report.passed, failed: report.failed, results, screenshots: shots, pageErrors }, null, 2));

await browser.close();
server.close();
