import WebSocket from 'ws';
import { encodeMessage, decodeMessage } from '@cmux-relay/shared';
import type { AgentOutgoing, RelayToAgent, ClientOutgoing, RelayToClient } from '@cmux-relay/shared';

type ClientDataHandler = (msg: ClientOutgoing) => void;

export class RelayConnection {
  private ws: WebSocket | null = null;
  private relayUrl: string;
  private apiToken: string;
  private sessionId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onClientDataCb: ClientDataHandler | null = null;
  private onClientConnectedCb: (() => void) | null = null;
  private onClientDisconnectedCb: (() => void) | null = null;
  private isConnecting = false;

  constructor(relayUrl: string, apiToken: string) {
    this.relayUrl = relayUrl;
    this.apiToken = apiToken;
  }

  connect(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.isConnecting) return;
      this.isConnecting = true;

      const url = `${this.relayUrl}?token=${encodeURIComponent(this.apiToken)}`;
      const ws = new WebSocket(url);

      ws.on('open', () => {
        console.log('[agent] Connected to relay server');
        ws.send(encodeMessage({ type: 'agent.register' }));
      });

      ws.on('message', (raw) => {
        const data = typeof raw === 'string' ? raw : raw.toString('utf-8');
        const msg = decodeMessage<RelayToAgent>(data);

        if (msg.type === 'session.created') {
          this.sessionId = msg.sessionId;
          this.isConnecting = false;
          this.ws = ws;
          this.startHeartbeat();
          resolve(msg.sessionId);
        } else if (msg.type === 'client.data') {
          this.onClientDataCb?.(msg.payload);
        } else if (msg.type === 'client.connected') {
          console.log('[agent] Client connected via relay');
          this.onClientConnectedCb?.();
        } else if (msg.type === 'client.disconnected') {
          console.log('[agent] Client disconnected from relay');
          this.onClientDisconnectedCb?.();
        }
      });

      ws.on('close', (code, reason) => {
        console.log(`[agent] Relay connection closed: ${code} ${reason}`);
        this.cleanup();
        this.scheduleReconnect();
      });

      ws.on('error', (err) => {
        console.error(`[agent] Relay connection error: ${err.message}`);
        this.cleanup();
        if (this.isConnecting) {
          this.isConnecting = false;
          reject(err);
        } else {
          this.scheduleReconnect();
        }
      });
    });
  }

  send(payload: RelayToClient): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeMessage({ type: 'agent.data', payload }));
    }
  }

  onClientData(handler: ClientDataHandler): void {
    this.onClientDataCb = handler;
  }

  onClientConnected(handler: () => void): void {
    this.onClientConnectedCb = handler;
  }

  onClientDisconnected(handler: () => void): void {
    this.onClientDisconnectedCb = handler;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(encodeMessage({ type: 'agent.heartbeat' }));
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private cleanup(): void {
    this.stopHeartbeat();
    this.ws = null;
  }

  private reconnectDelay = 3000;

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    console.log(`[agent] Reconnecting to relay in ${this.reconnectDelay / 1000}s...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        this.reconnectDelay = 3000;
        console.log(`[agent] Reconnected to relay, session: ${this.sessionId}`);
      } catch {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }
}
