import { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type Database from 'better-sqlite3';
import type { AgentOutgoing, RelayToAgent, ClientOutgoing, RelayToClient } from '@cmux-relay/shared';
import { encodeMessage, decodeMessage } from '@cmux-relay/shared';
import { randomBytes } from 'node:crypto';
import { sendPushToUser } from './push-sender.js';

interface ClientInfo {
  ws: WebSocket;
  clientId: string;
  ip: string;
  userAgent: string;
}

interface ActiveSession {
  sessionId: string;
  userId: string;
  agentWs: WebSocket;
  clients: ClientInfo[];
  connectedAt: number;
}

export class SessionRegistry {
  private sessions = new Map<string, ActiveSession>();
  private agentMap = new Map<WebSocket, string>();
  private clientMap = new Map<WebSocket, string>();
  private db: Database.Database | null = null;

  setDatabase(db: Database.Database): void {
    this.db = db;
  }

  registerAgent(userId: string, ws: WebSocket): string {
    const sessionId = randomBytes(8).toString('hex');

    const session: ActiveSession = {
      sessionId,
      userId,
      agentWs: ws,
      clients: [],
      connectedAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    this.agentMap.set(ws, sessionId);

    ws.send(encodeMessage({ type: 'session.created', sessionId }));
    console.log(`[relay] Agent registered: session=${sessionId} user=${userId}`);
    return sessionId;
  }

  connectClient(sessionId: string, ws: WebSocket, req: IncomingMessage): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
      || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    const clientId = randomBytes(4).toString('hex');

    session.clients.push({ ws, clientId, ip, userAgent });
    this.clientMap.set(ws, sessionId);
    session.agentWs.send(encodeMessage({ type: 'client.connected', clientId }));
    console.log(`[relay] Client connected to session=${sessionId} client=${clientId} ip=${ip}`);
    return true;
  }

  disconnectClient(ws: WebSocket): void {
    const sessionId = this.clientMap.get(ws);
    if (!sessionId) return;

    const session = this.sessions.get(sessionId);
    if (session) {
      const idx = session.clients.findIndex(c => c.ws === ws);
      const clientId = idx >= 0 ? session.clients[idx].clientId : 'unknown';
      if (idx >= 0) session.clients.splice(idx, 1);
      if (session.agentWs.readyState === WebSocket.OPEN) {
        session.agentWs.send(encodeMessage({ type: 'client.disconnected', clientId }));
      }
    }
    this.clientMap.delete(ws);
    console.log(`[relay] Client disconnected from session=${sessionId}`);
  }

  disconnectAgent(ws: WebSocket): void {
    const sessionId = this.agentMap.get(ws);
    if (!sessionId) return;

    const session = this.sessions.get(sessionId);
    if (session) {
      for (const client of session.clients) {
        client.ws.close(1011, 'Agent disconnected');
      }
      this.sessions.delete(sessionId);
    }
    this.agentMap.delete(ws);
    console.log(`[relay] Agent disconnected: session=${sessionId}`);
  }

  handleAgentMessage(ws: WebSocket, rawData: string): void {
    const sessionId = this.agentMap.get(ws);
    if (!sessionId) return;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    const msg = decodeMessage<AgentOutgoing>(rawData);

    if (msg.type === 'agent.data') {
      const payload = JSON.stringify(msg.payload);

      if (msg.targetClient) {
        const client = session.clients.find(c => c.clientId === msg.targetClient && c.ws.readyState === WebSocket.OPEN);
        if (client) {
          client.ws.send(payload);
        }
      } else {
        const clientCount = session.clients.filter(c => c.ws.readyState === WebSocket.OPEN).length;
        console.log(`[relay] Forwarding ${(msg.payload as any).type} to ${clientCount} clients (session=${sessionId})`);
        for (const client of session.clients) {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(payload);
          }
        }

        // Send push notifications for notifications (always, for mobile PWA background delivery)
        if (this.db && (msg.payload as any).type === 'notifications') {
          const notifs = (msg.payload as any).payload?.notifications as Array<{ title: string; subtitle: string; body: string; workspaceId?: string; surfaceId?: string }>;
          if (notifs && notifs.length > 0) {
            for (const n of notifs) {
              sendPushToUser(this.db, session.userId, {
                title: n.title,
                body: n.subtitle ? `${n.subtitle}: ${n.body}` : n.body,
                workspaceId: n.workspaceId,
                surfaceId: n.surfaceId,
              });
            }
          }
        }
      }
    } else if (msg.type === 'agent.heartbeat') {
      // no-op
    }
  }

  handleClientMessage(ws: WebSocket, rawData: string): void {
    const sessionId = this.clientMap.get(ws);
    if (!sessionId) return;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    const client = session.clients.find(c => c.ws === ws);
    if (!client) return;

    const clientMsg = decodeMessage<ClientOutgoing>(rawData);
    const relayMsg: RelayToAgent = { type: 'client.data', payload: clientMsg, clientId: client.clientId };
    if (session.agentWs.readyState === WebSocket.OPEN) {
      session.agentWs.send(encodeMessage(relayMsg));
    }
  }

  getSessionsForUser(userId: string) {
    const result: {
      sessionId: string;
      connectedAt: number;
      viewers: { ip: string; userAgent: string }[];
    }[] = [];
    for (const [, session] of this.sessions) {
      if (session.userId === userId) {
        result.push({
          sessionId: session.sessionId,
          connectedAt: session.connectedAt,
          viewers: session.clients.map(c => ({ ip: c.ip, userAgent: c.userAgent })),
        });
      }
    }
    return result;
  }
}
