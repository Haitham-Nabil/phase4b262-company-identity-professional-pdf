// Builds SELF-CONTAINED preview snapshots (CSS inlined) that reuse the real
// component builders, so a snapshot cannot drift from the shipped design system.
// These are throwaway review artifacts — they are not part of the application.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { card, button, badge, alert, field, textInput, select, table, kpi, pageHeader, modal } from '../ui/components/index.js';
import { loadingState, emptyState, errorState } from '../ui/components/states.js';
import { shellRegions } from '../ui/components/layout.js';
import { financialLegend, amountClass } from '../ui/components/financial.js';
import { findRouteById, getDefaultRoute } from '../ui/routes.js';
import { renderView } from '../ui/views/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(root, 'preview');
mkdirSync(out, { recursive: true });

const SHEETS = ['tokens.css', 'base.css', 'layout.css', 'components.css', 'financial.css'];
const inlinedCss = SHEETS
  .map((name) => `/* ===== ${name} ===== */\n${readFileSync(join(root, 'ui/styles', name), 'utf8')}`)
  .join('\n');

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${inlinedCss}
.preview-section-title { margin-bottom: var(--space-3); padding-top: var(--space-5); }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function section(title, body) {
  return `<section class="page-section"><h2 class="preview-section-title">${title}</h2>
${body}</section>`;
}

const designSystem = [
  section('الأزرار', `<div class="row">
${button({ label: 'أساسي', variant: 'primary' })}
${button({ label: 'محدد', variant: 'outline' })}
${button({ label: 'شفاف', variant: 'ghost' })}
${button({ label: 'خطر', variant: 'danger' })}
${button({ label: 'معطّل', disabled: true })}
</div>`),
  section('الحقول', `<div class="grid grid--cols-2">
${field({ label: 'حقل نصي', controlId: 'demo-text', hint: 'تلميح مساعد', control: textInput({ id: 'demo-text', placeholder: 'اكتب هنا' }) })}
${field({ label: 'قائمة اختيار', controlId: 'demo-select', control: select({ id: 'demo-select', options: [{ value: 'a', label: 'عنصر أول' }, { value: 'b', label: 'عنصر ثانٍ' }] }) })}
</div>`),
  section('الشارات', `<div class="row">
${badge('دائن', 'credit')}${badge('مدين', 'debit')}${badge('نقدي', 'cash')}${badge('غير نقدي', 'nonCash')}
${badge('رصيد موجب', 'positiveBalance')}${badge('رصيد سالب', 'negativeBalance')}${badge('ملغاة', 'cancelled')}
</div>`),
  section('التنبيهات', `<div class="stack">
${alert({ tone: 'info', title: 'معلومة', message: 'رسالة إعلامية للواجهة.' })}
${alert({ tone: 'success', title: 'نجاح', message: 'تمت العملية.' })}
${alert({ tone: 'warning', title: 'تنبيه', message: 'راجع البيانات قبل المتابعة.' })}
${alert({ tone: 'danger', title: 'خطأ', message: 'تعذّر إتمام العملية.' })}
</div>`),
  section('الجدول', table({
    caption: 'جدول بلا صفوف — لا بيانات وهمية',
    numeric: true,
    columns: [{ label: 'التاريخ' }, { label: 'النوع' }, { label: 'مدين' }, { label: 'دائن' }, { label: 'الحالة' }],
    rows: [],
    emptyMessage: 'لا توجد صفوف.'
  })),
  section('البطاقات والحالات', `<div class="grid grid--cols-2">
${card({ title: 'بطاقة', body: kpi({ label: 'مؤشر قبل توفر القيمة' }) })}
${card({ title: 'حالة التحميل', body: loadingState({ message: 'جارٍ التحميل…' }) })}
${card({ title: 'الحالة الفارغة', body: emptyState({ title: 'لا توجد بيانات', message: 'لم تُسجَّل حركات.' }) })}
${card({ title: 'حالة الخطأ', body: errorState({ title: 'تعذّر إتمام العملية', message: 'أعد المحاولة.', code: 'STORAGE_ERROR' }) })}
</div>`),
  section('الدلالات المالية', `<div class="row">
<span class="${amountClass('credit')}">1,250.00</span>
<span class="${amountClass('debit')}">(430.00)</span>
<span class="${amountClass('cashIn')}">800.00</span>
<span class="${amountClass('cashOut')}">(120.00)</span>
<span class="${amountClass('nonCash')}">200.00</span>
<span class="${amountClass('positiveBalance')}">6,430.00</span>
<span class="${amountClass('negativeBalance')}">(1,500.00)</span>
<span class="${amountClass('cancelled')}">(300.00)</span>
</div>${financialLegend()}
<p class="text-xs text-muted">القيم أعلاه عيّنة بصرية للدلالات فقط، وليست بيانات تطبيق.</p>`),
  section('النافذة المنبثقة', modal({ id: 'demo-modal', title: 'عنوان النافذة', body: '<p>محتوى النافذة المنبثقة.</p>', footer: button({ label: 'إغلاق', variant: 'outline' }) }))
].join('\n');

