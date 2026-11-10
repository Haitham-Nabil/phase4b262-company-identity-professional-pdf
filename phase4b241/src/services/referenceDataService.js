import { authService } from './authService.js';
// Phase 4B.11 — management of the two reference catalogues: receiving companies and
// carton types.
//
// Neither operation here touches the financial stores: creating, renaming or deactivating
// a reference record writes exactly ONE row in its own store and no movement, so it can
// never create a balance, a cash effect or a settlement. Inactive records are never
// deleted, so a historical movement keeps resolving the name it was recorded with.
//
// The factories below build the two services from the same rules; the only differences
// are the store, the id prefix and the Arabic wording.
import { receivingCompanyRepository } from '../repositories/receivingCompanyRepository.js';
import { cartonTypeRepository } from '../repositories/cartonTypeRepository.js';
import { strawberryVarietyRepository } from '../repositories/strawberryVarietyRepository.js';
import { REFERENCE_KIND, REFERENCE_LABEL_AR, requireReferenceName, cleanReferenceName } from '../domain/referenceRecords.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';
import { createId, ID_PREFIX } from '../utils/id.js';
import { nowIso } from '../domain/dateUtils.js';

function byName(a, b) {
  return cleanReferenceName(a.Name).localeCompare(cleanReferenceName(b.Name), 'ar');
}

function createReferenceService({ kind, repository, idPrefix }) {
  const label = REFERENCE_LABEL_AR[kind];
  const service = {
    Kind: kind,

    // Both catalogues are read in full; the screen decides where to show the inactive
    // ones. Nothing here filters by itself, so a historical movement can still resolve.
    async list() {
      const rows = await repository.getAll();
      return rows.slice().sort(byName);
    },

    async listActive() {
      return (await service.list()).filter((row) => row.IsActive === true);
    },

    async get(id) {
      return repository.getById(id);
    },

    async create(name) {
      authService.assertCanManageData();
      const cleaned = requireReferenceName(name, kind);
      const existing = await repository.getByNormalizedName(cleaned.NormalizedName);
      if (existing) {
        throw new AppError(ERROR_CODE.CONFLICT, `${label} بهذا الاسم موجود بالفعل: ${existing.Name}.`, { field: 'Name', details: { Id: existing.Id } });
      }
      const now = nowIso();
      const record = {
        Id: createId(idPrefix),
        Name: cleaned.Name,
        NormalizedName: cleaned.NormalizedName,
        IsActive: true,
        CreatedAt: now,
        UpdatedAt: now
      };
      await repository.add(record);
      return record;
    },

    // The name may change; the identity may not.
    async rename(id, name) {
      authService.assertCanManageData();
      const existing = await repository.getById(id);
      if (!existing) throw new AppError(ERROR_CODE.NOT_FOUND, `${label} غير موجودة.`, { field: 'Id' });
      const cleaned = requireReferenceName(name, kind);
      const duplicate = await repository.getByNormalizedName(cleaned.NormalizedName);
      if (duplicate && duplicate.Id !== existing.Id) {
        throw new AppError(ERROR_CODE.CONFLICT, `${label} بهذا الاسم موجود بالفعل: ${duplicate.Name}.`, { field: 'Name', details: { Id: duplicate.Id } });
      }
      const updated = {
        ...existing,
        Id: existing.Id,
        CreatedAt: existing.CreatedAt,
        Name: cleaned.Name,
        NormalizedName: cleaned.NormalizedName,
        UpdatedAt: nowIso()
      };
      await repository.put(updated);
      return updated;
    },

    // Deactivation replaces deletion: the rows referencing it stay readable.
    async setActive(id, isActive) {
      authService.assertCanManageData();
      const existing = await repository.getById(id);
      if (!existing) throw new AppError(ERROR_CODE.NOT_FOUND, `${label} غير موجودة.`, { field: 'Id' });
      if (typeof isActive !== 'boolean') {
        throw new AppError(ERROR_CODE.VALIDATION_ERROR, `حالة ${label} يجب أن تكون نشطة أو غير نشطة.`, { field: 'IsActive' });
      }
      if (existing.IsActive === isActive) return existing;
      const updated = { ...existing, IsActive: isActive, UpdatedAt: nowIso() };
      await repository.put(updated);
      return updated;
    },

    async deactivate(id) {
      return service.setActive(id, false);
    },

    // Used by the movement path. A missing id is a NOT_FOUND; an inactive one is a
    // business-rule refusal, so an inactive record can never enter a NEW movement while
    // the historical rows that already reference it stay perfectly readable.
    async requireActive(id, field = 'Id') {
      const record = await repository.getById(id);
      if (!record) throw new AppError(ERROR_CODE.NOT_FOUND, `${label} غير موجودة.`, { field });
      if (record.IsActive !== true) {
        throw new AppError(ERROR_CODE.BUSINESS_RULE_ERROR, `${label} غير نشطة؛ لا يمكن استخدامها في حركة جديدة.`, { field });
      }
      return record;
    }
  };
  return service;
}

export const receivingCompanyService = createReferenceService({
  kind: REFERENCE_KIND.RECEIVING_COMPANY,
  repository: receivingCompanyRepository,
  idPrefix: ID_PREFIX.RECEIVING_COMPANY
});

export const cartonTypeService = createReferenceService({
  kind: REFERENCE_KIND.CARTON_TYPE,
  repository: cartonTypeRepository,
  idPrefix: ID_PREFIX.CARTON_TYPE
});

// Phase 4B.13.1 — the strawberry varieties, built by the SAME factory and therefore under
// exactly the same rules (unique normalised name, rename keeps the identity, deactivation
// instead of deletion, active-only for a new movement, history always resolvable).
export const strawberryVarietyService = createReferenceService({
  kind: REFERENCE_KIND.STRAWBERRY_VARIETY,
  repository: strawberryVarietyRepository,
  idPrefix: ID_PREFIX.STRAWBERRY_VARIETY
});

export const referenceDataService = {
  receivingCompanies: receivingCompanyService,
  cartonTypes: cartonTypeService,
  strawberryVarieties: strawberryVarietyService
};
