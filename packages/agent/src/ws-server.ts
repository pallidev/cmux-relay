import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { SessionStore } from './session-store.js';
import { verifyToken, generateClientToken } from './auth.js';
import type { IInputHandler } from './input-handler.js';
import type { CmuxClient } from './cmux-client.js';
import {
  decodeMessage,
  type ClientOutgoing,
} from '@cmux-relay/shared';

export interface ServerDeps {
  store: SessionStore;
  inputHandler: IInputHandler;
  cmux?: CmuxClient;
}

export interface TlsOptions {
  cert: string;
  key: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function resolveWebDir(): string {
  // Check multiple possible locations for the built web files
  const metaDir = import.meta.dirname || '';
  const candidates = [
    metaDir ? join(metaDir, '../../web/dist') : '',     // monorepo: packages/web/dist
    metaDir ? join(metaDir, '../web') : '',              // bundled: server/web
    join(process.cwd(), 'web/dist'),                      // cwd relative
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return '';
}

export function createWSServer(
  port: number,
  host: string,
  deps: ServerDeps,
  tls?: TlsOptions,
  localMode = false,
): Promise<ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>> {
  return new Promise((resolve, reject) => {
    const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
      await handleHttpRequest(req, res, localMode);
    };

    const httpServer = tls
      ? createHttpsServer({ cert: tls.cert, key: tls.key }, requestHandler)
      : createHttpServer(requestHandler);

    const wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws) => {
      const clientId = randomUUID();
      deps.store.disconnectAllClients();
      deps.store.registerClient(clientId, ws);
      console.log(`Client connected: ${clientId}`);

      ws.on('message', (raw) => {
        const data = typeof raw === 'string' ? raw : raw.toString('utf-8');
        handleClientMessage(ws, clientId, data, deps);
      });

      ws.on('close', () => {
        deps.store.unregisterClient(clientId);
        console.log(`Client disconnected: ${clientId}`);
      });
    });

    httpServer.on('listening', () => {
      try {
        const protocol = tls ? 'https' : 'http';
        console.log(`cmux-relay server listening on ${protocol}://${host}:${port}`);
        console.log(`Client token: ${generateClientToken()}`);
        const webDir = resolveWebDir();
        if (webDir) {
          console.log(`Serving web UI from: ${webDir}`);
        } else {
          console.log(`Web UI not found. Build with: pnpm --filter web build`);
        }
      } catch (err) {
        console.error('Error in listening handler:', err);
      }
      resolve(httpServer);
    });

    httpServer.on('error', reject);
    httpServer.listen(port, host);
  });
}

const webDirCache: { value: string } = { value: '' };

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse, localMode: boolean): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;

  if (localMode && path === '/api/mode' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ mode: 'local' }));
    return;
  }

  if (localMode && path === '/api/local/auth' && req.method === 'POST') {
    const token = generateClientToken();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `relay_jwt=${token}; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`,
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (!webDirCache.value) {
    webDirCache.value = resolveWebDir();
  }
  const webDir = webDirCache.value;

  if (!webDir) {
    res.writeHead(404);
    res.end('Web UI not built. Run: pnpm --filter web build');
    return;
  }

  // Normalize URL path
  let urlPath = req.url?.split('?')[0] || '/';
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = join(webDir, urlPath);

  // Security: prevent directory traversal
  if (!filePath.startsWith(webDir)) {
    res.writeHead(403);
    res.end();
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      // SPA fallback: serve index.html for unknown routes
      const indexHtml = join(webDir, 'index.html');
      const content = await readFile(indexHtml);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
      return;
    }

    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    // SPA fallback: serve index.html for 404s
    try {
      const indexHtml = join(webDir, 'index.html');
      const content = await readFile(indexHtml);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }
}

async function handleClientMessage(
  ws: WebSocket,
  clientId: string,
  data: string,
  deps: ServerDeps,
): Promise<void> {
  let msg: ClientOutgoing;
  try {
    msg = decodeMessage<ClientOutgoing>(data);
  } catch {
    return;
  }

  if (msg.type === 'auth') {
    const decoded = verifyToken(msg.payload.token);
    if (!decoded) {
      send(ws, { type: 'error', payload: { message: 'Invalid token' } });
      ws.close(4001, 'Auth failed');
      return;
    }
    deps.store.authenticateClient(clientId);
    send(ws, { type: 'workspaces', payload: { workspaces: deps.store.getAllWorkspaces() } });
    // Send surfaces for each workspace
    for (const w of deps.store.getAllWorkspaces()) {
      send(ws, { type: 'surfaces', workspaceId: w.id, payload: { surfaces: deps.store.getSurfacesForWorkspace(w.id) } });
    }
    // Send pane layout per workspace
    for (const w of deps.store.getAllWorkspaces()) {
      const wsPanes = deps.store.getPanesForWorkspace(w.id);
      const containerFrame = deps.store.getContainerFrameForWorkspace(w.id);
      send(ws, { type: 'panes', workspaceId: w.id, payload: { panes: wsPanes, containerFrame } });
    }
    // Send current notifications
    const notifications = deps.store.getAllNotifications();
    console.log(`Sending ${notifications.length} notifications to client ${clientId}`);
    if (notifications.length > 0) {
      send(ws, { type: 'notifications', payload: { notifications } });
    }
    console.log(`Client ${clientId} authenticated`);
    return;
  }

  if (!deps.store.isClientAuthenticated(clientId)) {
    send(ws, { type: 'error', payload: { message: 'Not authenticated' } });
    return;
  }

  switch (msg.type) {
    case 'workspaces.list': {
      send(ws, { type: 'workspaces', payload: { workspaces: deps.store.getAllWorkspaces() } });
      break;
    }

    case 'surface.select': {
      const surface = deps.store.getSurface(msg.surfaceId);
      if (surface) {
        deps.store.setActiveSurface(clientId, msg.surfaceId, surface.workspaceId);
        send(ws, { type: 'surface.active', surfaceId: msg.surfaceId, workspaceId: surface.workspaceId });
        // Send surfaces for this workspace so the client knows siblings
        send(ws, {
          type: 'surfaces',
          workspaceId: surface.workspaceId,
          payload: { surfaces: deps.store.getSurfacesForWorkspace(surface.workspaceId) },
        });
        // Send current terminal content with scrollback history
        if (surface.type === 'terminal' && deps.cmux) {
          const text = await deps.cmux.readTerminalText(msg.surfaceId, true);
          if (text) {
            send(ws, {
              type: 'output',
              surfaceId: msg.surfaceId,
              payload: { data: Buffer.from(text).toString('base64') },
            });
          }
        }
      }
      break;
    }

    case 'input': {
      console.log(`Input for surface ${msg.surfaceId}: ${msg.payload.data?.length ?? 0} bytes`);
      await deps.inputHandler.handleInput(msg.surfaceId, msg.payload.data);
      // Immediately read and send updated screen after input
      if (deps.cmux) {
        const surface = deps.store.getSurface(msg.surfaceId);
        if (surface?.type === 'terminal') {
          await new Promise(r => setTimeout(r, 50));
          try {
            const text = await deps.cmux.readTerminalText(msg.surfaceId);
            if (text) {
              const b64 = Buffer.from(text).toString('base64');
              send(ws, {
                type: 'output',
                surfaceId: msg.surfaceId,
                payload: { data: b64 },
              });
            }
          } catch (err) {
            console.error('Failed to read terminal after input:', err);
          }
        }
      }
      break;
    }

    case 'resize': {
      deps.inputHandler.handleResize(msg.surfaceId, msg.payload.cols, msg.payload.rows);
      break;
    }
  }
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}