// Fix #1 evidence: a page where every element marked [hidden] must be absent even
// though its class carries a display rule (.modal-backdrop { display: grid }),
// plus a visible control proving those same display rules still apply normally.
const hiddenProofBody = `<main class="app-content">
<h2 class="page-header">التحقق من السلوك القياسي للسمة hidden</h2>
<div class="stack">
${card({ title: 'عنصر 1 — مخفي (modal-backdrop عليه display: grid)', body: '<p class="text-sm text-muted">إن ظهر هذا الإطار فهو الخطأ المطلوب إصلاحه.</p>' + modal({ id: 'proof-1', title: 'نافذة يجب ألا تظهر' }).replace('hidden>', 'hidden>') })}
${card({ title: 'عنصر 2 — مخفي (grid عليه display: grid)', body: '<p class="text-sm text-muted">إن ظهرت شبكة من عمودين هنا فالخطأ قائم.</p><div class="grid grid--cols-2" hidden><div class="card"><div class="card__body">عمود أ</div></div><div class="card"><div class="card__body">عمود ب</div></div></div>' })}
${card({ title: 'عنصر 3 — مخفي (بطاقة)', body: '<p class="text-sm text-muted">إن ظهرت هذه البطاقة فالخطأ قائم.</p><div class="card" hidden><div class="card__body">بطاقة لا يجب أن تظهر</div></div>' })}
${card({ title: 'عنصر ضابط — ظاهر (نفس قواعد العرض بدون السمة)', body: '<p class="text-sm text-muted">هذه الشبكة ظاهرة، وتثبت أن قواعد display لم تُكسر.</p><div class="grid grid--cols-2"><div class="card"><div class="card__body">عمود أ — ظاهر</div></div><div class="card"><div class="card__body">عمود ب — ظاهر</div></div></div>' })}
</div>
</main>`;
writeFileSync(join(out, 'hidden-proof.html'), page('التحقق من hidden', `<div class="app-shell" data-sidebar="closed">${hiddenProofBody}</div>`), 'utf8');

const route = findRouteById('dashboard') || getDefaultRoute();
const shellBody = renderView(route) + designSystem;

const shellOpen = shellRegions({ route, appName: 'حسابات العملاء', appTagline: 'تطبيق محلي يعمل دون اتصال', packageWeightKg: 14, body: shellBody })
  .replace('data-sidebar="closed"', 'data-sidebar="open"');
const shellClosed = shellRegions({ route, appName: 'حسابات العملاء', appTagline: 'تطبيق محلي يعمل دون اتصال', packageWeightKg: 14, body: shellBody });

writeFileSync(join(out, 'shell.html'), page('لقطة الهيكل — حسابات العملاء', shellClosed), 'utf8');
writeFileSync(join(out, 'shell-mobile-open.html'), page('لقطة الهيكل — قائمة الجوال مفتوحة', shellOpen), 'utf8');
writeFileSync(join(out, 'customers-view.html'), page('لقطة شاشة العملاء', shellRegions({ route: findRouteById('customers'), appName: 'حسابات العملاء', appTagline: 'تطبيق محلي يعمل دون اتصال', packageWeightKg: 14, body: renderView(findRouteById('customers')) })), 'utf8');
console.log('preview snapshots written to', out);
