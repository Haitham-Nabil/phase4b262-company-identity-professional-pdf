import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsViewHtml, settingsFormHtml, createSettingsController, SETTINGS_ROOT_ID, SETTINGS_WEIGHT_ID, SETTINGS_FORM_ID } from '../ui/views/settings.js';
import { cropPurchasesViewHtml, initCropPurchasesView, CROP_PURCHASE_LOCAL_ACTION, CROP_PURCHASE_CARTON_ACTION } from '../ui/views/cropPurchases.js';
import { resolveDestination } from '../ui/router.js';
import { renderDestinationView } from '../ui/views/index.js';
import { TRANSACTION_TYPE } from '../src/services/transactionFormService.js';

test('4B.23-S1 settings screen renders an editable positive numeric package-weight field', () => {
  assert.match(settingsViewHtml(), new RegExp(SETTINGS_ROOT_ID));
  const form = settingsFormHtml({ value: '14' });
  assert.match(form, new RegExp(SETTINGS_FORM_ID)); assert.match(form, new RegExp(SETTINGS_WEIGHT_ID));
  assert.match(form, /type="number"/); assert.match(form, /min="0\.001"/); assert.match(form, /الحركات المسجلة سابقًا/);
});

test('4B.23-S2 settings controller validates and persists the configured weight', async () => {
  const input = { value: '' };
  const root = { innerHTML: '', attributes: new Map(), setAttribute(k, v) { this.attributes.set(k, v); }, querySelector(selector) { return selector === `#${SETTINGS_WEIGHT_ID}` ? input : null; } };
  const badge = { textContent: '' }; const shell = { querySelector(selector) { return selector === '.app-header__actions .badge' ? badge : null; } };
  const listeners = {}; const container = { querySelector(selector) { return selector === `#${SETTINGS_ROOT_ID}` ? root : null; }, addEventListener(type, fn) { listeners[type] = fn; }, closest(selector) { return selector === '.app-shell' ? shell : null; } };
  let stored = 14; const service = { async getDefaultPackageWeight() { return stored; }, async setDefaultPackageWeight(value) { stored = value; return { Key: 'DefaultPackageWeight', Value: value }; } };
  const controller = createSettingsController({ container, service }); await controller.load();
  assert.equal(controller.state().value, '14'); assert.equal(root.attributes.get('aria-busy'), 'false');
  const invalid = await controller.save('0'); assert.equal(invalid.Ok, false); assert.equal(stored, 14);
  const saved = await controller.save('18.5'); assert.deepEqual(saved, { Ok: true, Value: 18.5 });
  assert.equal(stored, 18.5); assert.equal(controller.state().value, '18.5'); assert.match(root.innerHTML, /18\.5/);
  assert.match(root.innerHTML, /الحركات الجديدة فقط/); assert.equal(badge.textContent, 'الوزن الافتراضي للعبوة: 18.5 كجم');
  assert.equal(typeof listeners.submit, 'function');
});

test('4B.23-C1 crop-purchases hub offers distinct local and carton actions', () => {
  const html = cropPurchasesViewHtml(); assert.match(html, new RegExp(CROP_PURCHASE_LOCAL_ACTION));
  assert.match(html, new RegExp(CROP_PURCHASE_CARTON_ACTION)); assert.match(html, /إدارة الشركات والأصناف وأنواع الكراتين/);
});

test('4B.23-C2 crop-purchases actions navigate to the correct transaction type', () => {
  const listeners = {}; const container = { addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener() {} }; const paths = [];
  initCropPurchasesView({ container, navigate: (path) => paths.push(path) });
  const click = (action) => listeners.click({ target: { closest: () => ({ getAttribute: () => action }) } });
  click(CROP_PURCHASE_LOCAL_ACTION); click(CROP_PURCHASE_CARTON_ACTION);
  assert.equal(paths.length, 2); const local = resolveDestination(`#${paths[0]}`); const carton = resolveDestination(`#${paths[1]}`);
  assert.equal(local.destination.id, 'transactions-add'); assert.equal(local.params.type, TRANSACTION_TYPE.CROP_PURCHASE_LOCAL);
  assert.equal(carton.destination.id, 'transactions-add'); assert.equal(carton.params.type, TRANSACTION_TYPE.CROP_PURCHASE_CARTON);
  assert.match(renderDestinationView({ route: local.destination, params: local.params }), /data-transaction-type="CropPurchaseLocal"/);
});
