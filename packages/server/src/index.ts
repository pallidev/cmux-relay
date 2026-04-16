import { CmuxClient } from './cmux-client.js';
import { PtyCapture } from './pty-capture.js';
import { InputHandler } from './input-handler.js';
import { SessionStore } from './session-store.js';
import { createWSServer } from './ws-server.js';
import type { ServerDeps, TlsOptions } from './ws-server.js';
import type { WorkspaceInfo, SurfaceInfo, PaneInfo, CmuxNotification } from '@cmux-relay/shared';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const port = parseInt(getArg('--port') || process.env.CMUX_RELAY_PORT || '8080', 10);
const host = getArg('--host') || process.env.CMUX_RELAY_HOST || '0.0.0.0';
const cmuxSocket = getArg('--socket') || '';
const tlsCert = getArg('--tls-cert') || process.env.CMUX_RELAY_TLS_CERT || '';
const tlsKey = getArg('--tls-key') || process.env.CMUX_RELAY_TLS_KEY || '';

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

async function ensureSingleInstance(): Promise<void> {
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
    process.kill(existingPid, 0); // Check if process is alive
  } catch {
    // Stale PID file — process is dead
    await writeFile(PID_FILE, `${process.pid}`);
    return;
  }

  console.log(`Stopping existing instance (PID ${existingPid})...`);
  process.kill(existingPid, 'SIGTERM');
  await new Promise(r => setTimeout(r, 2000));

  // Verify it stopped
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
  await ensureSingleInstance();
  console.log('cmux-relay server starting...');

  const store = new SessionStore();
  const deps: ServerDeps = {
    store,
    inputHandler: {
      handleInput: () => Promise.resolve(),
      handleResize: () => Promise.resolve(),
    },
  };

  // Connect to cmux BEFORE starting the server so store is populated
  const cmux = new CmuxClient(cmuxSocket || undefined);
  const inputHandler = new InputHandler(cmux);
  deps.inputHandler = inputHandler;

  await connectWithRetry(cmux);

  deps.cmux = cmux;

  // Sync workspaces + surfaces periodically
  const syncAll = async () => {
    try {
      if (!cmux.isConnected()) {
        console.log('Reconnecting to cmux...');
        await connectWithRetry(cmux);
        deps.cmux = cmux;
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

      // Sync pane layout for EACH workspace
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

  // Initial sync immediately after connecting
  await syncAll();

  // Initial notification poll BEFORE starting server so clients get data on auth
  const knownNotificationIds = new Set<string>();
  const pollNotifications = async () => {
    try {
      if (!cmux.isConnected()) return;
      const notifications = await cmux.listNotifications();
      const newNotifications = notifications.filter(n => !knownNotificationIds.has(n.id));

      // Update known set to current snapshot
      knownNotificationIds.clear();
      for (const n of notifications) {
        knownNotificationIds.add(n.id);
      }

      if (newNotifications.length > 0) {
        console.log(`New cmux notifications: ${newNotifications.map(n => n.title).join(', ')}`);
      }

      // Always update store so new clients get current notifications on auth
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

  // NOW start the server — store is fully populated
  const wss = await createWSServer(port, host, deps, await loadTlsOptions());

  const syncInterval = setInterval(syncAll, 5000);

  // PTY capture
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

  // Poll terminal text per surface (only send when changed)
  const lastOutput = new Map<string, string>();
  const pollTerminal = async () => {
    try {
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
  process.on('exit', () => clearInterval(pollInterval));

  // Start notification polling (initial poll already done above)
  const notificationPollInterval = setInterval(pollNotifications, 2000);
  process.on('exit', () => clearInterval(notificationPollInterval));

  // Graceful shutdown
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

async function connectWithRetry(cmux: CmuxClient): Promise<void> {
  while (true) {
    try {
      await cmux.connect();
      return;
    } catch (err: any) {
      console.error(`cmux not available: ${err.message}`);
      console.log('Retrying in 3s... (start cmux to proceed)');
      await new Promise((r) => setTimeout(r, 3000));
      cmux.disconnect();
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
