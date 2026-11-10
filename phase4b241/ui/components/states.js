// Loading / empty / error states — the three shared non-content states.
import { escapeHtml } from './html.js';

export function loadingState({ message = 'جارٍ التحميل…' } = {}) {
  return `<div class="state" role="status" aria-live="polite">
  <span class="spinner" aria-hidden="true"></span>
  <span class="state__title">${escapeHtml(message)}</span>
</div>`;
}

export function emptyState({ title = 'لا توجد بيانات', message = '', icon: symbol = '📄' } = {}) {
  return `<div class="state">
  <span class="state__icon" aria-hidden="true">${escapeHtml(symbol)}</span>
  <span class="state__title">${escapeHtml(title)}</span>
  ${message ? `<span>${escapeHtml(message)}</span>` : ''}
</div>`;
}

export function errorState({ title = 'تعذّر إتمام العملية', message = '', code = null } = {}) {
  return `<div class="state state--error" role="alert">
  <span class="state__icon" aria-hidden="true">⚠️</span>
  <span class="state__title">${escapeHtml(title)}</span>
  ${message ? `<span>${escapeHtml(message)}</span>` : ''}
  ${code ? `<span class="badge">${escapeHtml(code)}</span>` : ''}
</div>`;
}
