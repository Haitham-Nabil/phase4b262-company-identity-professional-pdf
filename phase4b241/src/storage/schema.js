// Single source of truth for the IndexedDB schema.
export const DB_NAME = 'CustomerAccountsDB';
// Phase 4B.6 — version 2 added ONE new object store (the audit trail).
// Phase 4B.11 — version 3 adds TWO reference stores (receiving companies and carton
// types) and nothing else. Both upgrades are purely additive: every existing store,
// index and record is preserved, `createSchema` below only creates what is missing, and
// `migrateSchema` only ADDS a status marker to legacy local-crop rows (it never writes a
// weight, never touches an amount and never deletes anything).
// Phase 4B.13.1 — version 4 adds ONE reference store (the strawberry varieties of a
// local crop purchase). Additive again: no existing store, index or record is touched and
// no data migration is required, because a local movement recorded before this phase
// simply carries no `StrawberryVarietyId` and is therefore reported as «غير محدد».
// Phase 4B.24 — version 5 adds ONE isolated users store for local sign-in.
// The upgrade is additive: existing customer, movement, settings, and audit records are untouched.
export const DB_VERSION = 5;

export const STORE = Object.freeze({
  CUSTOMERS: 'customers',
  TRANSACTIONS: 'transactions',
  OPENING_BALANCE_HISTORY: 'openingBalanceHistory',
  SETTINGS: 'settings',
  METADATA: 'metadata',
  AUDIT_LOG: 'auditLog',
  // Phase 4B.11 — the receiving company is the party the crop is delivered to. It is
  // NOT a carton supplier and NOT a farmer: it is its own reference record.
  RECEIVING_COMPANIES: 'receivingCompanies',
  // Phase 4B.11 — the carton type is the packaging the crop was packed in.
  CARTON_TYPES: 'cartonTypes',
  // Phase 4B.13.1 — the agricultural variety of a LOCAL crop purchase (Fortuna,
  // Sensation, Florida …). It is a descriptive reference of the movement, not a
  // processing type, not a state and not a financial dimension.
  STRAWBERRY_VARIETIES: 'strawberryVarieties',
  USERS: 'users'
});

export const STORE_NAMES = Object.freeze(Object.values(STORE));

export const INDEX = Object.freeze({
  customers: Object.freeze({ CODE: 'code', NAME: 'name', PHONE: 'phone' }),
  transactions: Object.freeze({
    CUSTOMER_ID: 'customerId',
    DATE: 'date',
    TYPE: 'transactionType',
    STATUS: 'status',
    LINK_ID: 'linkId',
    CUSTOMER_DATE: 'customerId_date'
  }),
  openingBalanceHistory: Object.freeze({ CUSTOMER_ID: 'customerId', CHANGED_AT: 'changedAt' }),
  auditLog: Object.freeze({
    TRANSACTION_ID: 'transactionId',
    OCCURRED_AT: 'occurredAt',
    EVENT_TYPE: 'eventType'
  }),
  // The normalised name is UNIQUE, so a duplicate reference name cannot exist even if a
  // service check were bypassed. Names are compared after trimming, collapsing inner
  // whitespace and lower-casing (Arabic has no case, Latin text is case-insensitive).
  receivingCompanies: Object.freeze({ NORMALIZED_NAME: 'NormalizedName' }),
  cartonTypes: Object.freeze({ NORMALIZED_NAME: 'NormalizedName' }),
  // Phase 4B.13.1 — same uniqueness rule for the variety catalogue.
  strawberryVarieties: Object.freeze({ NORMALIZED_NAME: 'NormalizedName' })
});

export const KEY_PATH = Object.freeze({
  customers: 'Id',
  transactions: 'Id',
  openingBalanceHistory: 'Id',
  settings: 'Key',
  metadata: 'Key',
  auditLog: 'Id',
  receivingCompanies: 'Id',
  cartonTypes: 'Id',
  strawberryVarieties: 'Id',
  users: 'Id'
});

