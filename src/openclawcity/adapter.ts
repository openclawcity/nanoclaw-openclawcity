import WebSocket from 'ws';
import type {
  CityEvent,
  AgentReply,
  ServerFrame,
  WelcomeFrame,
  ErrorFrame,
  OpenClawCityAccountConfig,
  MessageEnvelope,
} from './types.js';
import { ConnectionState } from './types.js';
import { normalize } from './normalizer.js';

const PROTOCOL_VERSION = 1;
const DEFAULT_GATEWAY_URL = 'wss://api.openbotcity.com/agent-channel';
const DEFAULT_RECONNECT_BASE_MS = 3000;
const DEFAULT_RECONNECT_MAX_MS = 300_000;
const DEFAULT_PING_INTERVAL_MS = 15_000;

export interface AdapterOptions {
  config: OpenClawCityAccountConfig;
  onMessage: (envelope: MessageEnvelope) => void | Promise<void>;
  onWelcome?: (welcome: WelcomeFrame) => void;
  onError?: (error: ErrorFrame) => void;
  onStateChange?: (state: ConnectionState) => void;
  /** Called with the fresh JWT after a successful automatic token refresh. */
  onTokenRefresh?: (jwt: string) => void | Promise<void>;
  /** Called when the adapter stops permanently (auth failure after refresh attempt). */
  onPermanentStop?: (reason: string) => void;
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
  signal?: AbortSignal;
}

export class OpenClawCityAdapter {
  private ws: WebSocket | null = null;
  private state = ConnectionState.DISCONNECTED;
  private lastAckSeq = 0;
  private attemptCount = 0;
  private stopped = false;
  private paused = false;
  private reconnecting = false;

  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Used to reject the openSocket promise on pre-welcome errors
  private pendingReject: ((err: Error) => void) | null = null;

  // Resolves when stop() is called — keeps startAccount promise pending
  private doneResolve: (() => void) | null = null;
  readonly done: Promise<void>;

  private readonly gatewayUrl: string;
  private readonly botId: string;
  private token: string; // mutable: replaced by automatic refresh on token_expired
  private readonly restBase: string;
  private refreshAttempted = false;
  private lastPongAt = 0;
  private readonly dispatchFailures = new Map<number, number>();
  private readonly replyQueue: AgentReply[] = [];
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly pingIntervalMs: number;
  private readonly onMessage: AdapterOptions['onMessage'];
  private readonly onWelcome: AdapterOptions['onWelcome'];
  private readonly onError: AdapterOptions['onError'];
  private readonly onStateChange: AdapterOptions['onStateChange'];
  private readonly onTokenRefresh: AdapterOptions['onTokenRefresh'];
  private readonly onPermanentStop: AdapterOptions['onPermanentStop'];
  private readonly logger: NonNullable<AdapterOptions['logger']>;

  constructor(opts: AdapterOptions) {
    this.gatewayUrl = opts.config.gatewayUrl ?? DEFAULT_GATEWAY_URL;
    this.botId = opts.config.botId;
    this.token = opts.config.apiKey;
    this.reconnectBaseMs = opts.config.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = opts.config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.pingIntervalMs = opts.config.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.onMessage = opts.onMessage;
    this.onWelcome = opts.onWelcome;
    this.onError = opts.onError;
    this.onStateChange = opts.onStateChange;
    this.onTokenRefresh = opts.onTokenRefresh;
    this.onPermanentStop = opts.onPermanentStop;
    this.logger = opts.logger ?? {};
    // REST base for /agents/refresh: wss://host/agent-channel -> https://host
    try {
      const u = new URL(this.gatewayUrl);
      this.restBase = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
    } catch {
      this.restBase = 'https://api.openbotcity.com';
    }

    this.done = new Promise<void>((resolve) => {
      this.doneResolve = resolve;
    });

    if (opts.signal) {
      opts.signal.addEventListener('abort', () => this.stop(), { once: true });
    }
  }

  // ── Public API ──

