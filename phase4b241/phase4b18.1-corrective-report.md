# Phase 4B.18.1 — Local Crop Report Accuracy Fix

## Scope
Applied the two requested corrections only:
1. Explicitly distinguish stored net weight from weight derived from complete historical components in the detail table.
2. Prevent derivation when any required historical component is missing or invalid.

## Files changed
- `src/services/cropReportService.js`
  - `resolveStoredWeight()` now gives priority to a valid stored `NetWeightMilli`.
  - Derivation requires present, non-null, valid `LocalUnitsMilli`, `PackageWeightKg`, `LocalDeductionKgMilli`, and `LocalLooseKgMilli` values.
  - Missing values are no longer silently converted to zero.
  - Invalid/negative values and deductions greater than the stored package weight remain unresolved.
  - Derived values use the source marker `DerivedFromStoredComponents`.
- `ui/views/reportCropLocal.js`
  - Detail rows visibly label resolved weights as `مخزن تاريخيًا` or `مشتق من المكونات التاريخية`.
  - Unresolved rows continue to show `الوزن غير محسوم`.
- `tests/cropReports.test.js`
  - Added tests 37–40 for complete derivation, each missing component, stored-weight precedence, invalid components, and visible UI labels.

## Validation performed
- `node --check src/services/cropReportService.js` — PASS
- `node --check ui/views/reportCropLocal.js` — PASS
- `node --check tests/cropReports.test.js` — PASS
- Direct runtime checks of `resolveStoredWeight()` for complete components, each missing component, and stored-weight precedence — PASS
- Direct rendering check confirming all three Arabic source/status labels appear in detail HTML — PASS

## Test limitation
Attempted `node --test tests/cropReports.test.js`. The suite could not start because the ZIP does not contain installed dependencies and `fake-indexeddb` was unavailable (`ERR_MODULE_NOT_FOUND`). An `npm install` attempt timed out in this environment. Therefore the full test suite and browser tests are **not claimed as passed**. `package-lock.json` was verified unchanged.

## Protected areas
No changes were made to Schema, DB_VERSION, migrations, IndexedDB stores, financial services, amount calculation, settings, carton reports, or Dashboard.
