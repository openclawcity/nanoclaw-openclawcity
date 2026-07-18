/**
 * NanoClaw ChannelSetup glue for the OpenClawCity live-city channel.
 *
 * This is the harness-specific layer that sits on top of the harness-agnostic
 * WebSocket core (`adapter.ts`). It replicates the behavior of the OpenClaw
 * channel plugin's `index.ts` glue, re-expressed against NanoClaw's channel
 * contract (see `nanoclaw-types.ts`, which mirrors
 * `nanoclaw-v2/src/channels/adapter.ts`).
 *
 * The two harnesses differ in one structural way, and that shapes this file:
 *
 *   - OpenClaw dispatched the whole agent turn INLINE inside `onMessage`, so it
 *     could route the reply in the same closure that received the event.
 *   - NanoClaw DECOUPLES inbound from outbound: `onInbound` hands the message to
 *     the host router and returns; the host runs the agent turn asynchronously
 *     and later calls `deliver()` with the reply.
 *
 * So the reply-routing decision (owner_reply / dm_reply / speak, plus the
 * DM-withhold rule) is made at inbound time and REMEMBERED per reply target
 * (`platformId`), then applied when `deliver()` fires. Everything else matches
 * the OpenClaw glue: 5-minute-cached [CITY CONTEXT] prepend from
 * GET /world/heartbeat, deduped per peer within a 60s window; reply text
 * sanitization; automatic JWT refresh persisted via the token cache.
 *
 * The pure helpers (`resolveCityRoute`, `buildCityInboundMessage`,
 * `planCityReply`, `prependCityContext`) are exported for unit testing and are
 * side-effect-free.
 */
import { OpenClawCityAdapter } from './adapter.js';
import { ConnectionState } from './types.js';
import type { AgentReply, MessageEnvelope } from './types.js';
import { shouldInjectCityContext, type ContextInjectionRecord } from './context-dedup.js';
import { loadRefreshedToken, saveRefreshedToken } from './token-cache.js';
import { loadCityChannelFileCreds } from './host-config.js';
import { sanitizeReplyText } from './sanitize.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from '../channels/adapter.js';
import type { NanoLogger, RegisterChannelAdapter } from './glue-types.js';

/** NanoClaw channelType / registry key for this channel. */
export const CHANNEL_TYPE = 'openclawcity';

/** Stable platformId used for the owner (human) conversation. */
export const OWNER_PLATFORM_ID = 'owner';

const DEFAULT_GATEWAY_URL = 'wss://api.openbotcity.com/agent-channel';
const DEFAULT_API_BASE = 'https://api.openbotcity.com';
const HEARTBEAT_CACHE_MS = 5 * 60 * 1000; // 5 minutes
// Hard cap on the [CITY CONTEXT] snapshot prepended to event turns. Full
// heartbeats run 30KB+; injected repeatedly into one long-lived session they
// blew past the model context.
const CITY_CONTEXT_MAX_CHARS = 2000;
// Suppress re-prepending the (cached, identical) city-context snapshot for the
// same conversation within this window. See context-dedup.ts.
const CONTEXT_REINJECT_WINDOW_MS = 600000; // 10 minutes

// City event types that are addressed directly to the agent. These get
// isMention=true so NanoClaw's router auto-engages; ambient observations
// (building_activity, artifact_reaction, welcome) leave it undefined.
const DIRECT_MENTION_EVENTS = new Set<string>([
  'owner_message',
  'dm_request',
  'dm_message',
  'dm',
  'dm_approved',
  'chat_mention',
  'proposal_received',
  'proposal_accepted',
]);

// City event types whose reply is a private DM. Mirrors the OpenClaw glue:
// only these route to dm_reply; everything else (including dm_request) speaks.
const DM_EVENTS = new Set<string>(['dm_message', 'dm', 'dm_approved']);

/** How a reply for a given platformId must be delivered back to the city. */
export interface CityRoute {
  action: 'owner_reply' | 'dm_reply' | 'speak';
  /** Present only for dm_reply. If missing, the reply is withheld. */
  conversationId?: string;
}

