import { CmuxClient } from './cmux-client.js';
import { PtyCapture } from './pty-capture.js';
import { InputHandler } from './input-handler.js';
import { SessionStore } from './session-store.js';
import { createWSServer } from './ws-server.js';
import { RelayConnection } from './relay-connection.js';
import { handleClientMessage } from './message-handler.js';
import type { ServerDeps, TlsOptions } from './ws-server.js';
import type { MessageHandlerDeps } from './message-handler.js';
import type { WorkspaceInfo, SurfaceInfo, PaneInfo, RelayToClient } from '@cmux-relay/shared';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const port = parseInt(getArg('--port') || process.env.CMUX_RELAY_PORT || '8080', 10);
const host = getArg('--host') || process.env.CMUX_RELAY_HOST || '0.0.0.0';
const cmuxSocket = getArg('--socket') || '';
const tlsCert = getArg('--tls-cert') || process.env.CMUX_RELAY_TLS_CERT || '';
const tlsKey = getArg('--tls-key') || process.env.CMUX_RELAY_TLS_KEY || '';
const apiToken = getArg('--token') || process.env.CMUX_RELAY_TOKEN || '';
const relayUrl = getArg('--relay-url') || process.env.CMUX_RELAY_URL || '';

const AUTH_DIR = join(homedir(), '.cmux-relay');
const AUTH_FILE = join(AUTH_DIR, 'auth.json');

interface AuthData { token: string; relayUrl: string }

async function loadSavedAuth(): Promise<AuthData | null> {
  try {
    const data = await readFile(AUTH_FILE, 'utf-8');
    return JSON.parse(data) as AuthData;
  } catch { return null; }
}

async function saveAuth(token: string, url: string): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
  await writeFile(AUTH_FILE, JSON.stringify({ token, relayUrl: url }, null, 2), 'utf-8');
  console.log(`[agent] Token saved to ${AUTH_FILE}`);
}

function getArg(name: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && idx < args.length - 1 ? args[idx + 1] : '';
}

async function loadTlsOptions(): Promise<TlsOptions | undefined> {
  if (!tlsCert || !tlsKey) return undefined;
  try {
    const [cert, key] = await Promise.all([
      readFile(tlsCert, 'utf-8'),
      readFile(tlsKey, 'utf-8'),
    ]);
    console.log(`TLS enabled: cert=${tlsCert}`);
    return { cert, key };
  } catch (err: any) {
    console.error(`Failed to load TLS certs: ${err.message}`);
    return undefined;
  }
}

const PID_FILE = `${process.env.HOME}/.cmux-relay.pid`;

function killStaleProcesses(): void {
  try {
    const out = execSync(
      `pgrep -f "cmux-relay.*(tsx|src/index)" || true`,
      { encoding: 'utf-8' }
    ).trim();
    if (!out) return;

    const pids = out.split('\n').map(Number).filter(p => p && p !== process.pid);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`Killed stale process PID ${pid}`);
      } catch {
        // Already dead
      }
    }
    if (pids.length > 0) {
      execSync('sleep 1');
    }
  } catch {
    // pgrep not available or no matches
  }

  try {
    execSync(`pkill -f "cat /var/folders.*cmux-relay" 2>/dev/null || true`);
  } catch {
    // Ignore
  }
}

async function ensureSingleInstance(): Promise<void> {
  killStaleProcesses();

  if (!existsSync(PID_FILE)) {
    await writeFile(PID_FILE, `${process.pid}`);
    return;
  }

  const existingPid = parseInt(await readFile(PID_FILE, 'utf-8'), 10);
  if (isNaN(existingPid)) {
    await writeFile(PID_FILE, `${process.pid}`);
    return;
  }

  try {
    process.kill(existingPid, 0);
  } catch {
    await writeFile(PID_FILE, `${process.pid}`);
    return;
  }

  console.log(`Stopping existing instance (PID ${existingPid})...`);
  process.kill(existingPid, 'SIGTERM');
  await new Promise(r => setTimeout(r, 2000));

  try {
    process.kill(existingPid, 0);
    console.log(`Force killing PID ${existingPid}...`);
    process.kill(existingPid, 'SIGKILL');
    await new Promise(r => setTimeout(r, 500));
  } catch {
    // Good, it stopped
  }

  await writeFile(PID_FILE, `${process.pid}`);
}

async function main() {
  const savedAuth = await loadSavedAuth();
  const isCloudMode = !!apiToken || !!savedAuth;

  if (isCloudMode) {
    await runCloudMode(savedAuth);
  } else {
    await runLocalMode();
  }
}

