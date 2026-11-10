import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES } from '../ui/routes.js';
import { ICONS } from '../ui/components/icons.js';
import { navigation, shellRegions } from '../ui/components/layout.js';
import { dashboardViewHtml } from '../ui/views/dashboard.js';

const allowedRoles = new Set(['dashboard','customers','transactions','crop','payments','settlements','reports','settings','import','backup']);

test('Phase 4B.25: every navigation route uses a supported inline SVG icon key', () => {
  assert.equal(ROUTES.length, 10);
  for (const route of ROUTES) {
    assert.ok(allowedRoles.has(route.icon), `unsupported icon key for ${route.id}: ${route.icon}`);
    assert.ok(ICONS[route.icon], `missing SVG icon for ${route.id}`);
  }
});

test('Phase 4B.25: navigation renders real SVG glyphs and preserves active route semantics', () => {
  const html = navigation({ activeRouteId: 'customers' });
  assert.match(html, /<svg/);
  assert.match(html, /data-route-id="customers" aria-current="page"/);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
});

test('Phase 4B.25: dashboard welcome region is present without replacing existing data targets', () => {
  const html = dashboardViewHtml();
  assert.match(html, /class="dash-welcome"/);
  assert.match(html, /id="dashboard-kpis"/);
  assert.match(html, /id="dashboard-chart"/);
  assert.match(html, /id="dashboard-latest"/);
  assert.match(html, /id="dashboard-crop"/);
});

test('Phase 4B.25: application shell retains its route, content and responsive drawer hooks', () => {
  const html = shellRegions({
    route: { id: 'customers', title: 'العملاء', subtitle: 'سجل العملاء' },
    appName: 'حسابات العملاء', appTagline: 'محلي', packageWeightKg: 14, body: '<section>محتوى</section>'
  });
  for (const marker of ['app-shell', 'app-sidebar', 'app-header', 'app-content', 'data-sidebar-toggle', 'aria-controls="app-sidebar"', 'data-route="customers"']) {
    assert.ok(html.includes(marker), `missing shell marker: ${marker}`);
  }
});
