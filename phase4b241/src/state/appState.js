import { logger } from '../utils/logger.js';

// Minimal application state. NOT a source of truth: financial data is always
// re-read from the repositories/services.
const state = {
  currentCustomerId: null,
  defaultPackageWeight: null,
  lastError: null
};

const listeners = new Set();

export function getState() {
  return { ...state };
}

export function setState(patch) {
  Object.assign(state, patch);
  for (const listener of listeners) {
    try {
      listener(getState());
    } catch (error) {
      logger.error('state listener failed', { message: String(error && error.message ? error.message : error) });
    }
  }
  return getState();
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetState() {
  state.currentCustomerId = null;
  state.defaultPackageWeight = null;
  state.lastError = null;
}
