import test from 'node:test';
import assert from 'node:assert/strict';
import { authService, USER_ROLE } from '../src/services/authService.js';
import { DB_VERSION, STORE } from '../src/storage/schema.js';

test('Phase 4B.24 adds one additive users store without changing existing stores', () => {
  assert.equal(DB_VERSION, 5);
  assert.equal(STORE.USERS, 'users');
  assert.equal(USER_ROLE.ADMIN, 'admin');
  assert.equal(USER_ROLE.EMPLOYEE, 'employee');
});

test('enforced access denies unauthenticated mutation and management attempts', () => {
  authService.enableEnforcement();
  assert.throws(() => authService.assertCanAdd(), /تسجيل الدخول/);
  assert.throws(() => authService.assertCanViewOperations(), /تسجيل الدخول/);
  assert.throws(() => authService.assertCanCreateCustomer(), /تسجيل الدخول/);
  assert.throws(() => authService.assertCanViewLedger(), /تسجيل الدخول/);
  assert.throws(() => authService.assertCanManageData(), /صلاحيات الموظف/);
  assert.throws(() => authService.assertAdmin(), /متاحة للمدير فقط/);
});

test('logout clears the in-memory session', () => {
  authService.logout();
  assert.equal(authService.current(), null);
  assert.equal(authService.isAuthenticated(), false);
});
