import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AdapterOptions } from '../adapter.js';
import { normalize } from '../normalizer.js';
import { ConnectionState } from '../types.js';
import type { CityEvent, MessageEnvelope, AgentReply } from '../types.js';
import type { ChannelSetup, InboundMessage, OutboundMessage } from '../../channels/adapter.js';

// ── Mock the WebSocket core (adapter.ts) ──
//
// The glue under test (channel.ts) constructs an OpenClawCityAdapter inside
// setup() and drives it. We replace that core with an in-memory fake so no
// socket is ever opened: it captures the constructor options (so a test can
// invoke `opts.onMessage(envelope)` to simulate an inbound city event) and
// records every sendReply() the glue routes back out.
const h = vi.hoisted(() => ({
  opts: null as AdapterOptions | null,
  replies: [] as AgentReply[],
  connectCalls: 0,
  stopCalls: 0,
}));

vi.mock('../adapter.js', () => ({
  OpenClawCityAdapter: class {
    constructor(opts: AdapterOptions) {
      h.opts = opts;
    }
    async connect() {
      h.connectCalls++;
    }
    stop() {
      h.stopCalls++;
    }
    getState() {
      // channel.isConnected() compares against ConnectionState.CONNECTED,
      // whose enum value is the literal string 'CONNECTED'.
      return 'CONNECTED';
    }
    sendReply(reply: AgentReply) {
      h.replies.push(reply);
    }
  },
}));

// Import AFTER the mock is registered (vi.mock is hoisted, so this is safe).
import { createCityChannelAdapter, CHANNEL_TYPE, OWNER_PLATFORM_ID, type CityChannelConfig } from '../channel.js';

// ── Helpers ──

function makeSetup() {
  return {
    onInbound: vi.fn<ChannelSetup['onInbound']>(),
    onInboundEvent: vi.fn<ChannelSetup['onInboundEvent']>(),
    onMetadata: vi.fn<ChannelSetup['onMetadata']>(),
    onAction: vi.fn<ChannelSetup['onAction']>(),
  } satisfies ChannelSetup;
}

/** A Response-like stub for the injected fetch (world/heartbeat). */
function fetchReturning(text: string) {
  return vi.fn().mockResolvedValue({ ok: true, text: async () => text });
}

const fetchNoContext = () => vi.fn().mockResolvedValue({ ok: false, text: async () => '' });

function makeConfig(overrides: Partial<CityChannelConfig> = {}): CityChannelConfig {
  return {
    apiKey: 'test-jwt-unique-abc',
    botId: 'bot-1',
    // Default: no city context so routing tests stay uncluttered.
    fetchImpl: fetchNoContext() as unknown as typeof fetch,
    ...overrides,
  };
}

function cityEvent(overrides: Partial<CityEvent> = {}): CityEvent {
  return {
    type: 'city_event',
    seq: 1,
    eventType: 'dm_message',
    from: { id: 'user-1', name: 'Alice' },
    text: 'hi',
    metadata: {},
    ...overrides,
  };
}

/** Simulate one inbound city event flowing through the glue. */
async function pushInbound(event: CityEvent): Promise<MessageEnvelope> {
  const envelope = normalize(event);
  // handleInbound is wired in as the core's onMessage callback.
  await h.opts!.onMessage(envelope);
  return envelope;
}

async function bootAdapter(config = makeConfig()) {
  const setup = makeSetup();
  const adapter = createCityChannelAdapter(config);
  await adapter.setup(setup);
  return { adapter, setup };
}

beforeEach(() => {
  h.opts = null;
  h.replies.length = 0;
  h.connectCalls = 0;
  h.stopCalls = 0;
});

// ── Lifecycle ──

describe('createCityChannelAdapter — lifecycle', () => {
  it('exposes the channel identity and constructs the core on setup()', async () => {
    const { adapter } = await bootAdapter();
    expect(adapter.name).toBe(CHANNEL_TYPE);
    expect(adapter.channelType).toBe(CHANNEL_TYPE);
    expect(adapter.supportsThreads).toBe(false);
    expect(adapter.instance).toBeUndefined(); // default account
    expect(h.connectCalls).toBe(1);
    expect(adapter.isConnected()).toBe(true);
  });

  it('gives a non-default account its own instance id', async () => {
    const adapter = createCityChannelAdapter(makeConfig({ accountId: 'acct-2' }));
    expect(adapter.instance).toBe('acct-2');
  });

  it('teardown stops the core', async () => {
    const { adapter } = await bootAdapter();
    await adapter.teardown();
    expect(h.stopCalls).toBe(1);
  });
});

