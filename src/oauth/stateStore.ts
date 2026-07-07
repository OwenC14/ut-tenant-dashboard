import { randomBytes } from 'crypto';

// CSRF state for the Fox consent redirect. In-memory is fine at pilot scale
// (single Render instance, §2) — a restart just means an in-flight OAuth
// redirect has to be retried, not a broken invariant.
interface StateEntry {
  propertyId: number;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const states = new Map<string, StateEntry>();

export function createState(propertyId: number): string {
  const state = randomBytes(24).toString('hex');
  states.set(state, { propertyId, expiresAt: Date.now() + TTL_MS });
  return state;
}

export function consumeState(state: string): number | null {
  const entry = states.get(state);
  states.delete(state);
  if (!entry || entry.expiresAt < Date.now()) {
    return null;
  }
  return entry.propertyId;
}
