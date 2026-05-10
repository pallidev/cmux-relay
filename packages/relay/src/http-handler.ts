import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import type { SessionRegistry } from './session-registry.js';
import type { PairingRegistry } from './pairing-registry.js';
import {
  type RouteContext,
  authenticateRequest,
  handleGithubAuth,
  handleGithubCallback,
  handleVapidKey,
  handlePairInfo,
  handlePairApprove,
  handlePairReject,
  handleAuthMe,
  handleListTokens,
  handleCreateToken,
  handleDeleteToken,
  handleListSessions,
  handlePushSubscribe,
  handlePushUnsubscribe,
} from './routes.js';

export { authenticateRequest, readBody } from './routes.js';

type RouteHandler = (ctx: RouteContext) => Promise<void>;

interface Route {
  method: string;
  pattern: string;
  params: string[];
  handler: RouteHandler;
  auth: 'none' | 'optional' | 'required';
}

const ROUTES: Route[] = [
  // Public routes (no auth needed)
  { method: 'GET', pattern: '/api/auth/github', params: [], handler: handleGithubAuth, auth: 'none' },
  { method: 'GET', pattern: '/api/auth/github/callback', params: [], handler: handleGithubCallback, auth: 'none' },
  { method: 'GET', pattern: '/api/push/vapid-key', params: [], handler: handleVapidKey, auth: 'none' },
  { method: 'GET', pattern: '/api/pair/:code', params: ['code'], handler: handlePairInfo, auth: 'none' },

  // Pairing action routes (auth checked internally by handler)
  { method: 'POST', pattern: '/api/pair/:code/approve', params: ['code'], handler: handlePairApprove, auth: 'optional' },
  { method: 'POST', pattern: '/api/pair/:code/reject', params: ['code'], handler: handlePairReject, auth: 'optional' },

  // Authenticated routes
  { method: 'GET', pattern: '/api/auth/me', params: [], handler: handleAuthMe, auth: 'required' },
  { method: 'GET', pattern: '/api/tokens', params: [], handler: handleListTokens, auth: 'required' },
  { method: 'POST', pattern: '/api/tokens', params: [], handler: handleCreateToken, auth: 'required' },
  { method: 'DELETE', pattern: '/api/tokens/:id', params: ['id'], handler: handleDeleteToken, auth: 'required' },
  { method: 'GET', pattern: '/api/sessions', params: [], handler: handleListSessions, auth: 'required' },
  { method: 'POST', pattern: '/api/push/subscribe', params: [], handler: handlePushSubscribe, auth: 'required' },
  { method: 'DELETE', pattern: '/api/push/subscribe', params: [], handler: handlePushUnsubscribe, auth: 'required' },
];

function matchRoute(path: string, method: string): { route: Route; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;

    const routeParts = route.pattern.split('/');
    const pathParts = path.split('/');

    if (routeParts.length !== pathParts.length) continue;

    const params: Record<string, string> = {};
    let match = true;

    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) {
        params[routeParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (routeParts[i] !== pathParts[i]) {
        match = false;
        break;
      }
    }

    if (match) {
      return { route, params };
    }
  }

  return null;
}

export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  registry: SessionRegistry,
  pairing: PairingRegistry,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  const matched = matchRoute(path, method);

  if (!matched) {
    // Preserve original behavior: unmatched routes get 401 if not authenticated,
    // 404 if authenticated. This matches the original if/else chain where the
    // global auth guard runs before the final 404.
    const user = await authenticateRequest(req);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const { route, params } = matched;

  // Resolve authentication based on route requirements
  let user: { sub: string; username: string } | null = null;

  if (route.auth === 'required') {
    user = await authenticateRequest(req);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  } else if (route.auth === 'optional') {
    // Try to authenticate but don't reject; handler checks internally
    user = await authenticateRequest(req);
  }
  // auth === 'none': user stays null

  const ctx: RouteContext = {
    req,
    res,
    params,
    user,
    db,
    registry,
    pairing,
  };

  await route.handler(ctx);
}