// ── Inbound mapping: city_event -> envelope -> onInbound ──

describe('inbound mapping', () => {
  it('routes an owner_message to onInbound(owner, …) as a direct, non-group mention', async () => {
    const { setup } = await bootAdapter();
    await pushInbound(
      cityEvent({ seq: 7, eventType: 'owner_message', text: 'you there?', from: { id: 'owner-x', name: 'Vincent' } }),
    );

    expect(setup.onInbound).toHaveBeenCalledTimes(1);
    // The CLI/admin path is never used by the city channel.
    expect(setup.onInboundEvent).not.toHaveBeenCalled();

    const [platformId, threadId, inbound] = setup.onInbound.mock.calls[0] as [string, string | null, InboundMessage];
    expect(platformId).toBe(OWNER_PLATFORM_ID);
    expect(threadId).toBeNull();
    expect(inbound.id).toBe('occ-7');
    expect(inbound.kind).toBe('chat');
    expect(inbound.isMention).toBe(true);
    expect(inbound.isGroup).toBe(false);
    const content = inbound.content as Record<string, unknown>;
    expect(content.eventType).toBe('owner_message');
    expect(content.senderId).toBe(`${CHANNEL_TYPE}:owner-x`);
    expect(content.senderName).toBe('Vincent');
  });

  it('maps a dm_message with conversationId to that platformId and carries the id through', async () => {
    const { setup } = await bootAdapter();
    await pushInbound(
      cityEvent({
        seq: 8,
        eventType: 'dm_message',
        from: { id: 'u2', name: 'Bob' },
        metadata: { conversationId: 'conv-9' },
      }),
    );

    const [platformId, , inbound] = setup.onInbound.mock.calls[0] as [string, string | null, InboundMessage];
    expect(platformId).toBe('conv-9');
    expect(inbound.isMention).toBe(true);
    expect(inbound.isGroup).toBe(false);
    expect((inbound.content as Record<string, unknown>).conversationId).toBe('conv-9');
  });

  it('maps an ambient chat_mention to the senderId as group traffic', async () => {
    const { setup } = await bootAdapter();
    await pushInbound(
      cityEvent({ seq: 9, eventType: 'chat_mention', from: { id: 'u4', name: 'Cara' }, metadata: { zoneId: 2 } }),
    );

    const [platformId, , inbound] = setup.onInbound.mock.calls[0] as [string, string | null, InboundMessage];
    expect(platformId).toBe('u4');
    expect(inbound.isMention).toBe(true); // chat_mention is a direct-mention event
    expect(inbound.isGroup).toBe(true);
  });

  it('leaves isMention undefined for ambient building_activity (router self-gates)', async () => {
    const { setup } = await bootAdapter();
    await pushInbound(
      cityEvent({
        seq: 10,
        eventType: 'building_activity',
        from: { id: 'u5', name: 'Dee' },
        metadata: { buildingId: 'cafe' },
      }),
    );

    const [platformId, , inbound] = setup.onInbound.mock.calls[0] as [string, string | null, InboundMessage];
    expect(platformId).toBe('u5');
    expect(inbound.isMention).toBeUndefined();
    expect(inbound.isGroup).toBe(true);
  });

  it('is a no-op if an event arrives after teardown', async () => {
    const { adapter, setup } = await bootAdapter();
    await adapter.teardown();
    await pushInbound(cityEvent({ seq: 11 }));
    expect(setup.onInbound).not.toHaveBeenCalled();
  });
});

// ── City-context injection + dedup ──

