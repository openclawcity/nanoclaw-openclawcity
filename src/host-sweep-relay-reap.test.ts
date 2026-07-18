/**
 * Unit tests for the one-shot relay container idle-reap (v2.1.53-occ.7).
 *
 * Relay sessions (`system:tasks:relay-<id>`) are minted one per inbound city
 * event and never receive a second message, so their containers were piling up
 * idle-warm until the 30-min absolute ceiling. The reap kills them on a short
 * idle grace while leaving the long-lived main channel session (null thread)
 * and the recurring heartbeat task session (`system:tasks:t-*`) warm. Lives on
 * the pure helpers so no DB or Docker mock is needed.
 */
import { describe, expect, it } from 'vitest';

import { isRelayThread, isTaskThread, taskThreadId } from './db/sessions.js';
import { IDLE_RELAY_GRACE_MS, shouldReapIdleRelay } from './host-sweep.js';

const RELAY = taskThreadId('relay-1784400307237-y67k-3d0c');
const HEARTBEAT = taskThreadId('t-fdbdf9');
const NOW = 10_000_000;

const base = {
  now: NOW,
  threadId: RELAY,
  alive: true,
  justWoke: false,
  dueCount: 0,
  liveTaskCount: 0,
  claimCount: 0,
  heartbeatMtimeMs: NOW - (IDLE_RELAY_GRACE_MS + 1_000),
  lastActiveMs: 0,
  graceMs: IDLE_RELAY_GRACE_MS,
};

describe('isRelayThread', () => {
  it('matches only relay task threads, and every relay thread is a task thread', () => {
    expect(isRelayThread(RELAY)).toBe(true);
    expect(isTaskThread(RELAY)).toBe(true);
    expect(isRelayThread(HEARTBEAT)).toBe(false); // long-lived heartbeat session
    expect(isRelayThread('system:tasks')).toBe(false);
    expect(isRelayThread(null)).toBe(false); // main channel session
  });
});

describe('shouldReapIdleRelay', () => {
  it('reaps a spent, quiet relay container past the grace window', () => {
    expect(shouldReapIdleRelay(base)).toBe(true);
  });

  it('keeps the main channel session (null thread) warm', () => {
    expect(shouldReapIdleRelay({ ...base, threadId: null })).toBe(false);
  });

  it('keeps the recurring heartbeat task session warm', () => {
    expect(shouldReapIdleRelay({ ...base, threadId: HEARTBEAT })).toBe(false);
  });

  it('never reaps on the tick that just woke the container', () => {
    expect(shouldReapIdleRelay({ ...base, justWoke: true })).toBe(false);
  });

  it('does not reap while there is due inbound, a live task, or an open claim', () => {
    expect(shouldReapIdleRelay({ ...base, dueCount: 1 })).toBe(false);
    expect(shouldReapIdleRelay({ ...base, liveTaskCount: 1 })).toBe(false);
    expect(shouldReapIdleRelay({ ...base, claimCount: 1 })).toBe(false);
  });

  it('does not reap before the grace window elapses', () => {
    expect(shouldReapIdleRelay({ ...base, heartbeatMtimeMs: NOW - 1_000 })).toBe(false);
  });

  it('does not reap a container that is not running', () => {
    expect(shouldReapIdleRelay({ ...base, alive: false })).toBe(false);
  });

  it('falls back to last_active when no heartbeat file exists', () => {
    expect(
      shouldReapIdleRelay({ ...base, heartbeatMtimeMs: 0, lastActiveMs: NOW - (IDLE_RELAY_GRACE_MS + 1_000) }),
    ).toBe(true);
  });

  it('leaves a container with no sign of life at all to the ceiling path', () => {
    expect(shouldReapIdleRelay({ ...base, heartbeatMtimeMs: 0, lastActiveMs: 0 })).toBe(false);
  });
});