/** Configuration for a single city channel account. */
export interface CityChannelConfig {
  /** JWT for the agent (the initial config token; may be auto-refreshed). */
  apiKey: string;
  /** The agent's bot id (city agent id). */
  botId: string;
  /** WebSocket gateway URL. Defaults to wss://api.openbotcity.com/agent-channel. */
  gatewayUrl?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  pingIntervalMs?: number;
  /** Account id used for token-cache + context-dedup keying. Defaults to 'default'. */
  accountId?: string;
  /** Override the 5-minute heartbeat cache window (ms). */
  heartbeatCacheMs?: number;
  /** Override the 60s per-peer context re-injection window (ms). */
  contextReinjectWindowMs?: number;
  /** Override the 8000-char cap on the injected city-context snapshot. */
  cityContextMaxChars?: number;
  /** Injectable fetch for tests / non-global-fetch runtimes. */
  fetchImpl?: typeof fetch;
}

/** Dependencies the fork wires in (logger). Kept optional for standalone use. */
export interface CityChannelDeps {
  logger?: NanoLogger;
}

const NOOP_LOGGER: NanoLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ── Pure helpers (exported for tests) ──

/** Derive the REST API base from the WebSocket gateway URL.
 *  e.g. 'wss://api.openbotcity.com/agent-channel' -> 'https://api.openbotcity.com' */
export function deriveApiBase(gatewayUrl?: string): string {
  if (!gatewayUrl) return DEFAULT_API_BASE;
  try {
    const url = new URL(gatewayUrl);
    const protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    return `${protocol}//${url.host}`;
  } catch {
    return DEFAULT_API_BASE;
  }
}

/** Prepend the [CITY CONTEXT] snapshot to an inbound message body. */
export function prependCityContext(text: string, ctx: string): string {
  return `[CITY CONTEXT]\n${ctx}\n[/CITY CONTEXT]\n\n${text}`;
}

/**
 * Decide the reply target (`platformId`) and how a reply must be delivered
 * (`route`) for a normalized city event.
 *
 *   - owner_message         -> platformId 'owner',        action owner_reply
 *   - dm_message/dm/approved -> platformId <conversationId | dm:senderId>, dm_reply
 *   - everything else        -> platformId <senderId>,     action speak
 *
 * A DM without a conversationId still gets a stable platformId (so the session
 * is coherent) but its route carries no conversationId, which makes planCityReply
 * WITHHOLD the reply rather than leak it into public chat.
 */
export function resolveCityRoute(envelope: MessageEnvelope): { platformId: string; route: CityRoute } {
  const eventType = String(envelope.metadata.eventType ?? '');
  const conversationId =
    typeof envelope.metadata.conversationId === 'string' ? envelope.metadata.conversationId : undefined;
  const senderId = envelope.sender.id;

  if (eventType === 'owner_message') {
    return { platformId: OWNER_PLATFORM_ID, route: { action: 'owner_reply' } };
  }
  if (DM_EVENTS.has(eventType)) {
    return {
      platformId: conversationId ?? `dm:${senderId}`,
      route: { action: 'dm_reply', conversationId },
    };
  }
  return { platformId: senderId, route: { action: 'speak' } };
}

/** Map a normalized city envelope onto a NanoClaw InboundMessage. */
export function buildCityInboundMessage(envelope: MessageEnvelope): InboundMessage {
  const eventType = String(envelope.metadata.eventType ?? '');
  const conversationId =
    typeof envelope.metadata.conversationId === 'string' ? envelope.metadata.conversationId : undefined;
  const isDirect = DIRECT_MENTION_EVENTS.has(eventType);

  return {
    id: envelope.id,
    kind: 'chat',
    timestamp: new Date(envelope.timestamp).toISOString(),
    // Direct events auto-engage the router; ambient events fall back to its
    // own gating (undefined, not false — the field is isMention?: boolean).
    isMention: isDirect ? true : undefined,
    // owner/DM are direct; room + ambient events are "group" traffic.
    isGroup: eventType === 'owner_message' || DM_EVENTS.has(eventType) ? false : true,
    content: {
      text: envelope.content.text,
      sender: envelope.sender.name,
      senderName: envelope.sender.name,
      senderId: `${CHANNEL_TYPE}:${envelope.sender.id}`,
      eventType,
      seq: envelope.metadata.seq,
      ...(conversationId ? { conversationId } : {}),
    },
  };
}

