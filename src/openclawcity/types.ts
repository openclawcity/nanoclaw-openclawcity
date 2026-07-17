// ── Connection State ──

export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  DISCONNECTING = 'DISCONNECTING',
  FAILED = 'FAILED',
}

// ── City Event Types ──

export type CityEventType =
  | 'dm_request'
  | 'dm_message'
  | 'proposal_received'
  | 'proposal_accepted'
  | 'chat_mention'
  | 'owner_message'
  | 'building_activity'
  | 'artifact_reaction'
  | 'welcome';

export interface CityEventFrom {
  id: string;
  name: string;
  avatar?: string;
}

export interface CityEventMetadata {
  conversationId?: string;
  zoneId?: number;
  buildingId?: string | null;
  proposalId?: string;
  expiresIn?: number;
  artifactId?: string;
  reaction?: string;
  [key: string]: unknown;
}

export interface CityEvent {
  type: 'city_event';
  seq: number;
  eventType: CityEventType;
  from: CityEventFrom;
  text?: string;
  timestamp?: number;
  metadata: CityEventMetadata;
}

// ── Welcome Frame (server → client) ──

export interface WelcomeLocation {
  zoneId: number;
  zoneName: string;
  buildingId?: string | null;
  buildingName?: string | null;
}

export interface NearbyBot {
  id: string;
  name: string;
  avatar?: string;
}

export interface WelcomeFrame {
  type: 'welcome';
  version: number;
  botId?: string;
  display_name?: string;
  paused?: boolean;
  location?: WelcomeLocation;
  // Server uses snake_case field names
  nearby_bots?: NearbyBot[];
  pending_items?: Record<string, unknown>;
  // Keep these for backward compat if server ever changes
  nearby?: NearbyBot[];
  pending?: CityEvent[];
}

// ── Client → Server Frames ──

export interface HelloFrame {
  type: 'hello';
  version: number;
  botId: string;
  token: string;
}

export interface ResumeFrame {
  type: 'resume';
  version: number;
  botId: string;
  token: string;
  lastAckSeq: number;
}

export interface AckFrame {
  type: 'ack';
  seq: number;
}

// ── Agent Reply (client → server) ──

export type AgentReplyAction =
  | 'speak'
  | 'move'
  | 'dm_reply'
  | 'owner_reply'
  | 'enter_building'
  | 'leave_building'
  | 'execute_action'
  | 'react_to_artifact'
  | 'propose';

export interface AgentReply {
  type: 'agent_reply';
  action: AgentReplyAction;
  conversationId?: string;
  text?: string;
  targetId?: string;
  buildingId?: string;
  artifactId?: string;
  reaction?: string;
  zoneId?: number;
  [key: string]: unknown;
}

// ── Server → Client Frames ──

export interface ActionResultFrame {
  type: 'action_result';
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface ErrorFrame {
  type: 'error';
  reason: string;
  message?: string;
  supported?: number[];
  retryAfter?: number;
}

export interface PausedFrame {
  type: 'paused';
  message?: string;
}

export interface ResumedFrame {
  type: 'resumed';
}

export type ServerFrame = WelcomeFrame | CityEvent | ActionResultFrame | ErrorFrame | PausedFrame | ResumedFrame;

export type ClientFrame = HelloFrame | ResumeFrame | AckFrame | AgentReply;

// ── Config Types ──

export interface OpenClawCityAccountConfig {
  gatewayUrl?: string;
  apiKey: string;
  botId: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  pingIntervalMs?: number;
  enabled?: boolean;
}

// ── Normalized Message Envelope ──

export interface MessageEnvelope {
  id: string;
  timestamp: number;
  channelId: string;
  sender: {
    id: string;
    name: string;
    avatar?: string;
  };
  content: {
    text: string;
  };
  metadata: Record<string, unknown>;
}
