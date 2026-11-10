// Phase 4B.11 — reference-data management screen (البيانات المرجعية للمحصول).
//
// Two independent catalogues, managed here and nowhere else:
//   • ReceivingCompany — the company / factory the crop is delivered to. It is NOT a
//     farmer and NOT a carton supplier.
//   • CartonType — the shape of the package the crop is packed in. It carries no weight
//     and no capacity: a carton purchase is counted, never weighed.
//
// This module is presentation and interaction only. Every read and write goes through
// the approved reference services (`src/services/referenceDataService.js`); it never
// touches the persistence layer or the financial engine, and it never creates a
// movement, an amount or a balance.
import { pageHeader, card, button, table, badge, alert } from '../components/index.js';
import { escapeHtml } from '../components/html.js';
import { formatText } from '../../src/utils/formatting.js';
import { logger } from '../../src/utils/logger.js';
import { referenceDataService } from '../../src/services/referenceDataService.js';

export const REFERENCES_REGION_ID = 'references-region';
export const REFERENCES_STATUS_ID = 'references-status';

export const REFERENCE_KIND_COPY = Object.freeze({
  ReceivingCompany: Object.freeze({
    kind: 'ReceivingCompany',
    title: 'الشركات المستلمة للمحصول',
    note: 'الجهة المصدرة أو المصنع الذي يُسلَّم إليه المحصول. ليست مزارعًا وليست مورد كراتين.',
    nameLabel: 'اسم الشركة المستلمة',
    inputId: 'reference-company-name',
    addId: 'reference-company-add',
    placeholder: 'مثال: شركة الوادي للمحاصيل'
  }),
  CartonType: Object.freeze({
    kind: 'CartonType',
    title: 'أنواع الكراتين',
    note: 'شكل العبوة المستخدمة في تعبئة المحصول. لا يحمل وزنًا ولا سعة، ولا يُحسب به أي مبلغ.',
    nameLabel: 'اسم نوع الكرتونة',
    inputId: 'reference-type-name',
    addId: 'reference-type-add',
    placeholder: 'مثال: كرتونة كبيرة'
  }),
  // Phase 4B.13.1 — the agricultural variety of a LOCAL crop purchase. It carries no
  // weight, no capacity and no financial meaning: it only names what was bought.
  StrawberryVariety: Object.freeze({
    kind: 'StrawberryVariety',
    title: 'أصناف الفراولة',
    note: 'الصنف الزراعي للمحصول (مثل فيرتونا أو صنسيشن أو فلوريدا). بيان وصفي بلا وزن وبلا أثر مالي، ويُستخدم في حركة مشتريات المحصول المحلي.',
    nameLabel: 'اسم الصنف',
    inputId: 'reference-variety-name',
    addId: 'reference-variety-add',
    placeholder: 'مثال: فيرتونا'
  })
});

const KINDS = Object.freeze(['ReceivingCompany', 'CartonType', 'StrawberryVariety']);

export const REFERENCE_MESSAGE = Object.freeze({
  added: (name) => `تمت إضافة «${name}».`,
  renamed: (name) => `تم تحديث الاسم إلى «${name}».`,
  deactivated: (name) => `تم تعطيل «${name}». السجل يبقى ظاهرًا في الحركات السابقة ولا يظهر في الاختيارات الجديدة.`,
  reactivated: (name) => `أُعيد تفعيل «${name}».`,
  addFailed: 'تعذّرت إضافة السجل.',
  renameFailed: 'تعذّر تحديث الاسم.',
  toggleFailed: 'تعذّر تغيير حالة السجل.',
  emptyName: 'الاسم مطلوب ولا يمكن أن يكون فارغًا.',
  loadFailed: 'تعذّر تحميل السجلات المرجعية.'
});

// The one place that maps a kind to its service. Nothing else in this file decides
// which catalogue a row belongs to.
export function referenceService(kind, services = referenceDataService) {
  if (kind === 'CartonType') return services.cartonTypes;
  if (kind === 'StrawberryVariety') return services.strawberryVarieties;
  return services.receivingCompanies;
}

