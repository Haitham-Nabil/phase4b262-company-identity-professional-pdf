# Phase 4B.24 — Local Login & Role Permissions

## Status
Implementation packaged for user acceptance testing. This phase is **not accepted yet**; do not proceed to Phase 4B.25 until the user completes the manual tests and explicitly accepts it.

## Source baseline
Built on the accepted Phase 4B.23 project archive. Existing customer, transaction, financial, reporting, backup, restore, and settings behavior was retained except for authorization gates and the additive user-account store.

## Implemented

### 1. First-run administrator setup and login
- On a database with no user accounts, the application displays a first-run form to create the primary administrator.
- No fixed or published default username/password is created.
- Username is normalized to lowercase and validated (3–32 characters: English letters, digits, `.`, `_`, `-`).
- Password minimum is 10 characters.
- Passwords are never stored in plaintext. A unique 16-byte random salt and PBKDF2-HMAC-SHA-256 (210,000 iterations) are used to derive the stored password hash.
- Login checks active status and rechecks the latest account state after password derivation.
- The session is memory-only: reloading or reopening the app requires login again. Logout clears the session.

### 2. Roles
- **Administrator:** full access to the existing application.
- **Employee:** may create every supported transaction type for any existing customer through the new-movement form.
- Employee customer selection is limited to the fields needed for entry (customer ID, code, name, active status). It does not expose account balances or statements.
- Employee movement-success output does not reveal balances and does not show the account-statement shortcut.
- Employee navigation is limited to adding a movement. Direct attempts to open other routes are redirected back to the new-movement form.
- Employee cannot edit, cancel, delete, change opening balances, edit customers, edit reference data, change settings, access reports, or use backup/restore.

### 3. Service-layer authorization
Authorization checks were added to the write and read entry points used for protected functionality, including transaction creation/edit/cancellation, customer and reference-data maintenance, opening-balance changes, report read models, balances/ledgers, and backup/restore.
The add-movement path remains available to both roles. DebtTransfer remains one atomic two-row operation; employee preview/output is redacted so it does not disclose customer balances.

### 4. User administration
- Only the administrator can create employee accounts, list users, change passwords, and activate/deactivate employee accounts.
- User deletion is not provided; deactivation is used instead.
- The primary administrator cannot be deactivated.
- The administrator can change their own password from Settings.
- Password change/deactivation broadcasts session invalidation to other open tabs on the same browser origin where BroadcastChannel is available.

### 5. Database and backup compatibility
- `DB_VERSION` increased from 4 to 5 to add one object store: `users`.
- The migration is additive. It does not alter or rewrite any existing customer, movement, opening-balance, setting, reference, or audit records.
- User credentials are intentionally excluded from backup files.
- Restore intentionally does not clear or replace the `users` store, so restoring a business-data backup preserves the currently configured login accounts and roles. Older backup files remain usable under the existing restore rules.

## Important security limitation
This is a local, browser-side access-control layer for normal application use. It is **not** equivalent to server-enforced security. A person with sufficient access to the same browser profile, developer tools, or local browser storage can inspect or alter local application data and may bypass client-side restrictions. Password hashing protects stored passwords from being plaintext, but it does not turn IndexedDB into a secure multi-user server database. Strong isolation against local tampering requires the future API/server architecture discussed for Phase 4B.26.

## Verification performed

| Check | Result |
|---|---:|
| JavaScript syntax check across all `src/`, `ui/`, and `tests/` files | Passed |
| Focused existing + new test selection | 103/103 passed |
| Full `npm test` attempt | 110 passed; 32 test files failed to load because `fake-indexeddb` is not installed in the environment |
| Browser visual/manual automation | Not completed; no browser test pass is claimed |

The full-suite failures are dependency-loading failures (`ERR_MODULE_NOT_FOUND: fake-indexeddb`), not reported as successful tests. The dependency could not be installed in this environment. Manual browser acceptance remains required.

## Manual acceptance tests

### A. First-run administrator and login
1. Open the updated application using the existing browser profile and existing business data.
2. Verify the first-run administrator setup appears (there are no preconfigured users).
3. Create the primary administrator with a username and password of at least 10 characters. Do not use a temporary password that you cannot retain.
4. Verify the application opens after successful creation and login.
5. Reload the page or close/reopen the application; verify the login screen appears.
6. Try an incorrect password; verify access is refused. Enter the correct password; verify login succeeds.
7. Log out; verify the login screen appears again.

### B. Administrator user management
8. Log in as administrator and open Settings.
9. Verify the User Management section is visible.
10. Create an employee account. Verify it appears in the user list with Employee role and Active status.
11. Try creating another account with the same username; verify it is rejected.
12. Change the employee password; verify the success message.
13. Deactivate the employee. Verify the account becomes inactive and cannot log in.
14. Reactivate the employee and verify it can log in again.
15. Change the administrator password and verify the new password works after logging out and back in.

### C. Employee permissions and movement entry
16. Log out and log in with the employee account.
17. Verify the employee sees only the new-movement entry path, not the dashboard, customer list, transaction ledger, reports, settings, import, or backup/restore navigation.
18. Attempt direct hash navigation to `/dashboard`, `/customers`, `/transactions`, `/reports`, `/settings`, and `/backup`; verify each returns to the new-movement form.
19. Verify the customer picker allows selecting any existing customer and shows the necessary customer identity only (not balances or statement data).
20. Verify the employee can select and submit each supported movement type: pesticide sale, irrigation-network sale, sales return, cash received, cash paid, settlement, goods exchange, debt transfer, local crop purchase, and carton crop purchase.
21. Verify DebtTransfer still creates the linked pair correctly and only once.
22. Verify the employee success result does not show the new balance or an account-statement link.
23. Verify employee attempts to edit or cancel an existing movement, change an opening balance, edit a customer/reference, change settings, access reports, or use backup/restore are blocked.

### D. Administrator regression and data preservation
24. Log out and log in as administrator; verify all previous screens and capabilities are available.
25. Verify existing customers, movements, balances, reports, settings, and audit history are unchanged after the version-5 database upgrade.
26. Create a backup as administrator, restore it, and verify the administrator and employee accounts remain present and usable (user accounts are intentionally preserved outside the business-data backup).
27. Verify the employee cannot create a backup or restore a backup.
28. If the employee is logged in in another tab, deactivate that employee from the administrator tab; where BroadcastChannel is supported, verify the employee tab is returned to login.

## Files changed / added
- `src/storage/schema.js` — DB version 5 and additive `users` store.
- `src/services/authService.js` — new local authentication, password hashing, roles, user management, and session invalidation.
- `src/services/transactionService.js`, `transactionFormService.js`, `debtTransferService.js`, `paymentService.js`, `settlementService.js` — add-movement authorization and employee-safe responses.
- `src/services/customerService.js`, `referenceDataService.js`, `openingBalanceService.js`, `transactionLifecycleService.js`, `cancellationService.js` — protected maintenance/edit/cancel paths.
- `src/services/balanceService.js`, report services, `backupService.js`, `restoreService.js`, `settingsService.js` — manager-only read/write gates where applicable.
- `ui/app.js` — first-run setup, login/logout, route authorization, and role-aware navigation.
- `ui/views/settings.js` — administrator user-management panel.
- `ui/views/transactionForm.js` — hide statement shortcut and balances for employee.
- `ui/styles/base.css` — login/setup styling.
- `tests/authService.test.js` — new authorization/schema tests.

## Acceptance gate
Wait for the user's manual test results and explicit acceptance. Do not start Phase 4B.25 before that approval.
