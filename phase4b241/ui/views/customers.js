// Customers screen (Phase 4B.1). It reads through the services layer only and
// displays values the core already computed: no balance formula, no financial
// engine and no direct data-layer access exist in this module.
import { pageHeader, card, badge, table, kpi, alert } from '../components/index.js';
import { loadingState, emptyState, errorState } from '../components/states.js';
import { escapeHtml } from '../components/html.js';
import { amountClass } from '../components/financial.js';
import { formatMoneyMinor, formatText, formatCount } from '../../src/utils/formatting.js';
import { logger } from '../../src/utils/logger.js';
import { balanceService } from '../../src/services/balanceService.js';
import { customerService } from '../../src/services/customerService.js';
import { authService } from '../../src/services/authService.js';
import { customerAccountPath, customerEditPath, customerNewPath, transactionAddPath } from '../routes.js';
import { buildHash } from '../router.js';

function hasAdminUiAccess() { return !authService.isEnforced() || authService.isAdmin(); }

export const CUSTOMER_STATUS_FILTER = Object.freeze({ ALL: 'all', ACTIVE: 'active', INACTIVE: 'inactive' });
export const CUSTOMER_BALANCE_FILTER = Object.freeze({ ALL: 'all', POSITIVE: 'positive', NEGATIVE: 'negative', ZERO: 'zero' });
export const CUSTOMER_SORT_KEY = Object.freeze({ CODE: 'code', NAME: 'name', BALANCE: 'balance' });
export const SORT_DIRECTION = Object.freeze({ ASC: 'asc', DESC: 'desc' });
export const ALL_REGIONS = 'all';
export const NEEDS_NAME_LABEL = 'بحاجة إلى اسم';
export const EMPTY_VALUE = '—';

export function defaultCriteria() {
  return {
    search: '',
    status: CUSTOMER_STATUS_FILTER.ALL,
    balance: CUSTOMER_BALANCE_FILTER.ALL,
    region: ALL_REGIONS,
    sortKey: CUSTOMER_SORT_KEY.CODE,
    sortDir: SORT_DIRECTION.ASC
  };
}

export function normalizeText(value) {
  return formatText(value).toLowerCase();
}

export function customerOf(row) {
  return (row && row.Customer) || {};
}

export function summaryOf(row) {
  return (row && row.Summary) || {};
}

// Search covers exactly Code, Name and Phone (spec §12). Case-insensitive and
// Arabic-safe, and it never changes the loaded rows.
export function matchesSearch(row, term) {
  const needle = normalizeText(term);
  if (!needle) return true;
  const customer = customerOf(row);
  return [customer.Code, customer.Name, customer.Phone].some((value) => normalizeText(value).includes(needle));
}

export function matchesStatus(row, status) {
  if (!status || status === CUSTOMER_STATUS_FILTER.ALL) return true;
  const isActive = customerOf(row).IsActive === true;
  return status === CUSTOMER_STATUS_FILTER.ACTIVE ? isActive : !isActive;
}

// The balance side comes from the core summary; this only compares it.
export function matchesBalance(row, balance) {
  if (!balance || balance === CUSTOMER_BALANCE_FILTER.ALL) return true;
  const side = summaryOf(row).BalanceSide;
  if (balance === CUSTOMER_BALANCE_FILTER.POSITIVE) return side === 'Credit';
  if (balance === CUSTOMER_BALANCE_FILTER.NEGATIVE) return side === 'Debit';
  return side === 'Zero';
}

export function matchesRegion(row, region) {
  if (!region || region === ALL_REGIONS) return true;
  return formatText(customerOf(row).Region) === region;
}

export function filterCustomers(rows, criteria = defaultCriteria()) {
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((row) => (
    matchesSearch(row, criteria.search)
    && matchesStatus(row, criteria.status)
    && matchesBalance(row, criteria.balance)
    && matchesRegion(row, criteria.region)
  ));
}

function sortValue(row, sortKey) {
  if (sortKey === CUSTOMER_SORT_KEY.NAME) return normalizeText(customerOf(row).Name);
  if (sortKey === CUSTOMER_SORT_KEY.BALANCE) {
    const minor = summaryOf(row).BalanceMinor;
    return Number.isInteger(minor) ? minor : 0;
  }
  return normalizeText(customerOf(row).Code);
}

