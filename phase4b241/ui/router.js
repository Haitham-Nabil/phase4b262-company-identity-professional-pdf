// Hash router. Pure resolution logic first; browser wiring is optional so the
// module stays testable outside a DOM.
import { getDefaultRoute, findRouteByPath, matchCustomerSubroute, matchTransactionSubroute, matchReferenceSubroute } from './routes.js';

export const HASH_PREFIX = '#';

export function buildHash(path) {
  if (typeof path !== 'string' || path === '') return `${HASH_PREFIX}/`;
  return `${HASH_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
}

// '#' '#/' '#/customers?x=1' -> { path, segments, query }
export function parseHash(hash) {
  const raw = typeof hash === 'string' ? hash : '';
  const withoutPrefix = raw.startsWith(HASH_PREFIX) ? raw.slice(HASH_PREFIX.length) : raw;
  const [rawPath = '', rawQuery = ''] = withoutPrefix.split('?');
  const path = rawPath === '' ? '/' : (rawPath.startsWith('/') ? rawPath : `/${rawPath}`);
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const segments = trimmed.split('/').filter((segment) => segment !== '');
  return { path: trimmed, segments, query: rawQuery };
}

// '?customerId=X&type=Y' -> { customerId: 'X', type: 'Y' }
export function parseQuery(query) {
  const out = {};
  const raw = typeof query === 'string' ? query.replace(/^\?/, '') : '';
  if (!raw) return out;
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const index = pair.indexOf('=');
    const rawKey = index === -1 ? pair : pair.slice(0, index);
    const rawValue = index === -1 ? '' : pair.slice(index + 1);
    if (!rawKey) continue;
    let key = rawKey;
    let value = rawValue;
    try { key = decodeURIComponent(rawKey); } catch (error) { key = rawKey; }
    try { value = decodeURIComponent(rawValue); } catch (error) { value = rawValue; }
    out[key] = value;
  }
  return out;
}

export function resolveRoute(hash) {
  const { path } = parseHash(hash);
  return findRouteByPath(path);
}

// Unknown or empty hash always lands on the default route.
export function routeOrDefault(hash) {
  return resolveRoute(hash) || getDefaultRoute();
}

// Phase 4B.1: full destination resolution for the shell. Exact navigation routes
// win, then the customers sub-routes, then the default route.
export function resolveDestination(hash) {
  const parsed = parseHash(hash);
  const route = findRouteByPath(parsed.path);
  // Phase 4B.4: an exact route also absorbs its query string so a screen can read
  // an optional pre-selection (e.g. #/payments?customerId=...). Keys appear only
  // when the query actually carries them.
  if (route) return { destination: route, route, params: { ...parseQuery(parsed.query) }, path: parsed.path, query: parsed.query, resolved: true };
  const subroute = matchCustomerSubroute(parsed.path);
  if (subroute) return { destination: subroute, route: subroute, params: { ...subroute.params, ...parseQuery(parsed.query) }, path: parsed.path, query: parsed.query, resolved: true };
  const transactionSubroute = matchTransactionSubroute(parsed.path);
  if (transactionSubroute) return { destination: transactionSubroute, route: transactionSubroute, params: { ...transactionSubroute.params, ...parseQuery(parsed.query) }, path: parsed.path, query: parsed.query, resolved: true };
  const referenceSubroute = matchReferenceSubroute(parsed.path);
  if (referenceSubroute) return { destination: referenceSubroute, route: referenceSubroute, params: { ...referenceSubroute.params, ...parseQuery(parsed.query) }, path: parsed.path, query: parsed.query, resolved: true };
  const fallback = getDefaultRoute();
  return { destination: fallback, route: fallback, params: {}, path: parsed.path, query: parsed.query, resolved: false };
}

export function destinationOrDefault(hash) {
  return resolveDestination(hash).destination;
}

// Browser wiring. Returns a no-op teardown when there is no window (Node).
export function createRouter({ onNavigate, win = globalThis.window, initialHash = null } = {}) {
  if (!win || typeof win.addEventListener !== 'function') {
    return { start() {}, stop() {}, current: () => resolveDestination('') };
  }
  let current = resolveDestination(initialHash || win.location.hash);
  const handle = () => {
    current = resolveDestination(win.location.hash);
    if (typeof onNavigate === 'function') onNavigate(current);
  };
  return {
    start() {
      win.addEventListener('hashchange', handle);
      if (!win.location.hash) win.location.hash = buildHash(current.destination.path);
      else handle();
    },
    stop() {
      win.removeEventListener('hashchange', handle);
    },
    current: () => current
  };
}
