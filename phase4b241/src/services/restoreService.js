import { runTransaction } from '../storage/db.js';
import { STORE } from '../storage/schema.js';
import { DB_VERSION } from '../storage/schema.js';
import { BACKUP_APP_ID, BACKUP_FORMAT_VERSION } from './backupService.js';
import { isValidIsoDate, isValidIsoDateTime } from '../domain/dateUtils.js';
import { isTransactionType, STATUS, DEBT_TRANSFER_ROLE, TRANSACTION_TYPE } from '../domain/transactionTypes.js';
import { deriveFinancials } from '../domain/financialDirection.js';
import { isAuditEventType, AUDIT_EVENT_TYPES } from '../domain/auditTrail.js';
import { normalizeReferenceName } from '../domain/referenceRecords.js';
import { PACKAGE_WEIGHT_STATUS } from '../storage/schema.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';

function fail(message, field = null, details = null) {
  return new AppError(ERROR_CODE.RESTORE_ERROR, message, { field, details });
}

// Full validation BEFORE any write. A failed validation never touches current data.
export function validateBackup(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    return { ok: false, errors: [fail('ملف النسخة الاحتياطية غير صالح: البنية الأساسية مفقودة.')] };
  }
  const errors = [];
  const meta = backup.Meta;
  if (!meta || typeof meta !== 'object') errors.push(fail('بيانات التعريف (Meta) مفقودة.', 'Meta'));
  else {
    if (meta.App !== BACKUP_APP_ID) errors.push(fail('ملف النسخة الاحتياطية لا ينتمي لهذا التطبيق.', 'Meta.App'));
    if (meta.FormatVersion !== BACKUP_FORMAT_VERSION) errors.push(fail('إصدار صيغة النسخة الاحتياطية غير مدعوم.', 'Meta.FormatVersion'));
    // Phase 4B.6 — the schema version is now 2. A file written by an earlier release
    // (version 1) is still accepted on purpose: it simply carries no audit section, so
    // older backups keep restoring instead of being locked out by the new release.
    // Phase 4B.11 — every schema generation from 1 up to the current one must be accepted:
    // files written by 4B.6–4B.10 carry SchemaVersion 2 and are still perfectly restorable.
    if (!Number.isInteger(meta.SchemaVersion) || meta.SchemaVersion < 1 || meta.SchemaVersion > DB_VERSION) {
      errors.push(fail(`إصدار مخطط البيانات غير متوافق (المطلوب ${DB_VERSION}).`, 'Meta.SchemaVersion'));
    }
  }
  for (const key of ['Customers', 'Transactions', 'OpeningBalanceHistory', 'Settings', 'Metadata']) {
    if (!Array.isArray(backup[key])) errors.push(fail(`قسم مفقود أو غير صالح: ${key}`, key));
  }
  // Phase 4B.11 — the two reference catalogues are OPTIONAL sections: a backup written by
  // an earlier release (version 1 or 2) has neither, and restoring it must simply leave
  // those stores empty rather than fail. When present they must be valid lists.
  // Phase 4B.13.1 — the variety catalogue is validated by the same rule block.
  for (const key of ['ReceivingCompanies', 'CartonTypes', 'StrawberryVarieties']) {
    if (backup[key] !== undefined && backup[key] !== null && !Array.isArray(backup[key])) {
      errors.push(fail(`قسم غير صالح: ${key}`, key));
    }
  }
  // The audit section is optional so that a version 1 backup still restores; when it
  // is present it must be a valid list of audit events.
  if (backup.AuditLog !== undefined && backup.AuditLog !== null && !Array.isArray(backup.AuditLog)) {
    errors.push(fail('قسم سجل التدقيق غير صالح.', 'AuditLog'));
  }
  if (errors.length) return { ok: false, errors };

  const customerIds = new Set();
  const codes = new Set();
  for (const customer of backup.Customers) {
    if (!customer || typeof customer !== 'object') { errors.push(fail('سجل عميل غير صالح.', 'Customers')); continue; }
    if (!customer.Id) errors.push(fail('معرّف العميل مفقود.', 'Customers.Id'));
    if (!customer.Code) errors.push(fail('كود العميل مفقود.', 'Customers.Code'));
    if (codes.has(customer.Code)) errors.push(fail(`كود عميل مكرر: ${customer.Code}`, 'Customers.Code'));
    codes.add(customer.Code);
    if (customerIds.has(customer.Id)) errors.push(fail(`معرّف عميل مكرر: ${customer.Id}`, 'Customers.Id'));
    customerIds.add(customer.Id);
    if (!Number.isInteger(customer.OpeningBalanceMinor)) errors.push(fail(`رصيد افتتاحي غير صالح للعميل ${customer.Code}.`, 'Customers.OpeningBalanceMinor'));
    if (typeof customer.IsActive !== 'boolean') errors.push(fail(`حالة التفعيل غير صالحة للعميل ${customer.Code}.`, 'Customers.IsActive'));
    if (customer.Name !== null && customer.Name !== undefined && typeof customer.Name !== 'string') errors.push(fail(`اسم العميل غير صالح للكود ${customer.Code}.`, 'Customers.Name'));
  }

  // Phase 4B.11 — reference records: unique Id, required name, unique normalised name.
  for (const key of ['ReceivingCompanies', 'CartonTypes']) {
    const list = Array.isArray(backup[key]) ? backup[key] : [];
    const ids = new Set();
    const names = new Set();
    for (const record of list) {
      if (!record || typeof record !== 'object') { errors.push(fail(`سجل مرجعي غير صالح في ${key}.`, key)); continue; }
      if (!record.Id) errors.push(fail(`سجل مرجعي بلا معرّف في ${key}.`, `${key}.Id`));
      else if (ids.has(record.Id)) errors.push(fail(`معرّف مرجعي مكرر في ${key}: ${record.Id}`, `${key}.Id`));
      else ids.add(record.Id);
      const normalized = normalizeReferenceName(record.Name);
      if (!normalized) errors.push(fail(`سجل مرجعي بلا اسم في ${key}.`, `${key}.Name`));
      else if (names.has(normalized)) errors.push(fail(`اسم مرجعي مكرر في ${key}: ${record.Name}`, `${key}.Name`));
      else names.add(normalized);
      if (typeof record.IsActive !== 'boolean') errors.push(fail(`حالة تنشيط غير صالحة في ${key}: ${record.Name}`, `${key}.IsActive`));
    }
  }
  const receivingCompanyIds = new Set((Array.isArray(backup.ReceivingCompanies) ? backup.ReceivingCompanies : []).map((r) => r && r.Id).filter(Boolean));
  const cartonTypeIds = new Set((Array.isArray(backup.CartonTypes) ? backup.CartonTypes : []).map((r) => r && r.Id).filter(Boolean));
  const varietyIds = new Set((Array.isArray(backup.StrawberryVarieties) ? backup.StrawberryVarieties : []).map((r) => r && r.Id).filter(Boolean));

  const linkGroups = new Map();
  for (const row of backup.Transactions) {
    if (!row || typeof row !== 'object') { errors.push(fail('سجل حركة غير صالح.', 'Transactions')); continue; }
    if (!row.Id) errors.push(fail('معرّف الحركة مفقود.', 'Transactions.Id'));
    if (!row.CustomerId) errors.push(fail('الحركة غير مرتبطة بعميل.', 'Transactions.CustomerId'));
    else if (!customerIds.has(row.CustomerId)) errors.push(fail(`الحركة تشير إلى عميل غير موجود: ${row.CustomerId}`, 'Transactions.CustomerId'));
    if (!isValidIsoDate(row.Date)) errors.push(fail(`تاريخ حركة غير صالح: ${row.Date}`, 'Transactions.Date'));
    if (!isTransactionType(row.TransactionType)) errors.push(fail(`نوع حركة غير معتمد: ${row.TransactionType}`, 'Transactions.TransactionType'));
    if (!Number.isInteger(row.AmountMinor) || row.AmountMinor <= 0) errors.push(fail('قيمة الحركة يجب أن تكون أكبر من صفر.', 'Transactions.AmountMinor'));
    if (row.Status !== STATUS.ACTIVE && row.Status !== STATUS.CANCELLED) errors.push(fail(`حالة حركة غير صالحة: ${row.Status}`, 'Transactions.Status'));
    if (row.Status === STATUS.CANCELLED) {
      if (!row.CancellationReason) errors.push(fail('حركة ملغاة بدون سبب إلغاء.', 'Transactions.CancellationReason'));
      if (!isValidIsoDateTime(row.CancelledAt)) errors.push(fail('تاريخ إلغاء غير صالح.', 'Transactions.CancelledAt'));
    }
    // Phase 4B.11 — a carton purchase may carry the two reference ids; when a value is
    // present it must resolve inside the same file (no dangling reference is accepted).
    // An absent value stays "not specified" and is never guessed.
    if (row.ReceivingCompanyId !== undefined && row.ReceivingCompanyId !== null) {
      if (!receivingCompanyIds.has(row.ReceivingCompanyId)) errors.push(fail(`الحركة تشير إلى شركة مستلمة غير موجودة في النسخة: ${row.ReceivingCompanyId}`, 'Transactions.ReceivingCompanyId'));
    }
    if (row.CartonTypeId !== undefined && row.CartonTypeId !== null) {
      if (!cartonTypeIds.has(row.CartonTypeId)) errors.push(fail(`الحركة تشير إلى نوع كرتونة غير موجود في النسخة: ${row.CartonTypeId}`, 'Transactions.CartonTypeId'));
    }
    // Phase 4B.13.1 — a variety id, when present, must resolve inside the SAME file: a
    // dangling reference is refused here, before any store is cleared. An absent value is
    // «غير محدد», never a deletion.
    if (row.StrawberryVarietyId !== undefined && row.StrawberryVarietyId !== null) {
      if (!varietyIds.has(row.StrawberryVarietyId)) errors.push(fail(`الحركة تشير إلى صنف فراولة غير موجود في النسخة: ${row.StrawberryVarietyId}`, 'Transactions.StrawberryVarietyId'));
    }
    // The historical package weight of a local purchase: either a positive number marked
    // Confirmed, or an explicitly undetermined legacy row. A value that claims to be
    // confirmed without a number is refused.
    if (row.PackageWeightStatus !== undefined && row.PackageWeightStatus !== null) {
      if (row.PackageWeightStatus !== PACKAGE_WEIGHT_STATUS.CONFIRMED && row.PackageWeightStatus !== PACKAGE_WEIGHT_STATUS.UNKNOWN) {
        errors.push(fail(`حالة وزن العبوة غير صالحة: ${row.PackageWeightStatus}`, 'Transactions.PackageWeightStatus'));
      } else if (row.PackageWeightStatus === PACKAGE_WEIGHT_STATUS.CONFIRMED && !(Number.isFinite(row.PackageWeightKg) && row.PackageWeightKg > 0)) {
        errors.push(fail('حركة بوزن عبوة مؤكد دون قيمة وزن صالحة.', 'Transactions.PackageWeightKg'));
      }
    }
    try { deriveFinancials(row); } catch (error) { errors.push(fail(error.message, 'Transactions.TransactionType')); }
    if (row.TransactionType === TRANSACTION_TYPE.DEBT_TRANSFER) {
      if (!row.LinkId) errors.push(fail('تحويل مديونية بدون معرّف ربط.', 'Transactions.LinkId'));
      else {
        const group = linkGroups.get(row.LinkId) || [];
        group.push(row);
        linkGroups.set(row.LinkId, group);
      }
    }
  }
  for (const [linkId, rows] of linkGroups) {
    if (rows.length !== 2) { errors.push(fail(`زوج تحويل المديونية غير مكتمل: ${linkId}`, 'Transactions.LinkId')); continue; }
    const roles = rows.map((r) => r.TransferRole).sort();
    if (roles[0] !== DEBT_TRANSFER_ROLE.CREDIT_SIDE || roles[1] !== DEBT_TRANSFER_ROLE.DEBIT_SIDE) {
      errors.push(fail(`أدوار زوج التحويل غير صالحة: ${linkId}`, 'Transactions.TransferRole'));
    }
    if (rows[0].AmountMinor !== rows[1].AmountMinor) errors.push(fail(`مبلغ زوج التحويل غير متطابق: ${linkId}`, 'Transactions.AmountMinor'));
    if (rows[0].Date !== rows[1].Date) errors.push(fail(`تاريخ زوج التحويل غير متطابق: ${linkId}`, 'Transactions.Date'));
  }

  for (const entry of (backup.AuditLog || [])) {
    if (!entry || typeof entry !== 'object') { errors.push(fail('سجل تدقيق غير صالح.', 'AuditLog')); continue; }
    if (!entry.Id) errors.push(fail('معرّف سجل تدقيق مفقود.', 'AuditLog.Id'));
    if (!entry.TransactionId) errors.push(fail('سجل تدقيق بلا حركة مرتبطة.', 'AuditLog.TransactionId'));
    if (!isAuditEventType(entry.EventType)) errors.push(fail(`نوع حدث تدقيق غير معتمد: ${entry.EventType} (المسموح: ${AUDIT_EVENT_TYPES.join(' أو ')}).`, 'AuditLog.EventType'));
    if (!isValidIsoDateTime(entry.OccurredAt)) errors.push(fail('تاريخ حدث تدقيق غير صالح.', 'AuditLog.OccurredAt'));
    if (!entry.Reason) errors.push(fail('حدث تدقيق بدون سبب مسجل.', 'AuditLog.Reason'));
  }

  for (const entry of backup.OpeningBalanceHistory) {
    if (!entry || !entry.Id) { errors.push(fail('سجل تعديل رصيد بدون معرّف.', 'OpeningBalanceHistory.Id')); continue; }
    if (!customerIds.has(entry.CustomerId)) errors.push(fail(`سجل تعديل رصيد يشير لعميل غير موجود: ${entry.CustomerId}`, 'OpeningBalanceHistory.CustomerId'));
    if (!Number.isInteger(entry.NewValueMinor)) errors.push(fail('قيمة رصيد افتتاحي جديدة غير صالحة.', 'OpeningBalanceHistory.NewValueMinor'));
    if (!isValidIsoDateTime(entry.ChangedAt)) errors.push(fail('تاريخ تعديل غير صالح.', 'OpeningBalanceHistory.ChangedAt'));
    if (!entry.Reason) errors.push(fail('سبب تعديل الرصيد الافتتاحي مفقود.', 'OpeningBalanceHistory.Reason'));
  }

  for (const setting of backup.Settings) {
    if (!setting || !setting.Key) errors.push(fail('سجل إعداد بدون مفتاح.', 'Settings.Key'));
  }
  for (const entry of backup.Metadata) {
    if (!entry || !entry.Key) errors.push(fail('سجل بيانات تقنية بدون مفتاح.', 'Metadata.Key'));
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [] };
}

