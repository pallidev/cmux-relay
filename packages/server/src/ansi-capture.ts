import { createConnection as createNetConnection } from 'node:net';
import { existsSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface CaptureSession {
  surfaceId: string;
  captureFile: string;
  namedPipe: string;
  offset: number;
  watching: boolean;
  active: boolean;
}

/**
 * Per-surface ANSI capture using named pipe + tee.
 *
 * Creates a named pipe (FIFO), starts a background tee process
 * that reads from the pipe and writes to both a capture file and
 * the terminal, then redirects the shell's stdout/stderr to the pipe.
 */
export class AnsiCapture {
  private sessions = new Map<string, CaptureSession>();
  private cmuxSocketPath: string;

  constructor(socketPath?: string) {
    this.cmuxSocketPath = socketPath || process.env.CMUX_SOCKET_PATH ||
      `${process.env.HOME}/Library/Application Support/cmux/cmux.sock`;
  }

  async startCapture(
    surfaceId: string,
    onData: (chunk: Buffer) => void,
  ): Promise<void> {
    if (this.sessions.has(surfaceId)) return;

    const captureFile = join(tmpdir(), `cmux-capture-${surfaceId}.txt`);
    const namedPipe = join(tmpdir(), `cmux-pipe-${surfaceId}`);

    // Clean up old files
    for (const f of [captureFile, namedPipe]) {
      if (existsSync(f)) {
        try { unlinkSync(f); } catch { /* ignore */ }
      }
    }

    const session: CaptureSession = {
      surfaceId,
      captureFile,
      namedPipe,
      offset: 0,
      watching: false,
      active: false,
    };

    this.sessions.set(surfaceId, session);
    this.pollFile(session, onData);
    await this.injectCapture(surfaceId, namedPipe, captureFile);

    console.log(`ANSI capture: ready for ${surfaceId.slice(0, 8)}`);
  }

  /** Inject named pipe + tee via dedicated cmux socket connection */
  private async injectCapture(surfaceId: string, namedPipe: string, captureFile: string): Promise<void> {
    try {
      // Send Enter to ensure clean prompt
      await this.sendToCmux('surface.send_text', {
        surface_id: surfaceId,
        text: '\n',
      });
      await new Promise(r => setTimeout(r, 300));

      // Create FIFO, start background tee, redirect stdout
      // Step 1: Create named pipe
      await this.sendToCmux('surface.send_text', {
        surface_id: surfaceId,
        text: `mkfifo '${namedPipe}' 2>/dev/null\n`,
      });
      await new Promise(r => setTimeout(r, 200));

      // Step 2: Start tee in background (reads pipe → writes file + terminal)
      await this.sendToCmux('surface.send_text', {
        surface_id: surfaceId,
        text: `tee '${captureFile}' < '${namedPipe}' > /dev/tty &\n`,
      });
      await new Promise(r => setTimeout(r, 500));

      // Step 3: Redirect shell stdout/stderr to the named pipe
      await this.sendToCmux('surface.send_text', {
        surface_id: surfaceId,
        text: `exec > '${namedPipe}' 2>&1\n`,
      });
      await new Promise(r => setTimeout(r, 500));

      // Verify capture works
      await this.sendToCmux('surface.send_text', {
        surface_id: surfaceId,
        text: 'echo cmux-capture-ok\n',
      });

      console.log(`ANSI capture: injected for ${surfaceId.slice(0, 8)}`);
    } catch (err) {
      console.error(`ANSI capture: injection failed for ${surfaceId.slice(0, 8)}:`, err);
    }
  }

  /** Send a JSON-RPC request directly to cmux socket */
  private sendToCmux(method: string, params: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const sock = createNetConnection(this.cmuxSocketPath);
      const id = randomUUID();
      let buf = '';

      sock.on('connect', () => {
        sock.write(JSON.stringify({ id, method, params }) + '\n');
      });

      sock.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf-8');
        for (const line of buf.split('\n')) {
          if (!line.trim()) continue;
          try {
            const resp = JSON.parse(line);
            if (resp.id === id) {
              sock.destroy();
              if (resp.ok) resolve(resp.result);
              else reject(new Error(resp.error?.message || 'cmux error'));
              return;
            }
          } catch {}
        }
      });

      sock.on('error', (err) => {
        sock.destroy();
        reject(err);
      });

      setTimeout(() => {
        sock.destroy();
        reject(new Error('cmux injection timeout'));
      }, 5000);
    });
  }

  private pollFile(session: CaptureSession, onData: (chunk: Buffer) => void): void {
    session.watching = true;

    const poll = () => {
      if (!session.watching) return;

      try {
        if (!existsSync(session.captureFile)) {
          setTimeout(poll, 300);
          return;
        }

        const stat = statSync(session.captureFile);
        if (stat.size > session.offset) {
          const len = stat.size - session.offset;
          const buf = Buffer.alloc(len);
          const fd = openSync(session.captureFile, 'r');
          readSync(fd, buf, 0, len, session.offset);
          closeSync(fd);

          session.offset = stat.size;
          session.active = true;
          onData(buf);
        }
      } catch {
        // File temporarily unavailable
      }

      setTimeout(poll, 150);
    };

    poll();
  }

  hasActiveCapture(surfaceId: string): boolean {
    return this.sessions.get(surfaceId)?.active === true;
  }

  hasSession(surfaceId: string): boolean {
    return this.sessions.has(surfaceId);
  }

  stopCapture(surfaceId: string): void {
    const session = this.sessions.get(surfaceId);
    if (!session) return;

    session.watching = false;
    for (const f of [session.captureFile, session.namedPipe]) {
      if (existsSync(f)) {
        try { unlinkSync(f); } catch { /* ignore */ }
      }
    }
    this.sessions.delete(surfaceId);
  }

  stopAll(): void {
    for (const surfaceId of [...this.sessions.keys()]) {
      this.stopCapture(surfaceId);
    }
  }
}
