import { createServer, type Server } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * PTY output capture using a named pipe approach.
 *
 * Strategy: The agent creates a named pipe (FIFO) and watches for
 * shell sessions writing to it. A shell integration script is provided
 * that the user sources in their shell profile to redirect output.
 */
export class PtyCapture {
  private pipePath: string;
  private server: Server | null = null;
  private onData: ((chunk: Buffer) => void) | null = null;
  private watching = false;

  constructor(onData: (chunk: Buffer) => void) {
    this.pipePath = join(tmpdir(), `cmux-relay-${process.pid}.pipe`);
    this.onData = onData;
  }

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const pipeFile = this.pipePath;

      // Remove stale pipe if exists
      if (existsSync(pipeFile)) {
        try { unlinkSync(pipeFile); } catch { /* ignore */ }
      }

      // On macOS, use mkfifo shell command for a named pipe
      const mkfifoProc = spawn('mkfifo', [pipeFile]);
      mkfifoProc.on('exit', (code) => {
        if (code !== 0) {
          // Fallback: use a TCP server
          this.startTcpServer(resolve, reject);
          return;
        }

        // Start watching the named pipe
        this.watchPipe(pipeFile);
        resolve(pipeFile);
      });
      mkfifoProc.on('error', () => {
        this.startTcpServer(resolve, reject);
      });
    });
  }

  private startTcpServer(
    resolve: (path: string) => void,
    reject: (err: Error) => void,
  ): void {
    this.server = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        if (this.onData) this.onData(chunk);
      });
    });

    this.server.listen(0, '127.0.0.1', () => {
      const addr = this.server!.address() as { port: number };
      const tcpPath = `tcp://127.0.0.1:${addr.port}`;
      console.log(`PTY capture listening on ${tcpPath}`);
      resolve(tcpPath);
    });

    this.server.on('error', reject);
  }

  private watchPipe(pipePath: string): void {
    this.watching = true;
    const watch = () => {
      if (!this.watching) return;

      const cat = spawn('cat', [pipePath]);
      cat.stdout.on('data', (chunk: Buffer) => {
        if (this.onData) this.onData(chunk);
      });
      cat.on('exit', () => {
        // Re-open when the writer disconnects
        setTimeout(watch, 100);
      });
      cat.on('error', () => {
        setTimeout(watch, 1000);
      });
    };
    watch();
  }

  /**
   * Generate shell integration code that users source in their .zshrc/.bashrc
   */
  static getShellIntegration(capturePath: string): string {
    if (capturePath.startsWith('tcp://')) {
      const url = new URL(capturePath);
      return `
# cmux-relay PTY capture integration
if [ -n "$CMUX_RELAY_AGENT" ]; then
  _cmux_relay_capture() {
    printf '%s' "$1" | nc -q 0 ${url.hostname} ${url.port} 2>/dev/null || true
  }
fi
`;
    }
    return `
# cmux-relay PTY capture integration
if [ -n "$CMUX_RELAY_AGENT" ] && [ -p "${capturePath}" ]; then
  _cmux_relay_capture() {
    printf '%s' "$1" > "${capturePath}" 2>/dev/null || true
  }
fi
`;
  }

  stop(): void {
    this.watching = false;
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (existsSync(this.pipePath)) {
      try { unlinkSync(this.pipePath); } catch { /* ignore */ }
    }
  }
}