// Phase 4B.10 — the read-only file check used by the Backup & Restore screen.
//
// It is deliberately thin: it parses the text, then runs the SAME validateBackup()
// the restore path runs, and returns the count summary of the file. No rule is
// repeated here, so the screen can never accept a file the restore would refuse.
const EMPTY_FILE_MESSAGE = 'الملف فارغ؛ لا توجد بيانات لاستعادتها.';
const PARSE_ERROR_MESSAGE = 'تعذّر قراءة ملف النسخة الاحتياطية (JSON غير صالح).';

export function backupFileSummary(backup = {}) {
  return {
    customers: Array.isArray(backup.Customers) ? backup.Customers.length : 0,
    transactions: Array.isArray(backup.Transactions) ? backup.Transactions.length : 0,
    openingBalanceHistory: Array.isArray(backup.OpeningBalanceHistory) ? backup.OpeningBalanceHistory.length : 0,
    settings: Array.isArray(backup.Settings) ? backup.Settings.length : 0,
    metadata: Array.isArray(backup.Metadata) ? backup.Metadata.length : 0,
    auditLog: Array.isArray(backup.AuditLog) ? backup.AuditLog.length : 0,
    receivingCompanies: Array.isArray(backup.ReceivingCompanies) ? backup.ReceivingCompanies.length : 0,
    cartonTypes: Array.isArray(backup.CartonTypes) ? backup.CartonTypes.length : 0,
    strawberryVarieties: Array.isArray(backup.StrawberryVarieties) ? backup.StrawberryVarieties.length : 0
  };
}

