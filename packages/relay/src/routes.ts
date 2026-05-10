import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { createSessionJwt, verifySessionJwt } from './auth.js';
import { createApiToken, deleteApiToken, listApiTokens, upsertPushSubscription, deletePushSubscription } from './db.js';
import { getAuthorizationUrl, handleCallback } from './github-oauth.js';
import type { SessionRegistry } from './session-registry.js';
import type { PairingRegistry } from './pairing-registry.js';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  user: { sub: string; username: string } | null;
  db: Database.Database;
  registry: SessionRegistry;
  pairing: PairingRegistry;
}

const WEB_URL = process.env.WEB_URL || 'https://cmux.gateway.myaddr.io';

// Shared mutable state for OAuth flow (module-level, same as before)
const STATES = new Map<string, { expires: number; pairingCode?: string }>();

// ─── Helpers ───

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

export async function authenticateRequest(req: IncomingMessage): Promise<{ sub: string; username: string } | null> {
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

// ─── Public Route Handlers ───

export async function handleGithubAuth(ctx: RouteContext): Promise<void> {
  const pairingCode = new URL(ctx.req.url ?? '/', `http://${ctx.req.headers.host}`).searchParams.get('pair') || undefined;
  const { url: authUrl, state } = getAuthorizationUrl();
  STATES.set(state, { expires: Date.now() + 10 * 60 * 1000, pairingCode });
  setTimeout(() => STATES.delete(state), 10 * 60 * 1000);
  ctx.res.writeHead(302, { Location: authUrl.toString() });
  ctx.res.end();
}

export async function handleGithubCallback(ctx: RouteContext): Promise<void> {
  const url = new URL(ctx.req.url ?? '/', `http://${ctx.req.headers.host}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    ctx.res.writeHead(400, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ error: 'Invalid OAuth callback' }));
    return;
  }

  const stateData = STATES.get(state);
  if (!stateData) {
    ctx.res.writeHead(400, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ error: 'Invalid OAuth state' }));
    return;
  }
  STATES.delete(state);

  const user = await handleCallback(ctx.db, code);
  const jwt = await createSessionJwt(user.id, user.username);
  console.log(`[relay] OAuth callback success: user=${user.username}`);

  const redirectTo = stateData.pairingCode
    ? `${WEB_URL}/pair/${stateData.pairingCode}`
    : `${WEB_URL}/`;

  ctx.res.writeHead(302, {
    Location: redirectTo,
    'Set-Cookie': `relay_jwt=${jwt}; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`,
  });
  ctx.res.end();
}

export async function handleVapidKey(ctx: RouteContext): Promise<void> {
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY_CACHE;
  if (!vapidPublicKey) {
    ctx.res.writeHead(503, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ error: 'Push not configured' }));
    return;
  }
  ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify({ publicKey: vapidPublicKey }));
}

export async function handlePairInfo(ctx: RouteContext): Promise<void> {
  const pairCode = ctx.params.code;
  const info = ctx.pairing.getPairingInfo(pairCode);
  ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify(info));
}

// ─── Authenticated Route Handlers ───

export async function handlePairApprove(ctx: RouteContext): Promise<void> {
  if (!ctx.user) {
    ctx.res.writeHead(401, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const pairCode = ctx.params.code;
  const approved = ctx.pairing.approvePairing(pairCode, ctx.user.sub, ctx.db);
  ctx.res.writeHead(approved ? 200 : 404, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify(approved ? { ok: true } : { error: 'Pairing not found' }));
}

export async function handlePairReject(ctx: RouteContext): Promise<void> {
  if (!ctx.user) {
    ctx.res.writeHead(401, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const pairCode = ctx.params.code;
  const rejected = ctx.pairing.rejectPairing(pairCode);
  ctx.res.writeHead(rejected ? 200 : 404, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify(rejected ? { ok: true } : { error: 'Pairing not found' }));
}

export async function handleAuthMe(ctx: RouteContext): Promise<void> {
  if (!ctx.user) {
    ctx.res.writeHead(401, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify({ userId: ctx.user.sub, username: ctx.user.username }));
}

export async function handleListTokens(ctx: RouteContext): Promise<void> {
  if (!ctx.user) {
    ctx.res.writeHead(401, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  const tokens = listApiTokens(ctx.db, ctx.user.sub);
  ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify(tokens));
}

export async function handleCreateToken(ctx: RouteContext): Promise<void> {
  if (!ctx.user) {
    ctx.res.writeHead(401, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  const body = await readBody(ctx.req);
  const parsed = JSON.parse(body) as { name?: string };
  const token = createApiToken(ctx.db, ctx.user.sub, parsed.name);
  ctx.res.writeHead(201, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify({ token }));
}

export async function handleDeleteToken(ctx: RouteContext): Promise<void> {
  if (!ctx.user) {
    ctx.res.writeHead(401, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  const tokenId = ctx.params.id;
  const deleted = deleteApiToken(ctx.db, ctx.user.sub, tokenId);
  ctx.res.writeHead(deleted ? 200 : 404, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify(deleted ? { ok: true } : { error: 'Not found' }));
}

export async function handleListSessions(ctx: RouteContext): Promise<void> {
  if (!ctx.user) {
    ctx.res.writeHead(401, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  const sessions = ctx.registry.getSessionsForUser(ctx.user.sub);
  ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify(sessions));
}

export async function handlePushSubscribe(ctx: RouteContext): Promise<void> {
  if (!ctx.user) {
    ctx.res.writeHead(401, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  const body = await readBody(ctx.req);
  const parsed = JSON.parse(body) as { endpoint: string; keys: { p256dh: string; auth: string } };
  if (!parsed.endpoint || !parsed.keys?.p256dh || !parsed.keys?.auth) {
    ctx.res.writeHead(400, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ error: 'Invalid subscription' }));
    return;
  }
  const userAgent = ctx.req.headers['user-agent'] || undefined;
  upsertPushSubscription(ctx.db, ctx.user.sub, parsed.endpoint, parsed.keys.p256dh, parsed.keys.auth, userAgent);
  ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify({ ok: true }));
}

export async function handlePushUnsubscribe(ctx: RouteContext): Promise<void> {
  if (!ctx.user) {
    ctx.res.writeHead(401, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  const body = await readBody(ctx.req);
  const parsed = JSON.parse(body) as { endpoint: string };
  const deleted = deletePushSubscription(ctx.db, ctx.user.sub, parsed.endpoint);
  ctx.res.writeHead(deleted ? 200 : 404, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify(deleted ? { ok: true } : { error: 'Not found' }));
}
