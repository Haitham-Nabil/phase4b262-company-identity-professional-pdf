import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { ROUTES, DEFAULT_ROUTE_ID, groupedRoutes, findRouteById, findRouteByPath, listRouteIds, NAV_GROUP } from '../ui/routes.js';
import { parseHash, resolveRoute, routeOrDefault, buildHash } from '../ui/router.js';
import { shellRegions, navigation, header } from '../ui/components/layout.js';
import { renderView } from '../ui/views/index.js';
import { escapeHtml } from '../ui/components/html.js';
import { amountClass, badgeClass, AMOUNT_CLASS, BADGE_CLASS } from '../ui/components/financial.js';
import { loadingState, emptyState, errorState } from '../ui/components/states.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const uiRoot = join(projectRoot, 'ui');

const REQUIRED_ROUTES = [
  'dashboard', 'customers', 'transactions', 'crop-purchases', 'payments',
  'settlements', 'reports', 'settings', 'import', 'backup'
];

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (full.endsWith('.js')) found.push(full);
  }
  return found;
}

test('The approved navigation exposes exactly the ten required routes', () => {
  assert.deepEqual([...listRouteIds()].sort(), [...REQUIRED_ROUTES].sort());
  assert.equal(ROUTES.length, 10);
  for (const route of ROUTES) {
    assert.ok(route.id && route.path && route.title && route.group, `route ${route.id} is incomplete`);
    assert.ok(route.path.startsWith('/'), `route ${route.id} path must be absolute`);
  }
});

test('Route table resolves by id and by path, and groups in declaration order', () => {
  assert.equal(findRouteById('reports').path, '/reports');
  assert.equal(findRouteByPath('/backup').id, 'backup');
  assert.equal(findRouteById('missing-route'), null);
  assert.equal(findRouteByPath('/missing'), null);
  assert.equal(DEFAULT_ROUTE_ID, 'dashboard');

  const groups = groupedRoutes();
  const titles = groups.map((group) => group.title);
  assert.deepEqual(titles, [NAV_GROUP.OVERVIEW, NAV_GROUP.OPERATIONS, NAV_GROUP.ANALYSIS, NAV_GROUP.SYSTEM]);
  assert.equal(groups.reduce((total, group) => total + group.routes.length, 0), 10);
});

test('Hash parsing normalises every accepted form', () => {
  assert.deepEqual(parseHash('#/customers'), { path: '/customers', segments: ['customers'], query: '' });
  assert.deepEqual(parseHash('#/customers/'), { path: '/customers', segments: ['customers'], query: '' });
  assert.deepEqual(parseHash('customers'), { path: '/customers', segments: ['customers'], query: '' });
  assert.equal(parseHash('#/').path, '/');
  assert.equal(parseHash('').path, '/');
  assert.equal(parseHash('#/customers?tab=1').query, 'tab=1');
  assert.equal(buildHash('/customers'), '#/customers');
});

test('Unknown or empty destinations fall back to the default route', () => {
  assert.equal(resolveRoute('#/customers').id, 'customers');
  assert.equal(resolveRoute('#/nope'), null);
  assert.equal(routeOrDefault('#/nope').id, DEFAULT_ROUTE_ID);
  assert.equal(routeOrDefault('').id, DEFAULT_ROUTE_ID);
  assert.equal(routeOrDefault('#/').id, DEFAULT_ROUTE_ID);
});

test('The shell renders sidebar, header, content area and mobile toggle for every route', () => {
  for (const route of ROUTES) {
    const html = shellRegions({
      route, appName: 'حسابات العملاء', appTagline: 'تطبيق محلي', packageWeightKg: null, body: renderView(route)
    });
    assert.match(html, /class="app-shell"/, `${route.id}: shell missing`);
    assert.match(html, /class="app-sidebar"/, `${route.id}: sidebar missing`);
    assert.match(html, /class="app-header"/, `${route.id}: header missing`);
    assert.match(html, /class="app-content"/, `${route.id}: content area missing`);
    assert.match(html, /data-sidebar-toggle/, `${route.id}: mobile toggle missing`);
    assert.match(html, /class="app-backdrop"/, `${route.id}: backdrop missing`);
    assert.match(html, new RegExp(`<h1>${route.title}</h1>`), `${route.id}: header title must be the route title`);
  }
});

test('Active navigation state marks exactly one link per route', () => {
  for (const route of ROUTES) {
    const html = navigation({ activeRouteId: route.id });
    const active = html.match(/aria-current="page"/g) || [];
    assert.equal(active.length, 1, `${route.id}: exactly one active link expected`);
    assert.match(html, new RegExp(`data-route-id="${route.id}"[^>]*aria-current="page"|aria-current="page"`));
    const activeLink = html.split('</a>').find((chunk) => chunk.includes('aria-current="page"'));
    assert.match(activeLink, new RegExp(`data-route-id="${route.id}"`), `${route.id}: the wrong link is active`);
  }
  const none = navigation({ activeRouteId: null });
  assert.equal((none.match(/aria-current="page"/g) || []).length, 0);
});

