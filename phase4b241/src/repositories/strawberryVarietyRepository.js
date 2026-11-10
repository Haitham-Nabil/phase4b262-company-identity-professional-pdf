// Phase 4B.13.1 — storage access for the strawberry-variety reference records.
// Additive: a new store, the same runTransaction / req pattern as every other
// repository, and no access to the financial stores.
import { STORE, INDEX } from '../storage/schema.js';
import { runTransaction, req } from '../storage/db.js';

export const strawberryVarietyRepository = {
  async add(record) {
    return runTransaction(STORE.STRAWBERRY_VARIETIES, 'readwrite', async (stores) => {
      await req(stores[STORE.STRAWBERRY_VARIETIES].add(record));
      return record;
    });
  },
  async put(record) {
    return runTransaction(STORE.STRAWBERRY_VARIETIES, 'readwrite', async (stores) => {
      await req(stores[STORE.STRAWBERRY_VARIETIES].put(record));
      return record;
    });
  },
  async getById(id) {
    if (!id) return null;
    return runTransaction(STORE.STRAWBERRY_VARIETIES, 'readonly', (stores) => req(stores[STORE.STRAWBERRY_VARIETIES].get(id)));
  },
  async getByNormalizedName(normalizedName) {
    if (!normalizedName) return null;
    return runTransaction(STORE.STRAWBERRY_VARIETIES, 'readonly', (stores) => req(
      stores[STORE.STRAWBERRY_VARIETIES].index(INDEX.strawberryVarieties.NORMALIZED_NAME).get(normalizedName)
    ));
  },
  async getAll() {
    return runTransaction(STORE.STRAWBERRY_VARIETIES, 'readonly', (stores) => req(stores[STORE.STRAWBERRY_VARIETIES].getAll()));
  },
  async count() {
    return runTransaction(STORE.STRAWBERRY_VARIETIES, 'readonly', (stores) => req(stores[STORE.STRAWBERRY_VARIETIES].count()));
  },
  async clear() {
    return runTransaction(STORE.STRAWBERRY_VARIETIES, 'readwrite', async (stores) => {
      await req(stores[STORE.STRAWBERRY_VARIETIES].clear());
      return true;
    });
  }
};
