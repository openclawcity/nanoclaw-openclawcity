import { describe, it, expect } from 'vitest';
import { normalize, formatEventText, formatWelcomeText } from '../normalizer.js';
import type { CityEvent, WelcomeFrame } from '../types.js';

function makeEvent(overrides: Partial<CityEvent> = {}): CityEvent {
  return {
    type: 'city_event',
    seq: 1,
    eventType: 'dm_message',
    from: { id: 'user-1', name: 'Alice', avatar: 'https://example.com/alice.png' },
    text: 'Hello there',
    metadata: { conversationId: 'conv-1' },
    ...overrides,
  };
}

// ── formatEventText ──

describe('formatEventText', () => {
  it('formats dm_message', () => {
    const event = makeEvent({ eventType: 'dm_message', text: 'Hey!' });
    expect(formatEventText(event)).toBe('[DM from Alice] Hey!');
  });

  it('formats dm_request', () => {
    const event = makeEvent({ eventType: 'dm_request', text: 'Can we chat?' });
    expect(formatEventText(event)).toBe('[DM request from Alice] Can we chat?');
  });

  it('formats proposal_received with expiry', () => {
    const event = makeEvent({
      eventType: 'proposal_received',
      text: "Let's explore together",
      metadata: { proposalId: 'p1', expiresIn: 10 },
    });
    expect(formatEventText(event)).toBe("[Proposal from Alice] Let's explore together (expires in 10 min)");
  });

  it('formats proposal_received without expiry', () => {
    const event = makeEvent({
      eventType: 'proposal_received',
      text: "Let's go",
      metadata: {},
    });
    expect(formatEventText(event)).toBe("[Proposal from Alice] Let's go");
  });

  it('formats proposal_accepted', () => {
    const event = makeEvent({ eventType: 'proposal_accepted', text: 'Sounds great!' });
    expect(formatEventText(event)).toBe('[Proposal accepted by Alice] Sounds great!');
  });

  it('formats chat_mention with buildingId', () => {
    const event = makeEvent({
      eventType: 'chat_mention',
      text: '@Bot check this out',
      metadata: { buildingId: 'cafe-42', zoneId: 1 },
    });
    expect(formatEventText(event)).toBe('[Chat in building cafe-42] Alice: @Bot check this out');
  });

  it('formats chat_mention without buildingId', () => {
    const event = makeEvent({
      eventType: 'chat_mention',
      text: '@Bot hey',
      metadata: { zoneId: 3 },
    });
    expect(formatEventText(event)).toBe('[Chat in Zone 3] Alice: @Bot hey');
  });

  it('formats chat_mention with null buildingId falls back to zone', () => {
    const event = makeEvent({
      eventType: 'chat_mention',
      text: '@Bot hey',
      metadata: { buildingId: null, zoneId: 5 },
    });
    expect(formatEventText(event)).toBe('[Chat in Zone 5] Alice: @Bot hey');
  });

  it('formats owner_message', () => {
    const event = makeEvent({ eventType: 'owner_message', text: 'How are you doing?' });
    expect(formatEventText(event)).toBe('[Message from your human] How are you doing?');
  });

  it('formats building_activity', () => {
    const event = makeEvent({
      eventType: 'building_activity',
      text: 'Started a jam session',
      metadata: { buildingId: 'music-hall' },
    });
    expect(formatEventText(event)).toBe('[Activity in music-hall] Alice: Started a jam session');
  });

  it('formats artifact_reaction', () => {
    const event = makeEvent({
      eventType: 'artifact_reaction',
      text: '',
      metadata: { artifactId: 'art-1', reaction: '🔥' },
    });
    const result = formatEventText(event);
    expect(result).toContain('Alice');
    expect(result).toContain('reacted');
    expect(result).toContain('🔥');
    expect(result).toContain('art-1');
  });

  it('formats welcome', () => {
    const event = makeEvent({ eventType: 'welcome', text: 'Welcome to the city!' });
    expect(formatEventText(event)).toBe('[City] Welcome to the city!');
  });

  it('handles unknown event types gracefully', () => {
    const event = makeEvent({ eventType: 'unknown_type' as any, text: 'something' });
    expect(formatEventText(event)).toBe('[unknown_type] Alice: something');
  });

  it('handles missing text (undefined)', () => {
    const event = makeEvent({ text: undefined });
    const result = formatEventText(event);
    expect(result).toBeDefined();
    expect(result).not.toContain('undefined');
  });

  it('handles empty string text', () => {
    const event = makeEvent({ text: '' });
    const result = formatEventText(event);
    expect(result).toBe('[DM from Alice]');
  });

  it('handles missing from.name', () => {
    const event = makeEvent({ from: { id: 'u1', name: '' } });
    const result = formatEventText(event);
    expect(result).toBeDefined();
    // Empty name is passed through (truthy check is on `from`, not `from.name`)
    expect(result).toContain('[DM from ]');
  });

  it('handles null from (defensive)', () => {
    const event = makeEvent({ from: undefined as any });
    const result = formatEventText(event);
    expect(result).toContain('Unknown');
    expect(result).not.toContain('undefined');
  });
});

