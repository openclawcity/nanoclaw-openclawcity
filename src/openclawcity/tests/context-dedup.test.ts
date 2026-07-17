import { describe, it, expect } from 'vitest';
import { shouldInjectCityContext, type ContextInjectionRecord } from '../context-dedup.js';

const WINDOW = 60_000;
const CTX = '[CITY CONTEXT blob]';

describe('shouldInjectCityContext', () => {
  it('injects on the first event for a key', () => {
    const state = new Map<string, ContextInjectionRecord>();
    expect(shouldInjectCityContext(state, 'acct:peer', CTX, 1_000, WINDOW)).toBe(true);
    expect(state.get('acct:peer')).toEqual({ at: 1_000, ctx: CTX });
  });

  it('skips an identical repeat inside the window (the Aaga burst)', () => {
    const state = new Map<string, ContextInjectionRecord>();
    expect(shouldInjectCityContext(state, 'k', CTX, 0, WINDOW)).toBe(true);
    // 6 more events over the next ~50s, same cached context → all skipped
    for (const t of [5_000, 12_000, 20_000, 33_000, 45_000, 50_000]) {
      expect(shouldInjectCityContext(state, 'k', CTX, t, WINDOW)).toBe(false);
    }
    // Snapshot still reflects the first (only) injection
    expect(state.get('k')).toEqual({ at: 0, ctx: CTX });
  });

  it('re-injects once the window has elapsed', () => {
    const state = new Map<string, ContextInjectionRecord>();
    expect(shouldInjectCityContext(state, 'k', CTX, 0, WINDOW)).toBe(true);
    expect(shouldInjectCityContext(state, 'k', CTX, 59_999, WINDOW)).toBe(false);
    expect(shouldInjectCityContext(state, 'k', CTX, 60_000, WINDOW)).toBe(true); // boundary inclusive
    expect(state.get('k')?.at).toBe(60_000);
  });

  it('re-injects immediately when the snapshot changed (cache refresh)', () => {
    const state = new Map<string, ContextInjectionRecord>();
    expect(shouldInjectCityContext(state, 'k', CTX, 0, WINDOW)).toBe(true);
    expect(shouldInjectCityContext(state, 'k', '[CITY CONTEXT updated]', 5_000, WINDOW)).toBe(true);
    expect(state.get('k')?.ctx).toBe('[CITY CONTEXT updated]');
  });

  it('keys are independent — a second conversation still gets context', () => {
    const state = new Map<string, ContextInjectionRecord>();
    expect(shouldInjectCityContext(state, 'acct:aaga', CTX, 0, WINDOW)).toBe(true);
    // A different peer within the same window must NOT be starved
    expect(shouldInjectCityContext(state, 'acct:bob', CTX, 1_000, WINDOW)).toBe(true);
  });
});
