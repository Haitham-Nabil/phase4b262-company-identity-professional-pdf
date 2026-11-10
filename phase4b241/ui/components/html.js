// Tiny HTML builders shared by every UI module. They return strings so the
// shell can be rendered and asserted without a DOM.

const ENTITIES = Object.freeze({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
});

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (character) => ENTITIES[character]);
}

// Drops null/undefined/false entries so builders can stay declarative.
export function joinParts(parts) {
  return parts.filter((part) => part !== null && part !== undefined && part !== false && part !== '').join('\n');
}

export function attrs(map = {}) {
  return Object.entries(map)
    .filter(([, value]) => value !== null && value !== undefined && value !== false)
    .map(([key, value]) => (value === true ? key : `${key}="${escapeHtml(value)}"`))
    .join(' ');
}

export function icon(symbol, extraClass = '') {
  const classes = ['app-nav__icon', extraClass].filter(Boolean).join(' ');
  return `<span class="${escapeHtml(classes)}" aria-hidden="true">${escapeHtml(symbol)}</span>`;
}