// ── formatWelcomeText ──

describe('formatWelcomeText', () => {
  it('formats a full welcome with building', () => {
    const welcome: WelcomeFrame = {
      type: 'welcome',
      version: 1,
      location: { zoneId: 1, zoneName: 'Downtown', buildingName: 'The Byte Cafe' },
      nearby: [
        { id: 'b1', name: 'Alice' },
        { id: 'b2', name: 'Bob' },
      ],
      pending: [],
    };

    const text = formatWelcomeText(welcome);
    expect(text).toContain('Downtown');
    expect(text).toContain('The Byte Cafe');
    expect(text).toContain('2 bots nearby');
    expect(text).toContain('Alice');
    expect(text).toContain('Bob');
  });

  it('formats welcome without building', () => {
    const welcome: WelcomeFrame = {
      type: 'welcome',
      version: 1,
      location: { zoneId: 1, zoneName: 'Downtown' },
      nearby: [{ id: 'b1', name: 'Alice' }],
      pending: [],
    };

    const text = formatWelcomeText(welcome);
    expect(text).toContain('Downtown');
    expect(text).not.toContain('in null');
    expect(text).not.toContain('in undefined');
  });

  it('handles no nearby bots', () => {
    const welcome: WelcomeFrame = {
      type: 'welcome',
      version: 1,
      location: { zoneId: 2, zoneName: 'Suburbs' },
      nearby: [],
      pending: [],
    };

    const text = formatWelcomeText(welcome);
    expect(text).toContain('No bots nearby');
  });

  it('shows pending events count', () => {
    const welcome: WelcomeFrame = {
      type: 'welcome',
      version: 1,
      location: { zoneId: 1, zoneName: 'Downtown' },
      nearby: [],
      pending: [
        { type: 'city_event', seq: 1, eventType: 'dm_message', from: { id: 'u1', name: 'A' }, metadata: {} },
        { type: 'city_event', seq: 2, eventType: 'dm_message', from: { id: 'u2', name: 'B' }, metadata: {} },
      ],
    };

    const text = formatWelcomeText(welcome);
    expect(text).toContain('2 pending event(s)');
  });

  it('omits pending text when no pending events', () => {
    const welcome: WelcomeFrame = {
      type: 'welcome',
      version: 1,
      location: { zoneId: 1, zoneName: 'Downtown' },
      nearby: [],
      pending: [],
    };

    const text = formatWelcomeText(welcome);
    expect(text).not.toContain('pending');
  });
});

// ── normalize ──

describe('normalize', () => {
  it('produces a valid MessageEnvelope with all fields', () => {
    const event = makeEvent({ seq: 42, timestamp: 1700000000 });
    const envelope = normalize(event);

    expect(envelope.id).toBe('occ-42');
    expect(envelope.timestamp).toBe(1700000000);
    expect(envelope.channelId).toBe('openclawcity');
    expect(envelope.sender.id).toBe('user-1');
    expect(envelope.sender.name).toBe('Alice');
    expect(envelope.sender.avatar).toBe('https://example.com/alice.png');
    expect(envelope.content.text).toBe('[DM from Alice] Hello there');
    expect(envelope.metadata.eventType).toBe('dm_message');
    expect(envelope.metadata.seq).toBe(42);
    expect(envelope.metadata.conversationId).toBe('conv-1');
  });

  it('uses Date.now() when timestamp is missing', () => {
    const event = makeEvent({ timestamp: undefined });
    const before = Date.now();
    const envelope = normalize(event);
    const after = Date.now();

    expect(envelope.timestamp).toBeGreaterThanOrEqual(before);
    expect(envelope.timestamp).toBeLessThanOrEqual(after);
  });

  it('handles missing from gracefully', () => {
    const event = makeEvent({ from: undefined as any });
    const envelope = normalize(event);

    expect(envelope.sender.id).toBe('unknown');
    expect(envelope.sender.name).toBe('Unknown');
    expect(envelope.sender.avatar).toBeUndefined();
  });

  it('handles missing metadata gracefully', () => {
    const event = makeEvent({ metadata: undefined as any });
    const envelope = normalize(event);

    expect(envelope.metadata.eventType).toBe('dm_message');
    expect(envelope.metadata.seq).toBe(1);
  });

  it('preserves extra metadata fields', () => {
    const event = makeEvent({
      metadata: { conversationId: 'c1', zoneId: 3, custom: 'value' },
    });
    const envelope = normalize(event);

    expect(envelope.metadata.conversationId).toBe('c1');
    expect(envelope.metadata.zoneId).toBe(3);
    expect(envelope.metadata.custom).toBe('value');
  });

  it('seq in id uses the event seq, not a counter', () => {
    const e1 = normalize(makeEvent({ seq: 100 }));
    const e2 = normalize(makeEvent({ seq: 200 }));

    expect(e1.id).toBe('occ-100');
    expect(e2.id).toBe('occ-200');
  });
});
