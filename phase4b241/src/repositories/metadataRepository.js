import { STORE } from '../storage/schema.js';
import { runTransaction, req } from '../storage/db.js';

export const metadataRepository = {
  async get(key) {
    if (!key) return null;
    const record = await runTransaction(STORE.METADATA, 'readonly', (stores) => req(stores[STORE.METADATA].get(key)));
    return record || null;
  },
  async set(key, value) {
    const record = { Key: key, Value: value, UpdatedAt: new Date().toISOString() };
    return runTransaction(STORE.METADATA, 'readwrite', async (stores) => {
      await req(stores[STORE.METADATA].put(record));
      return record;
    });
  },
  async getAll() {
    return runTransaction(STORE.METADATA, 'readonly', (stores) => req(stores[STORE.METADATA].getAll()));
  },
  async ensureDefaults(defaults) {
    const created = [];
    for (const entry of defaults) {
      const existing = await metadataRepository.get(entry.Key);
      if (!existing) {
        await metadataRepository.set(entry.Key, entry.Value);
        created.push(entry.Key);
      }
    }
    return created;
  },
  async putMany(records) {
    return runTransaction(STORE.METADATA, 'readwrite', async (stores) => {
      for (const record of records) await req(stores[STORE.METADATA].put(record));
      return records.length;
    });
  },
  async clear() {
    return runTransaction(STORE.METADATA, 'readwrite', async (stores) => {
      await req(stores[STORE.METADATA].clear());
      return true;
    });
  }
};
