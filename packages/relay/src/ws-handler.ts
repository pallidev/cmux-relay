import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SessionRegistry } from './session-registry.js';
import type { PairingRegistry } from './pairing-registry.js';
import { validateApiToken } from './db.js';
import { verifySessionJwt } from './auth.js';
import { encodeMessage, decodeMessage } from '@cmux-relay/shared';
import type { AgentOutgoing } from '@cmux-relay/shared';
import type Database from 'better-sqlite3';

export function createWsHandler(
  db: Database.Database,
  registry: SessionRegistry,
  pairing: PairingRegistry,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage, type: 'agent' | 'client', params: URLSearchParams) => {
    if (type === 'agent') {
      handleAgentConnection(ws, req, db, registry, pairing, params);
    } else {
      handleClientConnection(ws, req, db, registry, params);
    }
  });

  return wss;
}

function handleAgentConnection(
  ws: WebSocket,
  _req: IncomingMessage,
  db: Database.Database,
  registry: SessionRegistry,
  pairing: PairingRegistry,
  params: URLSearchParams,
): void {
  const token = params.get('token');

  if (token) {
    // Existing token — register agent
    const user = validateApiToken(db, token);
    if (!user) {
      ws.close(1008, 'Invalid token');
      return;
    }
    registry.registerAgent(user.id, ws);
    setupAgentHandlers(ws, registry, pairing);
  } else {
    // No token — wait for pairing message
    ws.on('message', (raw) => {
      const data = typeof raw === 'string' ? raw : raw.toString('utf-8');
      const msg = decodeMessage<AgentOutgoing>(data);

      if (msg.type === 'agent.pair') {
        const { code, url } = pairing.createPairing(ws);
        ws.send(encodeMessage({ type: 'pairing.wait', code, url }));
        // Keep connection open, wait for approval via HTTP
        setupAgentHandlers(ws, registry, pairing);
      } else if (msg.type === 'agent.register') {
        ws.close(1008, 'Token required for registration');
      }
    });
  }
}

function setupAgentHandlers(ws: WebSocket, registry: SessionRegistry, pairing: PairingRegistry): void {
  ws.on('message', (raw) => {
    const data = typeof raw === 'string' ? raw : raw.toString('utf-8');
    registry.handleAgentMessage(ws, data);
  });

  ws.on('close', () => {
    registry.disconnectAgent(ws);
    pairing.removeByWs(ws);
  });

  ws.on('error', (err) => {
    console.error(`[relay] Agent WS error:`, err.message);
    registry.disconnectAgent(ws);
    pairing.removeByWs(ws);
  });
}

function handleClientConnection(
  ws: WebSocket,
  _req: IncomingMessage,
  _db: Database.Database,
  registry: SessionRegistry,
  params: URLSearchParams,
): void {
  const sessionId = params.get('session');
  if (!sessionId) {
    ws.close(1008, 'Missing session ID');
    return;
  }

  const jwtToken = params.get('token');
  if (jwtToken) {
    verifySessionJwt(jwtToken).then((user) => {
      if (!user) {
        ws.close(1008, 'Invalid auth token');
        return;
      }
      connectClientToSession(ws, registry, sessionId);
    });
    return;
  }

  connectClientToSession(ws, registry, sessionId);
}

function connectClientToSession(ws: WebSocket, registry: SessionRegistry, sessionId: string): void {
  const connected = registry.connectClient(sessionId, ws);
  if (!connected) {
    ws.close(1008, `Session ${sessionId} not found`);
    return;
  }

  ws.on('message', (raw) => {
    const data = typeof raw === 'string' ? raw : raw.toString('utf-8');
    registry.handleClientMessage(ws, data);
  });

  ws.on('close', () => {
    registry.disconnectClient(ws);
  });

  ws.on('error', (err) => {
    console.error(`[relay] Client WS error:`, err.message);
    registry.disconnectClient(ws);
  });
}

export function handleUpgrade(
  req: IncomingMessage,
  db: Database.Database,
  registry: SessionRegistry,
  pairing: PairingRegistry,
  wss: WebSocketServer,
  callback: (ws: WebSocket) => void,
): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === '/ws/agent') {
    wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
      wss.emit('connection', ws, req, 'agent', url.searchParams);
      callback(ws);
    });
  } else if (path === '/ws/client') {
    wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
      wss.emit('connection', ws, req, 'client', url.searchParams);
      callback(ws);
    });
  } else {
    req.socket.destroy();
  }
}