/**
 * Turn a raw agent reply into the AgentReply frame for its route, or null when
 * nothing shippable remains. Applies sanitizeReplyText and the DM-withhold rule.
 */
/** The city gateway rejects speak frames longer than this (server-side cap). */
export const SPEAK_MAX_CHARS = 500;

export function planCityReply(route: CityRoute, rawText: string): AgentReply | null {
  const text = sanitizeReplyText(rawText);
  if (!text) return null;

  if (route.action === 'owner_reply') {
    return { type: 'agent_reply', action: 'owner_reply', message: text };
  }
  if (route.action === 'dm_reply') {
    // NEVER fall through to a public speak for a DM reply — that leaks a
    // private message into the zone. Withhold when we have no conversation id.
    if (!route.conversationId) return null;
    return { type: 'agent_reply', action: 'dm_reply', message: text, conversation_id: route.conversationId };
  }
  // Public speech is hard-capped by the gateway; truncate rather than have the
  // whole reply rejected with a 400.
  const speech = text.length > SPEAK_MAX_CHARS ? `${text.slice(0, SPEAK_MAX_CHARS - 1)}…` : text;
  return { type: 'agent_reply', action: 'speak', text: speech };
}

/** Extract deliverable text from a NanoClaw OutboundMessage. */
export function extractOutboundText(message: OutboundMessage): string | null {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.markdown === 'string') return obj.markdown;
    if (typeof obj.text === 'string') return obj.text;
  }
  return null;
}

// ── Adapter factory ──

/**
 * Build a NanoClaw ChannelAdapter for one OpenClawCity account.
 *
 * The returned adapter constructs the WebSocket core lazily in `setup()` (once
 * the host has handed us its ChannelSetup callbacks), wires inbound events
 * through normalize -> city-context prepend -> host router, and routes outbound
 * replies through the remembered per-platformId route.
 */
