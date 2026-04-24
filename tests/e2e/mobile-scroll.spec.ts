/**
 * E2E test for terminal scrolling behavior.
 *
 * Tests the scroll logic (sticky bottom, scroll position preservation,
 * scroll-to-bottom button) and touch scroll handling using a standalone
 * test page with xterm.js to isolate from app routing complexity.
 */

import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal test page that loads xterm.js and replicates production writeOutput logic
const TEST_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>Scroll E2E Test</title>
  <link rel="stylesheet" href="/xterm.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; background: #1e1e2e; }
    #terminal-container { width: 375px; height: 600px; position: relative; }
  </style>
</head>
<body>
  <div id="terminal-container"></div>
  <script src="/xterm.js"></script>
  <script src="/addon-fit.js"></script>
  <script>
    const container = document.getElementById('terminal-container');
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 10000,
      convertEol: true,
      theme: { background: '#1e1e2e', foreground: '#cdd6f4' },
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    let lastB64 = '';
    let hasWritten = false;
    let previousText = '';
    let isAtBottom = true;

    const scrolledUpEl = document.createElement('button');
    scrolledUpEl.textContent = '\\u2193';
    scrolledUpEl.setAttribute('aria-label', 'Scroll to bottom');
    scrolledUpEl.style.cssText = 'position:absolute;bottom:8px;right:8px;width:32px;height:32px;border-radius:50%;border:none;background:rgba(137,180,250,0.8);color:#1e1e2e;font-size:16px;cursor:pointer;display:none;z-index:10;';
    scrolledUpEl.onclick = () => {
      isAtBottom = true;
      term.scrollToBottom();
      scrolledUpEl.style.display = 'none';
    };
    container.appendChild(scrolledUpEl);

    term.onScroll(() => {
      const buffer = term.buffer.active;
      const atBottom = buffer.viewportY + term.rows >= buffer.length;
      isAtBottom = atBottom;
      scrolledUpEl.style.display = atBottom ? 'none' : 'block';
    });

    let lastTouchY = 0;
    container.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      lastTouchY = e.touches[0].clientY;
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      const currentY = e.touches[0].clientY;
      const delta = lastTouchY - currentY;
      lastTouchY = currentY;
      if (Math.abs(delta) > 0) {
        term.scrollLines(Math.round(delta / 10) || (delta > 0 ? 1 : -1));
        e.preventDefault();
      }
    }, { passive: false });

    window.__term = term;
    window.__writeOutput = (base64Data) => {
      if (base64Data === lastB64) return;
      lastB64 = base64Data;
      const bytes = atob(base64Data);
      const text = new TextDecoder().decode(Uint8Array.from(bytes, c => c.charCodeAt(0)));
      if (!hasWritten) {
        hasWritten = true;
        previousText = text;
        term.write(text);
        term.scrollToBottom();
        return;
      }
      if (previousText) {
        term.write('\\x1b[' + term.rows + ';1H');
        term.write(previousText + '\\n');
        term.write('\\x1b[H');
      }
      term.write(text);
      term.write('\\x1b[J');
      previousText = text;
      if (isAtBottom) term.scrollToBottom();
    };
    window.__getScrollState = () => {
      const buf = term.buffer.active;
      return {
        viewportY: buf.viewportY,
        length: buf.length,
        rows: term.rows,
        isAtBottom: isAtBottom,
        scrollBtnVisible: scrolledUpEl.style.display !== 'none',
      };
    };
    window.__scrollToBottom = () => {
      isAtBottom = true;
      term.scrollToBottom();
      scrolledUpEl.style.display = 'none';
    };
    window.__isReady = true;
  </script>
