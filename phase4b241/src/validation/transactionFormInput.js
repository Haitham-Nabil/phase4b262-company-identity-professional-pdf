// Phase 4B.3 — pure mapping from the Add Transaction form to the input shapes the
// approved services already accept.
//
// It decides NOTHING financial: no direction, no cash / non-cash, no balance and
// no crop amount. Its only job is to turn raw human input into the drafts the Core
// validates, scaling units with the approved money helpers. For the two crop
// purchase types it deliberately OMITS any Amount key, so the derived value keeps
// exactly one source (Phase 3.1 rule); the Core rejects an explicit amount.
import { TRANSACTION_TYPE, isTransactionType, isCropPurchaseType, usesExplicitDirection } from '../domain/transactionTypes.js';
import { MONEY_FACTOR, QTY_FACTOR, toMinor } from '../domain/money.js';

export const FORM_KEY = Object.freeze({
  TransactionType: 'TransactionType',
  CUSTOMER: 'CustomerId',
  FROM_CUSTOMER: 'FromCustomerId',
  TO_CUSTOMER: 'ToCustomerId',
  DATE: 'Date',
  DESCRIPTION: 'Description',
  DIRECTION: 'Direction',
  EDIT_REASON: 'EditReason',
  AMOUNT: 'Amount',
  UNITS: 'Units',
  LOOSE_KG: 'LooseKg',
  DEDUCTION_KG: 'DeductionKg',
  UNIT_PRICE: 'UnitPrice',
  CARTON_QUANTITY: 'CartonQuantity',
  CARTON_DISCOUNT: 'CartonDiscount',
  CARTON_PRICE: 'CartonPrice',
  // Phase 4B.11 — carton purchase only: the receiving company and the carton type.
  RECEIVING_COMPANY: 'ReceivingCompanyId',
  CARTON_TYPE: 'CartonTypeId',
  // Phase 4B.13.1 — local crop purchase only: the strawberry variety (a descriptive
  // reference of the movement, never an amount and never a weight dimension).
  STRAWBERRY_VARIETY: 'StrawberryVarietyId'
});

// Fields a type SHOWS but does not REQUIRE. A variety is optional on purpose: a local
// crop purchase recorded before Phase 4B.13.1 has none, and a new one may also be saved
// without one rather than force the user to invent a variety that does not exist yet.
const OPTIONAL_FORM_KEYS = Object.freeze(['Description', 'StrawberryVarietyId']);

const CUSTOMER = FORM_KEY.CUSTOMER;
const DATE = FORM_KEY.DATE;
const DESCRIPTION = FORM_KEY.DESCRIPTION;
const AMOUNT = FORM_KEY.AMOUNT;

// Dynamic form definition: exactly the fields each type needs (spec §7, §25).
export const FORM_FIELDS_BY_TYPE = Object.freeze({
  [TRANSACTION_TYPE.SALE_PESTICIDES]: Object.freeze([CUSTOMER, DATE, AMOUNT, DESCRIPTION]),
  [TRANSACTION_TYPE.SALE_IRRIGATION]: Object.freeze([CUSTOMER, DATE, AMOUNT, DESCRIPTION]),
  [TRANSACTION_TYPE.SALES_RETURN]: Object.freeze([CUSTOMER, DATE, AMOUNT, DESCRIPTION]),
  // Phase 4B.13.1 — the local purchase now also names the strawberry variety. The
  // package count (D), the loose kilos (E), the kilo deduction (F) and the kilo price (H)
  // keep exactly the meaning and the formula they already had.
  [TRANSACTION_TYPE.CROP_PURCHASE_LOCAL]: Object.freeze([CUSTOMER, DATE, FORM_KEY.STRAWBERRY_VARIETY, FORM_KEY.UNITS, FORM_KEY.LOOSE_KG, FORM_KEY.DEDUCTION_KG, FORM_KEY.UNIT_PRICE, DESCRIPTION]),
  // Phase 4B.11 — the carton purchase now also names the receiving company and the
  // carton type. The carton COUNT (K) stays the only quantity dimension of this type:
  // no weight field is added, and the derived value is still (K - M) x L.
  [TRANSACTION_TYPE.CROP_PURCHASE_CARTON]: Object.freeze([CUSTOMER, DATE, FORM_KEY.RECEIVING_COMPANY, FORM_KEY.CARTON_TYPE, FORM_KEY.CARTON_QUANTITY, FORM_KEY.CARTON_DISCOUNT, FORM_KEY.CARTON_PRICE, DESCRIPTION]),
  [TRANSACTION_TYPE.CASH_RECEIVED]: Object.freeze([CUSTOMER, DATE, AMOUNT, DESCRIPTION]),
  [TRANSACTION_TYPE.CASH_PAID]: Object.freeze([CUSTOMER, DATE, AMOUNT, DESCRIPTION]),
  [TRANSACTION_TYPE.SETTLEMENT]: Object.freeze([CUSTOMER, DATE, AMOUNT, DESCRIPTION]),
  [TRANSACTION_TYPE.GOODS_EXCHANGE]: Object.freeze([CUSTOMER, DATE, AMOUNT, DESCRIPTION]),
  [TRANSACTION_TYPE.DEBT_TRANSFER]: Object.freeze([FORM_KEY.FROM_CUSTOMER, FORM_KEY.TO_CUSTOMER, DATE, AMOUNT, DESCRIPTION])
});

