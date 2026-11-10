import { netWeightMilli, weightTimesPriceMinor, cartonTotalMinor, toMinor, QTY_FACTOR, MONEY_FACTOR } from '../domain/money.js';
import { settingsService } from './settingsService.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';

// PURE domain helpers (unit-testable without storage).
export function computeLocalNetWeightMilli({ units, looseKg, deductionKg, packageWeightKg }) {
  return netWeightMilli({ units, looseKg, deductionKg, packageWeightKg });
}
export function computeLocalTotalMinor({ netWeight, unitPrice }) {
  return weightTimesPriceMinor(netWeight, toMinor(unitPrice, MONEY_FACTOR, 'سعر الوحدة'));
}
export function computeCartonTotalMinor({ quantity, discount, unitPrice }) {
  return cartonTotalMinor({ quantity, discount, unitPrice });
}

// Crop purchase G is DERIVED: never accepted from the user (spec Phase 2 §12.1).
export const cropPurchaseService = {
  // Phase 4B.11 — `packageWeightKg` may be supplied by the caller. At CREATION time the
  // caller passes the default read from Settings (stored on the row from then on); when
  // EDITING a movement whose historical weight is confirmed, the caller passes THAT
  // stored weight, so a later change of the setting can never alter an old movement.
  // When it is omitted the setting is read, exactly as before.
  async previewLocal({ units, looseKg, deductionKg, unitPrice, packageWeightKg: weightOverride = null }) {
    if (deductionKg !== undefined && deductionKg !== null && deductionKg < 0) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'خصم الكيلو لا يمكن أن يكون سالبًا.', { field: 'DeductionKg' });
    const packageWeightKg = Number.isFinite(weightOverride) && weightOverride > 0
      ? weightOverride
      : await settingsService.getDefaultPackageWeight();
    if (deductionKg > packageWeightKg) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'خصم الكيلو لا يمكن أن يكون أكبر من الوزن الافتراضي للعبوة.', { field: 'DeductionKg' });
    const netWeight = computeLocalNetWeightMilli({ units, looseKg, deductionKg, packageWeightKg });
    if (netWeight < 0) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'صافي الوزن المحسوب لا يمكن أن يكون سالبًا.', { field: 'NetWeight' });
    const totalMinor = computeLocalTotalMinor({ netWeight, unitPrice });
    return { packageWeightKg, NetWeightMilli: netWeight, LocalTotalMinor: totalMinor };
  },

  // The value is COMPUTED here and nowhere else: it is never accepted as input.
  async computeLocalAmountMinor({ units, looseKg, deductionKg, unitPrice, packageWeightKg = null }) {
    const preview = await cropPurchaseService.previewLocal({ units, looseKg, deductionKg, unitPrice, packageWeightKg });
    if (preview.LocalTotalMinor <= 0) {
      throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'قيمة مشتريات المحصول المحسوبة يجب أن تكون أكبر من صفر.', { field: 'Amount' });
    }
    return preview.LocalTotalMinor;
  },

  // The stored net weight of a new local movement (Phase 4B.11). Pure delegation to
  // the approved formula; nothing is derived here and no rounding is re-implemented.
  previewLocalNetWeight({ units, looseKg, deductionKg, packageWeightKg }) {
    return computeLocalNetWeightMilli({ units, looseKg, deductionKg, packageWeightKg });
  },

  // Phase 4B.11 — the DISPLAY FACTS of an already stored local crop purchase.
  //  · PackageCountMilli — the package count as stored on the row (D).
  //  · NetWeightMilli    — the net weight produced by the STORED package weight, computed
  //    here by the same approved formula. The current DefaultPackageWeight is NEVER read,
  //    so changing the setting later cannot rewrite a past movement.
  //  · Resolved          — false when the row has no package weight at all (a movement
  //    recorded before the weight was frozen). The caller must then show an explicit
  //    "unresolved" state instead of a number.
  localMovementFacts(row = {}) {
    const unitsMilli = Number.isInteger(row.LocalUnitsMilli) ? row.LocalUnitsMilli : null;
    const confirmed = row.PackageWeightStatus === 'Confirmed'
      && Number.isFinite(row.PackageWeightKg) && row.PackageWeightKg > 0;
    let netWeightMilli = Number.isInteger(row.NetWeightMilli) && row.NetWeightMilli >= 0 ? row.NetWeightMilli : null;
    let resolved = netWeightMilli !== null;
    if (confirmed) {
      netWeightMilli = computeLocalNetWeightMilli({
        units: unitsMilli === null ? 0 : unitsMilli / 1000,
        looseKg: (Number.isInteger(row.LocalLooseKgMilli) ? row.LocalLooseKgMilli : 0) / 1000,
        deductionKg: (Number.isInteger(row.LocalDeductionKgMilli) ? row.LocalDeductionKgMilli : 0) / 1000,
        packageWeightKg: row.PackageWeightKg
      });
      resolved = true;
    }
    return { PackageCountMilli: unitsMilli, NetWeightMilli: netWeightMilli, Resolved: resolved };
  },

  computeCartonAmountMinor({ quantity, discount, unitPrice }) {
    const total = computeCartonTotalMinor({ quantity, discount, unitPrice });
    if (total <= 0) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'إجمالي الكرتون المحسوب يجب أن يكون أكبر من صفر.', { field: 'Amount' });
    return total;
  },

  // Inputs still required by the storage model for a local purchase row.
  buildLocalCropFields({ units, looseKg, deductionKg, unitPrice }) {
    return {
      LocalUnitsMilli: toMinor(units, QTY_FACTOR, 'عدد العبوات'),
      LocalLooseKgMilli: toMinor(looseKg, QTY_FACTOR, 'الكيلو السائب'),
      LocalDeductionKgMilli: toMinor(deductionKg, QTY_FACTOR, 'خصم الكيلو'),
      LocalUnitPriceMinor: toMinor(unitPrice, MONEY_FACTOR, 'سعر الوحدة')
    };
  },

  buildCartonCropFields({ quantity, discount, unitPrice }) {
    return {
      CartonQuantityMilli: toMinor(quantity, QTY_FACTOR, 'الكمية'),
      CartonUnitPriceMinor: toMinor(unitPrice, MONEY_FACTOR, 'السعر'),
      CartonDiscountMinor: toMinor(discount, MONEY_FACTOR, 'خصم المبلغ')
    };
  }
};