// Deterministic: the requested key first, then Code, then Id.
export function sortCustomers(rows, sortKey = CUSTOMER_SORT_KEY.CODE, sortDir = SORT_DIRECTION.ASC) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const factor = sortDir === SORT_DIRECTION.DESC ? -1 : 1;
  return list.sort((a, b) => {
    const left = sortValue(a, sortKey);
    const right = sortValue(b, sortKey);
    let byKey = 0;
    if (typeof left === 'number' && typeof right === 'number') byKey = left - right;
    else byKey = String(left).localeCompare(String(right), 'ar');
    if (byKey !== 0) return byKey * factor;
    const byCode = normalizeText(customerOf(a).Code).localeCompare(normalizeText(customerOf(b).Code), 'ar');
    if (byCode !== 0) return byCode;
    return formatText(customerOf(a).Id).localeCompare(formatText(customerOf(b).Id), 'ar');
  });
}

export function visibleCustomers(rows, criteria = defaultCriteria()) {
  return sortCustomers(filterCustomers(rows, criteria), criteria.sortKey, criteria.sortDir);
}

export function countCustomers(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let active = 0;
  let inactive = 0;
  let needsName = 0;
  for (const row of list) {
    if (customerOf(row).IsActive === true) active += 1; else inactive += 1;
    if (!formatText(customerOf(row).Name)) needsName += 1;
  }
  return { Total: list.length, Active: active, Inactive: inactive, NeedsName: needsName };
}

export function collectRegions(rows) {
  const seen = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const region = formatText(customerOf(row).Region);
    if (region) seen.set(region, region);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'ar'));
}

// Display projection: it reads the summary the core produced and formats it, so
// the same balance the services report is the balance on screen.
export function balanceDisplay(row) {
  const summary = summaryOf(row);
  if (!Number.isInteger(summary.BalanceMinor)) return { text: EMPTY_VALUE, className: 'amount amount--zero' };
  const kind = summary.BalanceSide === 'Credit' ? 'positiveBalance'
    : summary.BalanceSide === 'Debit' ? 'negativeBalance' : 'zeroBalance';
  return { text: formatMoneyMinor(summary.BalanceMinor), className: amountClass(kind) };
}

export function openingBalanceDisplay(row) {
  const minor = summaryOf(row).OpeningBalanceMinor;
  if (!Number.isInteger(minor)) return { text: EMPTY_VALUE, className: 'amount' };
  return { text: formatMoneyMinor(minor), className: 'amount' };
}

// Status comes from IsActive only (spec §11). These classes are dedicated status
// classes, so the meaning of the financial colours is untouched.
export function statusBadge(customer) {
  const isActive = (customer || {}).IsActive === true;
  return `<span class="badge ${isActive ? 'badge--status-active' : 'badge--status-inactive'}">${isActive ? 'نشط' : 'غير نشط'}</span>`;
}

export function nameCell(customer) {
  const name = formatText((customer || {}).Name);
  const id = formatText((customer || {}).Id);
  if (!name) return `<span class="customer-name--missing">${escapeHtml(NEEDS_NAME_LABEL)}</span>`;
  if (!hasAdminUiAccess()) return `<span>${escapeHtml(name)}</span>`;
  return `<a class="customer-link" href="${escapeHtml(buildHash(customerAccountPath(id)))}">${escapeHtml(name)}</a>`;
}

function toRowCells(row) {
  const customer = customerOf(row);
  const opening = openingBalanceDisplay(row);
  const current = balanceDisplay(row);
  const isActive = customer.IsActive === true;
  return {
    cells: [
      `<span class="customer-code">${escapeHtml(formatText(customer.Code) || EMPTY_VALUE)}</span>`,
      nameCell(customer),
      escapeHtml(formatText(customer.Phone) || EMPTY_VALUE),
      escapeHtml(formatText(customer.Region) || EMPTY_VALUE),
      ...(hasAdminUiAccess() ? [`<span class="${escapeHtml(opening.className)}">${escapeHtml(opening.text)}</span>`, `<span class="${escapeHtml(current.className)}">${escapeHtml(current.text)}</span>`] : []),
      statusBadge(customer),
      hasAdminUiAccess() ? `<span class="table__actions">
<button class="btn btn--ghost btn--sm" type="button" data-action="account" data-id="${escapeHtml(formatText(customer.Id))}">الحساب</button>
<button class="btn btn--ghost btn--sm" type="button" data-action="edit" data-id="${escapeHtml(formatText(customer.Id))}">تعديل</button>
<button class="btn btn--outline btn--sm" type="button" data-action="toggle-active" data-id="${escapeHtml(formatText(customer.Id))}" data-next="${isActive ? 'false' : 'true'}">${isActive ? 'تعطيل' : 'تفعيل'}</button>
</span>` : `<a class="btn btn--outline btn--sm" href="${escapeHtml(buildHash(transactionAddPath(customer.Id)))}">إضافة حركة</a>`
    ]
  };
}

