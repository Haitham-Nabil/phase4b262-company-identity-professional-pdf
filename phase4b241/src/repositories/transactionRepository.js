import { STORE, INDEX } from '../storage/schema.js';
import { runTransaction, req, makeKeyRange } from '../storage/db.js';

export const transactionRepository = {
  async add(transaction) {
    return runTransaction(STORE.TRANSACTIONS, 'readwrite', async (stores) => {
      await req(stores[STORE.TRANSACTIONS].add(transaction));
      return transaction;
    });
  },
  async put(transaction) {
    return runTransaction(STORE.TRANSACTIONS, 'readwrite', async (stores) => {
      await req(stores[STORE.TRANSACTIONS].put(transaction));
      return transaction;
    });
  },
  async putMany(transactions) {
    return runTransaction(STORE.TRANSACTIONS, 'readwrite', async (stores) => {
      for (const transaction of transactions) await req(stores[STORE.TRANSACTIONS].put(transaction));
      return transactions.length;
    });
  },
  async getById(transactionId) {
    if (!transactionId) return null;
    return runTransaction(STORE.TRANSACTIONS, 'readonly', (stores) => req(stores[STORE.TRANSACTIONS].get(transactionId)));
  },
  async listByCustomer(customerId) {
    if (!customerId) return [];
    const keyRange = makeKeyRange();
    return runTransaction(STORE.TRANSACTIONS, 'readonly', (stores) =>
      req(stores[STORE.TRANSACTIONS].index(INDEX.transactions.CUSTOMER_ID).getAll(keyRange.only(customerId)))
    );
  },
  async listByLinkId(linkId) {
    if (!linkId) return [];
    const keyRange = makeKeyRange();
    return runTransaction(STORE.TRANSACTIONS, 'readonly', (stores) =>
      req(stores[STORE.TRANSACTIONS].index(INDEX.transactions.LINK_ID).getAll(keyRange.only(linkId)))
    );
  },
  async getAll() {
    return runTransaction(STORE.TRANSACTIONS, 'readonly', (stores) => req(stores[STORE.TRANSACTIONS].getAll()));
  },
  async count() {
    return runTransaction(STORE.TRANSACTIONS, 'readonly', (stores) => req(stores[STORE.TRANSACTIONS].count()));
  },
  async clear() {
    return runTransaction(STORE.TRANSACTIONS, 'readwrite', async (stores) => {
      await req(stores[STORE.TRANSACTIONS].clear());
      return true;
    });
  }
};
