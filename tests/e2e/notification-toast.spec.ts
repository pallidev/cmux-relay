/**
 * E2E test for notification toast popup
 *
 * Starts a mock WebSocket server serving the built web UI,
 * then uses Playwright to verify:
 * 1. Toast appears when notification arrives
 * 2. Toast has correct title/subtitle/body content
 * 3. Toast auto-dismisses after timeout
 * 4. Notification bell badge shows count
 */

import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { join, extname, dirname } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

const JWT_SECRET = 'e2e-test-secret';
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '../../packages/web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function signToken() {
  return jwt.sign({ role: 'client', iat: Math.floor(Date.now() / 1000) }, JWT_SECRET);
}

async function startServer(): Promise<{ server: Server; wss: WebSocketServer; port: number; token: string }> {
  const token = signToken();
  process.env.CMUX_RELAY_JWT_SECRET = JWT_SECRET;

  const server = createServer(async (req, res) => {
    let urlPath = req.url?.split('?')[0] || '/';
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = join(WEB_DIR, urlPath);
    try {
      const s = await stat(filePath);
      if (!s.isFile()) throw new Error('not file');
      const ext = extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(await readFile(filePath));
    } catch {
      try {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(await readFile(join(WEB_DIR, 'index.html')));
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    }
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth') {
        try {
          jwt.verify(msg.payload.token, JWT_SECRET);
          ws.send(JSON.stringify({ type: 'workspaces', payload: { workspaces: [
            { id: 'ws-1', title: 'Test Workspace' },
          ]}}));
          ws.send(JSON.stringify({ type: 'surfaces', workspaceId: 'ws-1', payload: { surfaces: [
            { id: 'surf-1', title: 'terminal', type: 'terminal', workspaceId: 'ws-1' },
          ]}}));
          ws.send(JSON.stringify({ type: 'panes', workspaceId: 'ws-1', payload: { panes: [{
            id: 'pane-1', index: 0, surfaceIds: ['surf-1'], selectedSurfaceId: 'surf-1',
            focused: true, frame: { x: 0, y: 0, width: 800, height: 600 }, columns: 80, rows: 24,
            workspaceId: 'ws-1',
          }], containerFrame: { x: 0, y: 0, width: 800, height: 600 }}}));
        } catch {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid token' } }));
          ws.close(4001);
        }
      }
      if (msg.type === 'surface.select') {
        ws.send(JSON.stringify({ type: 'surface.active', surfaceId: msg.surfaceId, workspaceId: 'ws-1' }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  return { server, wss, port, token };
}

let server: Server;
let wss: WebSocketServer;
let port: number;
let token: string;

test.beforeAll(async () => {
  ({ server, wss, port, token } = await startServer());
});

test.afterAll(async () => {
  wss.close();
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.CMUX_RELAY_JWT_SECRET;
});

test.describe('Notification toast', () => {

  test('toast appears and shows correct content', async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
    await page.waitForSelector('.status-dot.connected', { timeout: 5000 });

    // Get a connected WS client from server side
    const wsClient = Array.from(wss.clients).find(ws => ws.readyState === WebSocket.OPEN);
    if (!wsClient) throw new Error('No WS client');

    wsClient.send(JSON.stringify({ type: 'notifications', payload: { notifications: [{
      id: randomUUID(), title: 'Claude Code', subtitle: 'Waiting', body: 'Claude is waiting for input',
      surfaceId: 'surf-1', workspaceId: 'ws-1', isRead: false,
    }]}}));

    const toast = page.locator('.toast').first();
    await expect(toast).toBeVisible({ timeout: 3000 });
    await expect(toast.locator('.toast-title')).toHaveText('Claude Code');
    await expect(toast.locator('.toast-sub')).toHaveText('Waiting');
    await expect(toast.locator('.toast-body')).toHaveText('Claude is waiting for input');

    await page.close();
  });

  test('toast is positioned at top-right of viewport', async ({ browser }) => {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
    await page.waitForSelector('.status-dot.connected', { timeout: 5000 });

    const wsClient = Array.from(wss.clients).find(ws => ws.readyState === WebSocket.OPEN);
    if (!wsClient) throw new Error('No WS client');

    wsClient.send(JSON.stringify({ type: 'notifications', payload: { notifications: [{
      id: randomUUID(), title: 'Position Test', subtitle: 'Check', body: 'Top right check',
      surfaceId: '', workspaceId: '', isRead: false,
    }]}}));

    const toast = page.locator('.toast').first();
    await expect(toast).toBeVisible({ timeout: 3000 });

    // Wait for animation to complete
    await page.waitForTimeout(500);

    // Take screenshot to visually verify
    await page.screenshot({ path: '/tmp/toast-screenshot.png' });

    // Check toast container positioning via inline styles
    const pos = await page.evaluate(() => {
      const toastEl = document.querySelector('.toast');
      if (!toastEl) return null;
      const container = toastEl.parentElement;
      if (!container) return null;
      const style = getComputedStyle(container);
      const rect = container.getBoundingClientRect();
      return {
        position: style.position,
        top: style.top,
        right: style.right,
        zIndex: style.zIndex,
        rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
        vp: { width: window.innerWidth, height: window.innerHeight },
      };
    });

    expect(pos).not.toBeNull();
    expect(pos!.position).toBe('fixed');
    expect(pos!.rect.top, `Toast top=${pos!.rect.top} should be < 150`).toBeLessThan(150);
    expect(pos!.rect.left, `Toast left=${pos!.rect.left} should be > ${pos!.vp.width * 0.4}`).toBeGreaterThan(pos!.vp.width * 0.4);

    await page.close();
  });

  test('toast auto-dismisses after timeout', async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
    await page.waitForSelector('.status-dot.connected', { timeout: 5000 });

    const wsClient = Array.from(wss.clients).find(ws => ws.readyState === WebSocket.OPEN);
    if (!wsClient) throw new Error('No WS client');

    wsClient.send(JSON.stringify({ type: 'notifications', payload: { notifications: [{
      id: randomUUID(), title: 'AutoDismiss', subtitle: '', body: 'Should disappear',
      surfaceId: '', workspaceId: '', isRead: false,
    }]}}));

    const toast = page.locator('.toast').first();
    await expect(toast).toBeVisible({ timeout: 3000 });
    // Wait for auto-dismiss (5s + buffer)
    await expect(toast).toBeHidden({ timeout: 7000 });

    await page.close();
  });

  test('notification bell badge shows count', async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
    await page.waitForSelector('.status-dot.connected', { timeout: 5000 });

    const wsClient = Array.from(wss.clients).find(ws => ws.readyState === WebSocket.OPEN);
    if (!wsClient) throw new Error('No WS client');

    // Send notification
    wsClient.send(JSON.stringify({ type: 'notifications', payload: { notifications: [{
      id: randomUUID(), title: 'Badge Test', subtitle: '', body: '',
      surfaceId: '', workspaceId: '', isRead: false,
    }]}}));

    const badge = page.locator('.notif-badge');
    await expect(badge).toBeVisible({ timeout: 3000 });
    await expect(badge).toHaveText('1');

    await page.close();
  });
});
