import { authService } from './authService.js';
import { customerRepository } from '../repositories/customerRepository.js';
import { openingBalanceRepository } from '../repositories/openingBalanceRepository.js';
import { validateCustomerDraft } from '../validation/customerValidation.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';
import { STATUS } from '../domain/transactionTypes.js';
import { createId, ID_PREFIX } from '../utils/id.js';
import { nowIso } from '../domain/dateUtils.js';

function toRecord(validated, { id, createdAt, updatedAt }) {
  return {
    Id: id,
    Code: validated.Code,
    Name: validated.Name,
    Phone: validated.Phone,
    Region: validated.Region,
    Notes: validated.Notes,
    OpeningBalanceMinor: validated.OpeningBalanceMinor,
    IsActive: validated.IsActive,
    CreatedAt: createdAt,
    UpdatedAt: updatedAt
  };
}

export const customerService = {
  // Manual creation: Name is REQUIRED (spec §28). Code must be unique.
  async createCustomer(draft) {
    authService.assertCanCreateCustomer();
    if (authService.isEnforced() && !authService.isAdmin()) {
      draft = { ...draft, OpeningBalance: 0, OpeningBalanceMinor: 0 };
    }
    const all = await customerRepository.getAll();
    const existingCodes = new Set(all.map((c) => c.Code));
    const validation = validateCustomerDraft(draft, { existingCodes, nameRequired: true });
    if (!validation.ok) throw new AppError(validation.errors[0].code, validation.errors[0].message, { field: validation.errors[0].field, details: { errors: validation.errors } });
    const now = nowIso();
    const record = toRecord(validation.data, { id: createId(ID_PREFIX.CUSTOMER), createdAt: now, updatedAt: now });
    return customerRepository.add(record);
  },

  // Import path: a nameless customer is allowed ONLY here (spec §45).
  async createImportedCustomer(draft, { source = 'Imported' } = {}) {
    authService.assertCanManageData();
    const all = await customerRepository.getAll();
    const existingCodes = new Set(all.map((c) => c.Code));
    const validation = validateCustomerDraft(draft, { existingCodes, nameRequired: false });
    if (!validation.ok) throw new AppError(validation.errors[0].code, validation.errors[0].message, { field: validation.errors[0].field, details: { errors: validation.errors } });
    const now = nowIso();
    const record = toRecord(validation.data, { id: createId(ID_PREFIX.CUSTOMER), createdAt: now, updatedAt: now });
    record.Source = source;
    return customerRepository.add(record);
  },

  async updateCustomer(customerId, draft) {
    authService.assertCanManageData();
    const existing = await customerRepository.getById(customerId);
    if (!existing) throw new AppError(ERROR_CODE.NOT_FOUND, 'العميل غير موجود.', { field: 'CustomerId' });
    const all = await customerRepository.getAll();
    const existingCodes = new Set(all.map((c) => c.Code));
    // Name stays mandatory for records that already carry one (or are non-imported).
    const nameRequired = existing.Name !== null && existing.Name !== undefined ? true : existing.Source !== 'Imported';
    const validation = validateCustomerDraft({ ...existing, ...draft, OpeningBalance: undefined }, { existingCodes, originalCode: existing.Code, nameRequired });
    if (!validation.ok) throw new AppError(validation.errors[0].code, validation.errors[0].message, { field: validation.errors[0].field, details: { errors: validation.errors } });
    const updated = {
      ...existing,
      Code: validation.data.Code,
      Name: validation.data.Name,
      Phone: validation.data.Phone,
      Region: validation.data.Region,
      Notes: validation.data.Notes,
      IsActive: validation.data.IsActive,
      UpdatedAt: nowIso()
    };
    await customerRepository.put(updated);
    return updated;
  },

  async setActive(customerId, isActive) {
    authService.assertCanManageData();
    const existing = await customerRepository.getById(customerId);
    if (!existing) throw new AppError(ERROR_CODE.NOT_FOUND, 'العميل غير موجود.', { field: 'CustomerId' });
    if (typeof isActive !== 'boolean') throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'حالة التفعيل يجب أن تكون نعم/لا.', { field: 'IsActive' });
    const updated = { ...existing, IsActive: isActive, UpdatedAt: nowIso() };
    await customerRepository.put(updated);
    return updated;
  },

  async getCustomer(customerId) {
    authService.assertCanViewOperations(); return customerRepository.getById(customerId); },
  async getByCode(code) {
    authService.assertCanViewOperations(); return customerRepository.getByCode(code); },
  async listCustomers() { authService.assertCanViewOperations(); return customerRepository.getAll(); },

  async listSelectableCustomers() {
    authService.assertCanViewOperations();
    return (await customerRepository.getAll()).map(({ Id, Code, Name, IsActive }) => ({ Id, Code, Name, IsActive }));
  },

  async getSelectableCustomer(customerId) {
    authService.assertCanViewOperations();
    const row = await customerRepository.getById(customerId);
    return row ? { Id: row.Id, Code: row.Code, Name: row.Name, IsActive: row.IsActive } : null;
  },

  async searchCustomers(term) {
    authService.assertCanViewOperations();
    const all = await customerRepository.getAll();
    if (!term) return all;
    const needle = String(term).trim().toLowerCase();
    if (!needle) return all;
    return all.filter((c) =>
      (c.Code && String(c.Code).toLowerCase().includes(needle)) ||
      (c.Name && String(c.Name).toLowerCase().includes(needle)) ||
      (c.Phone && String(c.Phone).toLowerCase().includes(needle)) ||
      (c.Region && String(c.Region).toLowerCase().includes(needle))
    );
  },

  async listOpeningBalanceHistory(customerId) {
    authService.assertCanManageData();
    const rows = await openingBalanceRepository.listByCustomer(customerId);
    return rows.slice().sort((a, b) => String(a.ChangedAt).localeCompare(String(b.ChangedAt)));
  }
};

export { STATUS };
