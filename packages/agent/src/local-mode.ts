import { CmuxClient } from './cmux-client.js';
import { PtyCapture } from './pty-capture.js';
import { InputHandler } from './input-handler.js';
import { SessionStore } from './session-store.js';
import { AcpManager } from './acp-manager.js';
import { createWSServer } from './ws-server.js';
import { SyncEngine } from './sync-engine.js';
import type { Broadcaster } from './sync-engine.js';
import type { ServerDeps } from './ws-server.js';
import { ensureSingleInstance, cleanupPidFile } from './process-manager.js';
import { loadTlsOptions } from './cli.js';
import type { CliOptions } from './cli.js';
import type { AcpAgentConfig } from '@cmux-relay/shared';

/**
 * Retry connecting to cmux with exponential backoff.
 */
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
    } catch (err: unknown) {
      console.error(`[cmux] Connection failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`[cmux] Make sure cmux (Ghostty) is running. Retrying in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
      cmux.disconnect();
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}

/**
 * Run the agent in local mode (LAN WebSocket server).
 */
export async function runLocalMode(opts: CliOptions): Promise<void> {
  const pidFile = await ensureSingleInstance();
  console.log('cmux-relay agent starting (local mode)...');
  console.log(`  cmux socket: ${opts.cmuxSocket || process.env.CMUX_SOCKET_PATH || `${process.env.HOME}/Library/Application Support/cmux/cmux.sock`}`);
  console.log(`  listening: ${opts.host}:${opts.port}`);

  // Register early exit handler so Ctrl+C works during startup too
  process.on('SIGINT', () => {
    cleanupPidFile(pidFile).catch(() => {});
    process.exit(0);
  });

  const store = new SessionStore();
  const deps: ServerDeps = {
    store,
    inputHandler: {
      handleInput: () => Promise.resolve(),
      handleResize: () => Promise.resolve(),
    },
  };

  const cmux = new CmuxClient(opts.cmuxSocket || undefined);
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

  const localBroadcaster: Broadcaster = {
    broadcast: (msg) => store.broadcastToClients(msg),
    sendToSurface: (surfaceId, msg) => store.sendToClientsWithSurface(surfaceId, msg),
  };

  const syncEngine = new SyncEngine(cmux, store, localBroadcaster);

  await syncEngine.syncAll();
  await syncEngine.pollNotifications();

  const wss = await createWSServer(opts.port, opts.host, deps, await loadTlsOptions(opts.tlsCert, opts.tlsKey), true);

  syncEngine.startPeriodicSync(5000);

  // Track which surface is handled by PTY capture (skip cmux polling for it)
  let ptySurfaceId: string | null = null;

  const getFirstTerminalSurfaceId = (): string | null => {
    for (const [id, surf] of store.getAllSurfaces()) {
      if (surf.type === 'terminal') return id;
    }
    return null;
  };

  const ptyCapture = new PtyCapture((chunk) => {
    const surfaceId = getFirstTerminalSurfaceId();
    if (!surfaceId) return;
    ptySurfaceId = surfaceId;
    const data = chunk.toString('base64');
    localBroadcaster.sendToSurface(surfaceId, {
      type: 'output',
      surfaceId,
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

  syncEngine.startPollTerminal(1000, {
    getActiveSurfaceIds: () => store.getActiveSurfaceIds(),
    getPtySurfaceId: () => ptySurfaceId,
  });
  syncEngine.startPollNotifications(2000);

  // Initialize ACP agent if configured
  let acpManager: AcpManager | undefined;
  if (opts.acpCommand) {
    const acpConfig: AcpAgentConfig = {
      command: opts.acpCommand,
      args: opts.acpArgs,
      name: opts.acpName,
    };
    acpManager = new AcpManager(acpConfig, (msg) => {
      localBroadcaster.broadcast(msg);
    });
    deps.acpManager = acpManager;
    await acpManager.initialize();
    console.log(`[acp] Agent ready: ${opts.acpName || opts.acpCommand}`);
  }

  // Replace early handler with full cleanup handler
  const shutdown = () => {
    console.log('\nShutting down...');
    acpManager?.dispose();
    syncEngine.stop();
    ptyCapture.stop();
    wss.close();
    cmux.disconnect();
    cleanupPidFile(pidFile).catch(() => {});
    process.exit(0);
  };

  process.removeAllListeners('SIGINT');
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
