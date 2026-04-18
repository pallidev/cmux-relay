import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { createSessionJwt, verifySessionJwt } from './auth.js';
import { createApiToken, deleteApiToken, listApiTokens } from './db.js';
import { getAuthorizationUrl, handleCallback } from './github-oauth.js';
import { SessionRegistry } from './session-registry.js';

const WEB_URL = process.env.WEB_URL || 'https://cmux.jaz.duckdns.org';
const STATES = new Map<string, { expires: number }>();

export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  registry: SessionRegistry,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === '/api/auth/github' && req.method === 'GET') {
    const { url: authUrl, state } = getAuthorizationUrl();
    STATES.set(state, { expires: Date.now() + 10 * 60 * 1000 });
    setTimeout(() => STATES.delete(state), 10 * 60 * 1000);
    res.writeHead(302, { Location: authUrl.toString() });
    res.end();
    return;
  }

  if (path === '/api/auth/github/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || !STATES.delete(state)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid OAuth state' }));
      return;
    }

    const user = await handleCallback(db, code);
    const jwt = await createSessionJwt(user.id, user.username);
    console.log(`[relay] OAuth callback success: user=${user.username} jwt=${jwt.slice(0, 20)}...`);

    res.writeHead(302, {
      Location: `${WEB_URL}/`,
      'Set-Cookie': `relay_jwt=${jwt}; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`,
    });
    res.end();
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