test('The mobile sidebar toggle reflects its collapsed and expanded states', () => {
  const collapsed = header({ route: findRouteById('dashboard'), packageWeightKg: null });
  assert.match(collapsed, /aria-expanded="false"/);
  assert.match(collapsed, /aria-controls="app-sidebar"/);
  const expanded = header({ route: findRouteById('dashboard'), packageWeightKg: null }).replace('aria-expanded="false"', 'aria-expanded="true"');
  assert.match(expanded, /aria-expanded="true"/);
  assert.match(shellRegions({ route: findRouteById('dashboard'), appName: 'أ', appTagline: 'ب', packageWeightKg: null, body: '' }), /data-sidebar="closed"/);
});

test('The header shows the real settings value and never invents one', () => {
  assert.match(header({ route: findRouteById('settings'), packageWeightKg: null }), /جارٍ قراءة الإعدادات…/);
  assert.match(header({ route: findRouteById('settings'), packageWeightKg: 14 }), /الوزن الافتراضي للعبوة: 14 كجم/);
  assert.doesNotMatch(header({ route: findRouteById('settings'), packageWeightKg: null }), /14 كجم/);
});

test('Every placeholder view renders the design system and no fabricated data', () => {
  for (const route of ROUTES) {
    const html = renderView(route);
    assert.match(html, /class="page-header"/);
    assert.match(html, /class="alert alert--info"/);
    assert.match(html, /class="card"/);
    assert.match(html, /class="state"/);
    assert.match(html, /class="financial-legend"/);
    assert.match(html, /لم تُبنَ وظائف الشاشة بعد/);
    // No numeric financial literal may appear inside a view.
    assert.doesNotMatch(html, /class="(?:amount|kpi__value)">\s*[-\d]/, `${route.id}: a numeric value must not be fabricated`);
  }
});

test('Text crossing the builders is escaped', () => {
  assert.equal(escapeHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  assert.equal(escapeHtml('a & "b"'), 'a &amp; &quot;b&quot;');
  assert.equal(escapeHtml(null), '');
  const injected = header({ route: { title: '<b>x</b>', subtitle: '&' }, packageWeightKg: null });
  assert.match(injected, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(injected, /<b>x<\/b>/);
});

test('Financial visual classes are presentation-only, with no zero-value default that implies a direction', () => {
  assert.equal(amountClass('credit'), 'amount amount--credit');
  assert.equal(amountClass('unknown-kind'), 'amount');
  assert.equal(badgeClass('cancelled'), 'badge badge--cancelled');
  assert.equal(badgeClass(undefined), 'badge');
  for (const value of Object.values(AMOUNT_CLASS)) assert.match(value, /^amount\b/);
  for (const value of Object.values(BADGE_CLASS)) assert.match(value, /^badge\b/);
});

test('Loading, empty and error states are accessible and content-free', () => {
  assert.match(loadingState(), /aria-live="polite"/);
  assert.match(loadingState(), /class="spinner"/);
  assert.match(emptyState({ title: 'لا توجد بيانات' }), /state__title/);
  assert.match(errorState({ code: 'STORAGE_ERROR' }), /role="alert"/);
  assert.match(errorState({ code: 'STORAGE_ERROR' }), /STORAGE_ERROR/);
});

test('No UI module imports a repository, the storage layer or IndexedDB', () => {
  const files = walk(uiRoot);
  assert.ok(files.length >= 8, 'the ui tree should contain the shell modules');
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const forbidden of ['repositories', 'storage/db', 'storage/schema', 'indexedDB', 'IndexedDB', 'IDBKeyRange']) {
      assert.equal(source.includes(forbidden), false, `${file} must not reference ${forbidden}`);
    }
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    for (const target of imports) {
      if (target.startsWith('../src/')) {
        assert.match(target, /^\.\.\/src\/(services|utils)\//, `${file} may only reach the services layer, got ${target}`);
      }
    }
  }
});

test('The UI tree contains no forbidden markers and no mock or fake data', () => {
  for (const file of walk(uiRoot)) {
    const source = readFileSync(file, 'utf8');
    for (const marker of ['TODO', 'FIXME', 'XXX', 'HACK']) {
      assert.equal(source.includes(marker), false, `${file} contains ${marker}`);
    }
    for (const fake of ['mockData', 'fakeData', 'sampleCustomers', 'dummyCustomer', 'lorem']) {
      assert.equal(source.includes(fake), false, `${file} contains ${fake}`);
    }
  }
});

test('The shell entry page is RTL Arabic and loads only the ui styles and app module', () => {
  const html = readFileSync(join(projectRoot, 'index.html'), 'utf8');
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /<div id="app"><\/div>/);
  assert.match(html, /src="ui\/app.js"/);
  for (const sheet of ['tokens.css', 'base.css', 'layout.css', 'components.css', 'financial.css']) {
    assert.ok(html.includes(`ui/styles/${sheet}`), `index.html must load ${sheet}`);
  }
  assert.doesNotMatch(html, /https?:\/\//, 'the shell must not load any external resource');
});

test('Layout CSS keeps the RTL and responsive contract', () => {
  const layout = readFileSync(join(uiRoot, 'styles/layout.css'), 'utf8');
  assert.match(layout, /@media \(max-width: 820px\)/);
  assert.match(layout, /\[data-sidebar="open"\]/);
  assert.match(layout, /inset-inline-start: 0/);
  assert.match(layout, /html\[dir="rtl"\] \.app-sidebar/);
  assert.match(layout, /translateX\(100%\)/);
  assert.doesNotMatch(layout, /margin-left|padding-left|border-left\b/, 'physical left properties must not be used');
});