function controlField(label, id, control) {
  return `<div class="field"><label class="field__label" for="${escapeHtml(id)}">${escapeHtml(label)}</label>${control}</div>`;
}

function selectControl({ id, criteria, options, selected }) {
  const rendered = options
    .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('');
  return `<select class="select" id="${escapeHtml(id)}" data-criteria="${escapeHtml(criteria)}">${rendered}</select>`;
}

export function renderCustomersToolbar({ criteria = defaultCriteria(), regions = [] } = {}) {
  const statusOptions = [
    { value: CUSTOMER_STATUS_FILTER.ALL, label: 'الكل' },
    { value: CUSTOMER_STATUS_FILTER.ACTIVE, label: 'نشط' },
    { value: CUSTOMER_STATUS_FILTER.INACTIVE, label: 'غير نشط' }
  ];
  const balanceOptions = [
    { value: CUSTOMER_BALANCE_FILTER.ALL, label: 'الكل' },
    { value: CUSTOMER_BALANCE_FILTER.POSITIVE, label: 'له رصيد' },
    { value: CUSTOMER_BALANCE_FILTER.NEGATIVE, label: 'عليه رصيد' },
    { value: CUSTOMER_BALANCE_FILTER.ZERO, label: 'صفر' }
  ];
  const regionOptions = [{ value: ALL_REGIONS, label: 'الكل' }, ...regions.map((region) => ({ value: region, label: region }))];
  const sortOptions = [
    { value: CUSTOMER_SORT_KEY.CODE, label: 'كود' },
    { value: CUSTOMER_SORT_KEY.NAME, label: 'الاسم' },
    { value: CUSTOMER_SORT_KEY.BALANCE, label: 'الرصيد الحالي' }
  ];
  const isAsc = criteria.sortDir === SORT_DIRECTION.ASC;
  return `<div class="toolbar">
${controlField('بحث', 'customer-search', `<input class="input" id="customer-search" type="search" placeholder="كود أو اسم أو هاتف" value="${escapeHtml(criteria.search)}" data-criteria="search" aria-label="بحث في العملاء بالكود أو الاسم أو الهاتف">`)}
${controlField('الحالة', 'filter-status', selectControl({ id: 'filter-status', criteria: 'status', options: statusOptions, selected: criteria.status }))}
${hasAdminUiAccess() ? controlField('الرصيد', 'filter-balance', selectControl({ id: 'filter-balance', criteria: 'balance', options: balanceOptions, selected: criteria.balance })) : ''}
${controlField('المنطقة', 'filter-region', selectControl({ id: 'filter-region', criteria: 'region', options: regionOptions, selected: criteria.region }))}
${hasAdminUiAccess() ? controlField('الترتيب حسب', 'sort-key', selectControl({ id: 'sort-key', criteria: 'sortKey', options: sortOptions, selected: criteria.sortKey })) : ''}
<div class="field">
  <span class="field__label">اتجاه الترتيب</span>
  <button class="btn btn--outline" type="button" data-action="toggle-sort-direction" aria-pressed="${isAsc ? 'false' : 'true'}">${isAsc ? 'تصاعدي ↑' : 'تنازلي ↓'}</button>
</div>
</div>`;
}

export function renderCustomersSummary(counts) {
  const total = counts || countCustomers([]);
  const blocks = [
    card({ body: kpi({ label: 'إجمالي العملاء', value: formatCount(total.Total) }) }),
    card({ body: kpi({ label: 'عملاء نشطون', value: formatCount(total.Active) }) }),
    card({ body: kpi({ label: 'عملاء غير نشطين', value: formatCount(total.Inactive) }) })
  ];
  if (total.NeedsName > 0) {
    blocks.push(alert({ tone: 'warning', title: 'عملاء بحاجة إلى اسم', message: `يوجد ${formatCount(total.NeedsName)} عميلًا مستوردًا بدون اسم. أكمل الاسم قبل استخدام الحساب.` }));
  }
  return `<div class="grid grid--cols-3">${blocks.join('\n')}</div>`;
}

