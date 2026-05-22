import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CmuxClient } from './cmux-client.js';
import { PtyCapture } from './pty-capture.js';
import { InputHandler } from './input-handler.js';
import { SessionStore } from './session-store.js';
import { AcpManager } from './acp-manager.js';
import { RelayConnection } from './relay-connection.js';
import { AgentE2ECrypto } from './e2e-crypto.js';
import { handleClientMessage } from './message-handler.js';
import { SyncEngine } from './sync-engine.js';
import type { Broadcaster } from './sync-engine.js';
import type { MessageHandlerDeps } from './message-handler.js';
import type { CliOptions } from './cli.js';
import type { AcpAgentConfig } from '@cmux-relay/shared';
import qrcode from 'qrcode-terminal';

const AUTH_DIR = join(homedir(), '.cmux-relay');
const AUTH_FILE = join(AUTH_DIR, 'auth.json');

export interface AuthData {
  token: string;
  relayUrl: string;
}

/**
 * Load previously saved auth data from disk.
 */
export async function loadSavedAuth(): Promise<AuthData | null> {
  try {
    const data = await readFile(AUTH_FILE, 'utf-8');
    return JSON.parse(data) as AuthData;
  } catch { return null; }
}

/**
 * Persist auth token and relay URL to disk.
 */
export async function saveAuth(token: string, url: string): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
  await writeFile(AUTH_FILE, JSON.stringify({ token, relayUrl: url }, null, 2), 'utf-8');
  console.log(`[agent] Token saved to ${AUTH_FILE}`);
}

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
 * Run the agent in cloud mode (relay server + optional P2P).
 */
export async function runCloudMode(opts: CliOptions, savedAuth: AuthData | null): Promise<void> {
  console.log('cmux-relay agent starting (cloud mode)...');
  console.log(`  cmux socket: ${opts.cmuxSocket || process.env.CMUX_SOCKET_PATH || `${process.env.HOME}/Library/Application Support/cmux/cmux.sock`}`);
  console.log(`  relay: ${opts.relayUrl}`);
  console.log(`  auth: ${opts.apiToken ? 'API token' : savedAuth ? 'saved token' : 'none (pairing required)'}`);

  // Register early exit handler so Ctrl+C works during startup too
  process.on('SIGINT', () => process.exit(0));

  const store = new SessionStore();
  const cmux = new CmuxClient(opts.cmuxSocket || undefined);
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

  const token = opts.apiToken || savedAuth?.token || undefined;
  const url = opts.relayUrl || savedAuth?.relayUrl || 'wss://relay.gateway.myaddr.io/ws/agent';

  const e2e = new AgentE2ECrypto();
  await e2e.initialize();
  console.log('[agent] E2E encryption initialized');

  console.log('Connecting to relay server...');
  const relay = new RelayConnection(url, token, e2e);

  if (!token) {
    relay.onToken(async (newToken) => {
      await saveAuth(newToken, url);
    });
  }

  let syncEngine: SyncEngine | undefined;

  relay.onClientConnected(() => {
    syncEngine?.clearLastOutput();
    syncEngine?.syncAll();
    acpManager?.resendState();
  });

  relay.onClientData(async (msg, clientId) => {
    await handleClientMessage(
      JSON.stringify(msg),
      clientId,
      msgDeps,
      (response) => {
        // Send response only to the requesting client
        relay.sendToClient(clientId, response);
      },
    );
  });

  const sessionId = await relay.connect();
  const webUrl = process.env.CMUX_WEB_URL || 'https://cmux.gateway.myaddr.io';
  const terminalUrl = `${webUrl}/terminal`;
  console.log(`\n  Session ready: ${terminalUrl}\n`);
  if (token) {
    qrcode.generate(terminalUrl, { small: true }, (qr: string) => {
      console.log('\n' + qr);
      console.log(`\n  Scan QR code or open: ${terminalUrl}\n`);
    });
  }

  const cloudBroadcaster: Broadcaster = {
    broadcast: (msg) => relay.send(msg),
    sendToSurface: (_surfaceId, msg) => relay.send(msg),
  };

  syncEngine = new SyncEngine(cmux, store, cloudBroadcaster, {
    hasClients: () => relay.hasClients(),
  });

  await syncEngine.syncAll();
  await syncEngine.pollNotifications();

  syncEngine.startPeriodicSync(5000);
  syncEngine.startPollNotifications(2000);

  // Initialize ACP agent if configured
  let acpManager: AcpManager | undefined;
  if (opts.acpCommand) {
    const acpConfig: AcpAgentConfig = {
      command: opts.acpCommand,
      args: opts.acpArgs,
      name: opts.acpName,
    };
    acpManager = new AcpManager(acpConfig, {
      broadcast: (msg) => cloudBroadcaster.broadcast(msg),
      sendToSurface: (_surfaceId, msg) => cloudBroadcaster.broadcast(msg),
    });
    msgDeps.acpManager = acpManager;
    await acpManager.initialize();
    console.log(`[acp] Agent ready: ${opts.acpName || opts.acpCommand}`);
  }

  let cloudPtySurfaceId: string | null = null;

  const getFirstTerminalSurfaceId = (): string | null => {
    for (const [id, surf] of store.getAllSurfaces()) {
      if (surf.type === 'terminal') return id;
    }
    return null;
  };

  const ptyCapture = new PtyCapture((chunk) => {
    if (!relay.hasClients()) return;
    const surfaceId = getFirstTerminalSurfaceId();
    if (!surfaceId) return;
    cloudPtySurfaceId = surfaceId;
    const data = chunk.toString('base64');
    cloudBroadcaster.broadcast({ type: 'output', surfaceId, payload: { data } });
  });

  try {
    const capturePath = await ptyCapture.start();
    console.log(`PTY capture ready: ${capturePath}`);
  } catch (err) {
    console.error('PTY capture setup failed:', err);
    console.log('Continuing without PTY capture (cmux socket API only)');
  }

  syncEngine.startPollTerminal(1000, {
    getActiveSurfaceIds: () => {
      // In cloud mode, poll all terminal surfaces (no per-client tracking)
      const ids = new Set<string>();
      for (const [, surf] of store.getAllSurfaces()) {
        if (surf.type === 'terminal') ids.add(surf.id);
      }
      return ids;
    },
    getPtySurfaceId: () => cloudPtySurfaceId,
  });

  // Replace early handler with full cleanup handler
  const shutdown = () => {
    console.log('\nShutting down...');
    acpManager?.dispose();
    syncEngine.stop();
    ptyCapture.stop();
    relay.disconnect();
    cmux.disconnect();
    process.exit(0);
  };

  process.removeAllListeners('SIGINT');
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