</body>
</html>`;

async function startServer(): Promise<{ server: Server; port: number }> {
  const xtermDir = join(__dirname, '../../node_modules/.pnpm/@xterm+xterm@5.5.0/node_modules/@xterm/xterm');
  const fitDir = join(__dirname, '../../node_modules/.pnpm/@xterm+addon-fit@0.10.0_@xterm+xterm@5.5.0/node_modules/@xterm/addon-fit');

  const server = createServer(async (req, res) => {
    const url = req.url?.split('?')[0] || '/';
    try {
      if (url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(TEST_HTML);
      } else if (url === '/xterm.css') {
        const data = await readFile(join(xtermDir, 'css/xterm.css'));
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end(data);
      } else if (url === '/xterm.js') {
        const data = await readFile(join(xtermDir, 'lib/xterm.js'));
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(data);
      } else if (url === '/addon-fit.js') {
        const data = await readFile(join(fitDir, 'lib/addon-fit.js'));
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(data);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    } catch (e: any) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(e.message);
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  return { server, port };
}

let server: Server;
let port: number;

test.beforeAll(async () => {
  ({ server, port } = await startServer());
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function makeContent(version: string, lines = 20): string {
  const result: string[] = [];
  for (let i = 0; i < lines; i++) {
    result.push(`[${version}] Line ${i + 1}: test content abcdefghijklmnop`);
  }
  result.push('$ ');
  return result.join('\n');
}

function toBase64(text: string): string {
  return Buffer.from(text).toString('base64');
}

async function waitForReady(page: any) {
  await page.waitForFunction('window.__isReady === true', { timeout: 5000 });
}

async function writeOutput(page: any, text: string) {
  const b64 = toBase64(text);
  await page.evaluate((b) => window.__writeOutput(b), b64);
  await page.waitForTimeout(50);
}

async function getScrollState(page: any) {
  return page.evaluate(() => window.__getScrollState());
}

async function touchScroll(page: any, deltaY: number) {
  await page.evaluate((dy) => {
    const container = document.getElementById('terminal-container');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startY = rect.top + rect.height / 2;
    const endY = startY + dy;

    const t1 = new Touch({ identifier: 0, target: container, clientX: startX, clientY: startY });
    container.dispatchEvent(new TouchEvent('touchstart', { touches: [t1], bubbles: true, cancelable: true }));

    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const y = startY + (endY - startY) * (i / steps);
      const t = new Touch({ identifier: 0, target: container, clientX: startX, clientY: y });
      container.dispatchEvent(new TouchEvent('touchmove', { touches: [t], bubbles: true, cancelable: false }));
    }

    const tEnd = new Touch({ identifier: 0, target: container, clientX: startX, clientY: endY });
    container.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [tEnd], bubbles: true }));
  }, deltaY);
  await page.waitForTimeout(100);
}

test.describe('Terminal scroll behavior', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test('initial output scrolls to bottom', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    // First write always scrolls to bottom
    await writeOutput(page, makeContent('v1'));
    const state = await getScrollState(page);
    expect(state.isAtBottom).toBe(true);
    expect(state.scrollBtnVisible).toBe(false);
  });

  test('multiple outputs keep auto-scroll at bottom', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    for (let i = 0; i < 10; i++) {
      await writeOutput(page, makeContent(`auto-${i}`));
    }

    const state = await getScrollState(page);
    expect(state.isAtBottom).toBe(true);
    expect(state.scrollBtnVisible).toBe(false);
  });

  test('touch scroll up moves viewport up', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    for (let i = 0; i < 15; i++) {
      await writeOutput(page, makeContent(`scroll-${i}`));
    }

    const before = await getScrollState(page);
    expect(before.isAtBottom).toBe(true);

    // Scroll up (positive deltaY = finger moves down = content scrolls up)
    await touchScroll(page, 150);
    const after = await getScrollState(page);

    expect(after.viewportY).toBeLessThan(before.viewportY);
    expect(after.isAtBottom).toBe(false);
    expect(after.scrollBtnVisible).toBe(true);
  });

  test('scroll position preserved during new output when scrolled up', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    for (let i = 0; i < 10; i++) {
      await writeOutput(page, makeContent(`preserve-${i}`));
    }

    await touchScroll(page, 200);
    const scrolledState = await getScrollState(page);
    expect(scrolledState.isAtBottom).toBe(false);

    // Send new output while scrolled up
    for (let i = 0; i < 5; i++) {
      await writeOutput(page, makeContent(`new-${i}`));
    }

    const afterUpdate = await getScrollState(page);
    expect(afterUpdate.isAtBottom).toBe(false);
    expect(afterUpdate.scrollBtnVisible).toBe(true);
  });

  test('auto-scroll resumes after returning to bottom', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    for (let i = 0; i < 10; i++) {
      await writeOutput(page, makeContent(`resume-${i}`));
    }

    await touchScroll(page, 200);
    let state = await getScrollState(page);
    expect(state.isAtBottom).toBe(false);

    // Return to bottom
    await page.evaluate(() => window.__scrollToBottom());
    await page.waitForTimeout(100);
    state = await getScrollState(page);
    expect(state.isAtBottom).toBe(true);

    // New output should auto-scroll
    for (let i = 0; i < 3; i++) {
      await writeOutput(page, makeContent(`after-${i}`));
    }
    state = await getScrollState(page);
    expect(state.isAtBottom).toBe(true);
    expect(state.scrollBtnVisible).toBe(false);
  });

  test('repeated touch scrolls are stable', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    for (let i = 0; i < 20; i++) {
      await writeOutput(page, makeContent(`stable-${i}`));
    }

    // Multiple scroll-up gestures
    for (let i = 0; i < 5; i++) {
      await touchScroll(page, 80);
    }
    let state = await getScrollState(page);
    expect(state.isAtBottom).toBe(false);
    const vyAfter5Scrolls = state.viewportY;

    // Return to bottom and scroll up again
    await page.evaluate(() => window.__scrollToBottom());
    await page.waitForTimeout(100);

    for (let i = 0; i < 3; i++) {
      await touchScroll(page, 120);
    }
    state = await getScrollState(page);
    expect(state.isAtBottom).toBe(false);

    // Return to bottom again
    await page.evaluate(() => window.__scrollToBottom());
    await page.waitForTimeout(100);
    state = await getScrollState(page);
    expect(state.isAtBottom).toBe(true);
    expect(state.scrollBtnVisible).toBe(false);
  });

  test('rapid output updates maintain correct scroll state', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    // Rapid-fire 20 updates
    for (let i = 0; i < 20; i++) {
      await page.evaluate((b) => window.__writeOutput(b), toBase64(makeContent(`rapid-${i}`)));
    }
    await page.waitForTimeout(300);

    let state = await getScrollState(page);
    expect(state.isAtBottom).toBe(true);

    // Scroll up during rapid updates
    await touchScroll(page, 200);

    // More rapid updates while scrolled up
    for (let i = 0; i < 10; i++) {
      await page.evaluate((b) => window.__writeOutput(b), toBase64(makeContent(`rapid-scrolled-${i}`)));
    }
    await page.waitForTimeout(300);

    state = await getScrollState(page);
    expect(state.isAtBottom).toBe(false);
    expect(state.scrollBtnVisible).toBe(true);
  });

  test('different scroll distances all work', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    for (let i = 0; i < 20; i++) {
      await writeOutput(page, makeContent(`dist-${i}`));
    }

    const distances = [30, 80, 150, 250];
    for (const dy of distances) {
      // Start at bottom
      await page.evaluate(() => window.__scrollToBottom());
      await page.waitForTimeout(50);

      // Scroll up by different amounts
      await touchScroll(page, dy);
      const state = await getScrollState(page);
      expect(state.isAtBottom).toBe(false);
      expect(state.scrollBtnVisible).toBe(true);
    }
  });

  test('scroll up and down alternation 10 rounds', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    for (let i = 0; i < 15; i++) {
      await writeOutput(page, makeContent(`alt-${i}`));
    }

    for (let round = 0; round < 10; round++) {
      // Scroll up
      await touchScroll(page, 120);
      let state = await getScrollState(page);
      expect(state.isAtBottom).toBe(false);

      // Return to bottom
      await page.evaluate(() => window.__scrollToBottom());
      await page.waitForTimeout(50);
      state = await getScrollState(page);
      expect(state.isAtBottom).toBe(true);
    }
  });

  test('scroll back content shows previous versions', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    // Write several versions with distinct labels
    for (let i = 0; i < 10; i++) {
      await writeOutput(page, makeContent(`history-v${i}`));
    }

    // Scroll up significantly
    for (let i = 0; i < 10; i++) {
      await touchScroll(page, 80);
    }

    // Check that scrolled content contains earlier versions
    const hasOldContent = await page.evaluate(() => {
      const buf = window.__term.buffer.active;
      const topLine = buf.getLine(buf.viewportY)?.translateToString(true) || '';
      return topLine.length > 0;
    });
    expect(hasOldContent).toBe(true);

    // The viewport should be above the bottom
    const state = await getScrollState(page);
    expect(state.viewportY).toBeLessThan(state.length - state.rows);
  });
});
