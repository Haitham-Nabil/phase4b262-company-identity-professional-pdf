// Phase 4B.23 — direct entry point for crop-purchase workflows.
// The actual movement form and all calculations remain in the approved transaction
// form/services. This screen only routes the user to the correct movement type.
import { pageHeader, card, alert } from '../components/index.js';
import { escapeHtml } from '../components/html.js';
import { buildHash } from '../router.js';
import { TRANSACTION_TYPE } from '../../src/services/transactionFormService.js';
import { cropReferencesPath } from '../routes.js';
import { authService } from '../../src/services/authService.js';

function hasAdminUiAccess() { return !authService.isEnforced() || authService.isAdmin(); }

export const CROP_PURCHASES_ROOT_ID = 'crop-purchases-root';
export const CROP_PURCHASE_LOCAL_ACTION = 'add-local-crop-purchase';
export const CROP_PURCHASE_CARTON_ACTION = 'add-carton-crop-purchase';
export const CROP_PURCHASE_REFERENCES_ACTION = 'manage-crop-references';

export function cropPurchasesViewHtml() {
  return [pageHeader({ title: 'مشتريات المحصول', description: 'اختر نوع مشتريات المحصول لتسجيل حركة جديدة.' }),
    `<div id="${CROP_PURCHASES_ROOT_ID}" class="stack"><div class="grid grid--cols-2 page-section">
      ${card({ title: 'مشتريات محصول محلي', body: `<p>تسجيل المحصول بالعبوات والوزن السائب والخصم وسعر الكيلو. يحسب النظام صافي الوزن والمبلغ تلقائيًا وفق الوزن الافتراضي الحالي للعبوة.</p><button class="btn btn--primary" type="button" data-crop-action="${CROP_PURCHASE_LOCAL_ACTION}">إضافة مشتريات محصول محلي</button>` })}
      ${card({ title: 'مشتريات كرتون', body: `<p>تسجيل مشتريات الكراتين بالكميات والأسعار والخصومات المعتمدة، دون إدخال وزن محصول.</p><button class="btn btn--primary" type="button" data-crop-action="${CROP_PURCHASE_CARTON_ACTION}">إضافة مشتريات كرتون</button>` })}
    </div>${alert({ tone: 'info', message: 'تسجيل الحركة يتم من خلال نموذج الحركات المعتمد. تظل الحسابات والقيود المالية داخل طبقة الخدمات دون تكرارها في هذه الشاشة.' })}
    ${hasAdminUiAccess() ? `<div class="row"><a class="btn btn--outline" href="${escapeHtml(buildHash(cropReferencesPath()))}" data-crop-action="${CROP_PURCHASE_REFERENCES_ACTION}">إدارة الشركات والأصناف وأنواع الكراتين</a></div>` : ''}</div>`].join('\n');
}

export function initCropPurchasesView({ container, navigate = null } = {}) {
  if (!container) return null;
  const handler = (event) => {
    const action = event.target?.closest?.('[data-crop-action]')?.getAttribute('data-crop-action');
    if (!action || typeof navigate !== 'function') return;
    if (action === CROP_PURCHASE_LOCAL_ACTION) navigate(`/transactions/add?type=${encodeURIComponent(TRANSACTION_TYPE.CROP_PURCHASE_LOCAL)}`);
    if (action === CROP_PURCHASE_CARTON_ACTION) navigate(`/transactions/add?type=${encodeURIComponent(TRANSACTION_TYPE.CROP_PURCHASE_CARTON)}`);
    if (action === CROP_PURCHASE_REFERENCES_ACTION) { event.preventDefault?.(); navigate(cropReferencesPath()); }
  };
  container.addEventListener('click', handler);
  return { destroy() { container.removeEventListener?.('click', handler); } };
}
