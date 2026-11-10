import { STORE } from '../storage/schema.js';
import { runTransaction, req } from '../storage/db.js';

export const settingsRepository = {
  async get(key) {
    if (!key) return null;
    const record = await runTransaction(STORE.SETTINGS, 'readonly', (stores) => req(stores[STORE.SETTINGS].get(key)));
    return record || null;
  },
  async set(key, value, description = null) {
    const record = { Key: key, Value: value, Description: description, UpdatedAt: new Date().toISOString() };
    return runTransaction(STORE.SETTINGS, 'readwrite', async (stores) => {
      await req(stores[STORE.SETTINGS].put(record));
      return record;
    });
  },
  async getAll() {
    return runTransaction(STORE.SETTINGS, 'readonly', (stores) => req(stores[STORE.SETTINGS].getAll()));
  },
  async ensureDefaults(defaults) {
    const created = [];
    for (const setting of defaults) {
      const existing = await settingsRepository.get(setting.Key);
      if (!existing) {
        await settingsRepository.set(setting.Key, setting.Value, setting.Description ?? null);
        created.push(setting.Key);
      }
    }
    return created;
  },
  async putMany(records) {
    return runTransaction(STORE.SETTINGS, 'readwrite', async (stores) => {
      for (const record of records) await req(stores[STORE.SETTINGS].put(record));
      return records.length;
    });
  },
  async clear() {
    return runTransaction(STORE.SETTINGS, 'readwrite', async (stores) => {
      await req(stores[STORE.SETTINGS].clear());
      return true;
    });
  }
};
