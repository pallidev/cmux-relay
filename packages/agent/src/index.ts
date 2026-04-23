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
import { execFileSync } from 'node:child_process';

function openUrl(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
    execFileSync(cmd, args, { stdio: 'ignore' });
  } catch {}
}
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const isLocal = args.includes('--local');
const port = parseInt(getArg('--port') || process.env.CMUX_RELAY_PORT || '8080', 10);
const host = getArg('--host') || process.env.CMUX_RELAY_HOST || '0.0.0.0';
const cmuxSocket = getArg('--socket') || '';
const tlsCert = getArg('--tls-cert') || process.env.CMUX_RELAY_TLS_CERT || '';
const tlsKey = getArg('--tls-key') || process.env.CMUX_RELAY_TLS_KEY || '';
const apiToken = getArg('--token') || process.env.CMUX_RELAY_TOKEN || '';
const relayUrl = getArg('--relay-url') || process.env.CMUX_RELAY_URL || 'wss://relay.gateway.myaddr.io/ws/agent';

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
    const out = execFileSync(
      'pgrep', ['-f', 'cmux-relay.*(tsx|src/index)'],
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
  } catch {
    // pgrep not available or no matches
  }

  try {
    execFileSync('pkill', ['-f', 'cat /var/folders.*cmux-relay'], { stdio: 'ignore' });
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

  if (isLocal) {
    await runLocalMode();
  } else {
    await runCloudMode(savedAuth);
  }
}

async function runLocalMode() {
  await ensureSingleInstance();
  console.log('cmux-relay agent starting (local mode)...');
  console.log(`  cmux socket: ${cmuxSocket || process.env.CMUX_SOCKET_PATH || `${process.env.HOME}/Library/Application Support/cmux/cmux.sock`}`);
  console.log(`  listening: ${host}:${port}`);

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
        store.broadcastToClients({
          type: 'surfaces',
          workspaceId: w.id,
          payload: { surfaces: surfInfos },
        });
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

  const wss = await createWSServer(port, host, deps, await loadTlsOptions(), true);

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
  let pollRunning = false;
  const pollTerminal = async () => {
    if (pollRunning) return;
    pollRunning = true;
    try {
      if (!cmux.isConnected()) return;
      const activeIds = store.getActiveSurfaceIds();
      if (activeIds.size === 0) return;
      for (const surfaceId of activeIds) {
        const surface = store.getSurface(surfaceId);
        if (surface?.type === 'terminal') {
          const text = await cmux.readTerminalText(surfaceId);
          if (text) {
            const b64 = Buffer.from(text).toString('base64');
            if (lastOutput.get(surfaceId) !== b64) {
              lastOutput.set(surfaceId, b64);
              store.sendToClientsWithSurface(surfaceId, {
                type: 'output',
                surfaceId,
                payload: { data: b64 },
              });
            }
          }
        }
      }
    } catch {
      // ignore polling errors
    } finally {
      pollRunning = false;
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
  console.log(`  cmux socket: ${cmuxSocket || process.env.CMUX_SOCKET_PATH || `${process.env.HOME}/Library/Application Support/cmux/cmux.sock`}`);
  console.log(`  relay: ${relayUrl}`);
  console.log(`  auth: ${apiToken ? 'API token' : savedAuth ? 'saved token' : 'none (pairing required)'}`);

  const store = new SessionStore();
  const cmux = new CmuxClient(cmuxSocket || undefined);
  const inputHandler = new InputHandler(cmux);

  const msgDeps: MessageHandlerDeps = {
    store,
    inputHandler,
    cmux: undefined,
  };

  console.log('Connecting to cmux...');
  await connectWithRetry(cmux);
  msgDeps.cmux = cmux;
  console.log('cmux connected!');

  const token = apiToken || savedAuth?.token || undefined;
  const url = relayUrl || savedAuth?.relayUrl || 'wss://relay.gateway.myaddr.io/ws/agent';

  console.log('Connecting to relay server...');
  const relay = new RelayConnection(url, token);

  if (!token) {
    relay.onToken(async (newToken) => {
      await saveAuth(newToken, url);
    });
  }

  let cloudActiveSurfaceId: string | null = null;
  const lastOutput = new Map<string, string>();

  relay.onClientData(async (msg) => {
    const clientId = 'cloud-client';
    await handleClientMessage(
      JSON.stringify(msg),
      clientId,
      msgDeps,
      (response) => {
        relay.send(response);
        if ((response as any).type === 'surface.active') {
          cloudActiveSurfaceId = (response as any).surfaceId;
        }
        if ((response as any).type === 'output') {
          lastOutput.set((response as any).surfaceId, (response as any).payload.data);
        }
      },
    );
  });

  const sessionId = await relay.connect();
  const webUrl = process.env.CMUX_WEB_URL || 'https://cmux.gateway.myaddr.io';
  const sessionUrl = `${webUrl}/s/${sessionId}`;
  console.log(`\n  Session ready: ${sessionUrl}\n`);
  openUrl(webUrl);

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
        broadcastViaRelay({
          type: 'surfaces',
          workspaceId: w.id,
          payload: { surfaces: surfInfos },
        });
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

  let pollRunning = false;
  const pollTerminal = async () => {
    if (pollRunning) return;
    pollRunning = true;
    try {
      if (!cmux.isConnected()) return;
      const activeSurface = cloudActiveSurfaceId;
      if (!activeSurface) return;
      const text = await cmux.readTerminalText(activeSurface);
      if (text) {
        const b64 = Buffer.from(text).toString('base64');
        if (lastOutput.get(activeSurface) !== b64) {
          lastOutput.set(activeSurface, b64);
          broadcastViaRelay({ type: 'output', surfaceId: activeSurface, payload: { data: b64 } });
        }
      }
    } catch {
      // ignore
    } finally {
      pollRunning = false;
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
  let attempt = 0;

  while (true) {
    attempt++;
    try {
      if (attempt > 1) console.log(`[cmux] Connection attempt ${attempt}...`);
      await cmux.connect();
      console.log(`[cmux] Connected successfully`);
      return;
    } catch (err: any) {
      console.error(`[cmux] Connection failed: ${err.message}`);
      console.log(`[cmux] Make sure cmux (Ghostty) is running. Retrying in ${delay / 1000}s...`);
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
