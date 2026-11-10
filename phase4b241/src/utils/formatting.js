// Presentation-only formatting for the UI layer. It performs no financial
// calculation: the minor-unit conversion is delegated to the domain money module,
// which stays the single source of numeric truth.
import { fromMinor, MONEY_FACTOR, QTY_FACTOR } from '../domain/money.js';

const MONEY_FORMATTER = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatMoneyMinor(minor) {
  if (!Number.isInteger(minor)) return '—';
  return MONEY_FORMATTER.format(fromMinor(minor, MONEY_FACTOR));
}

// Quantity / weight stored in milli units (scale 3), shown in whole kg with three
// decimals. Presentation only: the value is still the Core value, never recomputed.
const QUANTITY_FORMATTER = new Intl.NumberFormat('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

export function formatQuantityMinor(minor) {
  if (!Number.isInteger(minor)) return '—';
  return QUANTITY_FORMATTER.format(fromMinor(minor, QTY_FACTOR));
}

export function formatText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function formatCount(value) {
  return Number.isFinite(value) ? String(value) : '0';
}

// Package counts and net weights read better without trailing zeros: 300 instead of
// 300.000. Purely presentational — the value is still the stored Core value.
const TRIMMED_QUANTITY = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });

export function formatQuantityTrimmed(minor) {
  if (!Number.isInteger(minor)) return '—';
  return TRIMMED_QUANTITY.format(fromMinor(minor, QTY_FACTOR));
}