// All state transitions of the screen, expressed as plain async functions so they can be
// tested without a DOM. Each one returns an outcome and never throws: an AppError becomes
// an Arabic message the screen can show as-is.
export function createReferencesController({ services = referenceDataService } = {}) {
  function refuse(error, fallback) {
    logger.error('reference management failed', {
      code: error && error.code ? String(error.code) : null,
      message: error && error.message ? String(error.message) : null
    });
    return { Ok: false, Message: (error && error.message) || fallback };
  }

  async function load() {
    const [companies, types, varieties] = await Promise.all([
      referenceService('ReceivingCompany', services).list(),
      referenceService('CartonType', services).list(),
      referenceService('StrawberryVariety', services).list()
    ]);
    return { ReceivingCompany: companies, CartonType: types, StrawberryVariety: varieties };
  }

  async function add(kind, name) {
    const cleaned = String(name == null ? '' : name).trim();
    if (!cleaned) return { Ok: false, Message: REFERENCE_MESSAGE.emptyName };
    try {
      const record = await referenceService(kind, services).create(cleaned);
      return { Ok: true, Record: record, Message: REFERENCE_MESSAGE.added(record.Name) };
    } catch (error) {
      return refuse(error, REFERENCE_MESSAGE.addFailed);
    }
  }

  async function rename(kind, id, name) {
    const cleaned = String(name == null ? '' : name).trim();
    if (!cleaned) return { Ok: false, Message: REFERENCE_MESSAGE.emptyName };
    try {
      const record = await referenceService(kind, services).rename(id, cleaned);
      return { Ok: true, Record: record, Message: REFERENCE_MESSAGE.renamed(record.Name) };
    } catch (error) {
      return refuse(error, REFERENCE_MESSAGE.renameFailed);
    }
  }

  async function setActive(kind, id, isActive) {
    try {
      const record = await referenceService(kind, services).setActive(id, isActive === true);
      return {
        Ok: true,
        Record: record,
        Message: record.IsActive ? REFERENCE_MESSAGE.reactivated(record.Name) : REFERENCE_MESSAGE.deactivated(record.Name)
      };
    } catch (error) {
      return refuse(error, REFERENCE_MESSAGE.toggleFailed);
    }
  }

  return { load, add, rename, setActive };
}

// ---------------------------------------------------------------------------
// Rendering (pure: it only prints what it is given)
// ---------------------------------------------------------------------------

// The stored value is an ISO stamp; the table shows a compact local stamp so the column
// cannot wrap into the neighbouring cells on a phone.
function formatUpdatedAt(value) {
  const text = formatText(value);
  if (!text) return '—';
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(text);
  return match ? `${match[1]} ${match[2]}` : text;
}

function statusBadge(isActive) {
  return isActive ? badge('نشط', 'credit') : badge('غير نشط', 'cancelled');
}

function rowActions(kind, row, editing) {
  if (editing && editing.kind === kind && editing.id === row.Id) {
    return [
      `<button class="btn btn--primary btn--small" type="button" data-action="reference-save" data-reference-kind="${escapeHtml(kind)}" data-reference-id="${escapeHtml(row.Id)}">حفظ</button>`,
      `<button class="btn btn--outline btn--small" type="button" data-action="reference-cancel">إلغاء</button>`
    ].join(' ');
  }
  return [
    `<button class="btn btn--outline btn--small" type="button" data-action="reference-edit" data-reference-kind="${escapeHtml(kind)}" data-reference-id="${escapeHtml(row.Id)}" data-reference-name="${escapeHtml(row.Name)}">تعديل الاسم</button>`,
    row.IsActive
      ? `<button class="btn btn--outline btn--small" type="button" data-action="reference-toggle" data-reference-kind="${escapeHtml(kind)}" data-reference-id="${escapeHtml(row.Id)}" data-reference-active="false">تعطيل</button>`
      : `<button class="btn btn--primary btn--small" type="button" data-action="reference-toggle" data-reference-kind="${escapeHtml(kind)}" data-reference-id="${escapeHtml(row.Id)}" data-reference-active="true">إعادة تفعيل</button>`
  ].join(' ');
}

