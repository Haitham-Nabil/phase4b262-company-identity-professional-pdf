// Inline SVG icon set for the navigation and the shared components.
// No icon library and no external asset is added: every glyph is a small inline
// path drawn with `currentColor`, so it inherits the surrounding text colour and
// keeps working offline. Presentation only — no business logic lives here.
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';

export const ICONS = Object.freeze({
  // --- navigation -------------------------------------------------------
  dashboard: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  customers: '<path d="M9 11.2a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2Z"/><path d="M2.8 20.2c.5-3.3 3-5.4 6.2-5.4s5.7 2.1 6.2 5.4"/><path d="M16.4 11.6a3 3 0 1 0-1.6-5.6"/><path d="M17.4 14.9c2 .5 3.4 2.2 3.8 4.6"/>',
  transactions: '<path d="M6.2 3.5h9.3l3.3 3.3v13.7H6.2z"/><path d="M15.5 3.5v3.4h3.3"/><path d="M9.2 12h6.6M9.2 15.6h6.6"/>',
  crop: '<path d="M12 21V9.6"/><path d="M12 9.6c0-3.4 2.6-6.1 6-6.1 0 3.4-2.6 6.1-6 6.1Z"/><path d="M12 13.2c0-3.4-2.6-6.1-6-6.1 0 3.4 2.6 6.1 6 6.1Z"/><path d="M7.6 21h8.8"/>',
  payments: '<rect x="2.8" y="6.4" width="18.4" height="11.2" rx="2.2"/><circle cx="12" cy="12" r="2.7"/><path d="M6.4 12h.01M17.6 12h.01"/>',
  settlements: '<path d="M4 8.4h13.6"/><path d="M14.4 5.2 17.8 8.4l-3.4 3.2"/><path d="M20 15.6H6.4"/><path d="M9.6 12.4 6.2 15.6l3.4 3.2"/>',
  reports: '<path d="M3.6 20.4h16.8"/><rect x="5.4" y="11.6" width="3.4" height="6"/><rect x="10.3" y="7.4" width="3.4" height="10.2"/><rect x="15.2" y="13.6" width="3.4" height="4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.9v2.4M12 18.7v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.9 12h2.4M18.7 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7"/>',
  import: '<path d="M12 3.6v10.2"/><path d="M8 10.2 12 14.2l4-4"/><path d="M4.4 15.4v3.2a1.8 1.8 0 0 0 1.8 1.8h11.6a1.8 1.8 0 0 0 1.8-1.8v-3.2"/>',
  backup: '<ellipse cx="12" cy="6.2" rx="7.2" ry="2.9"/><path d="M4.8 6.2v11.6c0 1.6 3.2 2.9 7.2 2.9s7.2-1.3 7.2-2.9V6.2"/><path d="M4.8 12c0 1.6 3.2 2.9 7.2 2.9s7.2-1.3 7.2-2.9"/>',

  // --- shell ------------------------------------------------------------
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/>',
  chevron: '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',

  // --- actions ----------------------------------------------------------
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  edit: '<path d="M4.5 19.5h4l10-10a2.4 2.4 0 0 0-3.4-3.4l-10 10z"/><path d="M14.4 6.9 17 9.5"/>',
  ban: '<circle cx="12" cy="12" r="8.4"/><path d="M6.1 6.1 17.9 17.9"/>',
  eye: '<path d="M2.8 12S6.6 6.2 12 6.2 21.2 12 21.2 12 17.4 17.8 12 17.8 2.8 12 2.8 12Z"/><circle cx="12" cy="12" r="2.6"/>',
  search: '<circle cx="11" cy="11" r="6.4"/><path d="m16 16 4.2 4.2"/>',
  filter: '<path d="M3.8 5.6h16.4l-6.4 7.6v6l-3.6-1.8v-4.2z"/>',
  refresh: '<path d="M20 11.6a8 8 0 1 0-2.5 5.8"/><path d="M20 5.6v6h-6"/>',
  check: '<path d="m5.4 12.6 4.2 4.2 9-9"/>',
  warning: '<path d="M12 4.2 2.9 19.6h18.2z"/><path d="M12 9.6v4.6M12 17.2h.01"/>',
  document: '<path d="M6.2 3.5h9.3l3.3 3.3v13.7H6.2z"/><path d="M15.5 3.5v3.4h3.3"/><path d="M9.2 12.4h6.6M9.2 16h4.4"/>',
  list: '<path d="M8.4 6.6h11.2M8.4 12h11.2M8.4 17.4h11.2"/><path d="M4.4 6.6h.01M4.4 12h.01M4.4 17.4h.01"/>',
  dot: '<circle cx="12" cy="12" r="3.4"/>'
});

const SAFE_KEY = /^[a-z-]+$/;

// Renders one glyph. An unknown key degrades to a neutral dot instead of
// throwing, so a missing icon can never break a screen.
export function iconSvg(key, extraClass = '') {
  const name = typeof key === 'string' && SAFE_KEY.test(key) && ICONS[key] ? key : 'dot';
  const classes = ['icon', extraClass].filter(Boolean).join(' ');
  return `<svg class="${classes}" viewBox="0 0 24 24" ${STROKE} aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}
