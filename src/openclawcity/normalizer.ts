import type { CityEvent, MessageEnvelope, WelcomeFrame, NearbyBot } from './types.js';

/**
 * Format a city event into human-readable text for the LLM.
 */
export function formatEventText(event: CityEvent): string {
  const name = event.from?.name ?? 'Unknown';
  const text = event.text ?? '';

  switch (event.eventType) {
    case 'dm_request':
      return `[DM request from ${name}] ${text}`.trim();

    case 'dm_message':
      return `[DM from ${name}] ${text}`.trim();

    case 'proposal_received': {
      const expires = event.metadata?.expiresIn ? ` (expires in ${event.metadata.expiresIn} min)` : '';
      return `[Proposal from ${name}] ${text}${expires}`.trim();
    }

    case 'proposal_accepted':
      return `[Proposal accepted by ${name}] ${text}`.trim();

    case 'chat_mention': {
      const location = event.metadata?.buildingId
        ? `building ${event.metadata.buildingId}`
        : `Zone ${event.metadata?.zoneId ?? '?'}`;
      return `[Chat in ${location}] ${name}: ${text}`.trim();
    }

    case 'owner_message':
      return `[Message from your human] ${text}`.trim();

    case 'building_activity': {
      const building = event.metadata?.buildingId ?? 'unknown building';
      return `[Activity in ${building}] ${name}: ${text}`.trim();
    }

    case 'artifact_reaction': {
      const reaction = event.metadata?.reaction ?? '';
      const artifact = event.metadata?.artifactId ?? 'an artifact';
      return `[${name} reacted ${reaction} to ${artifact}] ${text}`.trim();
    }

    case 'welcome':
      return `[City] ${text}`.trim();

    default:
      return `[${event.eventType}] ${name}: ${text}`.trim();
  }
}

/**
 * Format a welcome frame into human-readable text.
 */
export function formatWelcomeText(welcome: WelcomeFrame): string {
  const zone = welcome.location?.zoneName ?? `Zone ${welcome.location?.zoneId ?? '?'}`;
  const building = welcome.location?.buildingName ? ` in ${welcome.location.buildingName}` : '';
  const nearby = welcome.nearby_bots ?? welcome.nearby ?? [];
  const nearbyNames = nearby.map((b: NearbyBot) => b.name);
  const nearbyText =
    nearbyNames.length > 0 ? ` ${nearbyNames.length} bots nearby: ${nearbyNames.join(', ')}.` : ' No bots nearby.';
  const pendingEvents = welcome.pending ?? [];
  const pendingText = pendingEvents.length > 0 ? ` You have ${pendingEvents.length} pending event(s).` : '';

  return `[City] You're connected to OpenClawCity! You're in ${zone}${building}.${nearbyText}${pendingText}`;
}

/**
 * Normalize a city_event into an OpenClawCity MessageEnvelope.
 */
export function normalize(event: CityEvent): MessageEnvelope {
  return {
    id: `occ-${event.seq}`,
    timestamp: event.timestamp ?? Date.now(),
    channelId: 'openclawcity',
    sender: {
      id: event.from?.id ?? 'unknown',
      name: event.from?.name ?? 'Unknown',
      avatar: event.from?.avatar,
    },
    content: {
      text: formatEventText(event),
    },
    metadata: {
      eventType: event.eventType,
      seq: event.seq,
      ...(event.metadata ?? {}),
    },
  };
}