describe('city-context injection', () => {
  it('prepends the [CITY CONTEXT] heartbeat snapshot to the first inbound for a peer', async () => {
    const config = makeConfig({ fetchImpl: fetchReturning('ZONE=Downtown; MOOD=curious') as unknown as typeof fetch });
    const { setup } = await bootAdapter(config);

    await pushInbound(cityEvent({ seq: 1, eventType: 'chat_mention', from: { id: 'peer-a', name: 'A' }, text: 'yo' }));

    const inbound = setup.onInbound.mock.calls[0][2] as InboundMessage;
    const text = (inbound.content as Record<string, unknown>).text as string;
    expect(text).toContain('[CITY CONTEXT]');
    expect(text).toContain('ZONE=Downtown; MOOD=curious');
    expect(text).toContain('[/CITY CONTEXT]');
    // original body still present after the context block
    expect(text).toContain('A: yo');
  });

  it('dedupes an identical snapshot for the same peer within the window (and caches the heartbeat)', async () => {
    const fetchImpl = fetchReturning('CTX_V1');
    const { setup } = await bootAdapter(makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));

    await pushInbound(cityEvent({ seq: 1, eventType: 'chat_mention', from: { id: 'peer-a', name: 'A' }, text: 'one' }));
    await pushInbound(cityEvent({ seq: 2, eventType: 'chat_mention', from: { id: 'peer-a', name: 'A' }, text: 'two' }));

    const first = (setup.onInbound.mock.calls[0][2] as InboundMessage).content as Record<string, unknown>;
    const second = (setup.onInbound.mock.calls[1][2] as InboundMessage).content as Record<string, unknown>;
    expect(first.text as string).toContain('[CITY CONTEXT]');
    // Second event, same cached snapshot within 60s -> not re-injected.
    expect(second.text as string).not.toContain('[CITY CONTEXT]');
    // Heartbeat is fetched once and cached (5 min window).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still injects context for a second, distinct peer', async () => {
    const { setup } = await bootAdapter(makeConfig({ fetchImpl: fetchReturning('CTX_V1') as unknown as typeof fetch }));

    await pushInbound(cityEvent({ seq: 1, eventType: 'chat_mention', from: { id: 'peer-a', name: 'A' }, text: 'one' }));
    await pushInbound(cityEvent({ seq: 2, eventType: 'chat_mention', from: { id: 'peer-b', name: 'B' }, text: 'two' }));

    const second = (setup.onInbound.mock.calls[1][2] as InboundMessage).content as Record<string, unknown>;
    expect(second.text as string).toContain('[CITY CONTEXT]');
  });

  it('truncates an oversized heartbeat to the configured cap', async () => {
    const huge = 'X'.repeat(50_000);
    const { setup } = await bootAdapter(
      makeConfig({ fetchImpl: fetchReturning(huge) as unknown as typeof fetch, cityContextMaxChars: 500 }),
    );

    await pushInbound(cityEvent({ seq: 1, eventType: 'chat_mention', from: { id: 'peer-a', name: 'A' }, text: 'hey' }));
    const text = ((setup.onInbound.mock.calls[0][2] as InboundMessage).content as Record<string, unknown>)
      .text as string;
    expect(text).toContain('city context truncated');
    // The injected snapshot must be far smaller than the raw 50k body.
    expect(text.length).toBeLessThan(2_000);
  });
});

// ── Outbound reply routing ──

function outbound(text: string): OutboundMessage {
  return { kind: 'chat', content: { text } };
}

describe('outbound reply routing', () => {
  it('owner_message -> owner_reply', async () => {
    const { adapter } = await bootAdapter();
    await pushInbound(
      cityEvent({ seq: 1, eventType: 'owner_message', from: { id: 'owner-x', name: 'V' }, text: 'hi' }),
    );

    await adapter.deliver(OWNER_PLATFORM_ID, null, outbound('hello owner'));
    expect(h.replies).toEqual([{ type: 'agent_reply', action: 'owner_reply', message: 'hello owner' }]);
  });

  it('dm_message -> dm_reply carrying the conversation_id', async () => {
    const { adapter } = await bootAdapter();
    await pushInbound(
      cityEvent({
        seq: 1,
        eventType: 'dm_message',
        from: { id: 'u2', name: 'Bob' },
        metadata: { conversationId: 'conv-9' },
      }),
    );

    await adapter.deliver('conv-9', null, outbound('secret reply'));
    expect(h.replies).toEqual([
      { type: 'agent_reply', action: 'dm_reply', message: 'secret reply', conversation_id: 'conv-9' },
    ]);
  });

  it("'dm' and 'dm_approved' event types also route to dm_reply", async () => {
    const { adapter } = await bootAdapter();
    await pushInbound(
      cityEvent({
        seq: 1,
        eventType: 'dm' as CityEvent['eventType'],
        from: { id: 'u2', name: 'B' },
        metadata: { conversationId: 'c-dm' },
      }),
    );
    await pushInbound(
      cityEvent({
        seq: 2,
        eventType: 'dm_approved' as CityEvent['eventType'],
        from: { id: 'u3', name: 'C' },
        metadata: { conversationId: 'c-appr' },
      }),
    );

    await adapter.deliver('c-dm', null, outbound('a'));
    await adapter.deliver('c-appr', null, outbound('b'));
    expect(h.replies).toEqual([
      { type: 'agent_reply', action: 'dm_reply', message: 'a', conversation_id: 'c-dm' },
      { type: 'agent_reply', action: 'dm_reply', message: 'b', conversation_id: 'c-appr' },
    ]);
  });

  it('any other event type -> speak', async () => {
    const { adapter } = await bootAdapter();
    await pushInbound(
      cityEvent({ seq: 1, eventType: 'chat_mention', from: { id: 'u4', name: 'Cara' }, metadata: { zoneId: 1 } }),
    );

    await adapter.deliver('u4', null, outbound('hello zone'));
    expect(h.replies).toEqual([{ type: 'agent_reply', action: 'speak', text: 'hello zone' }]);
  });

  it('falls back to a public speak for an unknown platformId (no remembered route)', async () => {
    const { adapter } = await bootAdapter();
    await adapter.deliver('never-seen', null, outbound('broadcast'));
    expect(h.replies).toEqual([{ type: 'agent_reply', action: 'speak', text: 'broadcast' }]);
  });

  it('infers owner_reply for the owner platformId even without a remembered route', async () => {
    const { adapter } = await bootAdapter();
    await adapter.deliver(OWNER_PLATFORM_ID, null, outbound('hi human'));
    expect(h.replies).toEqual([{ type: 'agent_reply', action: 'owner_reply', message: 'hi human' }]);
  });

  it('reads outbound text from a markdown field too', async () => {
    const { adapter } = await bootAdapter();
    await pushInbound(cityEvent({ seq: 1, eventType: 'chat_mention', from: { id: 'u4', name: 'C' }, metadata: {} }));
    await adapter.deliver('u4', null, { kind: 'chat', content: { markdown: 'from markdown' } });
    expect(h.replies).toEqual([{ type: 'agent_reply', action: 'speak', text: 'from markdown' }]);
  });
});

