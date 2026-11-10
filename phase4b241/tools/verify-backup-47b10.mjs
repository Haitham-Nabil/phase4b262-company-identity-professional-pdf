// Phase 4B.10 — real-browser verification of the Backup & Restore screen.
//
// Serves the project over http, drives it in a real Chromium with the real IndexedDB,
// and checks the whole journey: create → download the JSON → change the data →
// restore the downloaded file → the changed row is gone. Also checks an invalid file,
// the confirmation gate, the mobile width and the console.
import http from 'node:http';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.env.PROJECT_ROOT || '/home/user/work/phase3-customer-accounts';
const PORT = Number(process.env.PORT || 8897);
const CHROME = process.env.CHROME || '/home/user/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const SHOT_DIR = process.env.SHOT_DIR || '/home/user/browser-proof-47b10';
const WORK_DIR = process.env.WORK_DIR || '/home/user/work';
const DOWNLOAD_DIR = join(WORK_DIR, '47b10-download');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` :: ${detail}` : ''}`);
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
      const file = rel === '' ? join(ROOT, 'index.html') : join(ROOT, rel);
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function customerCount(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('CustomerAccountsDB');
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('customers', 'readonly');
      const all = tx.objectStore('customers').getAll();
      all.onsuccess = () => { const n = all.result.length; db.close(); resolve(n); };
      all.onerror = () => { db.close(); reject(all.error); };
    };
    request.onerror = () => reject(request.error);
  }));
}

async function seedCustomer(page, record) {
  return page.evaluate((row) => new Promise((resolve, reject) => {
    const request = indexedDB.open('CustomerAccountsDB');
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('customers', 'readwrite');
      tx.objectStore('customers').put(row);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
    request.onerror = () => reject(request.error);
  }), record);
}

function customerRecord({ id, code, name, openingMinor = 0 }) {
  const now = '2026-10-21T09:00:00.000Z';
  return { Id: id, Code: code, Name: name, Phone: null, Region: null, Notes: null, OpeningBalanceMinor: openingMinor, IsActive: true, CreatedAt: now, UpdatedAt: now };
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const consoleErrors = [];
  const pageErrors = [];
  let context;
  try {
    context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 950 } });
    const page = await context.newPage();
    const badResponses = [];
    page.on('response', (response) => { if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`); });
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));

    // ---------------------------------------------------------------- 1. render
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    await page.evaluate(() => { window.location.hash = '#/backup'; });
    await page.waitForSelector('#backup-create', { timeout: 10000 });
    const renderChecks = {
      title: await page.locator('h1').first().innerText(),
      create: await page.locator('#backup-create').count(),
      file: await page.locator('#restore-file').count(),
      note: (await page.locator('#backup-region').innerText()).includes('تستبدل كامل البيانات الحالية'),
      active: await page.locator('[aria-current="page"]').count()
    };
    record('1. شاشة النسخ الاحتياطي تُعرض من التنقل الحقيقي', renderChecks.title.includes('النسخ الاحتياطي') && renderChecks.create === 1 && renderChecks.file === 1 && renderChecks.note && renderChecks.active === 1,
      JSON.stringify(renderChecks));

    // ---------------------------------------------------------------- 2. seed
    await seedCustomer(page, customerRecord({ id: 'cus_b10_1', code: 'UI-100', name: 'عميل النسخة', openingMinor: 100000 }));
    await page.evaluate(() => { window.location.hash = '#/customers'; });
    await page.waitForTimeout(600);
    const listed = (await page.locator('body').innerText()).includes('UI-100');
    record('2. بيانات حقيقية في IndexedDB تظهر في شاشة العملاء', listed && (await customerCount(page)) === 1, `count=${await customerCount(page)}`);

    // ---------------------------------------------------------------- 3. create + download
    await page.evaluate(() => { window.location.hash = '#/backup'; });
    await page.waitForSelector('#backup-create', { timeout: 10000 });
    let downloadPath = null;
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }),
        page.click('#backup-create')
      ]);
      downloadPath = join(DOWNLOAD_DIR, download.suggestedFilename());
      await download.saveAs(downloadPath);
    } catch (error) {
      record('3. زر الإنشاء يُنزّل ملف النسخة فعليًا', false, `download event failed: ${error.message}`);
    }
    if (downloadPath) {
      const info = await stat(downloadPath);
      const parsed = JSON.parse(await readFile(downloadPath, 'utf8'));
      const hasCustomer = parsed.Customers.some((row) => row.Code === 'UI-100');
      record('3. زر الإنشاء يُنزّل ملف النسخة فعليًا',
        info.size > 200 && parsed.Meta.App === 'CustomerAccountsDB' && hasCustomer,
        `${downloadPath.split('/').pop()} size=${info.size} customers=${parsed.Customers.length}`);
      record('3b. رسالة النجاح تظهر بعد تجهيز الملف', (await page.locator('#backup-region').innerText()).includes('تم إنشاء النسخة الاحتياطية'), '');
    }
    await page.screenshot({ path: join(SHOT_DIR, 'backup-1440.png'), fullPage: true });

    // ---------------------------------------------------------------- 4. restore the downloaded file
    await seedCustomer(page, customerRecord({ id: 'cus_b10_2', code: 'UI-200', name: 'عميل لاحق', openingMinor: 0 }));
    const countAfterSeed = await customerCount(page);
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => { window.location.hash = '#/backup'; });
    await page.waitForSelector('#restore-file', { timeout: 10000 });
    await page.setInputFiles('#restore-file', downloadPath);
    await page.waitForSelector('#restore-confirm', { timeout: 10000 });
    const countBeforeConfirm = await customerCount(page);
    const confirmVisible = await page.locator('#restore-confirm').count();
    record('4. اختيار ملف صالح يعرض الملخص ولا يستعيد قبل التأكيد',
      confirmVisible === 1 && countBeforeConfirm === countAfterSeed && (await page.locator('#restore-summary').innerText()).includes('عدد السجلات في النسخة'),
      `count=${countBeforeConfirm} confirm=${confirmVisible}`);
    await page.screenshot({ path: join(SHOT_DIR, 'backup-confirm-1440.png'), fullPage: true });

    await page.click('#restore-confirm');
    await page.waitForFunction(() => document.querySelector('#backup-region').innerText.includes('تمت الاستعادة بنجاح'), null, { timeout: 15000 });
    const countAfterRestore = await customerCount(page);
    record('5. الاستعادة المؤكدة تُرجع البيانات إلى محتوى الملف (استبدال كامل)',
      countAfterRestore === 1 && !(await page.locator('body').innerText()).includes('UI-200'),
      `count ${countAfterSeed} -> ${countAfterRestore}`);

    // ---------------------------------------------------------------- 5. invalid file
    const badPath = join(DOWNLOAD_DIR, 'invalid-backup.json');
    await writeFile(badPath, '{ not json', 'utf8');
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => { window.location.hash = '#/backup'; });
    await page.waitForSelector('#restore-file', { timeout: 10000 });
    await page.setInputFiles('#restore-file', badPath);
    await page.waitForTimeout(600);
    const regionText = await page.locator('#backup-region').innerText();
    const countAfterBad = await customerCount(page);
    record('6. ملف غير صالح يُرفض برسالة واضحة دون تغيير البيانات',
      regionText.includes('الملف مرفوض') && regionText.includes('JSON غير صالح') && (await page.locator('#restore-confirm').count()) === 0 && countAfterBad === 1,
      `count=${countAfterBad}`);

    // ---------------------------------------------------------------- 6. mobile
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => { window.location.hash = '#/backup'; });
    await page.waitForSelector('#backup-create', { timeout: 10000 });
    await page.waitForTimeout(300);
    const mobile = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      create: !!document.querySelector('#backup-create'),
      file: !!document.querySelector('#restore-file'),
      dir: document.documentElement.getAttribute('dir')
    }));
    record('7. عرض الهاتف 390px بدون تمرير أفقي مع ظهور الأقسام',
      mobile.scrollWidth <= mobile.clientWidth + 1 && mobile.create && mobile.file && mobile.dir === 'rtl',
      JSON.stringify(mobile));
    await page.screenshot({ path: join(SHOT_DIR, 'backup-390.png'), fullPage: true });

    // The browser asks for /favicon.ico on its own; the project ships no favicon.
    // Every other failing response is a real defect.
    const nonFaviconFailures = badResponses.filter((entry) => !/\/favicon\.ico$/.test(entry));
    const realErrors = consoleErrors.filter((text) => !/Failed to load resource/.test(text));
    record('8. لا أخطاء في الكونسول ولا أخطاء صفحة ولا موارد ناقصة',
      realErrors.length === 0 && pageErrors.length === 0 && nonFaviconFailures.length === 0,
      `console=${JSON.stringify(realErrors)} pageErrors=${JSON.stringify(pageErrors)} failedResponses=${JSON.stringify(badResponses)} nonFavicon=${JSON.stringify(nonFaviconFailures)}`);
  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }

  const passed = results.filter((row) => row.ok).length;
  console.log(`\nSUMMARY: ${passed}/${results.length} PASS`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error('HARNESS ERROR:', error && error.stack ? error.stack : error);
  process.exit(2);
});