async function runLocalMode() {
  await ensureSingleInstance();
  console.log('cmux-relay agent starting (local mode)...');

  const store = new SessionStore();
  const deps: ServerDeps = {
    store,
    inputHandler: {
      handleInput: () => Promise.resolve(),
      handleResize: () => Promise.resolve(),
    },
  };

  const cmux = new CmuxClient(cmuxSocket || undefined);
  const inputHandler = new InputHandler(cmux);
  deps.inputHandler = inputHandler;

  let isReconnecting = false;

  async function reconnect(): Promise<void> {
    if (isReconnecting) return;
    isReconnecting = true;
    try {
      await connectWithRetry(cmux);
      deps.cmux = cmux;
    } finally {
      isReconnecting = false;
    }
  }

  await connectWithRetry(cmux);
  deps.cmux = cmux;

  const syncAll = async () => {
    try {
      if (!cmux.isConnected()) {
        await reconnect();
      }

      const workspaces = await cmux.listWorkspaces();
      const wsInfos: WorkspaceInfo[] = workspaces.map(w => ({
        id: w.id,
        title: w.title,
      }));

      store.updateWorkspaces(wsInfos);

      for (const w of workspaces) {
        const surfaces = await cmux.listSurfaces(w.id);
        const surfInfos: SurfaceInfo[] = surfaces.map(s => ({
          id: s.id,
          title: s.title || '',
          type: s.type,
          workspaceId: w.id,
        }));
        store.updateSurfaces(w.id, surfInfos);
      }

      store.broadcastToClients({
        type: 'workspaces',
        payload: { workspaces: store.getAllWorkspaces() },
      });

      for (const w of workspaces) {
        try {
          const { panes, containerFrame } = await cmux.listPanes(w.id);
          const typedPanes: PaneInfo[] = panes.map(p => ({
            ...p,
            workspaceId: w.id,
          }));
          store.updatePanesForWorkspace(w.id, typedPanes, containerFrame);
          store.broadcastToClients({
            type: 'panes',
            workspaceId: w.id,
            payload: { panes: typedPanes, containerFrame },
          });
        } catch (err) {
          console.error(`Failed to sync panes for workspace ${w.id}:`, err);
        }
      }
    } catch (err) {
      console.error('Failed to sync:', err);
    }
  };

  await syncAll();

  const knownNotificationIds = new Set<string>();
  const pollNotifications = async () => {
    try {
      if (!cmux.isConnected()) return;
      const notifications = await cmux.listNotifications();
      const newNotifications = notifications.filter(n => !knownNotificationIds.has(n.id));

      knownNotificationIds.clear();
      for (const n of notifications) {
        knownNotificationIds.add(n.id);
      }

      if (newNotifications.length > 0) {
        console.log(`New cmux notifications: ${newNotifications.map(n => n.title).join(', ')}`);
      }

      store.updateNotifications(notifications);
      if (newNotifications.length > 0) {
        store.broadcastToClients({
          type: 'notifications',
          payload: { notifications: newNotifications },
        });
      }
    } catch {
      // ignore polling errors
    }
  };
  await pollNotifications();

  const wss = await createWSServer(port, host, deps, await loadTlsOptions());

  const syncInterval = setInterval(syncAll, 5000);

  const ptyCapture = new PtyCapture((chunk) => {
    const data = chunk.toString('base64');
    store.sendToClientsWithSurface('default', {
      type: 'output',
      surfaceId: 'default',
      payload: { data },
    });
  });

  try {
    const capturePath = await ptyCapture.start();
    console.log(`PTY capture ready: ${capturePath}`);
  } catch (err) {
    console.error('PTY capture setup failed:', err);
    console.log('Continuing without PTY capture (cmux socket API only)');
  }

  const lastOutput = new Map<string, string>();
  const pollTerminal = async () => {
    try {
      if (!cmux.isConnected()) return;
      const workspaces = await cmux.listWorkspaces();
      for (const w of workspaces) {
        const surfaces = await cmux.listSurfaces(w.id);
        for (const surf of surfaces) {
          if (surf.type === 'terminal') {
            const text = await cmux.readTerminalText(surf.id);
            if (text) {
              const b64 = Buffer.from(text).toString('base64');
              if (lastOutput.get(surf.id) !== b64) {
                lastOutput.set(surf.id, b64);
                store.broadcastToClients({
                  type: 'output',
                  surfaceId: surf.id,
                  payload: { data: b64 },
                });
              }
            }
          }
        }
      }
    } catch {
      // ignore polling errors
    }
  };
  const pollInterval = setInterval(pollTerminal, 1000);

  const notificationPollInterval = setInterval(pollNotifications, 2000);

  const shutdown = () => {
    console.log('\nShutting down...');
    clearInterval(syncInterval);
    clearInterval(pollInterval);
    clearInterval(notificationPollInterval);
    ptyCapture.stop();
    wss.close();
    cmux.disconnect();
    unlink(PID_FILE).catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runCloudMode(savedAuth: AuthData | null) {
  console.log('cmux-relay agent starting (cloud mode)...');

  const store = new SessionStore();
  const cmux = new CmuxClient(cmuxSocket || undefined);
  const inputHandler = new InputHandler(cmux);

  const msgDeps: MessageHandlerDeps = {
    store,
    inputHandler,
    cmux: undefined,
  };

  await connectWithRetry(cmux);
  msgDeps.cmux = cmux;

  const token = apiToken || savedAuth?.token || undefined;
  const url = relayUrl || savedAuth?.relayUrl || 'wss://relay.jaz.duckdns.org/ws/agent';

  const relay = new RelayConnection(url, token);

  if (!token) {
    relay.onToken(async (newToken) => {
      await saveAuth(newToken, url);
    });
  }

  relay.onClientData(async (msg) => {
    const clientId = 'cloud-client';
    await handleClientMessage(
      JSON.stringify(msg),
      clientId,
      msgDeps,
      (response) => relay.send(response),
    );
  });

  const sessionId = await relay.connect();
  const webUrl = process.env.CMUX_WEB_URL || 'https://cmux.jaz.duckdns.org';
  console.log(`\n  Session ready: ${webUrl}/s/${sessionId}\n`);

  // Broadcast via relay instead of direct WebSocket
  const broadcastViaRelay = (msg: RelayToClient) => {
    relay.send(msg);
  };

  const syncAll = async () => {
    try {
      if (!cmux.isConnected()) return;

      const workspaces = await cmux.listWorkspaces();
      const wsInfos: WorkspaceInfo[] = workspaces.map(w => ({
        id: w.id,
        title: w.title,
      }));
      store.updateWorkspaces(wsInfos);

      for (const w of workspaces) {
        const surfaces = await cmux.listSurfaces(w.id);
        const surfInfos: SurfaceInfo[] = surfaces.map(s => ({
          id: s.id,
          title: s.title || '',
          type: s.type,
          workspaceId: w.id,
        }));
        store.updateSurfaces(w.id, surfInfos);
      }

      broadcastViaRelay({ type: 'workspaces', payload: { workspaces: store.getAllWorkspaces() } });

      for (const w of workspaces) {
        try {
          const { panes, containerFrame } = await cmux.listPanes(w.id);
          const typedPanes: PaneInfo[] = panes.map(p => ({
            ...p,
            workspaceId: w.id,
          }));
          store.updatePanesForWorkspace(w.id, typedPanes, containerFrame);
          broadcastViaRelay({ type: 'panes', workspaceId: w.id, payload: { panes: typedPanes, containerFrame } });
        } catch (err) {
          console.error(`Failed to sync panes for workspace ${w.id}:`, err);
        }
      }
    } catch (err) {
      console.error('Failed to sync:', err);
    }
  };

  await syncAll();

  const knownNotificationIds = new Set<string>();
  const pollNotifications = async () => {
    try {
      if (!cmux.isConnected()) return;
      const notifications = await cmux.listNotifications();
      const newNotifications = notifications.filter(n => !knownNotificationIds.has(n.id));
      knownNotificationIds.clear();
      for (const n of notifications) knownNotificationIds.add(n.id);

      store.updateNotifications(notifications);
      if (newNotifications.length > 0) {
        broadcastViaRelay({ type: 'notifications', payload: { notifications: newNotifications } });
      }
    } catch {
      // ignore
    }
  };
  await pollNotifications();

  const syncInterval = setInterval(syncAll, 5000);
  const notificationPollInterval = setInterval(pollNotifications, 2000);

  const ptyCapture = new PtyCapture((chunk) => {
    const data = chunk.toString('base64');
    broadcastViaRelay({ type: 'output', surfaceId: 'default', payload: { data } });
  });

  try {
    const capturePath = await ptyCapture.start();
    console.log(`PTY capture ready: ${capturePath}`);
  } catch (err) {
    console.error('PTY capture setup failed:', err);
    console.log('Continuing without PTY capture (cmux socket API only)');
  }

  const lastOutput = new Map<string, string>();
  const pollTerminal = async () => {
    try {
      if (!cmux.isConnected()) return;
      const workspaces = await cmux.listWorkspaces();
      for (const w of workspaces) {
        const surfaces = await cmux.listSurfaces(w.id);
        for (const surf of surfaces) {
          if (surf.type === 'terminal') {
            const text = await cmux.readTerminalText(surf.id);
            if (text) {
              const b64 = Buffer.from(text).toString('base64');
              if (lastOutput.get(surf.id) !== b64) {
                lastOutput.set(surf.id, b64);
                broadcastViaRelay({ type: 'output', surfaceId: surf.id, payload: { data: b64 } });
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  };
  const pollInterval = setInterval(pollTerminal, 1000);

  const shutdown = () => {
    console.log('\nShutting down...');
    clearInterval(syncInterval);
    clearInterval(pollInterval);
    clearInterval(notificationPollInterval);
    ptyCapture.stop();
    relay.disconnect();
    cmux.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function connectWithRetry(cmux: CmuxClient): Promise<void> {
  let delay = 3000;
  const maxDelay = 30000;

  while (true) {
    try {
      await cmux.connect();
      return;
    } catch (err: any) {
      console.error(`cmux not available: ${err.message}`);
      console.log(`Retrying in ${delay / 1000}s... (start cmux to proceed)`);
      await new Promise((r) => setTimeout(r, delay));
      cmux.disconnect();
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
