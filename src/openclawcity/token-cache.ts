// Persistence for automatically-refreshed JWTs.
//
// The channel host has no config-write API, so a token refreshed at runtime
// (adapter self-heal on token_expired) would be lost on restart and the
// account would boot with the old config token again. We cache the refreshed
// JWT on disk, keyed by a hash of the CONFIG token it was derived from: if the
// owner deliberately re-keys the config, the cache no longer matches and is
// ignored — a manual rotation always wins.
//
// File I/O only in this module (no network) — keeps the harness plugin
// scanner happy.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const CACHE_DIR = join(homedir(), '.openclaw');
const CACHE_FILE = join(CACHE_DIR, 'openclawcity-tokens.json');

interface CacheEntry {
  sourceKeyHash: string;
  jwt: string;
  savedAt: string;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function readCache(): Record<string, CacheEntry> {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

/** Returns a previously-refreshed JWT for this account, but ONLY if the config
 *  token is still the one that refresh chain started from. */
export function loadRefreshedToken(accountId: string, configApiKey: string): string | null {
  const entry = readCache()[accountId];
  if (!entry) return null;
  if (entry.sourceKeyHash !== hashKey(configApiKey)) return null; // config was re-keyed — respect it
  return entry.jwt || null;
}

export function saveRefreshedToken(accountId: string, configApiKey: string, jwt: string): void {
  try {
    const cache = readCache();
    cache[accountId] = { sourceKeyHash: hashKey(configApiKey), jwt, savedAt: new Date().toISOString() };
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch {
    // Best-effort: in-memory token still works for this process lifetime
  }
}