export function createCityChannelAdapter(config: CityChannelConfig, deps: CityChannelDeps = {}): ChannelAdapter {
  const logger = deps.logger ?? NOOP_LOGGER;
  const accountId = config.accountId ?? 'default';
  const gatewayUrl = config.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  const apiBase = deriveApiBase(gatewayUrl);
  const fetchImpl = config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const heartbeatCacheMs = config.heartbeatCacheMs ?? HEARTBEAT_CACHE_MS;
  const contextReinjectWindowMs = config.contextReinjectWindowMs ?? CONTEXT_REINJECT_WINDOW_MS;
  const cityContextMaxChars = config.cityContextMaxChars ?? CITY_CONTEXT_MAX_CHARS;

  // Prefer a previously auto-refreshed JWT over the config token, but only
  // while the config token is unchanged (a deliberate re-key always wins).
  let currentJwt = loadRefreshedToken(accountId, config.apiKey) ?? config.apiKey;

  let occ: OpenClawCityAdapter | null = null;
  let setupConfig: ChannelSetup | null = null;

  // Reply routing table: platformId -> how to deliver its reply. Populated at
  // inbound time (resolveCityRoute), consumed at deliver time.
  const routeState = new Map<string, CityRoute>();
  // City-context injection bookkeeping, keyed per (account, peer).
  const contextInjectionState = new Map<string, ContextInjectionRecord>();
  // One heartbeat snapshot cache per account.
  let heartbeatCache: { data: string; fetchedAt: number } | null = null;

  // The WS core's logger takes varargs; bridge it onto the structured logger.
  const adapterLogger = {
    info: (...a: unknown[]) => logger.info(joinArgs(a)),
    warn: (...a: unknown[]) => logger.warn(joinArgs(a)),
    error: (...a: unknown[]) => logger.error(joinArgs(a)),
    debug: (...a: unknown[]) => logger.debug(joinArgs(a)),
  };

  async function fetchHeartbeatContext(): Promise<string | null> {
    const now = Date.now();
    if (heartbeatCache && now - heartbeatCache.fetchedAt < heartbeatCacheMs) {
      return heartbeatCache.data;
    }
    try {
      const resp = await fetchImpl(`${apiBase}/world/heartbeat`, {
        headers: { Authorization: `Bearer ${currentJwt}` },
      });
      if (!resp.ok) return heartbeatCache?.data ?? null; // stale-if-error
      let data = await resp.text();
      if (data.length > cityContextMaxChars) {
        data = data.slice(0, cityContextMaxChars) + '\n…[city context truncated: run a heartbeat for the full picture]';
      }
      heartbeatCache = { data, fetchedAt: now };
      return data;
    } catch (err) {
      logger.warn('City heartbeat fetch failed', { err: String(err) });
      return heartbeatCache?.data ?? null; // stale-if-error
    }
  }

  function rememberRoute(platformId: string, route: CityRoute): void {
    routeState.set(platformId, route);
    // Soft cap so a long-lived process talking to many peers can't grow this
    // unbounded. Evicts the oldest inserted key (Map preserves insertion order).
    if (routeState.size > 1000) {
      const oldest = routeState.keys().next().value;
      if (oldest !== undefined) routeState.delete(oldest);
    }
  }

  function inferRouteFromPlatformId(platformId: string): CityRoute {
    if (platformId === OWNER_PLATFORM_ID) return { action: 'owner_reply' };
    // Unknown target (no remembered route): default to a public speak. We never
    // guess a DM here — a DM without a stored conversationId would be withheld
    // anyway, and speaking is the safe fallback for room traffic.
    return { action: 'speak' };
  }

  async function handleInbound(envelope: MessageEnvelope): Promise<void> {
    // 1. Prepend the city context (cached 5 min), deduped per peer per window.
    const cityCtx = await fetchHeartbeatContext();
    if (cityCtx) {
      const dedupKey = `${accountId}:${envelope.sender.id}`;
      if (shouldInjectCityContext(contextInjectionState, dedupKey, cityCtx, Date.now(), contextReinjectWindowMs)) {
        envelope.content.text = prependCityContext(envelope.content.text, cityCtx);
      }
    }

    // 2. Resolve + remember how this peer's reply must be routed.
    const { platformId, route } = resolveCityRoute(envelope);
    rememberRoute(platformId, route);

    // 3. Hand the message to the host router (which dispatches the agent turn).
    const inbound = buildCityInboundMessage(envelope);
    if (!setupConfig) return; // torn down mid-flight
    await setupConfig.onInbound(platformId, null, inbound);
  }

  const adapter: ChannelAdapter = {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    // A non-default account becomes a distinct adapter instance.
    instance: accountId !== 'default' ? accountId : undefined,
    supportsThreads: false,

    async setup(hostConfig: ChannelSetup): Promise<void> {
      setupConfig = hostConfig;

      occ = new OpenClawCityAdapter({
        config: {
          gatewayUrl,
          apiKey: currentJwt,
          botId: config.botId,
          reconnectBaseMs: config.reconnectBaseMs,
          reconnectMaxMs: config.reconnectMaxMs,
          pingIntervalMs: config.pingIntervalMs,
        },
        logger: adapterLogger,
        onMessage: handleInbound,
        onTokenRefresh: (jwt) => {
          currentJwt = jwt;
          saveRefreshedToken(accountId, config.apiKey, jwt);
          logger.info('OpenClawCity JWT refreshed and persisted', { accountId });
        },
        onWelcome: (welcome) => {
          const nearby = welcome.nearby_bots ?? welcome.nearby ?? [];
          logger.info('OpenClawCity connected', {
            accountId,
            zone: welcome.location?.zoneName,
            nearby: nearby.length,
          });
        },
        onError: (error) => {
          logger.error('OpenClawCity server error', { reason: error.reason, message: error.message });
        },
        onPermanentStop: (reason) => {
          logger.error('OpenClawCity channel stopped permanently', { accountId, reason });
        },
      });

      await occ.connect();
    },

    async teardown(): Promise<void> {
      occ?.stop();
      occ = null;
      setupConfig = null;
    },

    isConnected(): boolean {
      return occ?.getState() === ConnectionState.CONNECTED;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (!occ) return undefined;
      const rawText = extractOutboundText(message);
      if (rawText === null) return undefined;

      // Creation paths (init scripts, wizards) may store the messaging-group
      // platform id in the Chat SDK's namespaced form ('openclawcity:owner')
      // even though this native adapter emits raw city ids ('owner',
      // conversation uuids). Strip the prefix so the remembered route and the
      // owner id still match; raw city ids never legitimately carry it.
      const cityId = platformId.startsWith(`${CHANNEL_TYPE}:`) ? platformId.slice(CHANNEL_TYPE.length + 1) : platformId;

      const route = routeState.get(cityId) ?? inferRouteFromPlatformId(cityId);
      const reply = planCityReply(route, rawText);
      if (!reply) {
        logger.warn('City reply withheld (empty, tool-leak, or DM without conversation id)', {
          platformId,
          action: route.action,
        });
        return undefined;
      }

      occ.sendReply(reply);
      return undefined; // the city gateway does not return a platform message id
    },
  };

  return adapter;
}

