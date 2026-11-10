// Component barrel. Every builder is a pure string function.
import { escapeHtml, joinParts, attrs } from './html.js';

export { escapeHtml, joinParts, attrs } from './html.js';
export {
  AMOUNT_CLASS, BADGE_CLASS, MARKER_CLASS,
  amountClass, badgeClass, markerClass, financialLegend
} from './financial.js';
// Local binding of badgeClass: the builders below use it to compose class names.
import { badgeClass } from './financial.js';

export function button({ label, variant = 'default', type = 'button', id = null, disabled = false, icon: symbol = null }) {
  const variantClass = variant === 'default' ? '' : ` btn--${variant}`;
  return `<button type="${escapeHtml(type)}" class="btn${variantClass}"${attrs({ id, disabled, 'aria-disabled': disabled ? 'true' : null })}>${
    symbol ? `<span aria-hidden="true">${escapeHtml(symbol)}</span>` : ''
  }<span>${escapeHtml(label)}</span></button>`;
}

export function card({ title = null, body = '', footer = null, id = null }) {
  return `<section class="card"${attrs({ id })}>
${title ? `  <header class="card__header"><h3 class="card__title">${escapeHtml(title)}</h3></header>` : ''}
  <div class="card__body">${body}</div>
${footer ? `  <footer class="card__footer">${footer}</footer>` : ''}
</section>`;
}

export function badge(label, kind = null) {
  return `<span class="${kind ? badgeClass(kind) : 'badge'}">${escapeHtml(label)}</span>`;
}

export function alert({ tone = 'info', title = null, message = '' }) {
  return `<div class="alert alert--${escapeHtml(tone)}" role="${tone === 'danger' ? 'alert' : 'status'}">
  <div>${title ? `<div class="alert__title">${escapeHtml(title)}</div>` : ''}<div>${escapeHtml(message)}</div></div>
</div>`;
}

export function field({ label, controlId, hint = null, control }) {
  return `<div class="field">
  <label class="field__label" for="${escapeHtml(controlId)}">${escapeHtml(label)}</label>
  ${control}
  ${hint ? `<span class="field__hint">${escapeHtml(hint)}</span>` : ''}
</div>`;
}

export function textInput({ id, name = null, placeholder = null, value = null, disabled = false, type = 'text' }) {
  return `<input class="input"${attrs({ id, name, type, placeholder, value, disabled })}>`;
}

export function select({ id, name = null, options = [], disabled = false, selected = null }) {
  const rendered = options
    .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('');
  return `<select class="select"${attrs({ id, name, disabled })}>${rendered}</select>`;
}

export function table({ columns = [], rows = [], caption = null, numeric = false, emptyMessage = '' }) {
  const head = columns.map((column) => `<th scope="col">${escapeHtml(column.label)}</th>`).join('');
  const body = rows.length
    ? rows.map((row) => `<tr${row.className ? ` class="${escapeHtml(row.className)}"` : ''}>${row.cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${columns.length}">${escapeHtml(emptyMessage)}</td></tr>`;
  return `<div class="table-wrapper"><table class="table${numeric ? ' table--numeric' : ''}">
${caption ? `  <caption>${escapeHtml(caption)}</caption>` : ''}
  <thead><tr>${head}</tr></thead>
  <tbody>${body}</tbody>
</table></div>`;
}

export function kpi({ label, value = null, hint = null }) {
  return `<div class="kpi">
  <span class="kpi__label">${escapeHtml(label)}</span>
  <span class="kpi__value">${value === null ? '<span class="skeleton" style="display:inline-block;width:5rem"></span>' : escapeHtml(value)}</span>
  ${hint ? `<span class="kpi__label">${escapeHtml(hint)}</span>` : ''}
</div>`;
}

export function pageHeader({ title, description = null, actions = null }) {
  return `<div class="page-header">
  <div><h2>${escapeHtml(title)}</h2>${description ? `<p class="page-header__description">${escapeHtml(description)}</p>` : ''}</div>
  ${actions ? `<div class="row">${actions}</div>` : ''}
</div>`;
}

export function modal({ id, title, body = '', footer = '' }) {
  return `<div class="modal-backdrop" id="${escapeHtml(id)}" hidden>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(id)}-title">
    <header class="modal__header"><h3 id="${escapeHtml(id)}-title">${escapeHtml(title)}</h3></header>
    <div class="modal__body">${body}</div>
    <footer class="modal__footer">${footer}</footer>
  </div>
</div>`;
}

