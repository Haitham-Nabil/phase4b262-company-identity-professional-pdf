import { authService } from '../../src/services/authService.js';
// Phase 4B.23 — functional application settings screen.
// The screen reads and writes through settingsService only. Historical crop movements
// are not touched: the setting is consumed only when a NEW local crop purchase is made.
import { pageHeader, card, alert } from '../components/index.js';
import { escapeHtml } from '../components/html.js';
import { errorState, loadingState } from '../components/states.js';
import { settingsService } from '../../src/services/settingsService.js';
import { logger } from '../../src/utils/logger.js';

export const SETTINGS_ROOT_ID = 'settings-root';
export const SETTINGS_FORM_ID = 'settings-form';
export const SETTINGS_WEIGHT_ID = 'settings-default-package-weight';
export const SETTINGS_SAVE_ID = 'settings-save';
export const SETTINGS_COMPANY_ID = 'settings-company-name';

export function settingsViewHtml() {
  return [pageHeader({ title: 'إعدادات التطبيق', description: 'إدارة القيم الافتراضية التي تستخدمها الحركات الجديدة.' }),
    `<section id="${SETTINGS_ROOT_ID}" class="stack" aria-busy="true">${loadingState({ message: 'جارٍ تحميل إعدادات التطبيق…' })}</section>${usersPanelHtml()}`].join('\n');
}

export function settingsFormHtml({ value = '', companyName = '', status = '', tone = 'info', error = null, busy = false } = {}) {
  const statusHtml = status ? alert({ tone, message: status }) : '';
  const errorHtml = error ? alert({ tone: 'danger', title: 'تعذّر حفظ الإعداد', message: error }) : '';
  return `${statusHtml}${errorHtml}${card({ title: 'بيانات الشركة', body: `<form id="settings-company-form" class="stack" novalidate><div class="field"><label class="field__label" for="${SETTINGS_COMPANY_ID}">اسم الشركة</label><input class="input" id="${SETTINGS_COMPANY_ID}" name="companyName" maxlength="120" required value="${escapeHtml(companyName)}" ${busy ? 'disabled' : ''}><span class="field__hint">سيظهر الاسم أعلى القائمة الجانبية وفي التقارير المطبوعة.</span></div><div class="row row--end"><button class="btn btn--primary" type="submit" ${busy ? 'disabled' : ''}>حفظ بيانات الشركة</button></div></form>` })}${card({ title: 'الوزن الافتراضي للعبوة', body: `<form id="${SETTINGS_FORM_ID}" class="stack" novalidate>
    <div class="field"><label class="field__label" for="${SETTINGS_WEIGHT_ID}">وزن العبوة بالكيلوجرام</label>
    <input class="input" id="${SETTINGS_WEIGHT_ID}" name="defaultPackageWeight" type="number" min="0.001" step="any" inputmode="decimal" required value="${escapeHtml(value)}" aria-describedby="settings-weight-hint" ${busy ? 'disabled' : ''}>
    <span class="field__hint" id="settings-weight-hint">تُستخدم هذه القيمة تلقائيًا عند تسجيل مشتريات محصول محلي جديدة فقط. لا تؤثر على أوزان الحركات المسجلة سابقًا.</span></div>
    <div class="row row--end"><button class="btn btn--primary" id="${SETTINGS_SAVE_ID}" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'جارٍ الحفظ…' : 'حفظ الإعدادات'}</button></div>
  </form>` })}`;
}

