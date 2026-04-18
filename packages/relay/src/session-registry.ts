import type { WebSocket } from 'ws';
import type { AgentOutgoing, RelayToAgent, ClientOutgoing, RelayToClient } from '@cmux-relay/shared';
import { encodeMessage, decodeMessage } from '@cmux-relay/shared';
import { randomBytes } from 'node:crypto';

interface ActiveSession {
  sessionId: string;
  userId: string;
  agentWs: WebSocket;
  clientConnections: Set<WebSocket>;
}

export class SessionRegistry {
  private sessions = new Map<string, ActiveSession>();
  private agentMap = new Map<WebSocket, string>();

  registerAgent(userId: string, ws: WebSocket): string {
    const sessionId = randomBytes(8).toString('hex');

    const session: ActiveSession = {
      sessionId,
      userId,
      agentWs: ws,
      clientConnections: new Set(),
    };

    this.sessions.set(sessionId, session);
    this.agentMap.set(ws, sessionId);

    ws.send(encodeMessage({ type: 'session.created', sessionId }));
    console.log(`[relay] Agent registered: session=${sessionId} user=${userId}`);
    return sessionId;
  }

  connectClient(sessionId: string, ws: WebSocket): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.clientConnections.add(ws);
    session.agentWs.send(encodeMessage({ type: 'client.connected' }));
    console.log(`[relay] Client connected to session=${sessionId}`);
    return true;
  }

  disconnectClient(ws: WebSocket): void {
    for (const [, session] of this.sessions) {
      if (session.clientConnections.delete(ws)) {
        if (session.agentWs.readyState === ws.OPEN) {
          session.agentWs.send(encodeMessage({ type: 'client.disconnected' }));
        }
        console.log(`[relay] Client disconnected from session=${session.sessionId}`);
        break;
      }
    }
  }

  disconnectAgent(ws: WebSocket): void {
    const sessionId = this.agentMap.get(ws);
    if (!sessionId) return;

    const session = this.sessions.get(sessionId);
    if (session) {
      for (const clientWs of session.clientConnections) {
        clientWs.close(1011, 'Agent disconnected');
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
      for (const clientWs of session.clientConnections) {
        if (clientWs.readyState === ws.OPEN) {
          clientWs.send(payload);
        }
      }
    } else if (msg.type === 'agent.heartbeat') {
      // no-op, connection liveness is tracked by ws
    }
  }

  handleClientMessage(ws: WebSocket, rawData: string): void {
    for (const [, session] of this.sessions) {
      if (session.clientConnections.has(ws)) {
        const clientMsg = decodeMessage<ClientOutgoing>(rawData);
        const relayMsg: RelayToAgent = { type: 'client.data', payload: clientMsg };
        if (session.agentWs.readyState === ws.OPEN) {
          session.agentWs.send(encodeMessage(relayMsg));
        }
        return;
      }
    }
    ws.close(1008, 'Session not found');
  }

  getSessionsForUser(userId: string): { sessionId: string; clientCount: number }[] {
    const result: { sessionId: string; clientCount: number }[] = [];
    for (const [, session] of this.sessions) {
      if (session.userId === userId) {
        result.push({ sessionId: session.sessionId, clientCount: session.clientConnections.size });
      }
    }
    return result;
  }
}
