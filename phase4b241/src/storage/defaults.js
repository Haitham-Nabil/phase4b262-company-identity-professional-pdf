// Seed values. This module is the ONLY place where the literal 14 (kg) exists;
// business logic always reads DefaultPackageWeight from the settings store.
export const SETTING_KEYS = Object.freeze({
  DEFAULT_PACKAGE_WEIGHT: 'DefaultPackageWeight',
  COMPANY_NAME: 'CompanyName'
});

export const METADATA_KEYS = Object.freeze({
  SCHEMA_VERSION: 'SchemaVersion',
  INITIALIZED_AT: 'InitializedAt',
  LAST_BACKUP_AT: 'LastBackupAt'
});

export const DEFAULT_SETTINGS = Object.freeze([
  Object.freeze({
    Key: SETTING_KEYS.DEFAULT_PACKAGE_WEIGHT,
    Value: 14,
    Description: 'الوزن الافتراضي للعبوة (كجم) - يُستخدم في حساب صافي وزن المحصول المحلي'
  }),
  Object.freeze({ Key: SETTING_KEYS.COMPANY_NAME, Value: '', Description: 'اسم الشركة الظاهر في التطبيق والتقارير' })
]);

export function createDefaultMetadata(schemaVersion) {
  return [
    { Key: METADATA_KEYS.SCHEMA_VERSION, Value: schemaVersion },
    { Key: METADATA_KEYS.INITIALIZED_AT, Value: new Date().toISOString() },
    { Key: METADATA_KEYS.LAST_BACKUP_AT, Value: null }
  ];
}