export function createSettingsController({ container, service = settingsService } = {}) {
  if (!container) return null;
  const state = { value: '', companyName: '', busy: false, loaded: false, error: null, status: '', tone: 'info' };
  const root = () => container.querySelector(`#${SETTINGS_ROOT_ID}`);
  const paint = () => {
    const target = root();
    if (!target) return;
    target.innerHTML = state.loaded ? settingsFormHtml({ value: state.value, companyName: state.companyName, status: state.status, tone: state.tone, error: state.error, busy: state.busy })
      : (state.error ? `${errorState({ title: 'تعذّر تحميل الإعدادات', message: state.error })}<div class="row"><button class="btn btn--outline" type="button" data-action="settings-retry">إعادة المحاولة</button></div>` : loadingState({ message: 'جارٍ تحميل إعدادات التطبيق…' }));
    target.setAttribute('aria-busy', state.busy || !state.loaded ? 'true' : 'false');
  };
  async function load() {
    state.error = null;
    try {
      const [value, companyName] = await Promise.all([service.getDefaultPackageWeight(), service.getCompanyName?.() ?? Promise.resolve('')]);
      if (!Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error('قيمة الوزن الافتراضي المخزنة غير صالحة.');
      state.value = String(value); state.companyName = companyName || ''; state.loaded = true; state.status = '';
    } catch (error) {
      logger.error('settings screen load failed', { code: error?.code || null, message: error?.message || null });
      state.error = error?.message || 'تعذّر تحميل إعدادات التطبيق.'; state.loaded = false;
    }
    paint(); return { ...state };
  }
  async function save(rawValue = null) {
    if (state.busy) return null;
    const input = rawValue === null ? root()?.querySelector(`#${SETTINGS_WEIGHT_ID}`)?.value : rawValue;
    const cleaned = String(input ?? '').trim();
    const value = cleaned === '' ? NaN : Number(cleaned);
    state.value = cleaned;
    if (!Number.isFinite(value) || value <= 0) {
      state.error = 'أدخل وزنًا رقميًا أكبر من صفر.'; state.status = ''; paint();
      return { Ok: false, Message: state.error };
    }
    state.busy = true; state.error = null; state.status = ''; paint();
    try {
      const saved = await service.setDefaultPackageWeight(value);
      state.value = String(saved.Value); state.loaded = true;
      state.status = `تم حفظ الوزن الافتراضي الجديد: ${state.value} كجم. سيُستخدم مع الحركات الجديدة فقط.`;
      state.tone = 'success'; updateHeaderWeight(container, saved.Value);
      return { Ok: true, Value: saved.Value };
    } catch (error) {
      logger.error('settings screen save failed', { code: error?.code || null, message: error?.message || null });
      state.error = error?.message || 'تعذّر حفظ الوزن الافتراضي.';
      return { Ok: false, Message: state.error };
    } finally { state.busy = false; paint(); }
  }
  container.addEventListener('submit', async (event) => {
    if (event.target?.id === 'settings-company-form') { event.preventDefault(); try { const saved = await service.setCompanyName(new FormData(event.target).get('companyName')); state.companyName = saved.Value; state.status = 'تم حفظ اسم الشركة وسيظهر في القائمة الجانبية والتقارير.'; state.tone = 'success'; state.error = null; paint(); updateCompanyName(container, saved.Value); container.dispatchEvent(new CustomEvent('company-name-updated', { bubbles: true, detail: { companyName: saved.Value } })); } catch (error) { state.error = error?.message || 'تعذّر حفظ اسم الشركة.'; paint(); } return; }
    if (event.target?.id !== SETTINGS_FORM_ID) return;
    event.preventDefault(); void save();
  });
  container.addEventListener('click', (event) => {
    if (event.target?.closest?.('[data-action="settings-retry"]')) void load();
  });
  void load();
  return { load, save, state: () => ({ ...state }) };
}

function updateCompanyName(container, value) { const shell = container.closest?.('.app-shell'); const brand = shell?.querySelector?.('.app-sidebar__title strong'); if (brand) brand.textContent = value; const sidebar = shell?.querySelector?.('.app-sidebar'); if (sidebar) sidebar.setAttribute('aria-label', value); }

function updateHeaderWeight(container, value) {
  const shell = container.closest?.('.app-shell');
  const badge = shell?.querySelector?.('.app-header__actions .badge');
  if (badge) badge.textContent = `الوزن الافتراضي للعبوة: ${value} كجم`;
}

export function initSettingsView({ container, service = settingsService } = {}) {
  const controller = createSettingsController({ container, service });
  if (authService.isAdmin()) {
    const list = async () => {
      const target = container.querySelector('#users-list'); if (!target) return;
      try {
        const users = await authService.listUsers();
        target.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>المستخدم</th><th>الصلاحية</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>${users.map(u => `<tr><td>${escapeHtml(u.DisplayName)}<small>${escapeHtml(u.Username)}</small></td><td>${u.Role === 'admin' ? 'مدير' : 'موظف'}</td><td>${u.IsActive ? 'نشط' : 'معطّل'}</td><td>${u.Role === 'employee' ? `<button class="btn btn--outline btn--sm" type="button" data-user-toggle="${escapeHtml(u.Id)}" data-active="${u.IsActive ? '1':'0'}">${u.IsActive ? 'تعطيل':'تفعيل'}</button> <button class="btn btn--outline btn--sm" type="button" data-user-password="${escapeHtml(u.Id)}">تغيير كلمة المرور</button>` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
      } catch (e) { target.textContent = e.message; }
    };
    void list();
    container.addEventListener('submit', async event => {
      if (event.target?.id !== 'employee-create-form') return;
      event.preventDefault(); const data = new FormData(event.target);
      const status = container.querySelector('#users-status');
      try { await authService.createEmployee({ username:data.get('username'), displayName:data.get('displayName'), password:data.get('password') }); event.target.reset(); status.textContent='تم إنشاء حساب الموظف.'; await list(); }
      catch(e) { status.textContent=e.message; }
    });
    container.addEventListener('click', async event => {
      const toggle = event.target.closest('[data-user-toggle]');
      const change = event.target.closest('[data-user-password]');
      const adminChange = event.target.closest('[data-admin-password]');
      const status = container.querySelector('#users-status');
      try {
        if (toggle) { await authService.setUserActive(toggle.dataset.userToggle, toggle.dataset.active !== '1'); await list(); }
        if (change) { const password = prompt('أدخل كلمة المرور الجديدة (10 أحرف على الأقل):'); if (password !== null) { await authService.changePassword(change.dataset.userPassword, password); status.textContent='تم تغيير كلمة المرور.'; } }
        if (adminChange) { const password = prompt('أدخل كلمة مرور المدير الجديدة (10 أحرف على الأقل):'); if (password !== null) { const me = authService.current(); await authService.changePassword(me.Id, password); status.textContent='تم تغيير كلمة مرور المدير.'; } }
      } catch(e) { status.textContent=e.message; }
    });
  }
  return controller;
}

// Phase 4B.24 — user administration is visible only to the primary manager.

function usersPanelHtml() {
  if (!authService.isAdmin()) return '';
  return `<section class="card stack" id="user-management"><div class="card__header"><h2>إدارة المستخدمين</h2></div>
    <form id="employee-create-form" class="grid grid--cols-2" novalidate>
      <label class="field"><span class="field__label">اسم المستخدم</span><input class="input" name="username" required autocomplete="off"></label>
      <label class="field"><span class="field__label">الاسم الظاهر</span><input class="input" name="displayName"></label>
      <label class="field"><span class="field__label">كلمة المرور (10 أحرف على الأقل)</span><input class="input" name="password" type="password" minlength="10" required autocomplete="new-password"></label>
      <div class="row row--end"><button class="btn btn--primary" type="submit">إنشاء مستخدم موظف</button></div>
    </form><div class="row row--end"><button class="btn btn--outline btn--sm" type="button" data-admin-password>تغيير كلمة مرور المدير</button></div><div id="users-status" aria-live="polite"></div><div id="users-list">جارٍ تحميل المستخدمين…</div>
  </section>`;
}

