// Phase 4A.1 hardening tests: the three mandatory corrections, exercised against
// the real modules. No dependency is added, no existing test is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { applySettingsOutcome, loadSettings, VIEW_LABEL, SETTINGS_STATE } from '../ui/app.js';
import { modal } from '../ui/components/index.js';
import { logger } from '../src/utils/logger.js';

logger.disable?.();

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const uiRoot = join(projectRoot, 'ui');

// Minimal stand-in for the mounted shell root: only the surface ui/app.js uses.
function createRootStub(badgeText = 'جارٍ قراءة الإعدادات…') {
  const attributes = new Map();
  const badge = { textContent: badgeText };
  const content = {
    html: '',
    insertAdjacentHTML(position, markup) {
      assert.equal(position, 'afterbegin', 'the error state is prepended to the content area');
      this.html += markup;
    }
  };
  return {
    attributes, badge, content,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    querySelector(selector) {
      if (selector === '.app-header__actions .badge') return badge;
      if (selector === '.app-content') return content;
      return null;
    }
  };
}

test('A — a successful settings read shows the configured value and ends the loading state', async () => {
  const root = createRootStub();
  const configured = 21; // deliberately not the 14 kg seed value
  const value = await loadSettings({ root, readSettings: async () => configured });

  assert.equal(value, configured);
  assert.match(root.badge.textContent, /21/);
  assert.notEqual(root.getAttribute('aria-busy'), 'true', 'aria-busy must not remain true');
  assert.equal(root.getAttribute('aria-busy'), 'false');
  assert.equal(root.getAttribute('data-settings'), SETTINGS_STATE.READY);
  assert.equal(root.content.html, '', 'the success path renders no error state');
  assert.doesNotMatch(root.badge.textContent, /14/, 'the seed value must never be used as a fallback');
  assert.doesNotMatch(root.badge.textContent, /تعذّر/, 'no error text on the success path');
});

test('B — a failed settings read ends the loading state, shows an error and invents no value', async () => {
  const root = createRootStub();
  const failure = new Error('settings unavailable');
  failure.code = 'STORAGE_ERROR';
  const value = await loadSettings({ root, readSettings: async () => { throw failure; } });

  assert.equal(value, null);
  assert.equal(root.getAttribute('aria-busy'), 'false');
  assert.notEqual(root.getAttribute('aria-busy'), 'true', 'the shell must never stay busy indefinitely');
  assert.equal(root.getAttribute('data-settings'), SETTINGS_STATE.ERROR);
  assert.equal(root.badge.textContent, VIEW_LABEL.error);
  assert.match(root.content.html, /role="alert"/);
  assert.match(root.content.html, /STORAGE_ERROR/);
  assert.match(root.content.html, /لم تُعرض أي قيمة بديلة/);

  const rendered = `${root.badge.textContent}${root.content.html}`;
  assert.doesNotMatch(rendered, /14/, 'no package weight may be invented after a failed read');
  assert.doesNotMatch(rendered, /كجم/, 'no weight unit may be shown after a failed read');
});

test('B2 — a missing settings value is treated as a failure, never as a value', async () => {
  const root = createRootStub();
  const value = await loadSettings({ root, readSettings: async () => null });

  assert.equal(value, null);
  assert.equal(root.getAttribute('data-settings'), SETTINGS_STATE.ERROR);
  assert.equal(root.badge.textContent, VIEW_LABEL.error);
  assert.notEqual(root.getAttribute('aria-busy'), 'true');
  assert.doesNotMatch(`${root.badge.textContent}${root.content.html}`, /14/);
});

test('B3 — the failure path never reports the shell as ready', () => {
  const root = createRootStub();
  applySettingsOutcome({ root, error: Object.assign(new Error('boom'), { code: 'STORAGE_ERROR' }) });

  assert.equal(root.getAttribute('data-settings'), SETTINGS_STATE.ERROR);
  assert.notEqual(root.getAttribute('data-settings'), SETTINGS_STATE.READY);
});

test('C — the hidden attribute cannot be overridden by any display rule', () => {
  const base = readFileSync(join(uiRoot, 'styles/base.css'), 'utf8');
  const rule = base.match(/\[hidden\]\s*\{[^}]*\}/);
  assert.ok(rule, 'a [hidden] rule must exist in the design system');
  assert.match(rule[0], /display:\s*none\s*!important/, 'the rule must win over every display declaration');

  // The competing display rules the fix has to beat are really present in the tree.
  const components = readFileSync(join(uiRoot, 'styles/components.css'), 'utf8');
  assert.match(components, /\.modal-backdrop\s*\{[^}]*display:\s*grid/);
  const layout = readFileSync(join(uiRoot, 'styles/layout.css'), 'utf8');
  assert.match(layout, /\.grid\s*\{[^}]*display:\s*grid/);

  // The modal builder still relies on the attribute, so the CSS rule is what hides it.
  const markup = modal({ id: 'proof-modal', title: 'عنوان' });
  assert.match(markup, /class="modal-backdrop" id="proof-modal" hidden/);
});

test('D — npm test is the official command and covers every test file', () => {
  const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  const script = pkg.scripts && pkg.scripts.test;

  assert.equal(typeof script, 'string');
  assert.doesNotMatch(script, /--test\s+tests\/?(\s|$)/, 'a bare directory is resolved as a module path and fails');
  assert.match(script, /node --test tests\/\*\.test\.js/, 'the script must target every test file');
  assert.deepEqual(pkg.devDependencies, { 'fake-indexeddb': '^6.2.5' }, 'no dependency was added and none was upgraded');

  const files = readdirSync(join(projectRoot, 'tests')).filter((name) => name.endsWith('.test.js'));
  assert.ok(files.length >= 12, `the suite must keep every test file, found ${files.length}`);
  assert.ok(files.includes('uiShell.test.js'), 'the Phase 4A UI tests must still exist');
  assert.ok(files.includes('balance.test.js') && files.includes('financialRules.test.js'));
});

test('E — the UI holds no package-weight literal and always reads Settings', () => {
  const walk = (directory) => readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.js') ? [full] : [];
  });

  const files = walk(uiRoot);
  assert.ok(files.length >= 8, 'the ui tree must still contain the shell modules');
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\?\?\s*14|\|\|\s*14\b/, `${file} must not fall back to a literal weight`);
  }

  const appSource = readFileSync(join(uiRoot, 'app.js'), 'utf8');
  assert.match(appSource, /settingsService\.getDefaultPackageWeight\(\)/, 'the weight must come from Settings');
  assert.doesNotMatch(appSource, /(^|[^\d])14([^\d]|$)/, 'the UI must hold no package-weight literal');
});