export function renderCustomersRegion({ rows = [], criteria = defaultCriteria(), error = null } = {}) {
  if (error) {
    return `<div class="stack">
${errorState({ title: 'تعذّر تحميل العملاء', message: 'لم يتم تحميل قائمة العملاء من المخزن المحلي، ولم تُعرض أي بيانات بديلة.', code: error.code ? String(error.code) : null })}
<div class="row"><button class="btn btn--primary" type="button" data-action="retry">إعادة المحاولة</button></div>
</div>`;
  }
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return card({
      title: 'لا يوجد عملاء حتى الآن',
      body: `${emptyState({ title: 'لا يوجد عملاء حتى الآن', message: 'أضف أول عميل للبدء.', icon: '👥' })}
<div class="row"><button class="btn btn--primary" type="button" data-action="add-customer">+ إضافة عميل</button></div>`
    });
  }
  const visible = visibleCustomers(list, criteria);
  if (!visible.length) {
    return card({
      title: 'لا نتائج مطابقة',
      body: `${emptyState({ title: 'لا نتائج مطابقة', message: 'جرّب تعديل البحث أو الفلاتر.', icon: '🔎' })}
<div class="row"><button class="btn btn--outline" type="button" data-action="clear-filters">مسح البحث والفلاتر</button></div>`
    });
  }
  const countLine = `<p class="toolbar__count" aria-live="polite">عدد النتائج: ${formatCount(visible.length)} من ${formatCount(list.length)}</p>`;
  return `${countLine}${table({
    numeric: true,
    columns: hasAdminUiAccess() ? [
      { label: 'كود' }, { label: 'الاسم' }, { label: 'الهاتف' }, { label: 'المنطقة' },
      { label: 'الرصيد الافتتاحي' }, { label: 'الرصيد الحالي' }, { label: 'الحالة' }, { label: 'الإجراءات' }
    ] : [ { label: 'كود' }, { label: 'الاسم' }, { label: 'الهاتف' }, { label: 'المنطقة' }, { label: 'الحالة' }, { label: 'الإجراء' } ],
    rows: visible.map(toRowCells),
    emptyMessage: 'لا توجد نتائج.'
  })}`;
}

export function customersScreenHtml({ rows = null, criteria = defaultCriteria(), error = null } = {}) {
  const hasData = Array.isArray(rows) && !error;
  const toolbar = hasData ? renderCustomersToolbar({ criteria, regions: collectRegions(rows) }) : '';
  const summary = hasData && hasAdminUiAccess() ? renderCustomersSummary(countCustomers(rows)) : '';
  const region = hasData || error
    ? renderCustomersRegion({ rows: rows || [], criteria, error })
    : loadingState({ message: 'جارٍ تحميل العملاء…' });
  return [
    pageHeader({
      title: 'العملاء',
      description: hasAdminUiAccess() ? 'سجل العملاء مع الأرصدة المحسوبة في طبقة الخدمات.' : 'عرض العملاء والبحث بينهم وإضافة عميل جديد.',
      actions: `<a class="btn btn--outline" href="${escapeHtml(buildHash(transactionAddPath()))}">تسجيل حركة</a><button class="btn btn--primary" type="button" data-action="add-customer">+ إضافة عميل</button>`
    }),
    `<div id="customers-summary" class="page-section">${summary}</div>`,
    `<div id="customers-toolbar" class="page-section">${toolbar}</div>`,
    `<div id="customers-region" class="page-section" aria-busy="${hasData || error ? 'false' : 'true'}">${region}</div>`
  ].join('\n');
}

export function customersViewHtml() {
  return customersScreenHtml();
}

