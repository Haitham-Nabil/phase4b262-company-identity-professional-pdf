import test from 'node:test';
import assert from 'node:assert/strict';
import { authService } from '../src/services/authService.js';
import { applyLedgerFilters, normalizeLedgerFilters } from '../src/services/transactionLedgerService.js';
import { isEmployeeRouteAllowed } from '../ui/app.js';

test('employee route policy permits operating screens but denies reports and administration', () => {
  for (const id of ['customers', 'customers-new', 'transactions', 'transactions-add', 'crop-purchases', 'payments', 'settlements']) {
    assert.equal(isEmployeeRouteAllowed(id), true, `${id} should be available to employees`);
  }
  for (const id of ['dashboard', 'reports', 'settings', 'import', 'backup', 'customer-account', 'references']) {
    assert.equal(isEmployeeRouteAllowed(id), false, `${id} should remain admin-only`);
  }
});

test('customer-specific ledger filter matches the selected customer and a transfer counterparty', () => {
  const rows = [
    { CustomerId: 'A', CounterpartyId: null, TransactionType: 'PesticideSale', Date: '2026-01-01', IsCancelled: false, SearchText: 'alpha' },
    { CustomerId: 'A', CounterpartyId: 'B', TransactionType: 'DebtTransfer', Date: '2026-01-02', IsCancelled: false, SearchText: 'alpha beta' },
    { CustomerId: 'C', CounterpartyId: null, TransactionType: 'PesticideSale', Date: '2026-01-03', IsCancelled: false, SearchText: 'gamma' }
  ];
  assert.deepEqual(applyLedgerFilters(rows, { customerId: 'B' }), [rows[1]]);
  assert.deepEqual(applyLedgerFilters(rows, { customerId: 'A' }), [rows[0], rows[1]]);
  assert.equal(normalizeLedgerFilters({ customerId: 'B' }).customerId, 'B');
});

test('unauthenticated users cannot use employee operational read gates', () => {
  authService.enableEnforcement();
  authService.logout();
  assert.throws(() => authService.assertCanViewOperations(), /تسجيل الدخول/);
  assert.throws(() => authService.assertCanCreateCustomer(), /تسجيل الدخول/);
  assert.throws(() => authService.assertCanViewLedger(), /تسجيل الدخول/);
});
