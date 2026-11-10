// Phase 4B.6 — storage access for the append-only audit trail.
//
// Deliberately ABSENT from this repository: `put` (single-record overwrite) and any
// remove/delete helper. A recorded audit event is therefore structurally impossible
// to rewrite or erase through the data layer; the only mutation paths are `add`
// (append one event), `putMany` and `clear`, which exist solely so that a full
// Backup -> Restore replacement can reproduce the log exactly.
import { STORE, INDEX } from '../storage/schema.js';
import { runTransaction, req, makeKeyRange } from '../storage/db.js';

export const auditLogRepository = {
  async add(entry) {
    return runTransaction(STORE.AUDIT_LOG, 'readwrite', async (stores) => {
      await req(stores[STORE.AUDIT_LOG].add(entry));
      return entry;
    });
  },

  async getById(entryId) {
    if (!entryId) return null;
    return runTransaction(STORE.AUDIT_LOG, 'readonly', (stores) => req(stores[STORE.AUDIT_LOG].get(entryId)));
  },

  async listByTransaction(transactionId) {
    if (!transactionId) return [];
    const keyRange = makeKeyRange();
    return runTransaction(STORE.AUDIT_LOG, 'readonly', (stores) =>
      req(stores[STORE.AUDIT_LOG].index(INDEX.auditLog.TRANSACTION_ID).getAll(keyRange.only(transactionId)))
    );
  },

  async getAll() {
    return runTransaction(STORE.AUDIT_LOG, 'readonly', (stores) => req(stores[STORE.AUDIT_LOG].getAll()));
  },

  async count() {
    return runTransaction(STORE.AUDIT_LOG, 'readonly', (stores) => req(stores[STORE.AUDIT_LOG].count()));
  },

  // Restore-only helpers: used inside the single all-or-nothing restore transaction.
  async putMany(entries) {
    return runTransaction(STORE.AUDIT_LOG, 'readwrite', async (stores) => {
      for (const entry of entries) await req(stores[STORE.AUDIT_LOG].put(entry));
      return entries.length;
    });
  },

  async clear() {
    return runTransaction(STORE.AUDIT_LOG, 'readwrite', async (stores) => {
      await req(stores[STORE.AUDIT_LOG].clear());
      return true;
    });
  }
};
