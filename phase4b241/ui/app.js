// Application entry: mounts the shell, wires the hash router, the active
// navigation state, the mobile sidebar toggle and the active screen. It talks to
// the SERVICES layer only and never reaches the persistence layer below it.
import { createRouter, buildHash, resolveDestination } from './router.js';
import { shellRegions } from './components/layout.js';
import { escapeHtml } from './components/html.js';
import { renderDestinationView, initDestinationView } from './views/index.js';
import { errorState } from './components/states.js';
import { databaseInit } from '../src/services/databaseInit.js';
import { settingsService } from '../src/services/settingsService.js';
import { logger } from '../src/utils/logger.js';
import { authService } from '../src/services/authService.js';
import { TRANSACTION_DESTINATION, transactionAddPath } from './routes.js';

export const APP_NAME = 'حسابات العملاء';
export const APP_TAGLINE = 'تطبيق محلي يعمل دون اتصال';

export const VIEW_LABEL = {
  loading: 'جارٍ تهيئة التخزين المحلي…',
  ready: null,
  error: 'تعذّر تهيئة التخزين المحلي.'
};

export const SETTINGS_STATE = Object.freeze({ READY: 'ready', ERROR: 'error' });

// Reads the one existing setting through the service layer. DefaultPackageWeight
// has exactly one source: Settings. The UI holds no package-weight literal, so a
// failed read propagates as a failure instead of quietly becoming a guessed value.
export async function readPackageWeight() {
  await databaseInit.initialize();
  return settingsService.getDefaultPackageWeight();
}

function settingsBadgeLabel(packageWeightKg) {
  return `الوزن الافتراضي للعبوة: ${packageWeightKg} كجم`;
}

// Applies the outcome of the settings read to the mounted shell. It runs on the
// success path AND on the failure path, and it never writes a fallback number: a
// failed read produces a visible error state instead of an inferred value.
export function applySettingsOutcome({ root, packageWeightKg = null, companyName = '', error = null } = {}) {
  if (!root) return null;
  const hasValue = !error && packageWeightKg !== null && packageWeightKg !== undefined;
  const badge = typeof root.querySelector === 'function' ? root.querySelector('.app-header__actions .badge') : null;

  if (hasValue) {
    if (badge) badge.textContent = settingsBadgeLabel(packageWeightKg);
    if (companyName) { const brand = root.querySelector('.app-sidebar__title strong'); if (brand) brand.textContent = companyName; const sidebar = root.querySelector('.app-sidebar'); if (sidebar) sidebar.setAttribute('aria-label', companyName); }
    root.setAttribute('data-settings', SETTINGS_STATE.READY);
    return packageWeightKg;
  }

  if (badge) badge.textContent = VIEW_LABEL.error;
  const content = typeof root.querySelector === 'function' ? root.querySelector('.app-content') : null;
  if (content && typeof content.insertAdjacentHTML === 'function') {
    content.insertAdjacentHTML('afterbegin', errorState({
      title: VIEW_LABEL.error,
      message: 'تعذّر قراءة إعدادات النظام من المخزن المحلي، ولم تُعرض أي قيمة بديلة.',
      code: error && error.code ? String(error.code) : null
    }));
  }
  root.setAttribute('data-settings', SETTINGS_STATE.ERROR);
  return null;
}

// The loading state always ends: aria-busy is cleared in a finally block, so the
// shell can never stay busy indefinitely, on success and on failure alike.
export async function loadSettings({ root, readSettings = readPackageWeight, readCompanyName = () => settingsService.getCompanyName(), onOutcome = null } = {}) {
  if (!root) return null;
  root.setAttribute('aria-busy', 'true');
  try {
    const [packageWeightKg, companyName] = await Promise.all([readSettings(), readCompanyName().catch(() => '')]);
    applySettingsOutcome({ root, packageWeightKg, companyName });
    if (typeof onOutcome === 'function') onOutcome({ packageWeightKg, companyName, error: null });
    return packageWeightKg;
  } catch (error) {
    logger.error('shell settings read failed', {
      code: error && error.code ? String(error.code) : null,
      message: error && error.message ? String(error.message) : null
    });
    applySettingsOutcome({ root, error });
    if (typeof onOutcome === 'function') onOutcome({ packageWeightKg: null, companyName: '', error });
    return null;
  } finally {
    root.setAttribute('aria-busy', 'false');
  }
}

