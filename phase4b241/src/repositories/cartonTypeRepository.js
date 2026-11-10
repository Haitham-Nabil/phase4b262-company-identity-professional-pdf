// Phase 4B.11 — storage access for the carton-type reference records.
// Additive: a new store, the same runTransaction / req pattern as every other
// repository, and no access to the financial stores.
import { STORE, INDEX } from '../storage/schema.js';
import { runTransaction, req } from '../storage/db.js';

export const cartonTypeRepository = {
  async add(record) {
    return runTransaction(STORE.CARTON_TYPES, 'readwrite', async (stores) => {
      await req(stores[STORE.CARTON_TYPES].add(record));
      return record;
    });
  },
  async put(record) {
    return runTransaction(STORE.CARTON_TYPES, 'readwrite', async (stores) => {
      await req(stores[STORE.CARTON_TYPES].put(record));
      return record;
    });
  },
  async getById(id) {
    if (!id) return null;
    return runTransaction(STORE.CARTON_TYPES, 'readonly', (stores) => req(stores[STORE.CARTON_TYPES].get(id)));
  },
  async getByNormalizedName(normalizedName) {
    if (!normalizedName) return null;
    return runTransaction(STORE.CARTON_TYPES, 'readonly', (stores) => req(
      stores[STORE.CARTON_TYPES].index(INDEX.cartonTypes.NORMALIZED_NAME).get(normalizedName)
    ));
  },
  async getAll() {
    return runTransaction(STORE.CARTON_TYPES, 'readonly', (stores) => req(stores[STORE.CARTON_TYPES].getAll()));
  },
  async count() {
    return runTransaction(STORE.CARTON_TYPES, 'readonly', (stores) => req(stores[STORE.CARTON_TYPES].count()));
  },
  async clear() {
    return runTransaction(STORE.CARTON_TYPES, 'readwrite', async (stores) => {
      await req(stores[STORE.CARTON_TYPES].clear());
      return true;
    });
  }
};
