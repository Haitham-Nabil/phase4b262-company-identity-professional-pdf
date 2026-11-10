// Shell regions: sidebar (brand + navigation), header (breadcrumb, title,
// actions) and the mobile backdrop.
// Phase 4B.7B keeps every contract the router, the JavaScript and the tests rely
// on: .app-shell[data-sidebar], #app-sidebar, .app-header, .app-content,
// [data-sidebar-toggle][aria-controls="app-sidebar"][aria-expanded],
// .app-nav__link[data-route-id][aria-current="page"], .app-nav__icon, .app-backdrop.
import { escapeHtml, attrs, joinParts } from './html.js';
import { groupedRoutes, findRouteById } from '../routes.js';
import { buildHash } from '../router.js';
import { iconSvg } from './icons.js';

export function sidebarBrand({ appName, appTagline }) {
  return `<div class="app-sidebar__brand">
  <span class="app-sidebar__logo" aria-hidden="true">ح</span>
  <span class="app-sidebar__title"><strong>${escapeHtml(appName)}</strong><span>${escapeHtml(appTagline)}</span></span>
</div>`;
}

export function navigation({ activeRouteId = null, ariaLabel = 'التنقل الرئيسي' }) {
  const groups = groupedRoutes().map((group) => {
    const links = group.routes.map((route) => {
      const isActive = route.id === activeRouteId;
      return `<a class="app-nav__link" href="${buildHash(route.path)}" data-route-id="${escapeHtml(route.id)}"${isActive ? ' aria-current="page"' : ''}>
  <span class="app-nav__icon" aria-hidden="true">${iconSvg(route.icon)}</span>
  <span>${escapeHtml(route.title)}</span>
</a>`;
    }).join('\n');
    return `<div class="app-nav__group">
  <div class="app-nav__group-title">${escapeHtml(group.title)}</div>
${links}
</div>`;
  }).join('\n');
  return `<nav class="app-nav" aria-label="${escapeHtml(ariaLabel)}">${groups}</nav>`;
}

export function sidebar({ activeRouteId = null, appName, appTagline }) {
  return `<aside class="app-sidebar" id="app-sidebar" aria-label="${escapeHtml(appName)}">
${sidebarBrand({ appName, appTagline })}
${navigation({ activeRouteId })}
</aside>`;
}

// A destination that hangs off a navigation item (customer account, customer
// form, add-transaction) gets a breadcrumb back to its parent section. A
// top-level route renders no breadcrumb, so nothing is invented for it.
export function breadcrumb({ route }) {
  if (!route || !route.parentRouteId) return '';
  const parent = findRouteById(route.parentRouteId);
  if (!parent) return '';
  return `<nav class="app-breadcrumb" aria-label="مسار التنقل">
  <a class="app-breadcrumb__link" href="${buildHash(parent.path)}">${escapeHtml(parent.title)}</a>
  <span class="app-breadcrumb__sep" aria-hidden="true">${iconSvg('chevron')}</span>
  <span class="app-breadcrumb__current">${escapeHtml(route.title)}</span>
</nav>`;
}

export function header({ route, packageWeightKg = null }) {
  const settingLabel = packageWeightKg === null
    ? 'جارٍ قراءة الإعدادات…'
    : `الوزن الافتراضي للعبوة: ${escapeHtml(packageWeightKg)} كجم`;
  return `<header class="app-header">
  <button class="btn btn--icon btn--ghost sidebar-toggle" type="button" data-sidebar-toggle aria-controls="app-sidebar" aria-expanded="false">
    ${iconSvg('menu')}<span class="visually-hidden">إظهار/إخفاء القائمة</span>
  </button>
  <div class="app-header__titles">
    ${breadcrumb({ route })}
    <h1>${escapeHtml(route.title)}</h1>
    <span class="app-header__subtitle">${escapeHtml(route.subtitle)}</span>
  </div>
  <div class="app-header__actions">
    <span class="badge">${escapeHtml(settingLabel)}</span>
  </div>
</header>`;
}

export function backdrop() {
  return '<div class="app-backdrop" data-sidebar-close aria-hidden="true"></div>';
}

export function contentArea(body, { id = 'app-content' } = {}) {
  return `<main class="app-content" id="${escapeHtml(id)}" tabindex="-1">${body}</main>`;
}

// activeRouteId lets a sub-screen (e.g. a customer form) keep its parent sidebar
// item highlighted. It defaults to the route's own id.
export function shellRegions({ route, appName, appTagline, packageWeightKg, body, activeRouteId = null }) {
  return joinParts([
    `<div class="app-shell" data-sidebar="closed"${attrs({ 'data-route': route.id })}>`,
    sidebar({ activeRouteId: activeRouteId || route.id, appName, appTagline }),
    '<div class="app-main">',
    header({ route, packageWeightKg }),
    contentArea(body),
    '</div>',
    backdrop(),
    '</div>'
  ]);
}
