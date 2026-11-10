import { runTransaction, req } from '../storage/db.js';
import { STORE } from '../storage/schema.js';
import { AppError, ERROR_CODE } from '../domain/errors.js';

export const USER_ROLE = Object.freeze({ ADMIN: 'admin', EMPLOYEE: 'employee' });
const ITERATIONS = 210000;
let activeSession = null;
let enforcementEnabled = false;
const authChannel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('customer-accounts-auth') : null;
if (authChannel) authChannel.addEventListener('message', event => {
  if (event.data?.type === 'invalidate' && activeSession?.Id === event.data.userId) {
    activeSession = null;
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('auth-session-invalidated'));
  }
});

function cryptoApi() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) throw new Error('المتصفح لا يدعم التشفير الآمن المطلوب.');
  return globalThis.crypto;
}
function bytesToHex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
function hexToBytes(hex) { return new Uint8Array((hex.match(/.{1,2}/g) || []).map(x => parseInt(x, 16))); }
async function derive(password, saltHex) {
  const c = cryptoApi();
  const material = await c.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await c.subtle.deriveBits({ name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: ITERATIONS, hash: 'SHA-256' }, material, 256);
  return bytesToHex(new Uint8Array(bits));
}
async function makePassword(password) {
  if (typeof password !== 'string' || password.length < 10) throw new Error('كلمة المرور يجب ألا تقل عن 10 أحرف.');
  const salt = new Uint8Array(16); cryptoApi().getRandomValues(salt);
  const saltHex = bytesToHex(salt);
  return { PasswordSalt: saltHex, PasswordHash: await derive(password, saltHex), PasswordIterations: ITERATIONS };
}
function normaliseUsername(value) { return String(value || '').trim().toLowerCase(); }
function safeUser(row) { return row ? { Id: row.Id, Username: row.Username, DisplayName: row.DisplayName, Role: row.Role, IsActive: row.IsActive } : null; }
async function allUsers() { return runTransaction(STORE.USERS, 'readonly', s => req(s[STORE.USERS].getAll())); }