// Preview fields are display-only: they are never stored and never sent.
export const PREVIEW_FIELDS_BY_TYPE = Object.freeze({
  [TRANSACTION_TYPE.CROP_PURCHASE_LOCAL]: Object.freeze(['DefaultPackageWeight', 'NetWeight', 'CalculatedAmount']),
  [TRANSACTION_TYPE.CROP_PURCHASE_CARTON]: Object.freeze(['CalculatedAmount'])
});

export function formFieldsFor(transactionType) {
  const fields = FORM_FIELDS_BY_TYPE[transactionType];
  return fields ? [...fields] : [];
}

export function previewFieldsFor(transactionType) {
  const fields = PREVIEW_FIELDS_BY_TYPE[transactionType];
  return fields ? [...fields] : [];
}

// Required for a usable submission. This is a presence list only — the Core stays
// the only authority on whether a value is financially valid.
export function requiredFormKeys(transactionType) {
  const fields = formFieldsFor(transactionType);
  return fields.filter((key) => OPTIONAL_FORM_KEYS.includes(key) === false);
}

export function emptyForm({ transactionType = '', date = '' } = {}) {
  return {
    TransactionType: transactionType,
    CustomerId: '',
    FromCustomerId: '',
    ToCustomerId: '',
    Date: date,
    Description: '',
    Direction: '',
    Amount: '',
    Units: '',
    LooseKg: '',
    DeductionKg: '',
    UnitPrice: '',
    CartonQuantity: '',
    CartonDiscount: '',
    CartonPrice: '',
    ReceivingCompanyId: '',
    CartonTypeId: '',
    StrawberryVarietyId: ''
  };
}

