# Phase 4B.24.1 — Employee Operational Permissions

## Status
Implementation completed against the approved scope. The package is ready for user manual testing; this phase is **not considered approved** until the user completes and confirms the manual tests.

## Changes delivered

### Employee access
- Employee can open the Customers list and search/filter customers using the existing customer-list controls.
- Employee can create a new customer.
- Employee-created customers always receive an opening balance of zero. The opening-balance input is not shown to employees, and the service independently enforces zero even if a request is manipulated.
- Employee can add the supported movement types through the existing transaction, payment, settlement, and crop-purchase workflows.
- Employee can open the central read-only Transactions Ledger, view movement details, and filter by customer, movement type, date range, and status.
- The customer filter matches both sides of a linked DebtTransfer operation.

### Restricted to administrator
- The complete Reports section and all report families.
- Dashboard / portfolio analytics and customer account statement routes.
- Customer editing, activation/deactivation, opening-balance changes, and import operations.
- Settings, user management, backup/restore, and reference-data administration.
- Editing or cancelling existing movements.

### Enforcement
- Added separate authorization gates for operational reads, customer creation, and ledger viewing.
- Existing admin-only service guards remain in place for reports, balances, lifecycle changes, settings, backup/restore, imports, and reference administration.
- Route restrictions are enforced on initial navigation and direct hash navigation; hiding navigation items is supplementary only.
- UI controls for employee mode omit customer balances, customer account links, editing/deactivation actions, opening-balance input, and reference administration links.
- Existing financial formulas, stored movement records, backup format, and database schema were not changed. `DB_VERSION` remains 5.

## Verification

| Check | Result |
|---|---|
| JavaScript syntax check across all `src/`, `ui/`, and `tests/` files | Passed |
| Focused authorization and employee-route tests | Passed |
| Customer-specific ledger filter tests, including linked-transfer counterparty | Passed |
| Existing non-IndexedDB-dependent test files | 113 passed, 0 failed |
| Full test suite | Not completed: `fake-indexeddb` was unavailable in the environment; dependency installation timed out |
| Browser visual/manual interaction test | Not run; requires user/browser verification |

The 113 passing tests are the set of test files that do not import the missing IndexedDB test dependency. No claim is made that the complete suite passed.

## Manual test plan

1. Sign in as employee and confirm the sidebar exposes Customers, Transactions, Crop Purchases, Payments, and Settlements only.
2. Open Customers and confirm the employee sees customer identity/contact fields but no opening/current balances, account statement link, edit action, or activate/deactivate action.
3. Add a new customer. Confirm it is saved and its opening balance is zero.
4. Attempt to open `#/customers/edit/<customer-id>` and confirm access is refused/redirected.
5. Attempt to open `#/customer/<customer-id>` and confirm access is refused/redirected.
6. Open Transactions and filter by a specific customer. Confirm only that customer's movements appear.
7. Test customer filtering on a DebtTransfer operation using either transfer party; the linked operation should appear once.
8. Combine customer filter with movement type, date range, and status filters; reset all filters and confirm the full ledger returns.
9. Open a movement's details and confirm no edit/cancel controls are available.
10. Attempt to open `#/reports` and each report route directly; confirm access is refused/redirected.
11. Attempt to open dashboard, settings, backup, import, and reference administration routes; confirm access is refused/redirected.
12. Sign in as administrator and confirm all previous screens, customer balances, reports, editing, settings, backup/restore, and user management remain available.
13. Confirm existing customers, movements, balances, and backup/restore behavior are unchanged.

## Files / compatibility
- Full project source and tests are included in the ZIP.
- No database migration is required.
- Existing application startup and local storage model are unchanged.