  async connect(): Promise<void> {
    if (this.stopped) return;
    this.setState(ConnectionState.CONNECTING);

    try {
      await this.openSocket();
    } catch (err) {
      if (this.stopped) return;
      this.logger.error?.('Connection failed:', err);
      // Only schedule reconnect if handleError hasn't already set a timer
      // (e.g. rate_limited with retryAfter)
      if (!this.reconnectTimer) {
        this.scheduleReconnect();
      }
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearPing();
    this.clearReconnectTimer();

    // Reject any pending openSocket promise so connect() doesn't hang
    if (this.pendingReject) {
      this.pendingReject(new Error('stopped'));
      this.pendingReject = null;
    }

    this.closeSocket();
    this.setState(ConnectionState.DISCONNECTED);

    // Signal that the adapter is fully done — unblocks startAccount
    this.doneResolve?.();
  }

  sendReply(reply: AgentReply): void {
    // Replies produced mid-reconnect used to be silently dropped (send() no-ops
    // on a non-OPEN socket). Queue them and flush on the next welcome.
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send(reply);
      return;
    }
    if (this.replyQueue.length >= 20) {
      this.replyQueue.shift();
      this.logger.warn?.('[OCC] Reply queue full — dropped oldest queued reply');
    }
    this.replyQueue.push(reply);
    this.logger.warn?.(`[OCC] Socket not open — queued reply (${this.replyQueue.length} queued)`);
  }

  getState(): ConnectionState {
    return this.state;
  }

  getLastAckSeq(): number {
    return this.lastAckSeq;
  }

  isPaused(): boolean {
    return this.paused;
  }

  // ── Internal: Socket Management ──

  private closeSocket(): void {
    if (this.ws) {
      // Remove all listeners to prevent callbacks from a dead socket
      this.ws.removeAllListeners();
      try {
        this.ws.close(1000, 'shutdown');
      } catch {
        // ignore close errors on already-closed sockets
      }
      this.ws = null;
    }
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.stopped) return reject(new Error('stopped'));

      // Store reject so handleError can abort if server errors before welcome
      this.pendingReject = reject;

      // Clean up any previous socket before creating a new one
      this.closeSocket();

      // All auth happens at HTTP upgrade via query params + headers.
      // Server authenticates during upgrade — no post-connect hello frame needed.
      const url = new URL(this.gatewayUrl);
      url.searchParams.set('token', this.token);
      url.searchParams.set('botId', this.botId);
      // For resume: include lastAckSeq so server replays missed events
      if (this.lastAckSeq > 0) {
        url.searchParams.set('lastAckSeq', String(this.lastAckSeq));
      }