// Phase 4B.24 — first-run bootstrap and login gate. This is local-device access control,
// not server-side identity security; browser-local storage remains accessible to a technically capable local user.
function authScreen({ setup = false, error = '' } = {}) {
  const title = setup ? 'إنشاء حساب المدير الأساسي' : 'تسجيل الدخول';
  const description = setup ? 'أنشئ أول حساب مدير. لا توجد بيانات دخول افتراضية.' : 'أدخل اسم المستخدم وكلمة المرور للمتابعة.';
  return `<main class="auth-screen" dir="rtl"><section class="auth-card"><div class="auth-brand">ح</div><h1>${title}</h1><p>${description}</p>
    ${error ? `<div class="alert alert--danger" role="alert">${String(error).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</div>` : ''}
    <form id="auth-form" class="stack" novalidate>
      ${setup ? `<label class="field"><span class="field__label">الاسم الظاهر</span><input class="input" name="displayName" autocomplete="name" required></label>` : ''}
      <label class="field"><span class="field__label">اسم المستخدم</span><input class="input" name="username" autocomplete="username" required></label>
      <label class="field"><span class="field__label">كلمة المرور</span><input class="input" name="password" type="password" autocomplete="${setup?'new-password':'current-password'}" required minlength="${setup?10:1}"></label>
      ${setup ? `<label class="field"><span class="field__label">تأكيد كلمة المرور</span><input class="input" name="confirmPassword" type="password" autocomplete="new-password" required minlength="10"></label>` : ''}
      <button class="btn btn--primary" type="submit">${setup ? 'إنشاء حساب المدير' : 'دخول'}</button>
    </form><p class="auth-footnote">يتم حفظ كلمة المرور بصيغة مشفّرة مشتقة مع Salt، ولا تُحفظ كنص صريح.</p>
  </section></main>`;
}

function showAuth(root, setup, error = '') {
  root.innerHTML = authScreen({ setup, error });
  const form = root.querySelector('#auth-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const username = String(data.get('username') || '');
    const password = String(data.get('password') || '');
    try {
      if (setup) {
        if (password !== String(data.get('confirmPassword') || '')) throw new Error('تأكيد كلمة المرور غير مطابق.');
        await authService.bootstrapAdmin({ username, displayName: data.get('displayName'), password });
      }
      await authService.login(username, password);
      root.replaceChildren();
      const app = mountApp({ root, packageWeightKg: null });
      loadSettings({ root, onOutcome: ({ packageWeightKg, companyName, error }) => app?.applySettings({ packageWeightKg, companyName, error }) });
    } catch (error) { showAuth(root, setup, error?.message || 'تعذّر إتمام العملية.'); }
  });
}

export function isEmployeeRouteAllowed(destinationId) {
  // Account statements, dashboards, reports, settings, backup/restore and reference
  // administration stay admin-only.
  return new Set([
    'customers', 'customers-new', 'transactions', 'transactions-add',
    'crop-purchases', 'payments', 'settlements'
  ]).has(destinationId);
}

export function routeAllowed(destination) {
  if (!authService.isAuthenticated()) return false;
  if (authService.isAdmin()) return true;
  return isEmployeeRouteAllowed(destination?.id);
}

