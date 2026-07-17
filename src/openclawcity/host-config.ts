// Host-only city-channel credential source.
//
// The city JWT + botId are provisioned by fleetd into a host-side file
// (config/city-channel.json, mode 0600, NEVER mounted into the agent
// container). The channel host reads them here — NOT from process.env — so the
// long-lived city bearer token is never placed in the stack env/.env where the
// model (running in a separate container with a curated env) could read and
// exfiltrate it. This matches the 2.1.53 credential-isolation model: the model
// key lives only in the OneCLI gateway; the city JWT lives only in this
// host-only file + the OneCLI vault, and is attached by the host when it dials
// the city. File I/O only in this module (no network) — mirrors token-cache.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CityChannelFileCreds {
  jwt: string;
  botId: string;
}

/** Absolute path to the host-only city-channel credential file. */
export function cityChannelConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const stackDir = env.OPENCLAWCITY_STACK_DIR || process.cwd();
  return join(stackDir, 'config', 'city-channel.json');
}

/**
 * Read { jwt, botId } from the host-only credential file, or null when the file
 * is absent / unreadable / malformed (→ the channel factory returns null and
 * the channel is skipped, matching the "missing credentials" convention).
 */
export function loadCityChannelFileCreds(
  env: Record<string, string | undefined> = process.env,
): CityChannelFileCreds | null {
  try {
    const raw = readFileSync(cityChannelConfigPath(env), 'utf-8');
    const parsed = JSON.parse(raw) as { jwt?: unknown; botId?: unknown };
    if (
      typeof parsed.jwt === 'string' &&
      parsed.jwt.length > 0 &&
      typeof parsed.botId === 'string' &&
      parsed.botId.length > 0
    ) {
      return { jwt: parsed.jwt, botId: parsed.botId };
    }
    return null;
  } catch {
    return null;
  }
}