function text(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

// Money in major units: passed through untouched (the Core converts and validates).
// A non-numeric entry becomes NaN so the Core rejects it as an invalid number.
function money(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : NaN;
}

// Quantity / weight in human units -> integer milli units (scale 3), using the
// approved conversion. Non-numeric entries become NaN and are refused downstream.
function quantity(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  const number = Number(raw);
  if (!Number.isFinite(number)) return NaN;
  return toMinor(number, QTY_FACTOR, 'الكمية');
}

// Price in major units -> integer minor units (scale 2).
function price(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  const number = Number(raw);
  if (!Number.isFinite(number)) return NaN;
  return toMinor(number, MONEY_FACTOR, 'السعر');
}

function isMissing(value) {
  return value === null || value === undefined || value === '';
}

/**
 * Turns form values into one of two shapes:
 *   { Kind: 'transaction',   Draft, Missing }
 *   { Kind: 'debtTransfer',  Input, Missing }
 * The crop draft never carries an Amount key.
 */
export function buildTransactionForm(form = {}) {
  const transactionType = form[FORM_KEY.CUSTOMER] === undefined ? form.TransactionType : form.TransactionType;
  if (!isTransactionType(transactionType)) {
    return { Kind: 'invalid', TransactionType: transactionType ?? null, Missing: ['TransactionType'] };
  }

  const date = text(form[DATE]);
  const description = text(form[DESCRIPTION]);
  // Settlement / GoodsExchange move in EITHER direction, so the direction is an
  // explicit statement (Credit = added to the farmer balance, Debit = deducted from
  // it). It is never a derived Debit/Credit figure — the core derives those from the
  // type, the direction and the amount. Any other type simply carries no Direction.
  const direction = usesExplicitDirection(transactionType) ? text(form[FORM_KEY.DIRECTION]) : null;

  if (transactionType === TRANSACTION_TYPE.DEBT_TRANSFER) {
    const Input = {
      FromCustomerId: text(form[FORM_KEY.FROM_CUSTOMER]),
      ToCustomerId: text(form[FORM_KEY.TO_CUSTOMER]),
      Amount: money(form[AMOUNT]),
      Date: date,
      Description: description
    };
    const Missing = [FORM_KEY.FROM_CUSTOMER, FORM_KEY.TO_CUSTOMER, AMOUNT, DATE].filter((key) => isMissing(Input[key]));
    return { Kind: 'debtTransfer', Input, Missing };
  }

  const Draft = {
    CustomerId: text(form[CUSTOMER]),
    Date: date,
    TransactionType: transactionType,
    Description: description
  };

  if (isCropPurchaseType(transactionType)) {
    // No Amount / AmountMinor key is ever created for a crop purchase.
    Draft.crop = transactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL
      ? {
        LocalUnitsMilli: quantity(form[FORM_KEY.UNITS]),
        LocalLooseKgMilli: quantity(form[FORM_KEY.LOOSE_KG]),
        LocalDeductionKgMilli: quantity(form[FORM_KEY.DEDUCTION_KG]),
        LocalUnitPriceMinor: price(form[FORM_KEY.UNIT_PRICE])
      }
      : {
        CartonQuantityMilli: quantity(form[FORM_KEY.CARTON_QUANTITY]),
        CartonDiscountMinor: price(form[FORM_KEY.CARTON_DISCOUNT]),
        CartonUnitPriceMinor: price(form[FORM_KEY.CARTON_PRICE])
      };
    if (transactionType === TRANSACTION_TYPE.CROP_PURCHASE_CARTON) {
      // Reference ids are passed through untouched; the services layer decides whether
      // they exist and are active. An empty choice stays null ("not specified").
      Draft.ReceivingCompanyId = text(form[FORM_KEY.RECEIVING_COMPANY]);
      Draft.CartonTypeId = text(form[FORM_KEY.CARTON_TYPE]);
    }
    if (transactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL) {
      // Phase 4B.13.1 — the variety id travels INSIDE the crop input object, next to the
      // D / E / F / H values it describes, so the draft keeps exactly one shape. An empty
      // choice stays null: no variety is ever invented for a movement.
      Draft.crop.StrawberryVarietyId = text(form[FORM_KEY.STRAWBERRY_VARIETY]);
    }
    const Missing = [CUSTOMER, DATE].filter((key) => isMissing(Draft[key]));
    return { Kind: 'transaction', Draft, Missing };
  }

  Draft.Amount = money(form[AMOUNT]);
  if (usesExplicitDirection(transactionType)) Draft.Direction = direction;
  const Missing = [CUSTOMER, DATE, AMOUNT].filter((key) => isMissing(Draft[key]));
  return { Kind: 'transaction', Draft, Missing };
}

// Phase 4B.6 — map the EDIT form (raw human input) onto the same draft shape the
// creation path uses. The transaction type and the customer are taken from the STORED
// row, so an ordinary edit can never move the movement to another type or another
// customer; crop inputs are scaled with the approved helpers and NO Amount key is ever
// created for a crop purchase, so the derived value keeps exactly one source.
export function buildTransactionEditForm(record, form = {}) {
  const transactionType = record ? record.TransactionType : null;
  if (!isTransactionType(transactionType)) return { Kind: 'invalid', TransactionType: transactionType ?? null };
  const Draft = {
    CustomerId: record.CustomerId,
    Date: text(form[DATE]),
    TransactionType: transactionType,
    Description: text(form[DESCRIPTION]),
    EditReason: text(form[FORM_KEY.EDIT_REASON])
  };
  if (isCropPurchaseType(transactionType)) {
    Draft.crop = transactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL
      ? {
        LocalUnitsMilli: quantity(form[FORM_KEY.UNITS]),
        LocalLooseKgMilli: quantity(form[FORM_KEY.LOOSE_KG]),
        LocalDeductionKgMilli: quantity(form[FORM_KEY.DEDUCTION_KG]),
        LocalUnitPriceMinor: price(form[FORM_KEY.UNIT_PRICE])
      }
      : {
        CartonQuantityMilli: quantity(form[FORM_KEY.CARTON_QUANTITY]),
        CartonDiscountMinor: price(form[FORM_KEY.CARTON_DISCOUNT]),
        CartonUnitPriceMinor: price(form[FORM_KEY.CARTON_PRICE])
      };
    if (transactionType === TRANSACTION_TYPE.CROP_PURCHASE_CARTON) {
      // Phase 4B.11 fix — an edit may RE-POINT a reference, but a reference the caller did
      // not mention must never reach the validator at all. Sending an empty string for a
      // field the dialog did not show was what let an ordinary edit look like "clear both
      // references". Only an explicitly supplied key is mapped, and the lifecycle service
      // keeps the stored one otherwise.
      if (Object.prototype.hasOwnProperty.call(form, FORM_KEY.RECEIVING_COMPANY)) {
        Draft.ReceivingCompanyId = text(form[FORM_KEY.RECEIVING_COMPANY]);
      }
      if (Object.prototype.hasOwnProperty.call(form, FORM_KEY.CARTON_TYPE)) {
        Draft.CartonTypeId = text(form[FORM_KEY.CARTON_TYPE]);
      }
    }
    if (transactionType === TRANSACTION_TYPE.CROP_PURCHASE_LOCAL
      && Object.prototype.hasOwnProperty.call(form, FORM_KEY.STRAWBERRY_VARIETY)) {
      // Same rule as the carton references: a field the dialog did not render must never
      // reach the validator, so an ordinary edit cannot look like "clear the variety".
      Draft.crop.StrawberryVarietyId = text(form[FORM_KEY.STRAWBERRY_VARIETY]);
    }
    return { Kind: 'transaction', Draft };
  }
  Draft.Amount = money(form[AMOUNT]);
  if (usesExplicitDirection(transactionType)) Draft.Direction = text(form[FORM_KEY.DIRECTION]);
  return { Kind: 'transaction', Draft };
}

export function hasExplicitAmountKey(draft) {
  return Boolean(draft) && Object.prototype.hasOwnProperty.call(draft, 'Amount');
}