// ── DM-WITHHOLD rule ──

describe('DM-withhold rule', () => {
  it('withholds a dm reply when the originating DM had no conversationId', async () => {
    const { adapter } = await bootAdapter();
    // dm_message WITHOUT a conversationId -> platformId 'dm:<senderId>', route has no conversationId.
    await pushInbound(cityEvent({ seq: 1, eventType: 'dm_message', from: { id: 'u7', name: 'Zed' }, metadata: {} }));

    await adapter.deliver('dm:u7', null, outbound('this must NOT leak to public chat'));
    // Reply is dropped rather than downgraded to a public speak.
    expect(h.replies).toHaveLength(0);
  });
});

// ── Sanitize applied to replies ──

describe('reply sanitization', () => {
  it('trims whitespace on a shippable reply', async () => {
    const { adapter } = await bootAdapter();
    await pushInbound(cityEvent({ seq: 1, eventType: 'owner_message', from: { id: 'o', name: 'V' }, text: 'hi' }));
    await adapter.deliver(OWNER_PLATFORM_ID, null, outbound('  hello there  '));
    expect(h.replies).toEqual([{ type: 'agent_reply', action: 'owner_reply', message: 'hello there' }]);
  });

  it('withholds a runtime-error banner instead of shipping it to the city', async () => {
    const { adapter } = await bootAdapter();
    await pushInbound(cityEvent({ seq: 1, eventType: 'chat_mention', from: { id: 'u4', name: 'C' }, metadata: {} }));
    await adapter.deliver(
      'u4',
      null,
      outbound('⚠️ Context is too large and auto-compaction could not recover this turn.'),
    );
    expect(h.replies).toHaveLength(0);
  });

  it('withholds a reply that is nothing but tool-call markup', async () => {
    const { adapter } = await bootAdapter();
    await pushInbound(cityEvent({ seq: 1, eventType: 'owner_message', from: { id: 'o', name: 'V' }, text: 'hi' }));
    await adapter.deliver(OWNER_PLATFORM_ID, null, outbound('<PLHD>[{"name":"read","parameters":{}}]<PLHD>'));
    expect(h.replies).toHaveLength(0);
  });

  it('does not send when the outbound content has no text/markdown', async () => {
    const { adapter } = await bootAdapter();
    await pushInbound(cityEvent({ seq: 1, eventType: 'owner_message', from: { id: 'o', name: 'V' }, text: 'hi' }));
    await adapter.deliver(OWNER_PLATFORM_ID, null, { kind: 'chat', content: { foo: 'bar' } });
    expect(h.replies).toHaveLength(0);
  });
});

// Reference the imported enum so the type-only import is retained and the mock's
// getState() string stays in sync with the real ConnectionState value.
it('mock CONNECTED value matches the real enum', () => {
  expect(ConnectionState.CONNECTED).toBe('CONNECTED');
});
