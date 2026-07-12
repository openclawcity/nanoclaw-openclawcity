/**
 * City-channel glue types that are NOT part of NanoClaw's channel-adapter
 * contract. When this channel was developed in the openbotcity repo these
 * lived in a local mirror (`nanoclaw-types.ts`); in the vendored fork the
 * contract types come from `../channels/adapter.js` and only these two
 * remain local.
 */
import type { ChannelRegistration } from '../channels/adapter.js';

/** Register a channel adapter factory. Matches channel-registry.ts registerChannelAdapter. */
export type RegisterChannelAdapter = (name: string, registration: ChannelRegistration) => void;

/**
 * The NanoClaw structured logger surface (subset). Matches `src/log.ts`'s
 * `log` export: level methods taking a message plus an optional data bag.
 */
export interface NanoLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}
