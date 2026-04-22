import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase } from './db.js';
import { SessionRegistry } from './session-registry.js';
import { PairingRegistry } from './pairing-registry.js';
import { handleHttpRequest } from './http-handler.js';
import { createWsHandler, handleUpgrade } from './ws-handler.js';

// Load .env file
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
} catch {
  // .env file is optional
}

const PORT = parseInt(process.env.RELAY_PORT ?? '3001', 10);
const HOST = process.env.RELAY_HOST ?? '0.0.0.0';
const DB_PATH = process.env.RELAY_DB_PATH ?? './relay.db';
const WEB_URL = process.env.WEB_URL || 'https://cmux.gateway.myaddr.io';

const db = initDatabase(DB_PATH);
const registry = new SessionRegistry();
const pairing = new PairingRegistry(WEB_URL);
const wss = createWsHandler(db, registry, pairing);

const server = createServer((req, res) => {
  handleHttpRequest(req, res, db, registry, pairing).catch((err) => {
    console.error('[relay] HTTP error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  });
});

server.on('upgrade', (req, socket, head) => {
  handleUpgrade(req, db, registry, pairing, wss, () => {});
});

server.listen(PORT, HOST, () => {
  console.log(`[relay] Central relay server listening on ${HOST}:${PORT}`);
  console.log(`[relay] Database: ${DB_PATH}`);
  console.log(`[relay] WebSocket endpoints:`);
  console.log(`[relay]   Agent:  ws://${HOST}:${PORT}/ws/agent?token=<apiToken>`);
  console.log(`[relay]   Client: ws://${HOST}:${PORT}/ws/client?session=<sessionId>`);
});
