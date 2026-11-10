// Phase 4B.11 — storage access for the receiving-company reference records.
// Additive: a new store, the same runTransaction / req pattern as every other
// repository, and no access to the financial stores.
import { STORE, INDEX } from '../storage/schema.js';
import { runTransaction, req } from '../storage/db.js';

export const receivingCompanyRepository = {
  async add(record) {
    return runTransaction(STORE.RECEIVING_COMPANIES, 'readwrite', async (stores) => {
      await req(stores[STORE.RECEIVING_COMPANIES].add(record));
      return record;
    });
  },
  async put(record) {
    return runTransaction(STORE.RECEIVING_COMPANIES, 'readwrite', async (stores) => {
      await req(stores[STORE.RECEIVING_COMPANIES].put(record));
      return record;
    });
  },
  async getById(id) {
    if (!id) return null;
    return runTransaction(STORE.RECEIVING_COMPANIES, 'readonly', (stores) => req(stores[STORE.RECEIVING_COMPANIES].get(id)));
  },
  async getByNormalizedName(normalizedName) {
    if (!normalizedName) return null;
    return runTransaction(STORE.RECEIVING_COMPANIES, 'readonly', (stores) => req(
      stores[STORE.RECEIVING_COMPANIES].index(INDEX.receivingCompanies.NORMALIZED_NAME).get(normalizedName)
    ));
  },
  async getAll() {
    return runTransaction(STORE.RECEIVING_COMPANIES, 'readonly', (stores) => req(stores[STORE.RECEIVING_COMPANIES].getAll()));
  },
  async count() {
    return runTransaction(STORE.RECEIVING_COMPANIES, 'readonly', (stores) => req(stores[STORE.RECEIVING_COMPANIES].count()));
  },
  async clear() {
    return runTransaction(STORE.RECEIVING_COMPANIES, 'readwrite', async (stores) => {
      await req(stores[STORE.RECEIVING_COMPANIES].clear());
      return true;
    });
  }
};