export function inspectBackupText(text) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  // The restore replaces every store, whatever the file holds — including an empty one.
  const replacesAllData = true;
  if (!source.trim()) {
    return { Ok: false, Errors: [{ message: EMPTY_FILE_MESSAGE, field: null }], ReplacesAllData: replacesAllData, Meta: null, Counts: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return { Ok: false, Errors: [{ message: PARSE_ERROR_MESSAGE, field: null }], ReplacesAllData: replacesAllData, Meta: null, Counts: null };
  }
  const validation = validateBackup(parsed);
  if (!validation.ok) {
    return {
      Ok: false,
      Errors: validation.errors.map((error) => ({ message: error.message, field: error.field ?? null })),
      ReplacesAllData: replacesAllData,
      Meta: null,
      Counts: null
    };
  }
  return {
    Ok: true,
    Errors: [],
    ReplacesAllData: replacesAllData,
    Meta: {
      App: parsed.Meta.App,
      FormatVersion: parsed.Meta.FormatVersion,
      SchemaVersion: parsed.Meta.SchemaVersion,
      ExportedAt: parsed.Meta.ExportedAt ?? null
    },
    Counts: backupFileSummary(parsed)
  };
}

export const restoreService = {
  validate(backup) { return validateBackup(backup); },

  inspectJson(text) { return inspectBackupText(text); },

  async restore(backup) {
    const { authService } = await import('./authService.js'); authService.assertCanManageData();
    const validation = validateBackup(backup);
    if (!validation.ok) {
      const first = validation.errors[0];
      throw new AppError(ERROR_CODE.RESTORE_ERROR, first.message, { field: first.field, details: { errors: validation.errors } });
    }
    const stores = [
      STORE.CUSTOMERS, STORE.TRANSACTIONS, STORE.OPENING_BALANCE_HISTORY, STORE.SETTINGS, STORE.METADATA, STORE.AUDIT_LOG,
      // Phase 4B.11 — the reference stores join the SAME single transaction, so the
      // replace stays all-or-nothing across old and new stores alike.
      STORE.RECEIVING_COMPANIES, STORE.CARTON_TYPES,
      // Phase 4B.13.1 — the variety store joins the SAME single transaction.
      STORE.STRAWBERRY_VARIETIES
    ];
    // All-or-nothing replacement inside ONE multi-store transaction.
    await runTransaction(stores, 'readwrite', async (handles) => {
      const clearAll = stores.map((name) => new Promise((resolve, reject) => {
        const request = handles[name].clear();
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(new AppError(ERROR_CODE.STORAGE_ERROR, 'تعذر تفريغ البيانات الحالية.', { cause: request.error }));
      }));
      await Promise.all(clearAll);
      const writes = [];
      const push = (name, record) => writes.push(new Promise((resolve, reject) => {
        const request = handles[name].put(record);
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(new AppError(ERROR_CODE.STORAGE_ERROR, 'تعذر كتابة بيانات الاستعادة.', { cause: request.error }));
      }));
      for (const record of backup.Customers) push(STORE.CUSTOMERS, record);
      for (const record of backup.Transactions) push(STORE.TRANSACTIONS, record);
      for (const record of backup.OpeningBalanceHistory) push(STORE.OPENING_BALANCE_HISTORY, record);
      for (const record of backup.Settings) push(STORE.SETTINGS, record);
      for (const record of backup.Metadata) push(STORE.METADATA, record);
      for (const record of (backup.AuditLog || [])) push(STORE.AUDIT_LOG, record);
      // An earlier backup has no reference sections: the two stores are simply left empty
      // (they were cleared together with the rest), never treated as deleted movements.
      for (const record of (backup.ReceivingCompanies || [])) push(STORE.RECEIVING_COMPANIES, record);
      for (const record of (backup.CartonTypes || [])) push(STORE.CARTON_TYPES, record);
      for (const record of (backup.StrawberryVarieties || [])) push(STORE.STRAWBERRY_VARIETIES, record);
      await Promise.all(writes);
      return true;
    });
    return { restored: true, counts: { customers: backup.Customers.length, transactions: backup.Transactions.length, openingBalanceHistory: backup.OpeningBalanceHistory.length, settings: backup.Settings.length, metadata: backup.Metadata.length, auditLog: (backup.AuditLog || []).length, receivingCompanies: (backup.ReceivingCompanies || []).length, cartonTypes: (backup.CartonTypes || []).length, strawberryVarieties: (backup.StrawberryVarieties || []).length } };
  },

  async restoreFromJson(json) {
    let parsed;
    try { parsed = typeof json === 'string' ? JSON.parse(json) : json; }
    catch (error) { throw new AppError(ERROR_CODE.RESTORE_ERROR, 'تعذر قراءة ملف النسخة الاحتياطية (JSON غير صالح).', { cause: error }); }
    return restoreService.restore(parsed);
  }
};
