// Technical identity generator. Ordering-safe: fixed-width time + sequence + random tail.
let sequence = 0;

function randomPart() {
  const provider = globalThis.crypto;
  if (provider && typeof provider.getRandomValues === 'function') {
    const buffer = new Uint32Array(1);
    provider.getRandomValues(buffer);
    return buffer[0].toString(36);
  }
  return Math.floor(Math.random() * 0xffffffff).toString(36);
}

export function createId(prefix = 'rec') {
  sequence += 1;
  const time = Date.now().toString(36).padStart(9, '0');
  const seq = sequence.toString(36).padStart(6, '0');
  return `${prefix}_${time}_${seq}_${randomPart()}`;
}

export function resetIdSequence() {
  sequence = 0;
}

export const ID_PREFIX = Object.freeze({
  CUSTOMER: 'cus',
  TRANSACTION: 'trx',
  OPENING_HISTORY: 'obh',
  LINK: 'lnk',
  // Phase 4B.6 — one audit event id per lifecycle change.
  AUDIT: 'aud',
  // Phase 4B.11 — reference records get their own stable identity prefixes.
  RECEIVING_COMPANY: 'rcv',
  CARTON_TYPE: 'ctn',
  // Phase 4B.13.1 — one stable identity per strawberry variety.
  STRAWBERRY_VARIETY: 'var'
});
