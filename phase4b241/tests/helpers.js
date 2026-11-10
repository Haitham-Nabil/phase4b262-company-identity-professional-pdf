import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from 'fake-indexeddb';
import { configureIndexedDB, configureDatabase, closeDatabase, openDatabase, deleteDatabase } from '../src/storage/db.js';
import { databaseInit } from '../src/services/databaseInit.js';
import { receivingCompanyService, cartonTypeService } from '../src/services/referenceDataService.js';

let counter = 0;

// Every scenario gets its own isolated database instance.
export async function freshDatabase(label = 'test') {
  counter += 1;
  const name = `ca_${label}_${counter}`;
  configureIndexedDB({ indexedDB: fakeIndexedDB, IDBKeyRange: fakeIDBKeyRange });
  configureDatabase({ name });
  await deleteDatabase();
  const info = await databaseInit.initialize();
  return { name, info };
}

// Simulates an application reload: drop the connection, then reopen lazily.
export async function simulateReload() {
  await closeDatabase();
  return openDatabase();
}

export { closeDatabase, deleteDatabase, configureDatabase };

// Phase 4B.11 FINAL — a carton purchase now REQUIRES a receiving company and a carton
// type. Tests that are about something else (the amount formula, the direction rules…)
// use this to satisfy the requirement without inventing a second code path.
let referenceCounter = 0;
export async function cartonRefs() {
  referenceCounter += 1;
  const company = await receivingCompanyService.create(`شركة اختبار ${referenceCounter}`);
  const type = await cartonTypeService.create(`نوع اختبار ${referenceCounter}`);
  return { ReceivingCompanyId: company.Id, CartonTypeId: type.Id };
}