function applyRoleShell(shell, navigate) {
  const user = authService.current();
  if (!user) return;
  if (user.Role !== 'admin') {
    const settingsBadge = shell.querySelector('.app-header__actions .badge');
    if (settingsBadge) settingsBadge.remove();
    const allowed = new Set(['customers', 'transactions', 'crop-purchases', 'payments', 'settlements']);
    shell.querySelectorAll('.app-nav__link').forEach(link => {
      const href = link.getAttribute('href') || '';
      const path = href.replace(/^#\/?/, '').split('?')[0];
      const id = path.split('/')[0];
      if (!allowed.has(id)) link.remove();
    });
    shell.querySelectorAll('.app-nav__group').forEach(group => {
      if (!group.querySelector('.app-nav__link')) group.remove();
    });
    const nav = shell.querySelector('.app-nav');
    if (nav && !nav.querySelector('.app-nav__link')) nav.innerHTML = `<a class="app-nav__link" href="#${transactionAddPath()}"><span class="app-nav__icon">＋</span><span>إضافة حركة جديدة</span></a>`;
  }
  const actions = shell.querySelector('.app-header__actions');
  const roleLabel = user.Role === 'admin' ? 'مدير' : 'موظف';
  if (actions) actions.insertAdjacentHTML('beforeend', `<span class="badge app-user-chip" data-user-role="${user.Role === 'admin' ? 'admin' : 'employee'}"><span class="app-user-chip__dot" aria-hidden="true"></span><span class="app-user-chip__name">${escapeHtml(user.DisplayName || '')}</span><span class="app-user-chip__role">${roleLabel}</span></span><button class="btn btn--outline btn--sm app-logout" type="button" data-auth-logout>خروج</button>`);
}

// Renders one destination (route) into the shell and activates its screen.
function renderShell({ root, destination, params, packageWeightKg, navigate }) {
  const shell = document.createElement('div');
  shell.innerHTML = shellRegions({
    route: destination,
    activeRouteId: destination.parentRouteId || destination.id,
    appName: APP_NAME,
    appTagline: APP_TAGLINE,
    packageWeightKg,
    body: renderDestinationView({ route: destination, params })
  });
  const node = shell.firstElementChild;
  applyRoleShell(node, navigate);
  root.replaceChildren(node);
  document.title = `${destination.title} — ${APP_NAME}`;
  const content = node.querySelector('.app-content');
  if (content) initDestinationView({ container: content, route: destination, params, navigate });
  return node;
}

export function mountApp({ root, win = globalThis.window, packageWeightKg = null, settingsError = null } = {}) {
  if (!root) return null;
  if (authService.isEnforced() && !authService.isAuthenticated()) { showAuth(root, false); return null; }
  const settings = { applied: packageWeightKg !== null || settingsError !== null, packageWeightKg, companyName: '', error: settingsError };
  const navigate = (path) => {
    if (win && win.location) win.location.hash = buildHash(path);
  };
  const renderWeight = () => (settings.applied && !settings.error ? settings.packageWeightKg : null);

  // Re-applies the settings outcome after every re-render so the header badge and
  // the visible settings error survive navigation.
  const paintSettings = () => {
    if (!settings.applied) return;
    applySettingsOutcome({ root, packageWeightKg: renderWeight(), companyName: settings.companyName, error: settings.error });
  };

  let initialResolution = resolveDestination(win && win.location ? win.location.hash : '');
  if (!authService.isAdmin() && authService.isAuthenticated() && !routeAllowed(initialResolution.destination)) {
    const fallback = '/transactions';
    if (win?.location) win.location.hash = buildHash(fallback);
    initialResolution = resolveDestination(buildHash(fallback));
  }
  let shell = renderShell({
    root,
    destination: initialResolution.destination,
    params: initialResolution.params,
    packageWeightKg: null,
    navigate
  });
  paintSettings();

  const closeSidebar = () => {
    shell.dataset.sidebar = 'closed';
    const toggle = shell.querySelector('[data-sidebar-toggle]');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  };

  const router = createRouter({
    win,
    onNavigate: (resolution) => {
      if (!routeAllowed(resolution.destination)) {
        navigate(authService.isAuthenticated() ? '/transactions' : '/dashboard');
        return;
      }
      shell = renderShell({
        root,
        destination: resolution.destination,
        params: resolution.params,
        packageWeightKg: renderWeight(),
        navigate
      });
      closeSidebar();
      paintSettings();
    }
  });

  // Delegated so listeners survive every re-render of the shell.
  root.addEventListener('company-name-updated', (event) => { settings.companyName = String(event.detail?.companyName || ''); applySettingsOutcome({ root, packageWeightKg: renderWeight(), companyName: settings.companyName }); });

  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-auth-logout]')) {
      authService.logout();
      router.stop();
      showAuth(root, false);
      return;
    }
    const toggle = event.target.closest('[data-sidebar-toggle]');
    if (toggle) {
      const isOpen = shell.dataset.sidebar === 'open';
      shell.dataset.sidebar = isOpen ? 'closed' : 'open';
      toggle.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
      return;
    }
    if (event.target.closest('[data-sidebar-close]')) closeSidebar();
  });

  win.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSidebar();
  });

  win.addEventListener('auth-session-invalidated', () => {
    router.stop();
    showAuth(root, false, 'تم إيقاف هذا الحساب أو تغيير كلمة مروره. سجّل الدخول مرة أخرى.');
  }, { once: true });

  router.start();
  return {
    router,
    navigate,
    applySettings({ packageWeightKg: value = null, companyName = '', error = null } = {}) {
      settings.applied = true;
      settings.packageWeightKg = value;
      settings.companyName = companyName;
      settings.error = error;
    }
  };
}

export async function bootstrap() {
  const root = document.getElementById('app');
  if (!root) return undefined;
  try {
    await databaseInit.initialize();
    authService.enableEnforcement();
    if (!(await authService.hasUsers())) { showAuth(root, true); return null; }
    if (!authService.isAuthenticated()) { showAuth(root, false); return null; }
    const app = mountApp({ root, packageWeightKg: null });
    loadSettings({ root, onOutcome: ({ packageWeightKg, companyName, error }) => app?.applySettings({ packageWeightKg, companyName, error }) });
    if (app) root.setAttribute('data-shell', 'mounted');
    return app;
  } catch (error) {
    root.innerHTML = `<main class="auth-screen"><section class="auth-card"><h1>تعذّر تشغيل التطبيق</h1><p>${String(error?.message || 'خطأ غير معروف')}</p></section></main>`;
    return null;
  }
}

export { buildHash };

if (typeof document !== 'undefined' && document.getElementById('app')) {
  bootstrap();
}
