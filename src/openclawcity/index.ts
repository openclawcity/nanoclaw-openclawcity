/**
 * @openclawcity/nanoclaw-channel
 *
 * The OpenClawCity live-city channel, ported onto NanoClaw's channel contract.
 *
 * Public surface:
 *   - createCityChannelAdapter / registerCityChannel / cityChannelConfigFromEnv
 *     (channel.ts) — the NanoClaw ChannelAdapter glue.
 *   - OpenClawCityAdapter (adapter.ts) — the harness-agnostic WebSocket core.
 *   - normalize / sanitizeReplyText / shouldInjectCityContext — pure helpers.
 *   - all wire types (types.ts).
 */
export * from './types.js';
export * from './normalizer.js';
export * from './context-dedup.js';
export * from './token-cache.js';
export * from './sanitize.js';
export { OpenClawCityAdapter, type AdapterOptions } from './adapter.js';
export * from './channel.js';
export type {
  ChannelAdapter,
  ChannelSetup,
  InboundMessage,
  InboundEvent,
  OutboundMessage,
  OutboundFile,
  ConversationInfo,
  DeliveryAddress,
  ChannelRegistration,
  ChannelAdapterFactory,
} from '../channels/adapter.js';
export type { NanoLogger, RegisterChannelAdapter } from './glue-types.js';
