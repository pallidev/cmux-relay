import WebSocket from 'ws';
import { encodeMessage, decodeMessage } from '@cmux-relay/shared';
import type { AgentOutgoing, RelayToAgent, ClientOutgoing, RelayToClient, EncryptedPayload } from '@cmux-relay/shared';
import { execFileSync } from 'node:child_process';
import type { AgentE2ECrypto } from './e2e-crypto.js';

type ClientDataHandler = (msg: ClientOutgoing) => void;

export class RelayConnection {
  private ws: WebSocket | null = null;
  private relayUrl: string;
  private apiToken: string | null;
  private sessionId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onClientDataCb: ClientDataHandler | null = null;
  private onClientConnectedCb: (() => void) | null = null;
  private onClientDisconnectedCb: (() => void) | null = null;
  private isConnecting = false;
  private intentionallyClosed = false;
  private onTokenCb: ((token: string) => void) | null = null;
  private e2e: AgentE2ECrypto | null;

  constructor(relayUrl: string, apiToken?: string, e2e?: AgentE2ECrypto) {
    this.relayUrl = relayUrl;
    this.apiToken = apiToken || null;
    this.e2e = e2e || null;
  }

  onToken(handler: (token: string) => void): void {
    this.onTokenCb = handler;
  }

  connect(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.isConnecting) return;
      this.isConnecting = true;

      const url = this.apiToken
        ? `${this.relayUrl}?token=${encodeURIComponent(this.apiToken)}`
        : this.relayUrl;
      const ws = new WebSocket(url);

      ws.on('open', () => {
        console.log('[agent] Connected to relay server');
        if (this.apiToken) {
          ws.send(encodeMessage({ type: 'agent.register' }));
        } else {
          ws.send(encodeMessage({ type: 'agent.pair' }));
        }
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
        } else if (msg.type === 'pairing.wait') {
          console.log(`\n  Open this URL to link your agent:\n`);
          console.log(`    ${msg.url}\n`);
          console.log(`  Waiting for approval...`);
          openUrl(msg.url);
        } else if (msg.type === 'pairing.approved') {
          console.log(`[agent] Pairing approved! Token received.`);
          this.apiToken = msg.token;
          this.onTokenCb?.(msg.token);
          // Reconnect with the new token
          ws.close();
          this.isConnecting = false;
          this.reconnectWithToken().then(resolve, reject);
        } else if (msg.type === 'pairing.rejected') {
          console.error(`[agent] Pairing rejected: ${msg.reason}`);
          ws.close();
          this.isConnecting = false;
          reject(new Error(msg.reason));
        } else if (msg.type === 'client.data') {
          this.handleIncomingClientData(msg.payload);
        } else if (msg.type === 'client.connected') {
          console.log('[agent] Client connected via relay');
          this.onClientConnectedCb?.();
        } else if (msg.type === 'client.disconnected') {
          console.log('[agent] Client disconnected from relay');
          this.onClientDisconnectedCb?.();
        }
      });

      ws.on('close', (code, reason) => {
        if (this.intentionallyClosed) return;
        if (!this.sessionId) return;
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

  private async handleIncomingClientData(msg: ClientOutgoing): Promise<void> {
    if (msg.type === 'e2e.init') {
      if (!this.e2e?.hasKeys()) return;
      try {
        const ack = await this.e2e.handleE2EInit(msg.publicKey);
        this.sendRaw(ack);
      } catch (err) {
        console.error('[agent] E2E handshake failed:', err);
      }
      return;
    }

    if (msg.type === 'input') {
      const payload = msg.payload;
      if ('encrypted' in payload && payload.encrypted) {
        if (!this.e2e?.isReady()) return;
        try {
          const decrypted = await this.e2e.decryptInput(payload as EncryptedPayload);
          this.onClientDataCb?.({
            type: 'input',
            surfaceId: msg.surfaceId,
            payload: { data: decrypted },
          });
          return;
        } catch (err) {
          console.error('[agent] E2E decrypt failed:', err);
          return;
        }
      }
    }

    this.onClientDataCb?.(msg);
  }

  async send(payload: RelayToClient): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (payload.type === 'output' && this.e2e?.isReady()) {
      const encryptedPayload = await this.e2e.encryptOutput(payload.payload.data);
      this.sendRaw({
        type: 'output',
        surfaceId: payload.surfaceId,
        payload: encryptedPayload,
      } as RelayToClient);
      return;
    }

    this.sendRaw(payload);
  }

  private sendRaw(payload: RelayToClient): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeMessage({ type: 'agent.data', payload }));
    }
  }

  private async reconnectWithToken(): Promise<string> {
    this.isConnecting = true;
    const url = `${this.relayUrl}?token=${encodeURIComponent(this.apiToken!)}`;
    const ws = new WebSocket(url);

    return new Promise((resolve, reject) => {
      ws.on('open', () => {
        ws.send(encodeMessage({ type: 'agent.register' }));
      });

      ws.on('message', (raw) => {
        const data = typeof raw === 'string' ? raw : raw.toString('utf-8');
        const msg = decodeMessage<RelayToAgent>(data);

        if (msg.type === 'session.created') {
          this.sessionId = msg.sessionId;
          this.ws = ws;
          this.isConnecting = false;
          this.startHeartbeat();
          this.setupMessageHandlers(ws);
          resolve(msg.sessionId);
        }
      });

      ws.on('error', (err) => {
        this.isConnecting = false;
        reject(err);
      });
    });
  }

  private setupMessageHandlers(ws: WebSocket): void {
    ws.on('message', (raw) => {
      const data = typeof raw === 'string' ? raw : raw.toString('utf-8');
      const msg = decodeMessage<RelayToAgent>(data);

      if (msg.type === 'client.data') {
        this.handleIncomingClientData(msg.payload);
      } else if (msg.type === 'client.connected') {
        console.log('[agent] Client connected via relay');
        this.onClientConnectedCb?.();
      } else if (msg.type === 'client.disconnected') {
        console.log('[agent] Client disconnected from relay');
        this.onClientDisconnectedCb?.();
      }
    });
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
    this.intentionallyClosed = true;
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

function openUrl(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
    execFileSync(cmd, args, { stdio: 'ignore' });
  } catch {
    // Browser open failed, user can copy the URL manually
  }
}
