// Add / Edit customer form (Phase 4B.1). Validation, uniqueness and persistence
// are decided by the services layer; this module only collects input, calls the
// service and shows the messages the service returned.
import { pageHeader, card, alert } from '../components/index.js';
import { loadingState, errorState } from '../components/states.js';
import { escapeHtml } from '../components/html.js';
import { formatText } from '../../src/utils/formatting.js';
import { logger } from '../../src/utils/logger.js';
import { customerService } from '../../src/services/customerService.js';
import { authService } from '../../src/services/authService.js';
import { customerListPath } from '../routes.js';
import { buildHash } from '../router.js';

function hasAdminUiAccess() { return !authService.isEnforced() || authService.isAdmin(); }

export const FORM_MODE = Object.freeze({ CREATE: 'create', EDIT: 'edit' });
export const FORM_FIELDS = Object.freeze(['Code', 'Name', 'Phone', 'Region', 'Notes', 'OpeningBalance', 'IsActive']);

export function buildDraftFromValues(values = {}) {
  const draft = {
    Code: formatText(values.Code),
    Name: formatText(values.Name),
    Phone: formatText(values.Phone) || null,
    Region: formatText(values.Region) || null,
    Notes: formatText(values.Notes) || null
  };
  const opening = formatText(values.OpeningBalance);
  if (opening !== '') draft.OpeningBalance = Number(opening);
  const active = values.IsActive;
  if (active === true || active === false) draft.IsActive = active;
  else if (active === 'true' || active === 'false') draft.IsActive = active === 'true';
  return draft;
}

export function fieldErrorsFromAppError(error) {
  const fromDetails = error && error.details && Array.isArray(error.details.errors) ? error.details.errors : [];
  const fromError = Array.isArray(error && error.errors) ? error.errors : [];
  const list = fromDetails.length ? fromDetails : fromError;
  if (list.length) return list.map((entry) => ({ field: entry.field || null, message: entry.message || 'قيمة غير صالحة.' }));
  if (error && error.message) return [{ field: error.field || null, message: String(error.message) }];
  return [{ field: null, message: 'تعذّر حفظ بيانات العميل.' }];
}

function field(label, controlId, control, error = null, hint = null) {
  return `<div class="field">
  <label class="field__label" for="${escapeHtml(controlId)}">${escapeHtml(label)}</label>
  ${control}
  ${hint ? `<span class="field__hint">${escapeHtml(hint)}</span>` : ''}
  ${error ? `<span class="field__error">${escapeHtml(error)}</span>` : ''}
</div>`;
}

export function customerFormHtml({ mode = FORM_MODE.CREATE, values = {}, errors = [] } = {}) {
  const isEdit = mode === FORM_MODE.EDIT;
  const messageFor = (name) => {
    const hit = errors.find((entry) => entry.field === name);
    return hit ? hit.message : null;
  };
  const invalid = (name) => (errors.some((entry) => entry.field === name) ? ' aria-invalid="true"' : '');
  const value = (name) => escapeHtml(formatText(values[name]));

  const codeControl = isEdit
    ? `<input class="input" id="customer-code" name="Code" type="text" value="${value('Code')}" readonly aria-readonly="true">`
    : `<input class="input" id="customer-code" name="Code" type="text" value="${value('Code')}"${invalid('Code')} required>`;
  const codeHint = isEdit ? 'كود العميل هو المعرّف الأساسي ولا يتغيّر بعد الإنشاء.' : 'مطلوب، ويجب ألا يتكرر مع عميل آخر.';
  const notesControl = `<textarea class="input" id="customer-notes" name="Notes" rows="3">${value('Notes')}</textarea>`;
  const openingControl = `<input class="input" id="customer-opening-balance" name="OpeningBalance" type="text" inputmode="decimal" value="${value('OpeningBalance')}"${invalid('OpeningBalance')}>`;
  const statusControl = `<select class="select" id="customer-is-active" name="IsActive">
  <option value="true"${values.IsActive === false ? '' : ' selected'}>نشط</option>
  <option value="false"${values.IsActive === false ? ' selected' : ''}>غير نشط</option>
</select>`;

  const body = `<form class="customer-form" data-mode="${escapeHtml(mode)}" novalidate>
  <div class="form-grid">
    ${field('كود *', 'customer-code', codeControl, messageFor('Code'), codeHint)}
    ${field('الاسم *', 'customer-name', `<input class="input" id="customer-name" name="Name" type="text" value="${value('Name')}"${invalid('Name')} required>`, messageFor('Name'))}
    ${field('الهاتف', 'customer-phone', `<input class="input" id="customer-phone" name="Phone" type="text" value="${value('Phone')}"${invalid('Phone')}>`, messageFor('Phone'), 'اختياري.')}
    ${field('المنطقة', 'customer-region', `<input class="input" id="customer-region" name="Region" type="text" value="${value('Region')}"${invalid('Region')}>`, messageFor('Region'), 'اختياري.')}
    ${field('ملاحظات', 'customer-notes', notesControl, messageFor('Notes'), 'اختياري.')}
    ${isEdit
      ? field('الحالة', 'customer-is-active', statusControl, messageFor('IsActive'), 'العميل غير النشط يبقى محفوظًا ولا يُحذف.')
      : (hasAdminUiAccess() ? field('الرصيد الافتتاحي', 'customer-opening-balance', openingControl, messageFor('OpeningBalance'), 'يُخزَّن كرصيد افتتاحي مستقل ولا يُسجَّل كحركة.') : '')}
  </div>
  <div class="form-actions">
    <button class="btn btn--primary" type="submit">${isEdit ? 'حفظ التعديلات' : 'حفظ العميل'}</button>
    <button class="btn btn--outline" type="button" data-action="cancel">إلغاء</button>
  </div>
</form>`;
  return card({ title: isEdit ? 'تعديل بيانات العميل' : 'بيانات العميل الجديد', body });
}

