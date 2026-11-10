// Phase 4B.22 / 4B.26.2 — shared CSV and professional browser-print helpers.
import { settingsService } from '../../src/services/settingsService.js';
import { authService } from '../../src/services/authService.js';
// Export is presentation-only: it reads the report currently rendered by the report
// services and never accesses the data layer, changes records, or recalculates totals.
const NUMERIC_HEADER = /(مدين|دائن|رصيد|مبلغ|قيمة|نقدية|وزن|كمية|عدد|عبوات|كراتين|حركات|المجموع|الإجمالي|السعر|سعر|صافي|الكيلو|القيمة)/i;

function cleanCell(cell) {
  const clone = cell.cloneNode(true);
  clone.querySelectorAll('button, input, select, textarea, svg, .icon').forEach((node) => node.remove());
  return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
}

function csvCell(value, numeric = false) {
  let text = value == null ? '' : String(value).trim();
  if (numeric && text && text !== '—' && text !== '-') {
    const match = text.match(/^\(?\s*(-?[\d,]+(?:\.\d+)?)\s*\)?/);
    if (match) {
      const parsed = Number(match[1].replace(/,/g, '')) * (text.includes('(') && text.includes(')') ? -1 : 1);
      if (Number.isFinite(parsed)) return String(parsed);
    }
  }
  // Prevent spreadsheet formula execution for textual values while preserving real numbers.
  if (!numeric && /^[\s]*[=+@\-\t\r]/.test(text) && !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tableToRows(table) {
  const headers = [...table.querySelectorAll('thead th')].map(cleanCell);
  if (!headers.length) return null;
  const keep = headers.map((header, index) => ({ header, index })).filter(({ header }) => !/(تفاصيل|الإجراء|كشف الحساب)/i.test(header));
  const rows = [...table.querySelectorAll('tbody tr')].map((tr) => {
    const cells = [...tr.querySelectorAll(':scope > td')];
    if (!cells.length || (cells.length === 1 && Number(cells[0].getAttribute('colspan')) > 1)) return null;
    return keep.map(({ index }) => cleanCell(cells[index]));
  }).filter(Boolean);
  return { headers: keep.map(({ header }) => header), rows };
}

function collectTables(root) {
  const visibleModal = root.querySelector('.modal-backdrop:not([hidden])');
  const scope = visibleModal || root;
  const tables = [...scope.querySelectorAll('table')].filter((table) => {
    let node = table;
    while (node && node !== root) {
      if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
      node = node.parentElement;
    }
    return true;
  });
  const sections = tables.map(tableToRows).filter((item) => item && item.headers.length);
  const kpiRoot = scope.querySelector('.dash-kpis');
  if (kpiRoot) {
    const cards = [...kpiRoot.querySelectorAll('.dash-kpi')].map((node) => ({
      label: node.querySelector('.kpi__label')?.textContent?.trim() || '',
      value: node.querySelector('.kpi__value')?.textContent?.trim() || ''
    })).filter((item) => item.label || item.value);
    if (cards.length) sections.unshift({ title: 'مؤشرات وإجماليات التقرير', headers: ['المؤشر', 'القيمة'], rows: cards.map((item) => [item.label, item.value]) });
  }
  return sections;
}

export function buildCsv(sections) {
  const lines = [];
  for (const section of sections) {
    if (!section || !section.headers?.length) continue;
    if (lines.length) lines.push('');
    if (section.title) lines.push(csvCell(section.title));
    lines.push(section.headers.map((header) => csvCell(header)).join(';'));
    for (const row of section.rows || []) lines.push(row.map((value, index) => csvCell(value, NUMERIC_HEADER.test(section.headers[index] || ''))).join(';'));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

function downloadCsv(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function reportExportActionsHtml() {
  return `<div class="row report-export-actions" data-report-export-actions role="group" aria-label="تصدير وطباعة التقرير">
    <button class="btn btn--outline" type="button" data-report-export-action="csv">تصدير CSV</button>
    <button class="btn btn--outline" type="button" data-report-export-action="print">طباعة / حفظ PDF</button>
  </div>`;
}

export function bindReportExportActions({ container, root, filename, getFallbackSections = null }) {
  if (!container || !root) return null;
  const handle = (event) => {
    const button = event.target.closest?.('[data-report-export-action]');
    if (!button || !root.contains(button)) return;
    const action = button.dataset.reportExportAction;
    if (action === 'csv') {
      const sections = collectTables(root);
      if (!sections.length && getFallbackSections) sections.push(...(getFallbackSections() || []));
      if (!sections.length) {
        window.alert('لا توجد بيانات جدولية جاهزة للتصدير في العرض الحالي.');
        return;
      }
      downloadCsv(buildCsv(sections), typeof filename === 'function' ? filename() : filename);
      return;
    }
    if (action === 'print') void printReport(root);
  };
  container.addEventListener('click', handle);
  return () => container.removeEventListener('click', handle);
}

async function printReport(root) {
  const existing = document.getElementById('report-print-root');
  if (existing) existing.remove();
  const filterParts = [...root.querySelectorAll('.page-section .field')].map((field) => {
    const label = field.querySelector('label')?.innerText?.trim();
    const control = field.querySelector('input, select');
    if (!label || !control) return '';
    const value = control.tagName === 'SELECT' ? control.selectedOptions?.[0]?.textContent?.trim() : control.value;
    return value ? `${label}: ${value}` : '';
  }).filter(Boolean);
  const selectedModes = [...root.querySelectorAll('[aria-selected="true"], [aria-pressed="true"]')]
    .map((node) => node.innerText?.trim()).filter(Boolean);
  const printRoot = document.createElement('main');
  printRoot.id = 'report-print-root';
  printRoot.dir = 'rtl';
  const visibleModal = root.querySelector('.modal-backdrop:not([hidden])');
  let clone;
  if (visibleModal) {
    clone = document.createElement('section');
    const pageHeading = root.querySelector('.page-header');
    const modalContent = visibleModal.querySelector('.modal');
    if (pageHeading) clone.append(pageHeading.cloneNode(true));
    if (modalContent) clone.append(modalContent.cloneNode(true));
  } else {
    clone = root.cloneNode(true);
    clone.querySelectorAll('[data-report-export-actions], button, input, select, textarea, [role="tablist"], .modal-backdrop[hidden]').forEach((node) => node.remove());
    clone.querySelectorAll('.page-section').forEach((section) => { if (section.querySelector('.toolbar')) section.remove(); });
    clone.querySelectorAll('[hidden]').forEach((node) => node.remove());
  }
  clone.querySelectorAll('[data-report-export-actions], button, input, select, textarea').forEach((node) => node.remove());
  const statementBlock = clone.querySelector('.customer-statement-print-only');
  if (statementBlock) { const pageHeader = clone.querySelector('.page-header')?.cloneNode(true); clone.replaceChildren(); if (pageHeader) clone.append(pageHeader); clone.append(statementBlock); }
  const companyName = await settingsService.getCompanyName().catch(() => '');
  const currentUser = authService.current();
  const reportTitle = root.querySelector('.page-header h2, .page-header h1')?.textContent?.trim() || root.querySelector('.card__title')?.textContent?.trim() || 'تقرير';
  const heading = document.createElement('header');
  heading.className = 'report-print-heading';
  heading.innerHTML = `<div class="report-print-company"></div><div class="report-print-title"></div><div class="report-print-info"></div>`;
  heading.querySelector('.report-print-company').textContent = companyName || 'اسم الشركة غير محدد';
  heading.querySelector('.report-print-title').textContent = reportTitle;
  heading.querySelector('.report-print-info').textContent = `تاريخ ووقت الإعداد: ${new Intl.DateTimeFormat('ar-EG', { dateStyle: 'short', timeStyle: 'short' }).format(new Date())}  ·  أعد التقرير: ${currentUser?.DisplayName || currentUser?.Username || '—'}`;
  printRoot.append(heading, clone);
  const context = [...selectedModes, ...filterParts].filter(Boolean).join(' · ');
  if (context) {
    const filterLine = document.createElement('p');
    filterLine.className = 'report-print-context';
    filterLine.textContent = context;
    printRoot.insertBefore(filterLine, printRoot.children[1] || null);
  }
  document.body.append(printRoot);
  const cleanup = () => {
    printRoot.remove();
    document.body.classList.remove('report-printing');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup, { once: true });
  document.body.classList.add('report-printing');
  window.print();
  window.setTimeout(cleanup, 60000);
}