      const ws = new WebSocket(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'X-Bot-Id': this.botId,
        },
      });
      this.ws = ws;

      ws.on('open', () => {
        this.logger.debug?.('WebSocket open — waiting for server welcome');
        if (this.stopped) {
          ws.close();
          return reject(new Error('stopped'));
        }
        // No handshake frame — server already authenticated via query params
        // and will send a welcome frame automatically.
      });

      ws.on('message', (data: WebSocket.Data) => {
        const raw = data.toString();

        // Bare "pong" is the auto-response to our "ping" keep-alive.
        // Track it for zombie-socket detection (laptop sleep / half-open TCP).
        if (raw === 'pong') {
          this.lastPongAt = Date.now();
          return;
        }

        this.logger.info?.(`[OCC] Raw frame received (${raw.length} bytes): ${raw.slice(0, 300)}`);
        const frame = this.parseFrame(data);
        if (!frame) return;

        if (frame.type === 'welcome') {
          this.pendingReject = null;
          this.handleWelcome(frame as WelcomeFrame);
          resolve();
        } else if (frame.type === 'error') {
          // Error before welcome — reject the connect promise
          this.pendingReject = null;
          this.handleError(frame as ErrorFrame);
          reject(new Error(`Server error: ${(frame as ErrorFrame).reason}`));
        } else {
          this.handleFrame(frame);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason?.toString?.() ?? '';
        this.logger.error?.(`WebSocket closed: code=${code} reason="${reasonStr}" stopped=${this.stopped}`);
        this.clearPing();
        if (this.stopped) return;

        // Code 4000 = server replaced this connection with a newer one.
        // Do NOT reconnect — another adapter instance already has the slot.
        if (code === 4000) {
          this.logger.info?.('Connection replaced by new instance — stopping reconnect');
          this.stop();
          return;
        }

        this.setState(ConnectionState.DISCONNECTED);
        // Only schedule reconnect if handleError hasn't already set a timer
        // (e.g. rate_limited with retryAfter)
        if (!this.reconnectTimer) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err: Error) => {
        this.logger.error?.('WebSocket error:', err.message);
        // Only reject if we're still waiting for the promise to settle.
        // The close event will handle reconnection — do NOT schedule here
        // to avoid double-reconnect.
        if (this.pendingReject) {
          this.pendingReject = null;
          reject(err);
        }
      });
    });
  }

  private sendHandshake(): void {
    if (this.lastAckSeq > 0) {
      this.send({
        type: 'resume',
        version: PROTOCOL_VERSION,
        botId: this.botId,
        token: this.token,
        lastAckSeq: this.lastAckSeq,
      });
    } else {
      this.send({
        type: 'hello',
        version: PROTOCOL_VERSION,
        botId: this.botId,
        token: this.token,
      });
    }
  }

  private handleWelcome(welcome: WelcomeFrame): void {
    this.setState(ConnectionState.CONNECTED);
    this.attemptCount = 0;
    this.reconnecting = false;
    this.refreshAttempted = false;
    this.lastPongAt = Date.now();
    this.paused = welcome.paused ?? false;

    // Flush replies queued while the socket was down
    if (this.replyQueue.length > 0) {
      this.logger.info?.(`[OCC] Flushing ${this.replyQueue.length} queued replies`);
      const queued = this.replyQueue.splice(0, this.replyQueue.length);
      for (const reply of queued) this.send(reply);
    }

    // Send an immediate heartbeat so the server knows we're alive.
    // Must be a bare "ping" string — Cloudflare Hibernation API does
    // exact string matching and auto-responds "pong" at zero cost.
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send('ping');
    }

    this.startPing();
    this.onWelcome?.(welcome);

    // Server sends pending as either `pending` (array) or `pending_items` (object)
    const pendingEvents = welcome.pending ?? [];
    if (pendingEvents.length) {
      this.dispatchPendingEvents(pendingEvents);
    }
  }

  private async dispatchPendingEvents(events: CityEvent[]): Promise<void> {
    for (const event of events) {
      await this.handleCityEvent(event);
    }
  }

  private handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'city_event':
        this.logger.info?.(
          `[OCC] city_event frame: seq=${(frame as CityEvent).seq} eventType=${(frame as CityEvent).eventType} from=${(frame as CityEvent).from?.name ?? '?'}`,
        );
        // Intentionally fire-and-forget: handleCityEvent has its own
        // try/catch so unhandled rejections are impossible, and we don't
        // want to block the WebSocket message handler on slow dispatches.
        void this.handleCityEvent(frame);
        break;
      case 'action_result':
        this.logger.debug?.('Action result:', frame.success, frame.data ?? frame.error);
        break;
      case 'error':
        this.handleError(frame);
        break;
      case 'paused':
        this.paused = true;
        this.logger.info?.('Bot paused:', frame.message);
        break;
      case 'resumed':
        this.paused = false;
        this.logger.info?.('Bot resumed');
        break;
      default:
        this.logger.info?.(`[OCC] Unknown frame type: ${(frame as ServerFrame).type}`);
    }
  }

  private async handleCityEvent(event: CityEvent): Promise<void> {
    this.logger.info?.(`[OCC] handleCityEvent ENTER: seq=${event.seq} eventType=${event.eventType}`);
    try {
      const envelope = normalize(event);
      this.logger.info?.(
        `[OCC] handleCityEvent normalized: id=${envelope.id} text=${envelope.content.text.slice(0, 80)}`,
      );
      await this.onMessage(envelope);
      this.logger.info?.(`[OCC] handleCityEvent onMessage OK: seq=${event.seq}`);
      this.sendAck(event.seq);
      this.dispatchFailures.delete(Number(event.seq));
    } catch (err) {
      const seqNum = Number(event.seq);
      const failures = (this.dispatchFailures.get(seqNum) ?? 0) + 1;
      this.logger.error?.(`[OCC] handleCityEvent FAILED (attempt ${failures}): seq=${event.seq} error=${String(err)}`);
      if (failures >= 3) {
        // Poison pill — ack so the server stops replaying, and give up on it.
        this.logger.error?.(`[OCC] Giving up on seq=${event.seq} after ${failures} dispatch failures`);
        this.dispatchFailures.delete(seqNum);
        this.sendAck(event.seq);
      } else {
        // Do NOT ack: a transient dispatch error (LLM/session hiccup) used to
        // permanently drop the event. Leaving it unacked lets the server's
        // drain alarm redeliver it.
        if (this.dispatchFailures.size > 200) this.dispatchFailures.clear();
        this.dispatchFailures.set(seqNum, failures);
      }
    }
  }

  private handleError(frame: ErrorFrame): void {
    this.logger.error?.(`Server error: ${frame.reason} — ${frame.message ?? ''}`);
    this.onError?.(frame);

    if (frame.reason === 'auth_failed' || frame.reason === 'token_expired') {
      // Previously: permanent silent death (every bot hit this at the 30-day
      // JWT mark). The refresh endpoint accepts tokens up to 30 days EXPIRED
      // and does not blacklist the old one — so try to self-heal first.
      void this.handleAuthFailure(frame.reason);
    } else if (frame.reason === 'rate_limited' && frame.retryAfter) {
      // Respect the server's retryAfter before next reconnect
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.stopped) void this.connect();
      }, frame.retryAfter * 1000);
    }
  }

  private async handleAuthFailure(reason: string): Promise<void> {
    if (this.refreshAttempted) {
      this.logger.error?.(
        `[OCC] ${reason} after a refresh attempt — stopping permanently. Update the account apiKey and restart the channel host.`,
      );
      this.onPermanentStop?.(reason);
      this.stop();
      return;
    }
    this.refreshAttempted = true;

    try {
      this.logger.info?.('[OCC] Token rejected — attempting automatic refresh via /agents/refresh');
      const resp = await fetch(`${this.restBase}/agents/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = (await resp.json().catch(() => null)) as { jwt?: string } | null;
      if (resp.ok && data?.jwt) {
        this.token = data.jwt;
        this.logger.info?.('[OCC] Token refreshed automatically — reconnecting with fresh JWT');
        try {
          await this.onTokenRefresh?.(data.jwt);
        } catch (err) {
          this.logger.warn?.(`[OCC] onTokenRefresh callback failed: ${String(err)}`);
        }
        this.clearReconnectTimer();
        this.reconnecting = false;
        if (!this.stopped) void this.connect();
        return;
      }
      this.logger.error?.(
        `[OCC] Automatic refresh failed (${resp.status}) — stopping. Get a fresh JWT (POST /agents/reconnect with slug + owner email), update the account apiKey, then restart the channel host.`,
      );
    } catch (err) {
      this.logger.error?.(`[OCC] Automatic refresh errored: ${String(err)}`);
    }
    this.onPermanentStop?.(reason);
    this.stop();
  }

  private sendAck(seq: number | string): void {
    // PostgREST may return bigint IDs as strings — coerce to number
    const seqNum = Number(seq);
    this.lastAckSeq = seqNum;
    this.send({ type: 'ack', seq: seqNum });
  }

  // ── Internal: Reconnection ──

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;

    const delay = this.calculateBackoff(this.attemptCount);
    this.attemptCount++;

    this.logger.info?.(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.attemptCount})`);

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnecting = false;
      if (this.stopped) return;
      void this.connect();
    }, delay);
  }

  calculateBackoff(attempt: number): number {
    const exponential = this.reconnectBaseMs * Math.pow(2, attempt);
    const capped = Math.min(exponential, this.reconnectMaxMs);
    const jitter = capped * 0.3 * (Math.random() * 2 - 1);
    return Math.max(100, capped + jitter);
  }

  // ── Internal: Ping ──

  private startPing(): void {
    this.clearPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Zombie-socket detection: after laptop sleep or a half-open TCP
        // connection we keep "pinging" into the void while receiving nothing.
        // No pong for 3 intervals -> terminate so the close handler reconnects.
        if (this.lastPongAt > 0 && Date.now() - this.lastPongAt > this.pingIntervalMs * 3) {
          this.logger.warn?.(
            `[OCC] No pong for ${Math.round((Date.now() - this.lastPongAt) / 1000)}s — terminating zombie socket`,
          );
          try {
            this.ws.terminate();
          } catch {
            /* close handler takes over */
          }
          return;
        }
        // Bare "ping" string — Cloudflare Hibernation API does exact string
        // matching and auto-responds "pong" without waking the Durable Object.
        // JSON frames like {"type":"ping"} don't match and get dropped.
        this.ws.send('ping');
      }
    }, this.pingIntervalMs);
  }

  private clearPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Internal: Helpers ──

  private send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private parseFrame(data: WebSocket.Data): ServerFrame | null {
    try {
      return JSON.parse(data.toString()) as ServerFrame;
    } catch {
      this.logger.warn?.('Failed to parse frame:', data.toString().slice(0, 200));
      return null;
    }
  }

  private setState(next: ConnectionState): void {
    if (this.state !== next) {
      this.state = next;
      this.onStateChange?.(next);
    }
  }
}
