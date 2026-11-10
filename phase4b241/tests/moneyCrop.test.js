import test from 'node:test';
import assert from 'node:assert/strict';
import { netWeightMilli, weightTimesPriceMinor, cartonTotalMinor, toMinor, fromMinor, MONEY_FACTOR, QTY_FACTOR } from '../src/domain/money.js';

test('Net Weight G = D x (DefaultPackageWeight - F) + E', () => {
  const g = netWeightMilli({ units: 10, looseKg: 0, deductionKg: 0, packageWeightKg: 14 });
  assert.equal(fromMinor(g, QTY_FACTOR), 140);
  const withDeduction = netWeightMilli({ units: 10, looseKg: 5, deductionKg: 2, packageWeightKg: 14 });
  assert.equal(fromMinor(withDeduction, QTY_FACTOR), 125);
});

test('Local Total = G x H', () => {
  const g = netWeightMilli({ units: 10, looseKg: 0, deductionKg: 0, packageWeightKg: 14 });
  const total = weightTimesPriceMinor(g, toMinor(5, MONEY_FACTOR));
  assert.equal(fromMinor(total), 700);
});

test('Carton Total = (K - M) x L', () => {
  const total = cartonTotalMinor({ quantity: 20, discount: 2, unitPrice: 15 });
  assert.equal(fromMinor(total), 270);
});

test('Integer minor units avoid floating point drift', () => {
  const a = toMinor(0.1, MONEY_FACTOR);
  const b = toMinor(0.2, MONEY_FACTOR);
  assert.equal((a + b) / MONEY_FACTOR, 0.3);
});
