// Phase 4B.11 — the ONE services-layer place that turns a stored crop movement into
// the facts and the Arabic wording the customer statement shows.
//
// Why it lives here and not in the view: the statement row is prepared by balanceService,
// the wording is produced here, and the view only escapes and prints. This removes the
// duplication that produced a statement line without the carton count, and it keeps every
// read of a stored value in one auditable function.
//
// Nothing here performs a financial calculation: no amount, no debit / credit, no cash
// figure and no balance is produced or changed. A carton purchase is described by its
// COUNT — never by a weight. A local purchase is described by its package count and the
// net weight produced by the package weight STORED on that row.
import { formatText, formatQuantityTrimmed, formatMoneyMinor } from '../utils/formatting.js';

// Two explicit states, kept apart on purpose: a value the row never had is «غير محدد»,
// and a value the row had but that can no longer be read is «سجل غير متاح». Neither is
// ever replaced by an invented name or number.
export const UNSPECIFIED = 'غير محدد';
export const UNAVAILABLE = 'سجل غير متاح';

// Quantity facts of a carton purchase, read straight from the stored row.
export function cartonMovementFacts(row = {}) {
  const quantityMilli = Number.isInteger(row.CartonQuantityMilli) ? row.CartonQuantityMilli : null;
  return { QuantityMilli: quantityMilli, Resolved: quantityMilli !== null };
}

// Arabic counted noun for «كرتونة»: 1 → كرتونة واحدة, 2 → كرتونتان, 3..10 → N كراتين,
// anything else → N كرتونة. Presentation only; the number is the stored value.
export function cartonCountLabel(quantityMilli) {
  if (!Number.isInteger(quantityMilli)) return null;
  const count = quantityMilli / 1000;
  if (!Number.isFinite(count)) return null;
  if (count === 1) return 'كرتونة واحدة';
  if (count === 2) return 'كرتونتان';
  const text = formatQuantityTrimmed(quantityMilli);
  if (Number.isInteger(count) && count >= 3 && count <= 10) return `${text} كراتين`;
  return `${text} كرتونة`;
}

// The name of a reference record as the row resolves it today, with its state appended
// when it is no longer active. An id that resolves to nothing is reported as unavailable,
// and a row that carries no id at all is reported as unspecified.
function referenceLabel(name, id, isActive) {
  const text = formatText(name);
  if (text) return isActive === false ? `${text} (غير نشطة)` : text;
  return id ? UNAVAILABLE : UNSPECIFIED;
}

// Carton purchase: receiving company + carton type + stored carton count + stored unit price.
export function cartonReferenceParts(row = {}) {
  const facts = cartonMovementFacts(row);
  const label = cartonCountLabel(facts.QuantityMilli);
  return [
    `الشركة المستلمة: ${referenceLabel(row.ReceivingCompanyName, row.ReceivingCompanyId, row.ReceivingCompanyActive)}`,
    `نوع الكرتونة: ${referenceLabel(row.CartonTypeName, row.CartonTypeId, row.CartonTypeActive)}`,
    label ? `العدد: ${label}` : 'عدد الكراتين غير محدد',
    Number.isInteger(row.CartonUnitPriceMinor) ? `سعر الكرتونة: ${formatMoneyMinor(row.CartonUnitPriceMinor)} ج` : 'سعر الكرتونة غير محدد'
  ];
}

// Local crop purchase: variety + package count + FINAL net weight + stored price/kg. The package-unit
// weight is not the movement's weight and is never shown here.
//
// Phase 4B.13.1 — the variety name comes from the record the stored id resolves to. A row
// that carries no id reports «غير محدد» (nothing is invented), and an id that resolves to
// nothing reports «سجل غير متاح»; a deactivated variety is still named, with its state.
export function localReferenceParts(row = {}) {
  const parts = [];
  parts.push(`صنف الفراولة: ${referenceLabel(row.StrawberryVarietyName, row.StrawberryVarietyId, row.StrawberryVarietyActive)}`);
  if (Number.isInteger(row.PackageCountMilli)) {
    parts.push(`عدد العبوات: ${formatQuantityTrimmed(row.PackageCountMilli)}`);
  }
  if (row.CropWeightResolved === true && Number.isInteger(row.CropNetWeightMilli)) {
    parts.push(`الوزن الصافي: ${formatQuantityTrimmed(row.CropNetWeightMilli)} كجم`);
  } else {
    parts.push('الوزن الصافي غير محسوم (حركة سابقة لحفظ وزن العبوة)');
  }
  parts.push(Number.isInteger(row.LocalUnitPriceMinor) ? `سعر الكيلو: ${formatMoneyMinor(row.LocalUnitPriceMinor)} ج` : 'سعر الكيلو غير محدد');
  return parts;
}

// The one entry point the statement uses. Any other type contributes no reference line.
export function referencePartsFor(row = {}) {
  if (row.TransactionType === 'CropPurchaseCarton') return cartonReferenceParts(row);
  if (row.TransactionType === 'CropPurchaseLocal') return localReferenceParts(row);
  return [];
}

export const movementNotes = { UNSPECIFIED, UNAVAILABLE, cartonMovementFacts, cartonCountLabel, cartonReferenceParts, localReferenceParts, referencePartsFor };
