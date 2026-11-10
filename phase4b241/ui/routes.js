// The approved navigation structure (Phase 1 v1.2 / Phase 2 v1.2 FINAL).
// Pure data: no DOM, no business logic, no financial rule.
export const NAV_GROUP = Object.freeze({
  OVERVIEW: 'نظرة عامة',
  OPERATIONS: 'العمليات اليومية',
  ANALYSIS: 'التحليل',
  SYSTEM: 'النظام'
});

export const ROUTES = Object.freeze([
  Object.freeze({
    id: 'dashboard', path: '/dashboard', group: NAV_GROUP.OVERVIEW, icon: 'dashboard',
    title: 'لوحة التحكم', subtitle: 'نظرة عامة على حالة الحسابات'
  }),
  Object.freeze({
    id: 'customers', path: '/customers', group: NAV_GROUP.OPERATIONS, icon: 'customers',
    title: 'العملاء', subtitle: 'سجل العملاء وكود كل عميل'
  }),
  Object.freeze({
    id: 'transactions', path: '/transactions', group: NAV_GROUP.OPERATIONS, icon: 'transactions',
    title: 'الحركات', subtitle: 'سجل الحركات المركزي'
  }),
  Object.freeze({
    id: 'crop-purchases', path: '/crop-purchases', group: NAV_GROUP.OPERATIONS, icon: 'crop',
    title: 'مشتريات المحصول', subtitle: 'المشتريات المحلية والكرتون'
  }),
  Object.freeze({
    id: 'payments', path: '/payments', group: NAV_GROUP.OPERATIONS, icon: 'payments',
    title: 'المدفوعات', subtitle: 'الحركة النقدية للعملاء'
  }),
  Object.freeze({
    id: 'settlements', path: '/settlements', group: NAV_GROUP.OPERATIONS, icon: 'settlements',
    title: 'التسويات', subtitle: 'التسويات ومبادلة البضاعة وتحويل المديونية'
  }),
  Object.freeze({
    id: 'reports', path: '/reports', group: NAV_GROUP.ANALYSIS, icon: 'reports',
    title: 'التقارير', subtitle: 'أرصدة العملاء وكشف الحساب'
  }),
  Object.freeze({
    id: 'settings', path: '/settings', group: NAV_GROUP.SYSTEM, icon: 'settings',
    title: 'الإعدادات', subtitle: 'إعدادات التطبيق'
  }),
  Object.freeze({
    id: 'import', path: '/import', group: NAV_GROUP.SYSTEM, icon: 'import',
    title: 'الاستيراد من Excel', subtitle: 'استيراد بيانات العملاء والحركات'
  }),
  Object.freeze({
    id: 'backup', path: '/backup', group: NAV_GROUP.SYSTEM, icon: 'backup',
    title: 'النسخ الاحتياطي والاستعادة', subtitle: 'حماية بيانات المخزن المحلي'
  })
]);

export const DEFAULT_ROUTE_ID = 'dashboard';

export function listRouteIds() {
  return ROUTES.map((route) => route.id);
}

export function findRouteById(id) {
  return ROUTES.find((route) => route.id === id) || null;
}

export function findRouteByPath(path) {
  return ROUTES.find((route) => route.path === path) || null;
}

export function getDefaultRoute() {
  return findRouteById(DEFAULT_ROUTE_ID);
}

// Navigation grouped for the sidebar, preserving declaration order.
export function groupedRoutes() {
  const groups = [];
  for (const route of ROUTES) {
    let group = groups.find((entry) => entry.title === route.group);
    if (!group) {
      group = { title: route.group, routes: [] };
      groups.push(group);
    }
    group.routes.push(route);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Phase 4B.1 — destinations that hang off the Customers navigation item.
// They are deliberately NOT sidebar entries: the sidebar keeps its 10 items and
// these screens share the Customers active state.
// ---------------------------------------------------------------------------
export const CUSTOMERS_PATH = '/customers';

export const CUSTOMER_DESTINATION = Object.freeze({
  LIST: 'customers',
  NEW: 'customers-new',
  EDIT: 'customers-edit',
  ACCOUNT: 'customer-account'
});

export const CUSTOMER_SUBROUTES = Object.freeze([
  Object.freeze({ id: CUSTOMER_DESTINATION.NEW, pattern: '/customers/new', parentRouteId: 'customers', title: 'إضافة عميل', subtitle: 'إنشاء عميل جديد بكود فريد' }),
  Object.freeze({ id: CUSTOMER_DESTINATION.EDIT, pattern: '/customers/edit/:id', parentRouteId: 'customers', title: 'تعديل عميل', subtitle: 'تعديل البيانات الأساسية للعميل' }),
  Object.freeze({ id: CUSTOMER_DESTINATION.ACCOUNT, pattern: '/customer/:id', parentRouteId: 'customers', title: 'حساب العميل', subtitle: 'كشف حساب العميل' })
]);

export function customerListPath() { return CUSTOMERS_PATH; }
export function customerNewPath() { return '/customers/new'; }
export function customerEditPath(customerId) { return `/customers/edit/${encodeURIComponent(String(customerId))}`; }
export function customerAccountPath(customerId) { return `/customer/${encodeURIComponent(String(customerId))}`; }

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    // A malformed escape sequence is kept as-is instead of failing navigation.
    return value;
  }
}

