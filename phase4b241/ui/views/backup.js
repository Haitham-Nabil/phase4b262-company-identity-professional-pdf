// Phase 4B.10 — Backup & Restore screen (النسخ الاحتياطي والاستعادة).
//
// This module is presentation and interaction only. It never reads or writes the
// local database directly, never touches a data-access module and never computes a
// financial value. Every operation is delegated to the approved services:
//   • backupService  → builds the backup and its download payload
//   • restoreService → parses, validates, summarises and restores a backup file
// The screen only decides what to show and when to ask for confirmation.
import { pageHeader, card, alert, button, badge } from '../components/index.js';
import { escapeHtml } from '../components/html.js';
import { formatCount } from '../../src/utils/formatting.js';
import { logger } from '../../src/utils/logger.js';
import { createBackupFile } from '../../src/services/backupService.js';
import { restoreService } from '../../src/services/restoreService.js';

export const BACKUP_REGION_ID = 'backup-region';
export const BACKUP_CREATE_ID = 'backup-create';
export const BACKUP_STATUS_ID = 'backup-status';
export const RESTORE_FILE_ID = 'restore-file';
export const RESTORE_SUMMARY_ID = 'restore-summary';
export const RESTORE_CONFIRM_ID = 'restore-confirm';
export const RESTORE_CANCEL_ID = 'restore-cancel';
export const RESTORE_STATUS_ID = 'restore-status';

export const BACKUP_BUSY = Object.freeze({ CREATE: 'create', INSPECT: 'inspect', RESTORE: 'restore' });

export const BACKUP_MESSAGE = Object.freeze({
  createBusy: 'جارٍ إنشاء النسخة الاحتياطية…',
  createDone: 'تم إنشاء النسخة الاحتياطية وتجهيز الملف للتنزيل.',
  createFailed: 'تعذّر إنشاء النسخة الاحتياطية.',
  inspectBusy: 'جارٍ التحقق من الملف…',
  inspectInvalid: 'الملف مرفوض ولم تُغيَّر أي بيانات.',
  restoreBusy: 'جارٍ تنفيذ الاستعادة…',
  restoreDone: 'تمت الاستعادة بنجاح.',
  restoreFailed: 'تعذّرت الاستعادة، ولم تُستبدل البيانات الحالية.',
  noFile: 'اختر ملف نسخة احتياطية بصيغة JSON أولًا.',
  emptyFile: 'الملف فارغ؛ لا توجد بيانات لاستعادتها.'
});

// The restore in this project REPLACES every store in one transaction. The wording
// below is taken from the implementation, never chosen for persuasion.
export const RESTORE_BEHAVIOUR_NOTE = 'الاستعادة تستبدل كامل البيانات الحالية (العملاء، الحركات، سجل الرصيد الافتتاحي، الإعدادات، البيانات التقنية، سجل التدقيق) دفعة واحدة بعد نجاح التحقق. لا توجد عملية دمج.';

const COUNTER_LABELS = Object.freeze([
  ['customers', 'العملاء'],
  ['transactions', 'الحركات'],
  ['openingBalanceHistory', 'سجل الرصيد الافتتاحي'],
  ['settings', 'الإعدادات'],
  ['metadata', 'البيانات التقنية'],
  ['auditLog', 'سجل التدقيق'],
  // Phase 4B.11 / 4B.13.1 — the reference catalogues are counted too, so a restored file
  // never hides a whole section from the summary.
  ['receivingCompanies', 'الشركات المستلمة'],
  ['cartonTypes', 'أنواع الكراتين'],
  ['strawberryVarieties', 'أصناف الفراولة']
]);

export function countItems(counts = {}) {
  return COUNTER_LABELS.map(([key, label]) => ({ key, label, value: counts[key] ?? 0 }));
}

