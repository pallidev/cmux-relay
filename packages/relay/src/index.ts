import { createServer } from 'node:http';
import { initDatabase } from './db.js';
import { SessionRegistry } from './session-registry.js';
import { handleHttpRequest } from './http-handler.js';
import { createWsHandler, handleUpgrade } from './ws-handler.js';

const PORT = parseInt(process.env.RELAY_PORT ?? '3001', 10);
const HOST = process.env.RELAY_HOST ?? '0.0.0.0';
const DB_PATH = process.env.RELAY_DB_PATH ?? './relay.db';

const db = initDatabase(DB_PATH);
const registry = new SessionRegistry();
const wss = createWsHandler(db, registry);

const server = createServer((req, res) => {
  handleHttpRequest(req, res, db, registry).catch((err) => {
    console.error('[relay] HTTP error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  });
});

server.on('upgrade', (req, socket, head) => {
  handleUpgrade(req, db, registry, wss, () => {});
});

server.listen(PORT, HOST, () => {
  console.log(`[relay] Central relay server listening on ${HOST}:${PORT}`);
  console.log(`[relay] Database: ${DB_PATH}`);
  console.log(`[relay] WebSocket endpoints:`);
  console.log(`[relay]   Agent:  ws://${HOST}:${PORT}/ws/agent?token=<apiToken>`);
  console.log(`[relay]   Client: ws://${HOST}:${PORT}/ws/client?session=<sessionId>`);
});