export const authService = {
  async hasUsers() { return (await allUsers()).length > 0; },
  enableEnforcement() { enforcementEnabled = true; },
  isEnforced() { return enforcementEnabled; },
  current() { return activeSession ? { ...activeSession } : null; },
  isAuthenticated() { return Boolean(activeSession); },
  isAdmin() { return activeSession?.Role === USER_ROLE.ADMIN; },
  canAddMovements() { return Boolean(activeSession && [USER_ROLE.ADMIN, USER_ROLE.EMPLOYEE].includes(activeSession.Role)); },
  canUseOperations() { return Boolean(activeSession && [USER_ROLE.ADMIN, USER_ROLE.EMPLOYEE].includes(activeSession.Role)); },
  assertCanViewOperations() { if (enforcementEnabled && !this.canUseOperations()) throw new Error('يجب تسجيل الدخول لعرض بيانات التشغيل.'); },
  assertCanCreateCustomer() { if (enforcementEnabled && !this.canUseOperations()) throw new Error('يجب تسجيل الدخول لإضافة عميل.'); },
  assertCanViewLedger() { if (enforcementEnabled && !this.canUseOperations()) throw new Error('يجب تسجيل الدخول لعرض سجل الحركات.'); },
  assertAdmin() { if (enforcementEnabled && !this.isAdmin()) throw new Error('هذه العملية متاحة للمدير فقط.'); },
  assertCanAdd() { if (enforcementEnabled && !this.canAddMovements()) throw new Error('يجب تسجيل الدخول لإضافة الحركات.'); },
  assertCanManageData() { if (enforcementEnabled && !this.isAdmin()) throw new Error('صلاحيات الموظف لا تسمح بهذه العملية.'); },
  async bootstrapAdmin({ username, displayName, password }) {
    if (await this.hasUsers()) throw new Error('تم إعداد المستخدمين بالفعل.');
    const user = normaliseUsername(username);
    if (!/^[a-z0-9._-]{3,32}$/.test(user)) throw new Error('اسم المستخدم من 3 إلى 32 حرفًا إنجليزيًا أو رقمًا أو . _ -');
    const credentials = await makePassword(password);
    const row = { Id: `usr_${cryptoApi().randomUUID()}`, Username: user, DisplayName: String(displayName || '').trim() || user, Role: USER_ROLE.ADMIN, IsActive: true, ...credentials, CreatedAt: new Date().toISOString() };
    await runTransaction(STORE.USERS, 'readwrite', async s => {
      const existing = await req(s[STORE.USERS].getAll());
      if (existing.length) throw new AppError(ERROR_CODE.BUSINESS_RULE_ERROR, 'تم إعداد حساب المستخدمين بالفعل.');
      await req(s[STORE.USERS].add(row));
    });
    return safeUser(row);
  },
  async login(username, password) {
    const key = normaliseUsername(username);
    const row = (await allUsers()).find(u => u.Username === key && u.IsActive);
    if (!row) throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة.');
    const hash = await derive(String(password || ''), row.PasswordSalt);
    if (hash !== row.PasswordHash) throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة.');
    const latest = (await allUsers()).find(u => u.Id === row.Id);
    if (!latest || !latest.IsActive || latest.PasswordHash !== hash) throw new Error('تم تعطيل الحساب أو تغيير كلمة مروره. حاول تسجيل الدخول مرة أخرى.');
    activeSession = { Id: row.Id, Username: row.Username, DisplayName: row.DisplayName, Role: row.Role, LoginAt: new Date().toISOString() };
    return this.current();
  },
  logout() { const userId = activeSession?.Id; activeSession = null; if (userId) authChannel?.postMessage({ type: 'invalidate', userId }); },
  async listUsers() { this.assertAdmin(); return (await allUsers()).map(safeUser); },
  async createEmployee({ username, displayName, password }) {
    this.assertAdmin();
    const key = normaliseUsername(username);
    if (!/^[a-z0-9._-]{3,32}$/.test(key)) throw new Error('اسم المستخدم غير صالح.');
    if ((await allUsers()).some(x => x.Username === key)) throw new AppError(ERROR_CODE.CONFLICT, 'اسم المستخدم مستخدم بالفعل.');
    const credentials = await makePassword(password);
    const row = { Id: `usr_${cryptoApi().randomUUID()}`, Username: key, DisplayName: String(displayName || '').trim() || key, Role: USER_ROLE.EMPLOYEE, IsActive: true, ...credentials, CreatedAt: new Date().toISOString() };
    await runTransaction(STORE.USERS, 'readwrite', async s => {
      const rows = await req(s[STORE.USERS].getAll());
      if (rows.some(x => x.Username === key)) throw new AppError(ERROR_CODE.CONFLICT, 'اسم المستخدم مستخدم بالفعل.');
      await req(s[STORE.USERS].add(row));
    });
    return safeUser(row);
  },
  async setUserActive(id, isActive) {
    this.assertAdmin();
    await runTransaction(STORE.USERS, 'readwrite', async s => {
      const row = await req(s[STORE.USERS].get(id));
      if (!row) throw new Error('المستخدم غير موجود.');
      if (row.Role === USER_ROLE.ADMIN && !isActive) throw new Error('لا يمكن تعطيل حساب المدير الأساسي.');
      row.IsActive = Boolean(isActive); row.UpdatedAt = new Date().toISOString(); await req(s[STORE.USERS].put(row));
    });
    if (!isActive) authChannel?.postMessage({ type: 'invalidate', userId: id });
  },
  async changePassword(id, password) {
    this.assertAdmin();
    const credentials = await makePassword(password);
    await runTransaction(STORE.USERS, 'readwrite', async s => {
      const row = await req(s[STORE.USERS].get(id)); if (!row) throw new Error('المستخدم غير موجود.');
      Object.assign(row, credentials, { UpdatedAt: new Date().toISOString() }); await req(s[STORE.USERS].put(row));
    });
    authChannel?.postMessage({ type: 'invalidate', userId: id });
  }
};
