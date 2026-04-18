import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { createSessionJwt, verifySessionJwt } from './auth.js';
import { createApiToken, deleteApiToken, listApiTokens } from './db.js';
import { getAuthorizationUrl, handleCallback } from './github-oauth.js';
import type { SessionRegistry } from './session-registry.js';
import type { PairingRegistry } from './pairing-registry.js';

const WEB_URL = process.env.WEB_URL || 'https://cmux.jaz.duckdns.org';
const STATES = new Map<string, { expires: number; pairingCode?: string }>();

export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  registry: SessionRegistry,
  pairing: PairingRegistry,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === '/api/auth/github' && req.method === 'GET') {
    const pairingCode = url.searchParams.get('pair') || undefined;
    const { url: authUrl, state } = getAuthorizationUrl();
    STATES.set(state, { expires: Date.now() + 10 * 60 * 1000, pairingCode });
    setTimeout(() => STATES.delete(state), 10 * 60 * 1000);
    res.writeHead(302, { Location: authUrl.toString() });
    res.end();
    return;
  }

  if (path === '/api/auth/github/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid OAuth callback' }));
      return;
    }

    const stateData = STATES.get(state);
    if (!stateData) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid OAuth state' }));
      return;
    }
    STATES.delete(state);

    const user = await handleCallback(db, code);
    const jwt = await createSessionJwt(user.id, user.username);
    console.log(`[relay] OAuth callback success: user=${user.username}`);

    const redirectTo = stateData.pairingCode
      ? `${WEB_URL}/pair/${stateData.pairingCode}`
      : `${WEB_URL}/`;

    res.writeHead(302, {
      Location: redirectTo,
      'Set-Cookie': `relay_jwt=${jwt}; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`,
    });
    res.end();
    return;
  }

  // Pairing endpoints (public)
  if (path.startsWith('/api/pair/') && req.method === 'GET') {
    const pairCode = path.slice('/api/pair/'.length);
    const info = pairing.getPairingInfo(pairCode);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(info));
    return;
  }

  if (path.startsWith('/api/pair/') && path.endsWith('/approve') && req.method === 'POST') {
    const user = await authenticateRequest(req);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const pairCode = path.slice('/api/pair/'.length, -'/approve'.length);
    const approved = pairing.approvePairing(pairCode, user.sub, db);
    res.writeHead(approved ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(approved ? { ok: true } : { error: 'Pairing not found' }));
    return;
  }

  if (path.startsWith('/api/pair/') && path.endsWith('/reject') && req.method === 'POST') {
    const user = await authenticateRequest(req);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const pairCode = path.slice('/api/pair/'.length, -'/reject'.length);
    const rejected = pairing.rejectPairing(pairCode);
    res.writeHead(rejected ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rejected ? { ok: true } : { error: 'Pairing not found' }));
    return;
  }

  const user = await authenticateRequest(req);
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  if (path === '/api/auth/me' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ userId: user.sub, username: user.username }));
    return;
  }

  if (path === '/api/tokens' && req.method === 'GET') {
    const tokens = listApiTokens(db, user.sub);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tokens));
    return;
  }

  if (path === '/api/tokens' && req.method === 'POST') {
    const body = await readBody(req);
    const parsed = JSON.parse(body) as { name?: string };
    const token = createApiToken(db, user.sub, parsed.name);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token }));
    return;
  }

  if (path.startsWith('/api/tokens/') && req.method === 'DELETE') {
    const tokenId = path.slice('/api/tokens/'.length);
    const deleted = deleteApiToken(db, user.sub, tokenId);
    res.writeHead(deleted ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(deleted ? { ok: true } : { error: 'Not found' }));
    return;
  }

  if (path === '/api/sessions' && req.method === 'GET') {
    const sessions = registry.getSessionsForUser(user.sub);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

async function authenticateRequest(req: IncomingMessage): Promise<{ sub: string; username: string } | null> {
  const cookieHeader = req.headers.cookie ?? '';
  const match = cookieHeader.match(/(?:^|;\s*)relay_jwt=([^;]+)/);
  if (match) {
    return verifySessionJwt(match[1]);
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return verifySessionJwt(authHeader.slice(7));
  }

  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