// Screen controller: loads through the services layer, keeps the search/filter
// state, and re-paints only the results so typing never loses focus.
export function initCustomersView({ container, navigate = null } = {}) {
  if (!container) return null;
  const state = { rows: [], criteria: defaultCriteria(), error: null, busy: false };
  const summaryBox = container.querySelector('#customers-summary');
  const toolbarBox = container.querySelector('#customers-toolbar');
  const region = container.querySelector('#customers-region');
  const live = () => Boolean(region) && (!('isConnected' in region) || region.isConnected);

  function paintRegion() {
    if (!live()) return;
    region.innerHTML = renderCustomersRegion({ rows: state.rows, criteria: state.criteria, error: state.error });
    region.setAttribute('aria-busy', 'false');
  }

  function paintToolbar() {
    if (toolbarBox) toolbarBox.innerHTML = renderCustomersToolbar({ criteria: state.criteria, regions: collectRegions(state.rows) });
  }

  function paintSummary() {
    if (summaryBox) summaryBox.innerHTML = hasAdminUiAccess() ? renderCustomersSummary(countCustomers(state.rows)) : '';
  }

  function paintBusy(isBusy) {
    state.busy = isBusy;
    container.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  }

  async function load() {
    paintBusy(true);
    state.error = null;
    if (region) {
      region.setAttribute('aria-busy', 'true');
      region.innerHTML = loadingState({ message: 'جارٍ تحميل العملاء…' });
    }
    if (toolbarBox) toolbarBox.innerHTML = '';
    if (summaryBox) summaryBox.innerHTML = '';
    try {
      const rows = hasAdminUiAccess()
        ? await balanceService.listCustomerBalances()
        : (await customerService.listCustomers()).map(Customer => ({ Customer, Summary: {} }));
      if (!live()) return;
      state.rows = rows;
      paintSummary();
      paintToolbar();
      paintRegion();
    } catch (error) {
      if (!live()) return;
      logger.error('customers screen load failed', {
        code: error && error.code ? String(error.code) : null,
        message: error && error.message ? String(error.message) : null
      });
      state.error = error;
      state.rows = [];
      paintSummary();
      paintToolbar();
      paintRegion();
    } finally {
      paintBusy(false);
    }
  }

  function applySortDirection(button) {
    state.criteria.sortDir = state.criteria.sortDir === SORT_DIRECTION.ASC ? SORT_DIRECTION.DESC : SORT_DIRECTION.ASC;
    const isAsc = state.criteria.sortDir === SORT_DIRECTION.ASC;
    if (button) {
      button.setAttribute('aria-pressed', isAsc ? 'false' : 'true');
      button.textContent = isAsc ? 'تصاعدي ↑' : 'تنازلي ↓';
    }
    paintRegion();
  }

  async function toggleActive(button) {
    const id = button.getAttribute('data-id');
    const next = button.getAttribute('data-next') === 'true';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const updated = await customerService.setActive(id, next);
      const index = state.rows.findIndex((row) => customerOf(row).Id === id);
      if (index >= 0) state.rows[index] = { ...state.rows[index], Customer: updated };
      paintSummary();
      paintRegion();
    } catch (error) {
      logger.error('customer status change failed', {
        code: error && error.code ? String(error.code) : null,
        message: error && error.message ? String(error.message) : null
      });
      state.error = error;
      paintRegion();
    }
  }

  container.addEventListener('input', (event) => {
    const target = event.target;
    if (target && target.getAttribute && target.getAttribute('data-criteria') === 'search') {
      state.criteria.search = target.value;
      paintRegion();
    }
  });

  container.addEventListener('change', (event) => {
    const target = event.target;
    const key = target && target.getAttribute ? target.getAttribute('data-criteria') : null;
    if (!key || key === 'search') return;
    state.criteria[key] = target.value;
    paintRegion();
  });

  container.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const add = target.closest('[data-action="add-customer"]');
    if (add) { if (navigate) navigate(customerNewPath()); return; }
    const retry = target.closest('[data-action="retry"]');
    if (retry) { load(); return; }
    const clear = target.closest('[data-action="clear-filters"]');
    if (clear) { state.criteria = defaultCriteria(); paintToolbar(); paintRegion(); return; }
    const direction = target.closest('[data-action="toggle-sort-direction"]');
    if (direction) { applySortDirection(direction); return; }
    const toggle = target.closest('[data-action="toggle-active"]');
    if (toggle) { toggleActive(toggle); return; }
    const edit = target.closest('[data-action="edit"]');
    if (edit) { if (navigate) navigate(customerEditPath(edit.getAttribute('data-id'))); return; }
    const account = target.closest('[data-action="account"]');
    if (account && navigate) navigate(customerAccountPath(account.getAttribute('data-id')));
  });

  load();
  return { reload: load, criteria: () => ({ ...state.criteria }) };
}

export { table };