function counterTable(counts = {}) {
  const rows = countItems(counts)
    .map((item) => `<tr><td>${escapeHtml(item.label)}</td><td class="num">${escapeHtml(formatCount(item.value))}</td></tr>`)
    .join('');
  return `<table class="table"><caption class="text-sm text-muted">عدد السجلات في النسخة</caption>
<thead><tr><th scope="col">القسم</th><th scope="col">العدد</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function errorsList(errors = []) {
  const items = errors.slice(0, 12).map((error) => `<li>${escapeHtml(error.message || String(error))}</li>`).join('');
  const more = errors.length > 12 ? `<li>و${escapeHtml(formatCount(errors.length - 12))} خطأ آخر…</li>` : '';
  return `<ul class="error-list">${items}${more}</ul>`;
}

function statusBlock({ tone, message, detail = null }) {
  if (!message) return '';
  const extra = detail ? `<div class="page-section">${detail}</div>` : '';
  return `<div id="${tone === 'danger' ? RESTORE_STATUS_ID : BACKUP_STATUS_ID}">${alert({ tone, message })}${extra}</div>`;
}

// The screen markup. Both sections are separated, and the destructive nature of the
// restore is stated before the user can act.
export function backupViewHtml() {
  return [
    pageHeader({
      title: 'النسخ الاحتياطي والاستعادة',
      description: 'حماية بيانات المخزن المحلي: إنشاء نسخة كاملة وتنزيلها، أو استعادة نسخة من ملف.'
    }),
    '<div class="page-section">',
    alert({
      tone: 'info',
      title: 'الفرق بين العمليتين',
      message: 'النسخ الاحتياطي يقرأ البيانات الحالية ويُنزّل ملفًا — لا يغيّر شيئًا. الاستعادة تقرأ ملفًا وتستبدل به البيانات الحالية بالكامل.'
    }),
    '</div>',
    `<div class="grid grid--cols-2 page-section" id="${BACKUP_REGION_ID}"></div>`
  ].join('\n');
}

// The live body of both cards. Re-rendered on every state change so a button is
// disabled for the whole duration of its own operation and no second run can start.
export function backupBodyHtml({ busy = null, inspection = null, createResult = null, restoreResult = null, error = null } = {}) {
  const creating = busy === BACKUP_BUSY.CREATE;
  const inspecting = busy === BACKUP_BUSY.INSPECT;
  const restoring = busy === BACKUP_BUSY.RESTORE;

  const createCard = card({
    title: 'إنشاء نسخة احتياطية',
    body: `<p class="text-sm text-muted">تُنشأ النسخة من البيانات الحالية ثم تُنزَّل إلى جهازك كملف JSON. لا تُرسل إلى أي جهة خارجية.</p>
<div class="row"><button class="btn btn--primary" type="button" id="${BACKUP_CREATE_ID}" data-action="create-backup"${creating ? ' disabled aria-disabled="true"' : ''}>
${creating ? '<span class="spinner" aria-hidden="true"></span><span>جارٍ الإنشاء…</span>' : '<span>إنشاء وتنزيل النسخة</span>'}</button></div>
${creating ? statusBlock({ tone: 'info', message: BACKUP_MESSAGE.createBusy }) : ''}
${createResult ? statusBlock({ tone: 'success', message: BACKUP_MESSAGE.createDone, detail: `<p class="text-sm">الملف: <strong>${escapeHtml(createResult.FileName)}</strong></p>${counterTable(createResult.Counts)}` }) : ''}
${error && error.where === 'create' ? statusBlock({ tone: 'danger', message: `${BACKUP_MESSAGE.createFailed} ${error.message}` }) : ''}`,
    footer: badge('قراءة فقط', 'nonCash')
  });

  const restoreCard = card({
    title: 'استعادة نسخة احتياطية',
    body: `<p class="text-sm text-muted">${escapeHtml(RESTORE_BEHAVIOUR_NOTE)}</p>
<div class="field"><label class="field__label" for="${RESTORE_FILE_ID}">ملف النسخة الاحتياطية (JSON)</label>
<input class="input" type="file" id="${RESTORE_FILE_ID}" data-action="pick-backup" accept="application/json,.json"${restoring ? ' disabled' : ''}></div>
${inspecting ? statusBlock({ tone: 'info', message: BACKUP_MESSAGE.inspectBusy }) : ''}
<div id="${RESTORE_SUMMARY_ID}">${inspectionHtml({ inspection, restoring, busy })}</div>
${error && error.where === 'restore' ? statusBlock({ tone: 'danger', message: `${BACKUP_MESSAGE.restoreFailed} ${error.message}` }) : ''}
${restoreResult ? statusBlock({ tone: 'success', message: BACKUP_MESSAGE.restoreDone, detail: counterTable(restoreResult.counts) }) : ''}`,
    footer: badge('استبدال كامل', 'debit')
  });

  return createCard + restoreCard;
}

function inspectionHtml({ inspection = null, restoring = false, busy = null } = {}) {
  if (!inspection) return '';
  const idle = busy === null;
  if (!inspection.Ok) {
    return `${alert({ tone: 'danger', message: BACKUP_MESSAGE.inspectInvalid })}${errorsList(inspection.Errors)}`;
  }
  const meta = inspection.Meta || {};
  const when = meta.ExportedAt ? `<p class="text-sm">تاريخ النسخة: ${escapeHtml(String(meta.ExportedAt))}</p>` : '';
  const version = `<p class="text-sm">إصدار الصيغة: ${escapeHtml(String(meta.FormatVersion ?? '—'))} · إصدار المخطط: ${escapeHtml(String(meta.SchemaVersion ?? '—'))}</p>`;
  const confirm = `<div class="confirm-panel">
<button class="btn btn--danger" type="button" id="${RESTORE_CONFIRM_ID}" data-action="confirm-restore"${idle ? '' : ' disabled aria-disabled="true"'}>${restoring ? 'جارٍ الاستعادة…' : 'تأكيد الاستعادة واستبدال البيانات'}</button>
<button class="btn btn--outline" type="button" id="${RESTORE_CANCEL_ID}" data-action="cancel-restore"${idle ? '' : ' disabled aria-disabled="true"'}>إلغاء</button>
</div>`;
  return `${alert({ tone: 'warning', message: 'الملف صالح، ولم تُنفَّذ الاستعادة بعد. راجع الملخص ثم أكّد الاستبدال.' })}
${when}${version}${counterTable(inspection.Counts)}${confirm}`;
}

// Default browser download. Kept out of the controller body so the tests can inject
// a spy instead of touching the DOM download path.
export function downloadInBrowser({ fileName, content, mime = 'application/json' } = {}) {
  if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('التنزيل غير مدعوم في هذه البيئة.');
  }
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

const defaultServices = Object.freeze({
  createBackupFile: (...args) => createBackupFile(...args),
  inspectJson: (...args) => restoreService.inspectJson(...args),
  restoreFromJson: (...args) => restoreService.restoreFromJson(...args)
});

export function initBackupView({ container, services = null, download = null, navigate = null } = {}) {
  if (!container) return null;
  const api = { ...defaultServices, ...(services || {}) };
  const downloadFile = typeof download === 'function' ? download : downloadInBrowser;
  const region = () => (typeof container.querySelector === 'function' ? container.querySelector(`#${BACKUP_REGION_ID}`) : null);

  const state = {
    busy: null,
    inspection: null,
    pendingJson: null,
    createResult: null,
    restoreResult: null,
    error: null
  };

  const snapshot = () => ({ busy: state.busy, inspection: state.inspection, createResult: state.createResult, restoreResult: state.restoreResult, error: state.error });
  const stateApi = () => ({ ...snapshot(), pendingJson: state.pendingJson });

  function paint() {
    const target = region();
    if (!target) return;
    target.innerHTML = backupBodyHtml(snapshot());
  }

  function control(id) {
    const target = region();
    return target && typeof target.querySelector === 'function' ? target.querySelector(`#${id}`) : null;
  }

  function messageOf(error) {
    return error && error.message ? String(error.message) : 'خطأ غير معروف.';
  }

  function logFailure(scope, error) {
    logger.error(`backup screen: ${scope} failed`, {
      code: error && error.code ? String(error.code) : null,
      message: error && error.message ? String(error.message) : null
    });
  }

  // Concurrency guard: one running operation at a time, whatever the user clicks.
  function begin(kind) {
    if (state.busy) return false;
    state.busy = kind;
    state.error = null;
    paint();
    return true;
  }

  function end() {
    state.busy = null;
    paint();
  }

  async function createBackup() {
    if (!begin(BACKUP_BUSY.CREATE)) return null;
    state.createResult = null;
    state.error = null;
    try {
      const result = await api.createBackupFile();
      // The success message is only produced after the payload exists AND the download
      // hand-off returned, so "تم" can never appear before the file is ready.
      downloadFile({ fileName: result.FileName, content: result.Json, mime: 'application/json' });
      state.createResult = { FileName: result.FileName, Counts: result.Counts };
      return state.createResult;
    } catch (error) {
      logFailure('create', error);
      state.error = { where: 'create', message: messageOf(error) };
      return null;
    } finally {
      end();
    }
  }

  async function pickFile(file) {
    if (state.busy) return null;
    if (!file) {
      state.inspection = { Ok: false, Errors: [{ message: BACKUP_MESSAGE.noFile }] };
      state.pendingJson = null;
      paint();
      return null;
    }
    if (!begin(BACKUP_BUSY.INSPECT)) return null;
    state.inspection = null;
    state.pendingJson = null;
    state.restoreResult = null;
    state.error = null;
    try {
      const text = typeof file.text === 'function' ? await file.text() : String(file || '');
      if (!String(text || '').trim()) {
        state.inspection = { Ok: false, Errors: [{ message: BACKUP_MESSAGE.emptyFile }] };
        return state.inspection;
      }
      const inspection = await api.inspectJson(text);
      state.inspection = inspection;
      // Only a validated file is retained for the restore step.
      state.pendingJson = inspection && inspection.Ok ? text : null;
      return inspection;
    } catch (error) {
      logFailure('inspect', error);
      state.inspection = { Ok: false, Errors: [{ message: messageOf(error) }] };
      state.pendingJson = null;
      return state.inspection;
    } finally {
      end();
    }
  }

  async function confirmRestore() {
    if (state.busy) return null;
    if (!state.inspection || state.inspection.Ok !== true) return null;
    if (!state.pendingJson) return null;
    const payload = state.pendingJson;
    if (!begin(BACKUP_BUSY.RESTORE)) return null;
    state.error = null;
    try {
      const result = await api.restoreFromJson(payload);
      state.restoreResult = result;
      state.inspection = null;
      state.pendingJson = null;
      return result;
    } catch (error) {
      logFailure('restore', error);
      state.error = { where: 'restore', message: messageOf(error) };
      return null;
    } finally {
      end();
    }
  }

  function cancelRestore() {
    if (state.busy) return false;
    state.inspection = null;
    state.pendingJson = null;
    state.error = null;
    paint();
    return true;
  }

  const onClick = (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('[data-action="create-backup"]')) { void createBackup(); return; }
    if (target.closest('[data-action="confirm-restore"]')) { void confirmRestore(); return; }
    if (target.closest('[data-action="cancel-restore"]')) { cancelRestore(); }
  };

  const onChange = (event) => {
    const target = event.target;
    const id = target && typeof target.getAttribute === 'function' ? target.getAttribute('id') : null;
    if (id !== RESTORE_FILE_ID) return;
    const files = target.files;
    void pickFile(files && files.length ? files[0] : null);
  };

  if (typeof container.addEventListener === 'function') {
    container.addEventListener('click', onClick);
    container.addEventListener('change', onChange);
  }

  paint();

  return {
    state: stateApi,
    createBackup,
    pickFile,
    confirmRestore,
    cancelRestore,
    control,
    refresh: paint,
    navigate: typeof navigate === 'function' ? navigate : null
  };
}
