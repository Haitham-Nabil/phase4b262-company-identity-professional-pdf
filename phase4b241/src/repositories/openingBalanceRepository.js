import { STORE, INDEX } from '../storage/schema.js';
import { runTransaction, req, makeKeyRange } from '../storage/db.js';

export const openingBalanceRepository = {
  async add(entry) {
    return runTransaction(STORE.OPENING_BALANCE_HISTORY, 'readwrite', async (stores) => {
      await req(stores[STORE.OPENING_BALANCE_HISTORY].add(entry));
      return entry;
    });
  },
  async putMany(entries) {
    return runTransaction(STORE.OPENING_BALANCE_HISTORY, 'readwrite', async (stores) => {
      for (const entry of entries) await req(stores[STORE.OPENING_BALANCE_HISTORY].put(entry));
      return entries.length;
    });
  },
  async listByCustomer(customerId) {
    if (!customerId) return [];
    const keyRange = makeKeyRange();
    return runTransaction(STORE.OPENING_BALANCE_HISTORY, 'readonly', (stores) =>
      req(stores[STORE.OPENING_BALANCE_HISTORY].index(INDEX.openingBalanceHistory.CUSTOMER_ID).getAll(keyRange.only(customerId)))
    );
  },
  async getAll() {
    return runTransaction(STORE.OPENING_BALANCE_HISTORY, 'readonly', (stores) => req(stores[STORE.OPENING_BALANCE_HISTORY].getAll()));
  },
  async count() {
    return runTransaction(STORE.OPENING_BALANCE_HISTORY, 'readonly', (stores) => req(stores[STORE.OPENING_BALANCE_HISTORY].count()));
  },
  async clear() {
    return runTransaction(STORE.OPENING_BALANCE_HISTORY, 'readwrite', async (stores) => {
      await req(stores[STORE.OPENING_BALANCE_HISTORY].clear());
      return true;
    });
  }
};