export function createSchema(db) {
  if (!db.objectStoreNames.contains(STORE.CUSTOMERS)) {
    const store = db.createObjectStore(STORE.CUSTOMERS, { keyPath: KEY_PATH.customers });
    store.createIndex(INDEX.customers.CODE, 'Code', { unique: true });
    store.createIndex(INDEX.customers.NAME, 'Name');
    store.createIndex(INDEX.customers.PHONE, 'Phone');
  }
  if (!db.objectStoreNames.contains(STORE.TRANSACTIONS)) {
    const store = db.createObjectStore(STORE.TRANSACTIONS, { keyPath: KEY_PATH.transactions });
    store.createIndex(INDEX.transactions.CUSTOMER_ID, 'CustomerId');
    store.createIndex(INDEX.transactions.DATE, 'Date');
    store.createIndex(INDEX.transactions.TYPE, 'TransactionType');
    store.createIndex(INDEX.transactions.STATUS, 'Status');
    store.createIndex(INDEX.transactions.LINK_ID, 'LinkId');
    store.createIndex(INDEX.transactions.CUSTOMER_DATE, ['CustomerId', 'Date']);
  }
  if (!db.objectStoreNames.contains(STORE.OPENING_BALANCE_HISTORY)) {
    const store = db.createObjectStore(STORE.OPENING_BALANCE_HISTORY, { keyPath: KEY_PATH.openingBalanceHistory });
    store.createIndex(INDEX.openingBalanceHistory.CUSTOMER_ID, 'CustomerId');
    store.createIndex(INDEX.openingBalanceHistory.CHANGED_AT, 'ChangedAt');
  }
  if (!db.objectStoreNames.contains(STORE.SETTINGS)) {
    db.createObjectStore(STORE.SETTINGS, { keyPath: KEY_PATH.settings });
  }
  if (!db.objectStoreNames.contains(STORE.METADATA)) {
    db.createObjectStore(STORE.METADATA, { keyPath: KEY_PATH.metadata });
  }
  // Phase 4B.6 — append-only audit trail. It has no update path of its own: the only
  // writer is the audited-change transaction, and the repository exposes no `put`
  // and no `delete` for a single entry, so a historical event can never be rewritten.
  if (!db.objectStoreNames.contains(STORE.AUDIT_LOG)) {
    const store = db.createObjectStore(STORE.AUDIT_LOG, { keyPath: KEY_PATH.auditLog });
    store.createIndex(INDEX.auditLog.TRANSACTION_ID, 'TransactionId');
    store.createIndex(INDEX.auditLog.OCCURRED_AT, 'OccurredAt');
    store.createIndex(INDEX.auditLog.EVENT_TYPE, 'EventType');
  }
  // Phase 4B.11 — additive reference stores.
  if (!db.objectStoreNames.contains(STORE.RECEIVING_COMPANIES)) {
    const store = db.createObjectStore(STORE.RECEIVING_COMPANIES, { keyPath: KEY_PATH.receivingCompanies });
    store.createIndex(INDEX.receivingCompanies.NORMALIZED_NAME, 'NormalizedName', { unique: true });
  }
  if (!db.objectStoreNames.contains(STORE.CARTON_TYPES)) {
    const store = db.createObjectStore(STORE.CARTON_TYPES, { keyPath: KEY_PATH.cartonTypes });
    store.createIndex(INDEX.cartonTypes.NORMALIZED_NAME, 'NormalizedName', { unique: true });
  }
  // Phase 4B.24 — isolated local authentication accounts. Passwords are PBKDF2 hashes, never plaintext.
  if (!db.objectStoreNames.contains(STORE.USERS)) {
    const store = db.createObjectStore(STORE.USERS, { keyPath: KEY_PATH.users });
    store.createIndex('username', 'Username', { unique: true });
    store.createIndex('role', 'Role');
  }
  // Phase 4B.13.1 — additive variety store. Its unique index makes a duplicate variety
  // name impossible even if the service check were bypassed.
  if (!db.objectStoreNames.contains(STORE.STRAWBERRY_VARIETIES)) {
    const store = db.createObjectStore(STORE.STRAWBERRY_VARIETIES, { keyPath: KEY_PATH.strawberryVarieties });
    store.createIndex(INDEX.strawberryVarieties.NORMALIZED_NAME, 'NormalizedName', { unique: true });
  }
}

// Phase 4B.11 — additive data migration, run inside the same upgrade transaction.
//
// A local-crop movement recorded before this phase never stored the package weight that
// was in effect when it was created, so that weight is UNKNOWABLE. This migration does
// not invent one: it marks the row `PackageWeightStatus: 'Unknown'` and leaves the weight
// (and the net weight) null, so Phase 4B.12 can keep unconfirmed weights out of its
// confirmed totals. Amounts, dates, directions and balances are never touched.
export const PACKAGE_WEIGHT_STATUS = Object.freeze({ CONFIRMED: 'Confirmed', UNKNOWN: 'Unknown' });

export function migrateSchema(db, transaction) {
  if (!db || !transaction) return;
  if (!db.objectStoreNames.contains(STORE.TRANSACTIONS)) return;
  const store = transaction.objectStore(STORE.TRANSACTIONS);
  const request = store.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const row = cursor.value;
    if (row && row.TransactionType === 'CropPurchaseLocal' && !Object.prototype.hasOwnProperty.call(row, 'PackageWeightKg')) {
      cursor.update({
        ...row,
        PackageWeightKg: null,
        PackageWeightStatus: PACKAGE_WEIGHT_STATUS.UNKNOWN,
        NetWeightMilli: row.NetWeightMilli ?? null
      });
    }
    cursor.continue();
  };
}