export function referenceTableHtml(kind, rows = [], editing = null) {
  const copy = REFERENCE_KIND_COPY[kind];
  const list = Array.isArray(rows) ? rows : [];
  const body = list.map((row) => {
    const isEditing = editing && editing.kind === kind && editing.id === row.Id;
    const nameCell = isEditing
      ? `<input class="input" id="reference-edit-name" type="text" value="${escapeHtml(isEditing ? editing.name : row.Name)}" data-reference-kind="${escapeHtml(kind)}">`
      : escapeHtml(formatText(row.Name));
    return {
      className: row.IsActive ? null : 'ledger-row--cancelled',
      cells: [
        nameCell,
        statusBadge(row.IsActive === true),
        escapeHtml(formatUpdatedAt(row.UpdatedAt)),
        rowActions(kind, row, editing)
      ]
    };
  });
  return table({
    columns: [
      { label: copy.nameLabel },
      { label: 'الحالة' },
      { label: 'آخر تحديث' },
      { label: 'إجراءات' }
    ],
    rows: body,
    emptyMessage: 'لا توجد سجلات بعد. أضف أول سجل من الحقل أعلاه.'
  });
}

export function referenceSectionHtml(kind, { rows = [], editing = null, busy = false, draftName = '' } = {}) {
  const copy = REFERENCE_KIND_COPY[kind];
  return card({
    title: copy.title,
    body: `<p class="text-sm text-muted">${escapeHtml(copy.note)}</p>
<div class="row row--wrap reference-add">
  <label class="field__label" for="${copy.inputId}">${escapeHtml(copy.nameLabel)}</label>
  <input class="input" id="${copy.inputId}" type="text" placeholder="${escapeHtml(copy.placeholder)}" value="${escapeHtml(draftName || '')}"${busy ? ' disabled' : ''}>
  <button class="btn btn--primary btn--small" type="button" id="${copy.addId}" data-action="reference-add" data-reference-kind="${escapeHtml(kind)}"${busy ? ' disabled aria-disabled="true"' : ''}>إضافة</button>
</div>
${referenceTableHtml(kind, rows, editing)}`
  });
}

export function referencesMessageHtml(message) {
  if (!message || !message.text) return '';
  return alert({ tone: message.tone || 'info', title: message.title || null, message: message.text });
}

export function referencesBodyHtml({ rows = {}, editing = null, busy = false, message = null, draftName = {} } = {}) {
  return [
    referencesMessageHtml(message),
    `<div class="grid grid--cols-1 page-section" id="${REFERENCES_STATUS_ID}">`,
    referenceSectionHtml('ReceivingCompany', { rows: rows.ReceivingCompany || [], editing, busy, draftName: (draftName || {}).ReceivingCompany || '' }),
    referenceSectionHtml('CartonType', { rows: rows.CartonType || [], editing, busy, draftName: (draftName || {}).CartonType || '' }),
    referenceSectionHtml('StrawberryVariety', { rows: rows.StrawberryVariety || [], editing, busy, draftName: (draftName || {}).StrawberryVariety || '' }),
    '</div>'
  ].join('\n');
}

