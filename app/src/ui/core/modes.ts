/**
 * The two modes of the app (`docs/product/ui-spec.md`, 4.3): which screen a launch opens,
 * which doors may be shown, and the staff PIN. Pure.
 */

/** The screen a launch opens. A fresh install is in visitor mode. */
export function startScreen(prefs: { visitorMode: boolean; onboardingDone: boolean }): 'visitor' | 'welcome' | 'home' {
  if (prefs.visitorMode) {
    return 'visitor';
  }
  // Staff mode was opened, but the app was closed before the welcome cards were through.
  return prefs.onboardingDone ? 'home' : 'welcome';
}

/**
 * Whether a door the server reports may be shown. A visitor sees a door only where a
 * staff member saved one (`manual`: placed by hand, `selected`: a found doorway chosen by
 * staff); a doorway the server found by itself (`auto`) is a suggestion for staff.
 */
export function doorMayBeShown(source: string | null | undefined, savedOnly: boolean): boolean {
  if (!source || source === 'none') {
    return false;
  }
  return savedOnly ? source === 'manual' || source === 'selected' : true;
}

// ---- staff PIN ---------------------------------------------------------------------------

export const PIN_LENGTH = 4;
export const PIN_MAX_TRIES = 5;
export const PIN_LOCK_MS = 30_000;

export function isPin(text: string): boolean {
  return /^\d{4}$/.test(text);
}

/** SHA-256 of a string, as hex. Small and dependency-free; the input here is short. */
export function sha256(text: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes: number[] = [];
  for (const char of unescape(encodeURIComponent(text))) {
    bytes.push(char.charCodeAt(0));
  }
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }
  for (let shift = 56; shift >= 0; shift -= 8) {
    bytes.push(shift >= 32 ? 0 : (bitLength >>> shift) & 0xff);
  }
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const w = new Array<number>(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return h.map((word) => word.toString(16).padStart(8, '0')).join('');
}

/**
 * What is kept of the PIN. Four digits are few, so the hash keeps nobody out who can read
 * the app's files; it only avoids storing the PIN itself.
 */
export function hashPin(pin: string): string {
  return sha256(`staff-pin:${pin}`);
}

export function pinMatches(pin: string, hash: string | null): boolean {
  return hash !== null && isPin(pin) && hashPin(pin) === hash;
}

/** Wrong tries in a row, and until when the pad is locked after too many. */
export interface PinGate {
  wrong: number;
  lockedUntil: number;
}

export const OPEN_GATE: PinGate = { wrong: 0, lockedUntil: 0 };

export function gateLocked(gate: PinGate, now: number): boolean {
  return now < gate.lockedUntil;
}

/** The gate after a wrong PIN: the fifth wrong try in a row locks the pad for half a minute. */
export function afterWrongPin(gate: PinGate, now: number): PinGate {
  const wrong = gate.wrong + 1;
  return wrong >= PIN_MAX_TRIES ? { wrong: 0, lockedUntil: now + PIN_LOCK_MS } : { wrong, lockedUntil: gate.lockedUntil };
}
