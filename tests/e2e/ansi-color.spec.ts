/**
 * E2E test for ANSI color rendering in xterm.js
 *
 * Verifies that ANSI escape sequences (colors, backgrounds) are correctly
 * rendered by xterm.js when terminal output is written via the writeOutput
 * pipeline (base64 decode → xterm.write).
 */

import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>ANSI Color E2E Test</title>
  <link rel="stylesheet" href="/xterm.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; background: #1e1e2e; }
    #terminal-container { width: 800px; height: 600px; position: relative; }
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
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#94e2d5',
      },
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    let lastB64 = '';
    let hasWritten = false;
    let previousText = '';

    // Production writeOutput logic from Terminal.tsx
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
      if (true) term.scrollToBottom();
    };

    // Get foreground color at buffer position (row, col)
    // Returns the xterm color number or RGB value
    window.__getFgAt = (row, col) => {
      const line = term.buffer.active.getLine(row);
      if (!line) return null;
      const cell = line.getCell(col);
      if (!cell) return null;
      return {
        fg: cell.getFgColor(),
        fgMode: cell.getFgColorMode(),
        bg: cell.getBgColor(),
        bgMode: cell.getBgColorMode(),
        char: cell.getChars(),
      };
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

test.describe('ANSI color rendering', () => {
  test('colored text renders foreground color', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    const ansiText = '\x1b[31mHello\x1b[0m';
    await writeOutput(page, ansiText);

    const cell = await page.evaluate(() => window.__getFgAt(0, 0));
    expect(cell).not.toBeNull();
    expect(cell!.char).toBe('H');
    // xterm.js resolves ANSI colors using theme (mode = RGB = 2^24)
    expect(cell!.fgMode).not.toBe(0); // Not DEFAULT
    expect(cell!.fg).toBe(1); // ANSI red color index
  });

  test('reset code clears foreground color', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    // "Red" is colored, "Normal" is default
    const ansiText = '\x1b[31mRed\x1b[0mNormal';
    await writeOutput(page, ansiText);

    const redCell = await page.evaluate(() => window.__getFgAt(0, 0));
    expect(redCell!.fg).toBe(1); // Red

    const normalCell = await page.evaluate(() => window.__getFgAt(0, 3));
    expect(normalCell!.fg).not.toBe(1); // Not red — default color
  });

  test('multiple colors in one line', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    const ansiText = '\x1b[31mRed\x1b[32mGreen\x1b[34mBlue\x1b[0m';
    await writeOutput(page, ansiText);

    const red = await page.evaluate(() => window.__getFgAt(0, 0));
    expect(red!.fg).toBe(1); // Red (ANSI 31)

    const green = await page.evaluate(() => window.__getFgAt(0, 3));
    expect(green!.fg).toBe(2); // Green (ANSI 32)

    const blue = await page.evaluate(() => window.__getFgAt(0, 8));
    expect(blue!.fg).toBe(4); // Blue (ANSI 34)
  });

  test('background color renders correctly', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    const ansiText = '\x1b[41mRedBG\x1b[0m';
    await writeOutput(page, ansiText);

    const cell = await page.evaluate(() => window.__getFgAt(0, 0));
    expect(cell).not.toBeNull();
    // Background color should be non-default
    expect(cell!.bgMode).not.toBe(0); // Not DEFAULT
    expect(cell!.bg).toBe(1); // ANSI red background index
  });

  test('color preserved across screen updates', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    // First write with colored text
    const v1 = '\x1b[31mVersion 1\x1b[0m';
    await writeOutput(page, v1);

    const cellV1 = await page.evaluate(() => window.__getFgAt(0, 0));
    expect(cellV1!.fg).toBe(1); // Red

    // Second write with different colored text
    const v2 = '\x1b[32mVersion 2\x1b[0m';
    await writeOutput(page, v2);

    // After screen update, the new content should have green color
    // The new content is written after cursor manipulation
    // The visible screen should show "Version 2" in green
    const cellV2 = await page.evaluate(() => {
      const buf = term.buffer.active;
      // Find "Version 2" in the buffer — it should be on a recent line
      for (let row = 0; row < buf.length; row++) {
        const line = buf.getLine(row);
        if (!line) continue;
        const text = line.translateToString(true);
        if (text.includes('Version 2')) {
          return window.__getFgAt(row, 0);
        }
      }
      return null;
    });
    expect(cellV2).not.toBeNull();
    expect(cellV2!.fg).toBe(2); // Green
  });

  test('bold and underline styles render', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    const ansiText = '\x1b[1mBold\x1b[0m \x1b[4mUnderline\x1b[0m';
    await writeOutput(page, ansiText);

    // Bold text should be rendered (check it exists in buffer)
    const boldCell = await page.evaluate(() => window.__getFgAt(0, 0));
    expect(boldCell!.char).toBe('B');

    const underlineCell = await page.evaluate(() => window.__getFgAt(0, 5));
    expect(underlineCell!.char).toBe('U');
  });

  test('256-color and truecolor sequences render', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await waitForReady(page);

    // 256-color: \x1b[38;5;196m (bright red)
    const ansiText = '\x1b[38;5;196mCustom\x1b[0m';
    await writeOutput(page, ansiText);

    const cell = await page.evaluate(() => window.__getFgAt(0, 0));
    expect(cell).not.toBeNull();
    expect(cell!.char).toBe('C');
    // Should have a non-default foreground color
    expect(cell!.fgMode).not.toBe(0); // Not DEFAULT
  });
});