export function referencesViewHtml() {
  return [
    pageHeader({
      title: 'البيانات المرجعية للمحصول',
      description: 'الشركات المستلمة للمحصول وأنواع الكراتين المستخدمة في مشتريات الكرتون وأصناف الفراولة المستخدمة في مشتريات المحصول المحلي'
    }),
    `<div id="${REFERENCES_REGION_ID}" aria-busy="true">${referencesBodyHtml({})}</div>`
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Controller wiring (the screen's own state, nothing else)
// ---------------------------------------------------------------------------
export async function initReferencesView({ container, navigate = null, services = referenceDataService, autoLoad = true } = {}) {
  const region = () => (container && typeof container.querySelector === 'function' ? container.querySelector(`#${REFERENCES_REGION_ID}`) : null);
  const controller = createReferencesController({ services });
  const state = {
    rows: { ReceivingCompany: [], CartonType: [], StrawberryVariety: [] },
    editing: null,
    busy: false,
    message: null,
    draftName: {}
  };

  function paint() {
    const target = region();
    if (!target) return;
    target.innerHTML = referencesBodyHtml({
      rows: state.rows,
      editing: state.editing,
      busy: state.busy,
      message: state.message,
      draftName: state.draftName
    });
    target.setAttribute('aria-busy', state.busy ? 'true' : 'false');
  }

  async function load() {
    try {
      state.rows = await controller.load();
      state.message = null;
      if (state.rows.ReceivingCompany.length === 0 && state.rows.CartonType.length === 0 && state.rows.StrawberryVariety.length === 0) {
        state.message = { tone: 'info', text: 'لا توجد سجلات مرجعية بعد. أضف شركة مستلمة ونوع كرتونة قبل تسجيل مشتريات الكرتون، وأضف صنف فراولة قبل تسجيل مشتريات المحصول المحلي.' };
      }
    } catch (error) {
      logger.error('reference screen load failed', { message: error && error.message ? String(error.message) : null });
      state.message = { tone: 'error', title: 'تعذّر التحميل', text: REFERENCE_MESSAGE.loadFailed };
    }
    paint();
    return state.rows;
  }

  function readName(inputId) {
    const target = region();
    const input = target && typeof target.querySelector === 'function' ? target.querySelector(`#${inputId}`) : null;
    return input ? String(input.value || '') : '';
  }

  async function run(outcome) {
    state.busy = false;
    state.message = {
      tone: outcome.Ok ? 'success' : 'error',
      title: outcome.Ok ? null : 'لم يتم الحفظ',
      text: outcome.Message
    };
    if (outcome.Ok) {
      state.editing = null;
      state.draftName = {};
      state.rows = await controller.load();
    }
    paint();
    return outcome;
  }

  async function addReference(kind) {
    if (state.busy) return null;
    // The typed name is read BEFORE the busy repaint: a repaint rebuilds the input, so
    // reading afterwards would submit an empty value for a valid entry.
    const name = readName(REFERENCE_KIND_COPY[kind].inputId);
    state.busy = true;
    paint();
    const outcome = await controller.add(kind, name);
    if (!outcome.Ok && String(outcome.Message || '').includes('الاسم مطلوب')) {
      // The name stays visible so the user can correct it instead of retyping it.
      state.draftName = { [kind]: name };
    }
    return run(outcome);
  }

  async function saveRename(kind, id) {
    const name = readName('reference-edit-name');
    return run(await controller.rename(kind, id, name));
  }

  async function toggle(kind, id, isActive) {
    return run(await controller.setActive(kind, id, isActive === true));
  }

  container.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const addButton = target.closest('[data-action="reference-add"]');
    if (addButton) {
      void addReference(addButton.getAttribute('data-reference-kind') || 'ReceivingCompany');
      return;
    }
    const editButton = target.closest('[data-action="reference-edit"]');
    if (editButton) {
      state.editing = {
        kind: editButton.getAttribute('data-reference-kind') || 'ReceivingCompany',
        id: editButton.getAttribute('data-reference-id'),
        name: editButton.getAttribute('data-reference-name') || ''
      };
      paint();
      const input = region() && typeof region().querySelector === 'function' ? region().querySelector('#reference-edit-name') : null;
      if (input && typeof input.focus === 'function') input.focus();
      return;
    }
    if (target.closest('[data-action="reference-cancel"]')) {
      state.editing = null;
      paint();
      return;
    }
    const saveButton = target.closest('[data-action="reference-save"]');
    if (saveButton) {
      void saveRename(saveButton.getAttribute('data-reference-kind') || 'ReceivingCompany', saveButton.getAttribute('data-reference-id'));
      return;
    }
    const toggleButton = target.closest('[data-action="reference-toggle"]');
    if (toggleButton) {
      void toggle(
        toggleButton.getAttribute('data-reference-kind') || 'ReceivingCompany',
        toggleButton.getAttribute('data-reference-id'),
        toggleButton.getAttribute('data-reference-active') === 'true'
      );
    }
  });

  if (autoLoad) await load();
  return {
    reload: load,
    controller,
    addReference,
    saveRename,
    toggle,
    state: () => ({ ...state, rows: { ...state.rows } }),
    regionId: REFERENCES_REGION_ID
  };
}
