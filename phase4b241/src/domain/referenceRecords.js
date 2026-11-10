// Phase 4B.11 — pure rules for the two reference records introduced by this phase.
//
// A "receiving company" is the party the crop is DELIVERED TO (the company whose
// packaging is used). It is deliberately NOT a carton supplier and NOT a farmer: it has
// its own identity, its own store and no financial meaning of its own.
// A "carton type" is the packaging the crop was packed in. The two records are
// independent: a carton type is never owned by one company.
import { AppError, ERROR_CODE } from './errors.js';

export const REFERENCE_KIND = Object.freeze({
  RECEIVING_COMPANY: 'ReceivingCompany',
  CARTON_TYPE: 'CartonType',
  // Phase 4B.13.1 — the agricultural variety of a LOCAL crop purchase. It describes the
  // crop (Fortuna / Sensation / Florida …); it is not a processing type, not a state and
  // it carries no weight, no capacity and no financial meaning of its own.
  STRAWBERRY_VARIETY: 'StrawberryVariety'
});

export const REFERENCE_LABEL_AR = Object.freeze({
  ReceivingCompany: 'الشركة المستلمة للمحصول',
  CartonType: 'نوع الكرتونة',
  StrawberryVariety: 'صنف الفراولة'
});

// Trim, collapse inner whitespace, lower-case. Arabic has no case, so this only makes
// Latin-script names case-insensitive; it never changes the stored display name.
export function normalizeReferenceName(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

export function cleanReferenceName(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

// A reference name is required. An empty / whitespace-only name is refused here, before
// any storage call, so the message is the domain's and not the engine's.
export function requireReferenceName(value, kind = REFERENCE_KIND.RECEIVING_COMPANY) {
  const name = cleanReferenceName(value);
  if (!name) {
    throw new AppError(
      ERROR_CODE.VALIDATION_ERROR,
      `اسم ${REFERENCE_LABEL_AR[kind]} مطلوب ولا يمكن أن يكون فارغًا.`,
      { field: 'Name' }
    );
  }
  return { Name: name, NormalizedName: normalizeReferenceName(name) };
}

export function referenceDisplayName(record) {
  if (!record) return null;
  const name = cleanReferenceName(record.Name);
  return name || null;
}