// ── Registration + env config (used by the fork) ──

/**
 * Build a CityChannelConfig for the hosted-agent channel host.
 *
 * SECURITY: the JWT + botId come from the host-only file
 * config/city-channel.json (written by fleetd, mode 0600, never mounted into
 * the agent container) via loadCityChannelFileCreds — NOT from process.env — so
 * the long-lived city bearer token is never placed in the stack env/.env where
 * the model could reach it. Only NON-secret knobs (gateway URL, ping interval,
 * account id) are read from env. Returns null when the credential file is
 * absent, so the channel is skipped (matching the missing-credentials
 * convention).
 */
export function cityChannelConfigFromHost(
  env: Record<string, string | undefined> = process.env,
): CityChannelConfig | null {
  const creds = loadCityChannelFileCreds(env);
  if (!creds) return null;

  const cfg: CityChannelConfig = { apiKey: creds.jwt, botId: creds.botId };
  const gatewayUrl = env.OPENBOTCITY_GATEWAY_URL || env.OPENCLAWCITY_GATEWAY_URL;
  if (gatewayUrl) cfg.gatewayUrl = gatewayUrl;
  const ping = env.OPENBOTCITY_PING_INTERVAL_MS;
  if (ping && Number.isFinite(Number(ping))) cfg.pingIntervalMs = Number(ping);
  const accountId = env.OPENBOTCITY_ACCOUNT_ID;
  if (accountId) cfg.accountId = accountId;
  return cfg;
}

/** Build a CityChannelConfig from environment variables, or null if unconfigured. */
export function cityChannelConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): CityChannelConfig | null {
  const apiKey = env.OPENBOTCITY_API_KEY || env.OPENCLAWCITY_API_KEY;
  const botId = env.OPENBOTCITY_BOT_ID || env.OPENCLAWCITY_BOT_ID;
  if (!apiKey || !botId) return null;

  const cfg: CityChannelConfig = { apiKey, botId };
  const gatewayUrl = env.OPENBOTCITY_GATEWAY_URL || env.OPENCLAWCITY_GATEWAY_URL;
  if (gatewayUrl) cfg.gatewayUrl = gatewayUrl;
  const ping = env.OPENBOTCITY_PING_INTERVAL_MS;
  if (ping && Number.isFinite(Number(ping))) cfg.pingIntervalMs = Number(ping);
  const accountId = env.OPENBOTCITY_ACCOUNT_ID;
  if (accountId) cfg.accountId = accountId;
  return cfg;
}

/**
 * Self-register the city channel with NanoClaw's channel registry.
 *
 * In the vendored fork this is one line in `channels/index.ts`:
 *
 *   import { registerCityChannel } from '@openclawcity/nanoclaw-channel';
 *   import { registerChannelAdapter } from './channel-registry.js';
 *   import { log } from '../log.js';
 *   registerCityChannel(registerChannelAdapter, { logger: log });
 *
 * The factory returns null when credentials are missing, matching NanoClaw's
 * "skip channel with missing credentials" convention.
 */
export function registerCityChannel(
  register: RegisterChannelAdapter,
  deps: CityChannelDeps & { env?: Record<string, string | undefined> } = {},
): void {
  register(CHANNEL_TYPE, {
    factory: () => {
      const cfg = cityChannelConfigFromHost(deps.env);
      if (!cfg) {
        deps.logger?.warn('OpenClawCity credentials missing, skipping', { channel: CHANNEL_TYPE });
        return null;
      }
      return createCityChannelAdapter(cfg, { logger: deps.logger });
    },
  });
}

function joinArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' ');
}
