// Financial VISUAL language. These helpers only return presentation class names
// for values that were already computed by the domain/services layer. They never
// decide a direction, never convert or format a value, and never calculate.
export const AMOUNT_CLASS = Object.freeze({
  credit: 'amount amount--credit',
  debit: 'amount amount--debit',
  cashIn: 'amount amount--cash-in',
  cashOut: 'amount amount--cash-out',
  nonCash: 'amount amount--noncash',
  positiveBalance: 'amount amount--positive',
  negativeBalance: 'amount amount--negative',
  zeroBalance: 'amount amount--zero',
  cancelled: 'amount amount--cancelled'
});

export const BADGE_CLASS = Object.freeze({
  credit: 'badge badge--credit',
  debit: 'badge badge--debit',
  cash: 'badge badge--cash',
  nonCash: 'badge badge--noncash',
  positiveBalance: 'badge badge--positive',
  negativeBalance: 'badge badge--negative',
  cancelled: 'badge badge--cancelled'
});

export const MARKER_CLASS = Object.freeze({
  credit: 'marker marker--credit',
  debit: 'marker marker--debit',
  cash: 'marker marker--cash',
  nonCash: 'marker marker--noncash',
  cancelled: 'marker marker--cancelled'
});

export function amountClass(kind) {
  return AMOUNT_CLASS[kind] || 'amount';
}

export function badgeClass(kind) {
  return BADGE_CLASS[kind] || 'badge';
}

export function markerClass(kind) {
  return MARKER_CLASS[kind] || 'marker';
}

// A visible key for the legend so every colour has a written meaning.
export function financialLegend() {
  const items = [
    ['credit', 'دائن'],
    ['debit', 'مدين'],
    ['cash', 'نقدي'],
    ['nonCash', 'غير نقدي'],
    ['cancelled', 'ملغاة']
  ];
  return `<div class="financial-legend">${items
    .map(([kind, label]) => `<span><span class="${markerClass(kind)}"></span>${escapeForLegend(label)}</span>`)
    .join('')}</div>`;
}

function escapeForLegend(text) {
  return String(text).replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character]));
}
