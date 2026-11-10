import { DB_NAME, DB_VERSION, STORE_NAMES, createSchema, migrateSchema } from './schema.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';

let indexedDbImpl = null;
let keyRangeImpl = null;
let databaseName = DB_NAME;
let databaseVersion = DB_VERSION;
let connection = null;
let openingPromise = null;

// Dependency injection keeps the data layer testable in Node.
export function configureIndexedDB({ indexedDB, IDBKeyRange } = {}) {
  if (indexedDB) indexedDbImpl = indexedDB;
  if (IDBKeyRange) keyRangeImpl = IDBKeyRange;
}

export function configureDatabase({ name, version } = {}) {
  const nameChanged = typeof name === 'string' && name !== '' && name !== databaseName;
  const versionChanged = Number.isInteger(version) && version !== databaseVersion;
  if (nameChanged) databaseName = name;
  if (versionChanged) databaseVersion = version;
  if (nameChanged || versionChanged) {
    connection = null;
    openingPromise = null;
  }
}

export function getDatabaseName() {
  return databaseName;
}

export function getDatabaseVersion() {
  return databaseVersion;
}

export function makeKeyRange() {
  const impl = keyRangeImpl || globalThis.IDBKeyRange;
  if (!impl) throw new AppError(ERROR_CODE.STORAGE_ERROR, 'نطاق مفاتيح التخزين المحلي غير متوفر.');
  return impl;
}

function factory() {
  const impl = indexedDbImpl || globalThis.indexedDB;
  if (!impl) throw new AppError(ERROR_CODE.STORAGE_ERROR, 'محرك التخزين المحلي غير متوفر في هذه البيئة.');
  return impl;
}

export function openDatabase() {
  if (connection) return Promise.resolve(connection);
  if (openingPromise) return openingPromise;
  openingPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = factory().open(databaseName, databaseVersion);
    } catch (error) {
      openingPromise = null;
      reject(new AppError(ERROR_CODE.STORAGE_ERROR, 'تعذر فتح قاعدة البيانات المحلية.', { cause: error }));
      return;
    }
    request.onupgradeneeded = (event) => {
      // Both steps run inside the SAME version-change transaction: the schema stays
      // all-or-nothing with the data migration.
      createSchema(request.result);
      migrateSchema(request.result, request.transaction);
    };
    request.onsuccess = () => {
      connection = request.result;
      connection.onclose = () => {
        connection = null;
        openingPromise = null;
      };
      resolve(connection);
    };
    request.onerror = () => {
      openingPromise = null;
      reject(new AppError(ERROR_CODE.STORAGE_ERROR, 'تعذر فتح قاعدة البيانات المحلية.', { cause: request.error }));
    };
    request.onblocked = () => {
      openingPromise = null;
      reject(new AppError(ERROR_CODE.STORAGE_ERROR, 'قاعدة البيانات مشغولة بعملية أخرى، أعد المحاولة.'));
    };
  });
  return openingPromise;
}

export async function closeDatabase() {
  if (connection) {
    try {
      connection.close();
    } catch (error) {
      connection = null;
    }
  }
  connection = null;
  openingPromise = null;
}

export async function deleteDatabase() {
  await closeDatabase();
  return new Promise((resolve, reject) => {
    const request = factory().deleteDatabase(databaseName);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(new AppError(ERROR_CODE.STORAGE_ERROR, 'تعذر حذف قاعدة البيانات المحلية.', { cause: request.error }));
  });
}

// Maps a raw IDB error to a typed AppError (ConstraintError -> CONFLICT).
function mapRequestError(error, fallbackMessage) {
  if (error && error.name === 'ConstraintError') {
    return new AppError(ERROR_CODE.CONFLICT, 'القيمة مكررة ولا يمكن تخزينها (قيود التخزين).', { cause: error });
  }
  return new AppError(ERROR_CODE.STORAGE_ERROR, fallbackMessage, { cause: error });
}

export function req(request, fallbackMessage = 'فشل تنفيذ عملية التخزين.') {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(mapRequestError(request.error, fallbackMessage));
  });
}

// Single entry point for every storage write/read. Multi-store atomicity is inherited.
export async function runTransaction(storeNames, mode, work) {
  const db = await openDatabase();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(names, mode);
    } catch (error) {
      reject(new AppError(ERROR_CODE.STORAGE_ERROR, 'تعذر بدء عملية تخزين.', { cause: error }));
      return;
    }
    const stores = {};
    for (const name of names) stores[name] = tx.objectStore(name);
    let outcome = null;
    let failure = null;
    tx.oncomplete = () => {
      if (failure) reject(failure);
      else resolve(outcome);
    };
    tx.onabort = () => {
      reject(failure || new AppError(ERROR_CODE.STORAGE_ERROR, 'تم إلغاء عملية التخزين.', { cause: tx.error }));
    };
    tx.onerror = () => {
      if (!failure) failure = mapRequestError(tx.error, 'فشل تنفيذ عملية التخزين.');
    };
    (async () => {
      try {
        outcome = await work(stores, tx);
      } catch (error) {
        failure = error instanceof AppError ? error : new AppError(ERROR_CODE.STORAGE_ERROR, 'فشل تنفيذ عملية التخزين.', { cause: error });
        try {
          tx.abort();
        } catch (abortError) {
          // Aborting a transaction that is already aborting must not mask the real
          // cause: the original failure stays the reported one.
          if (!failure) failure = new AppError(ERROR_CODE.STORAGE_ERROR, 'فشل إلغاء عملية التخزين بعد خطأ.', { cause: abortError });
        }
      }
    })();
  });
}

export async function inspectSchema() {
  const db = await openDatabase();
  const stores = Array.from(db.objectStoreNames);
  const indexes = {};
  for (const name of stores) {
    const tx = db.transaction(name, 'readonly');
    indexes[name] = Array.from(tx.objectStore(name).indexNames);
  }
  return { name: db.name, version: db.version, stores, indexes, expectedStores: [...STORE_NAMES] };
}
