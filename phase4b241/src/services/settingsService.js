import { settingsRepository } from '../repositories/settingsRepository.js';
import { SETTING_KEYS, DEFAULT_SETTINGS } from '../storage/defaults.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';
import { isFiniteNumber } from '../domain/money.js';

// DefaultPackageWeight ALWAYS comes from settings; no literal in business logic.
export const settingsService = {
  async getDefaultPackageWeight() {
    const record = await settingsRepository.get(SETTING_KEYS.DEFAULT_PACKAGE_WEIGHT);
    if (!record) throw new AppError(ERROR_CODE.NOT_FOUND, 'إعداد الوزن الافتراضي للعبوة غير موجود؛ يجب تهيئة قاعدة البيانات.', { field: 'DefaultPackageWeight' });
    const value = Number(record.Value);
    if (!isFiniteNumber(value) || value <= 0) throw new AppError(ERROR_CODE.STORAGE_ERROR, 'قيمة الوزن الافتراضي للعبوة غير صالحة.', { field: 'DefaultPackageWeight' });
    return value;
  },
  async getCompanyName() {
    const record = await settingsRepository.get(SETTING_KEYS.COMPANY_NAME);
    return typeof record?.Value === 'string' ? record.Value.trim() : '';
  },
  async setCompanyName(value) {
    const { authService } = await import('./authService.js'); authService.assertCanManageData();
    const name = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (!name) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'اسم الشركة مطلوب.', { field: 'CompanyName' });
    if (name.length > 120) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'اسم الشركة يجب ألا يتجاوز 120 حرفًا.', { field: 'CompanyName' });
    const record = await settingsRepository.set(SETTING_KEYS.COMPANY_NAME, name, 'اسم الشركة الظاهر في التطبيق والتقارير');
    return { Key: record.Key, Value: name };
  },
  async setDefaultPackageWeight(value) {
    const { authService } = await import('./authService.js'); authService.assertCanManageData();
    if (!isFiniteNumber(value) || value <= 0) throw new AppError(ERROR_CODE.VALIDATION_ERROR, 'الوزن الافتراضي للعبوة يجب أن يكون رقمًا أكبر من صفر.', { field: 'DefaultPackageWeight' });
    const record = await settingsRepository.set(SETTING_KEYS.DEFAULT_PACKAGE_WEIGHT, value, 'الوزن الافتراضي للعبوة (كجم)');
    return { Key: record.Key, Value: value };
  },
  async list() { return settingsRepository.getAll(); },
  async ensureDefaults() { return settingsRepository.ensureDefaults(DEFAULT_SETTINGS); }
};
