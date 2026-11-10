import { openDatabase, closeDatabase, deleteDatabase, inspectSchema, getDatabaseName, getDatabaseVersion } from '../storage/db.js';
import { DB_VERSION } from '../storage/schema.js';
import { settingsRepository } from '../repositories/settingsRepository.js';
import { metadataRepository } from '../repositories/metadataRepository.js';
import { DEFAULT_SETTINGS, createDefaultMetadata, METADATA_KEYS } from '../storage/defaults.js';
import { logger } from '../utils/logger.js';

// First run: create DB, initialise stores, metadata and default settings.
// No fake customers, no fake transactions are ever created.
export const databaseInit = {
  async initialize() {
    const db = await openDatabase();
    const schema = await inspectSchema();
    const missing = schema.expectedStores.filter((name) => !schema.stores.includes(name));
    if (missing.length) {
      throw new Error(`Missing object stores after upgrade: ${missing.join(', ')}`);
    }
    const createdSettings = await settingsRepository.ensureDefaults(DEFAULT_SETTINGS);
    const createdMetadata = await metadataRepository.ensureDefaults(createDefaultMetadata(DB_VERSION));
    logger.info('database initialized', { name: getDatabaseName(), version: db.version, createdSettings, createdMetadata });
    return {
      name: getDatabaseName(), version: getDatabaseVersion(), stores: schema.stores, indexes: schema.indexes,
      createdSettings, createdMetadata
    };
  },
  async getInfo() {
    const schema = await inspectSchema();
    const metadata = await metadataRepository.getAll();
    return { schema, metadata };
  },
  async close() { return closeDatabase(); },
  async drop() {
    // Destructive helper used ONLY by tests.
    const removed = await deleteDatabase();
    return removed;
  },
  METADATA_KEYS
};