export function customerFormShellHtml({ mode = FORM_MODE.CREATE } = {}) {
  const isEdit = mode === FORM_MODE.EDIT;
  const region = isEdit ? loadingState({ message: 'جارٍ تحميل بيانات العميل…' }) : customerFormHtml({ mode: FORM_MODE.CREATE });
  return [
    pageHeader({
      title: isEdit ? 'تعديل عميل' : 'إضافة عميل',
      description: isEdit ? 'تعديل البيانات الأساسية للعميل.' : 'إنشاء عميل جديد بكود فريد.',
      actions: `<a class="btn btn--outline" href="${escapeHtml(buildHash(customerListPath()))}">العودة إلى العملاء</a>`
    }),
    `<div id="customer-form-region" class="page-section" aria-busy="${isEdit ? 'true' : 'false'}">${region}</div>`
  ].join('\n');
}

export function initCustomerFormView({ container, mode = FORM_MODE.CREATE, customerId = null, navigate = null } = {}) {
  if (!container) return null;
  const region = container.querySelector('#customer-form-region');
  const live = () => Boolean(region) && (!('isConnected' in region) || region.isConnected);
  const isEdit = mode === FORM_MODE.EDIT;

  function paint(values = {}, errors = []) {
    if (!live()) return;
    region.innerHTML = customerFormHtml({ mode, values, errors });
    region.setAttribute('aria-busy', 'false');
  }

  function paintFailure(error) {
    if (!live()) return;
    region.innerHTML = `<div class="stack">
${errorState({ title: 'تعذّر تحميل بيانات العميل', message: 'لم يتم تحميل بيانات العميل من المخزن المحلي.', code: error && error.code ? String(error.code) : null })}
<div class="row"><button class="btn btn--primary" type="button" data-action="retry-form">إعادة المحاولة</button></div>
<div class="row"><a class="btn btn--outline" href="${escapeHtml(buildHash(customerListPath()))}">العودة إلى العملاء</a></div>
</div>`;
    region.setAttribute('aria-busy', 'false');
  }

  async function loadForEdit() {
    try {
      const customer = await customerService.getCustomer(customerId);
      if (!live()) return;
      if (!customer) {
        paintFailure({ code: 'NOT_FOUND', message: 'العميل غير موجود.' });
        return;
      }
      paint(customer);
    } catch (error) {
      if (!live()) return;
      logger.error('customer form load failed', {
        code: error && error.code ? String(error.code) : null,
        message: error && error.message ? String(error.message) : null
      });
      paintFailure(error);
    }
  }

  function readValues() {
    const form = region ? region.querySelector('form') : null;
    if (!form || typeof FormData !== 'function') return {};
    const values = {};
    for (const [key, value] of new FormData(form).entries()) values[key] = typeof value === 'string' ? value : '';
    return values;
  }

  async function submit() {
    const values = readValues();
    const draft = buildDraftFromValues(values);
    try {
      if (isEdit) await customerService.updateCustomer(customerId, draft);
      else await customerService.createCustomer(draft);
      if (navigate) navigate(customerListPath());
      return { ok: true, errors: [] };
    } catch (error) {
      logger.error('customer form save failed', {
        code: error && error.code ? String(error.code) : null,
        message: error && error.message ? String(error.message) : null
      });
      const errors = fieldErrorsFromAppError(error);
      paint(values, errors);
      return { ok: false, errors };
    }
  }

  container.addEventListener('submit', (event) => {
    if (event.target && event.target.closest && event.target.closest('.customer-form')) {
      event.preventDefault();
      submit();
    }
  });

  container.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    if (target.closest('[data-action="cancel"]') && navigate) navigate(customerListPath());
    if (target.closest('[data-action="retry-form"]')) loadForEdit();
  });

  if (isEdit) loadForEdit();
  return { submit, reload: loadForEdit };
}