// Pure pattern matcher: '/customers/edit/:id' + '/customers/edit/C-1' -> { id: 'C-1' }
export function matchSubroute(path, subroutes) {
  const segments = String(path || '').split('/').filter((segment) => segment !== '');
  for (const entry of subroutes) {
    const patternSegments = entry.pattern.split('/').filter((segment) => segment !== '');
    if (patternSegments.length !== segments.length) continue;
    const params = {};
    let matched = true;
    for (let index = 0; index < patternSegments.length; index += 1) {
      const pattern = patternSegments[index];
      const segment = safeDecode(segments[index]);
      if (pattern.startsWith(':')) { params[pattern.slice(1)] = segment; continue; }
      if (pattern !== segment) { matched = false; break; }
    }
    if (matched) return { ...entry, params, path };
  }
  return null;
}


// ---------------------------------------------------------------------------
// Phase 4B.3 — destinations that hang off the Transactions navigation item.
// The sidebar keeps its 10 items; this screen shares the Transactions state.
// ---------------------------------------------------------------------------
export const TRANSACTIONS_PATH = '/transactions';

export const TRANSACTION_DESTINATION = Object.freeze({
  LEDGER: 'transactions',
  ADD: 'transactions-add'
});

export const TRANSACTION_SUBROUTES = Object.freeze([
  Object.freeze({
    id: TRANSACTION_DESTINATION.ADD,
    pattern: '/transactions/add',
    parentRouteId: 'transactions',
    title: 'تسجيل حركة مالية',
    subtitle: 'إضافة حركة مالية جديدة لعميل'
  })
]);

export function transactionsPath() { return TRANSACTIONS_PATH; }

// An optional customerId pre-selects the customer (arriving from a customer row or
// from the customer statement). The identifier is always the real CustomerId.
export function transactionAddPath(customerId = null) {
  return customerId ? `/transactions/add?customerId=${encodeURIComponent(String(customerId))}` : '/transactions/add';
}

export function matchTransactionSubroute(path) {
  return matchSubroute(path, TRANSACTION_SUBROUTES);
}

export function matchCustomerSubroute(path) {
  return matchSubroute(path, CUSTOMER_SUBROUTES);
}


// ---------------------------------------------------------------------------
// Phase 4B.4 — the Payments screen keeps its navigation item and additionally
// accepts an optional customerId so a payment can be entered straight from a
// customer row. The identifier stays the real CustomerId.
// ---------------------------------------------------------------------------
export const PAYMENTS_PATH = '/payments';

export function paymentsPath(customerId = null) {
  return customerId ? `${PAYMENTS_PATH}?customerId=${encodeURIComponent(String(customerId))}` : PAYMENTS_PATH;
}

// ---------------------------------------------------------------------------
// Phase 4B.5 — the Settlements screen keeps its navigation item and additionally
// accepts an optional customerId so a settlement can be entered straight from a
// customer row. The identifier stays the real CustomerId.
// ---------------------------------------------------------------------------
export const SETTLEMENTS_PATH = '/settlements';

export function settlementsPath(customerId = null) {
  return customerId ? `${SETTLEMENTS_PATH}?customerId=${encodeURIComponent(String(customerId))}` : SETTLEMENTS_PATH;
}

// ---------------------------------------------------------------------------
// Phase 4B.11 — reference data of the crop purchase (receiving companies, carton types).
// A sub-route of «مشتريات المحصول»: the sidebar keeps its approved 10 items and this
// screen shares that active state.
// ---------------------------------------------------------------------------
export const CROP_REFERENCES_PATH = '/crop-purchases/references';

export const REFERENCE_DESTINATION = Object.freeze({
  LIST: 'crop-purchases-references'
});

export const REFERENCE_SUBROUTES = Object.freeze([
  Object.freeze({
    id: REFERENCE_DESTINATION.LIST,
    pattern: CROP_REFERENCES_PATH,
    parentRouteId: 'crop-purchases',
    title: 'البيانات المرجعية للمحصول',
    subtitle: 'الشركات المستلمة للمحصول وأنواع الكراتين'
  })
]);

export function cropReferencesPath() { return CROP_REFERENCES_PATH; }

export function matchReferenceSubroute(path) {
  return matchSubroute(path, REFERENCE_SUBROUTES);
}
