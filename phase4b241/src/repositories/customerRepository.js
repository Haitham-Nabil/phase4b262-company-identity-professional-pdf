import { STORE, INDEX } from '../storage/schema.js';
import { runTransaction, req } from '../storage/db.js';

export const customerRepository = {
  async add(customer) {
    return runTransaction(STORE.CUSTOMERS, 'readwrite', async (stores) => {
      await req(stores[STORE.CUSTOMERS].add(customer));
      return customer;
    });
  },
  async put(customer) {
    return runTransaction(STORE.CUSTOMERS, 'readwrite', async (stores) => {
      await req(stores[STORE.CUSTOMERS].put(customer));
      return customer;
    });
  },
  async putMany(customers) {
    return runTransaction(STORE.CUSTOMERS, 'readwrite', async (stores) => {
      for (const customer of customers) await req(stores[STORE.CUSTOMERS].put(customer));
      return customers.length;
    });
  },
  async getById(customerId) {
    if (!customerId) return null;
    return runTransaction(STORE.CUSTOMERS, 'readonly', (stores) => req(stores[STORE.CUSTOMERS].get(customerId)));
  },
  async getByCode(code) {
    if (!code) return null;
    return runTransaction(STORE.CUSTOMERS, 'readonly', (stores) => req(stores[STORE.CUSTOMERS].index(INDEX.customers.CODE).get(code)));
  },
  async getAll() {
    return runTransaction(STORE.CUSTOMERS, 'readonly', (stores) => req(stores[STORE.CUSTOMERS].getAll()));
  },
  async count() {
    return runTransaction(STORE.CUSTOMERS, 'readonly', (stores) => req(stores[STORE.CUSTOMERS].count()));
  },
  async clear() {
    return runTransaction(STORE.CUSTOMERS, 'readwrite', async (stores) => {
      await req(stores[STORE.CUSTOMERS].clear());
      return true;
    });
  }
};
