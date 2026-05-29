import { ChildProcess, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { Writable, Readable } from 'node:stream';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import type {
  Client,
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { AcpAgentConfig } from '@cmux-relay/shared';
import type { RelayToClient } from '@cmux-relay/shared';
import type { CmuxClient } from './cmux-client.js';

interface SurfaceSession {
  acpSessionId: string;
  history: SessionUpdate[];
  isPrompting: boolean;
  replaying: boolean;
  cwd?: string;
}

export interface AcpSender {
  broadcast: (msg: RelayToClient) => void;
  sendToSurface: (surfaceId: string, msg: RelayToClient) => void;
}

const PERMISSION_TIMEOUT_MS = 60_000;
const MAX_TERMINAL_CONTEXT_CHARS = 4000;
const RELAY_DIR = join(homedir(), '.cmux-relay');
const HISTORY_DIR = join(RELAY_DIR, 'acp-history');
const LEGACY_HISTORY_FILE = join(RELAY_DIR, 'acp-history.json');

export class AcpManager {
  private agentProcess: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private sender: AcpSender;
  private config: AcpAgentConfig;
  private cmux: CmuxClient | null;
  private sessions = new Map<string, SurfaceSession>(); // surfaceId → session
  private acpToSurface = new Map<string, string>(); // acpSessionId → surfaceId
  private pendingPermissions = new Map<string, {
    resolve: (response: RequestPermissionResponse) => void;
    timer: ReturnType<typeof setTimeout>;
    surfaceId: string;
  }>();
  private agentStatus: 'starting' | 'ready' | 'error' = 'starting';
  private agentError: string | undefined;
  private agentCapabilities: unknown = {};

  constructor(config: AcpAgentConfig, sender: AcpSender, cmux?: CmuxClient) {
    this.config = config;
    this.sender = sender;
    this.cmux = cmux ?? null;
  }

  async initialize(): Promise<void> {
    this.sendStatus('starting');

    try {
      this.agentProcess = spawn(this.config.command, this.config.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.config.env },
      });

      this.agentProcess.stderr?.on('data', (data: Buffer) => {
        process.stderr.write(data);
      });

      this.agentProcess.on('exit', (code) => {
        console.error(`[acp] Agent process exited with code ${code}`);
        this.agentError = `Agent process exited with code ${code}`;
        this.sendStatus('error');
        this.connection = null;
      });

      if (!this.agentProcess.stdin || !this.agentProcess.stdout) {
        throw new Error('Failed to create stdio pipes');
      }

      const input = Writable.toWeb(this.agentProcess.stdin);
      const output = Readable.toWeb(this.agentProcess.stdout) as ReadableStream<Uint8Array>;

      const stream = ndJsonStream(input, output);
      const client: Client = {
        sessionUpdate: (params) => this.handleSessionUpdate(params),
        requestPermission: (params) => this.handleRequestPermission(params),
        writeTextFile: (params) => this.handleWriteTextFile(params),
        readTextFile: (params) => this.handleReadTextFile(params),
      };

      this.connection = new ClientSideConnection(() => client, stream);

      const initResult: InitializeResponse = await this.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      });

      this.agentCapabilities = initResult.agentCapabilities;

      console.log(`[acp] Initialized: protocol v${initResult.protocolVersion}, agent=${initResult.agentInfo?.name ?? this.config.name}`);

      this.sendStatus('ready');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[acp] Initialization failed: ${message}`);
      this.agentError = message;
      this.sendStatus('error');
    }
  }

  private sendStatus(status: 'starting' | 'ready' | 'error'): void {
    this.agentStatus = status;
    this.sender.broadcast({
      type: 'acp.agent_status',
      status,
      agentName: this.config.name,
      ...(status === 'error' && this.agentError ? { error: this.agentError } : {}),
    });
  }

  /** Extract working directory for a surface. */
  private async getSurfaceCwd(surfaceId: string): Promise<string | undefined> {
    // Strategy 1: Parse shell prompt from terminal text
    const terminalCwd = await this.getTerminalCwd(surfaceId);
    if (terminalCwd) return terminalCwd;

    // Strategy 2: Find most recently used Claude Code project
    const claudeCwd = await this.getRecentClaudeProject();
    if (claudeCwd) {
      console.log(`[acp] getSurfaceCwd: using recent Claude project "${claudeCwd}"`);
      return claudeCwd;
    }

    return undefined;
  }

  /** Parse cwd from terminal prompt text. */
  private async getTerminalCwd(surfaceId: string): Promise<string | undefined> {
    if (!this.cmux) return undefined;
    try {
      const text = await this.cmux.readTerminalText(surfaceId);
      if (!text) return undefined;

      // Strip ANSI escape codes
      const clean = text
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/\x1b\].*?\x07/g, '')
        .replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '');

      const lines = clean.split('\n').filter(l => l.trim());
      console.log(`[acp] getTerminalCwd: last 3 lines for surface ${surfaceId}:`);
      for (let i = Math.max(0, lines.length - 3); i < lines.length; i++) {
        console.log(`[acp]   "${lines[i]}"`);
      }

      // Walk backwards to find a line that looks like a shell prompt
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];

        // Pattern 1: Full/tilde path before prompt char (/path $, ~/path %, etc.)
        const pathMatch = line.match(/(~?\/[^\s\x1b`$%#>"']+)\s*[$%#>]\s*$/);
        if (pathMatch) {
          let path = pathMatch[1];
          if (path.startsWith('~')) path = path.replace('~', homedir());
          console.log(`[acp] getTerminalCwd: extracted "${path}" from prompt`);
          return path;
        }

        // Pattern 2: user@host dirname %  (zsh default)
        const zshMatch = line.match(/@\S+\s+(\S+)\s*[%$#]\s*$/);
        if (zshMatch) {
          const dir = zshMatch[1];
          if (!dir.startsWith('(') && !dir.startsWith('-')) {
            let path = dir.startsWith('~') ? dir.replace('~', homedir()) : join(homedir(), dir);
            try {
              if (statSync(path).isDirectory()) {
                console.log(`[acp] getTerminalCwd: resolved "${path}" from zsh prompt`);
                return path;
              }
            } catch { /* not a valid dir */ }
          }
        }
      }
      console.log(`[acp] getTerminalCwd: no cwd found in terminal text`);
    } catch (err) {
      console.log(`[acp] getTerminalCwd failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return undefined;
  }

  /** Find the most recently used Claude Code project directory. */
  private async getRecentClaudeProject(): Promise<string | undefined> {
    try {
      const { readdirSync, statSync } = await import('node:fs');
      const claudeDir = join(homedir(), '.claude', 'projects');
      const entries = readdirSync(claudeDir, { withFileTypes: true });
      let latestPath: string | undefined;
      let latestTime = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Decode path: "-Users-jonginkim-my-project" → "/Users/jonginkim/my-project"
        const decoded = entry.name.replace(/^-/, '/').replace(/-/g, '/');
        try {
          const st = statSync(join(claudeDir, entry.name));
          if (st.mtimeMs > latestTime) {
            latestTime = st.mtimeMs;
            latestPath = decoded;
          }
        } catch { /* skip */ }
      }
      return latestPath;
    } catch {
      return undefined;
    }
  }

  /** Ensure a session exists for the given surface. Creates one lazily if needed. */
  async ensureSession(surfaceId: string, cwd?: string): Promise<void> {
    if (this.sessions.has(surfaceId)) return;
    if (!this.connection) return;

    try {
      // Load persisted history for cwd resolution and session restoration
      const persisted = await this.loadSurfaceHistory(surfaceId);

      // Resolve cwd: explicit param > terminal prompt > persisted disk > process.cwd()
      if (!cwd) {
        cwd = await this.getSurfaceCwd(surfaceId) || persisted?.cwd || process.cwd();
      }

      // Try to resume a persisted session for this surface
      if (persisted?.sessionId) {
        try {
          const acpSessionId = persisted.sessionId;
          // Set mapping before loadSession so sessionUpdate callbacks during replay route correctly
          this.acpToSurface.set(acpSessionId, surfaceId);
          const surfaceSession: SurfaceSession = {
            acpSessionId,
            history: [],
            isPrompting: false,
            replaying: true,
          };
          this.sessions.set(surfaceId, surfaceSession);

          await this.connection.loadSession({
            sessionId: acpSessionId,
            cwd: cwd || process.cwd(),
            mcpServers: [],
          });
          surfaceSession.replaying = false;

          // If loadSession didn't replay history, restore from disk
          if (surfaceSession.history.length === 0) {
            surfaceSession.history = persisted.history;
          }
          console.log(`[acp] Loaded session for surface ${surfaceId}: ${acpSessionId} (${surfaceSession.history.length} history entries)`);
        } catch {
          // loadSession failed, try resume
          try {
            await this.connection.resumeSession({
              sessionId: persisted.sessionId,
              cwd: cwd || process.cwd(),
            });
            // Restore history from disk since resumeSession doesn't replay
            const ss = this.sessions.get(surfaceId)!;
            ss.history = persisted.history;
            console.log(`[acp] Resumed session for surface ${surfaceId}: ${persisted.sessionId}`);
          } catch {
            // Persisted session no longer exists in agent — try listing available sessions
            this.sessions.delete(surfaceId);
            this.acpToSurface.delete(persisted.sessionId);
            await this.tryLoadExistingSession(surfaceId, cwd);
            // Restore disk history only if the new session has no replay data
            const newSession = this.sessions.get(surfaceId);
            if (newSession && newSession.history.length === 0 && persisted.history.length > 0) {
              newSession.history = persisted.history;
              console.log(`[acp] Restored ${persisted.history.length} history entries from disk for surface ${surfaceId} (new ACP session: ${newSession.acpSessionId})`);
            }
          }
        }
      } else {
        // No per-surface history — try to load the most recent agent session
        // (first surface to request gets the existing conversation)
        await this.tryLoadExistingSession(surfaceId, cwd);
      }

      // Notify web client about the new session
      const session = this.sessions.get(surfaceId);
      if (session) {
        // Persist cwd for future session restoration
        session.cwd = cwd;
        this.persistSurfaceHistory(surfaceId);

        this.sender.sendToSurface(surfaceId, {
          type: 'acp.session.created',
          sessionId: session.acpSessionId,
          surfaceId,
          capabilities: this.agentCapabilities,
        });

        // Replay any loaded history
        for (const update of session.history) {
          this.sender.sendToSurface(surfaceId, {
            type: 'acp.session_update',
            sessionId: session.acpSessionId,
            surfaceId,
            update,
          });
        }

        // Migrate legacy history if session is empty (new session) and legacy file exists
        if (session.history.length === 0) {
          await this.migrateLegacyHistory(surfaceId, session);
        }
      }
    } catch (err) {
      console.error(`[acp] ensureSession failed for surface ${surfaceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Try to load the most recent existing session from the agent for a surface. */
  private async tryLoadExistingSession(surfaceId: string, cwd?: string): Promise<void> {
    if (!this.connection) return;

    // Don't steal a session already assigned to another surface
    const usedSessionIds = new Set([...this.sessions.values()].map(s => s.acpSessionId));

    try {
      const listResult = await this.connection.listSessions({ cwd: cwd || process.cwd() });
      if (listResult.sessions.length > 0) {
        const sorted = listResult.sessions.sort((a, b) => {
          const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return bTime - aTime;
        });

        // Find the most recent session not already claimed by another surface
        const unclaimed = sorted.find(s => !usedSessionIds.has(s.sessionId));
        if (unclaimed) {
          try {
            this.acpToSurface.set(unclaimed.sessionId, surfaceId);
            const session: SurfaceSession = {
              acpSessionId: unclaimed.sessionId,
              history: [],
              isPrompting: false,
              replaying: true,
            };
            this.sessions.set(surfaceId, session);
            await this.connection.loadSession({
              sessionId: unclaimed.sessionId,
              cwd: cwd || process.cwd(),
              mcpServers: [],
            });
            session.replaying = false;
            console.log(`[acp] Loaded existing session for surface ${surfaceId}: ${unclaimed.sessionId} (${unclaimed.title ?? 'untitled'}, ${session.history.length} history entries)`);
            return;
          } catch {
            // loadSession failed, try resume
            try {
              await this.connection.resumeSession({
                sessionId: unclaimed.sessionId,
                cwd: cwd || process.cwd(),
              });
              console.log(`[acp] Resumed existing session for surface ${surfaceId}: ${unclaimed.sessionId}`);
              return;
            } catch {
              // Both failed, fall through to new session
              this.sessions.delete(surfaceId);
              this.acpToSurface.delete(unclaimed.sessionId);
            }
          }
        }
      }
    } catch {
      // listSessions not supported
    }

    await this.createNewSession(surfaceId, cwd);
  }

  private async createNewSession(surfaceId: string, cwd?: string): Promise<void> {
    if (!this.connection) return;

    const result: NewSessionResponse = await this.connection.newSession({
      cwd: cwd || process.cwd(),
      mcpServers: [],
    });

    const surfaceSession: SurfaceSession = {
      acpSessionId: result.sessionId,
      history: [],
      isPrompting: false,
      replaying: false,
    };
    this.sessions.set(surfaceId, surfaceSession);
    this.acpToSurface.set(result.sessionId, surfaceId);
    console.log(`[acp] New session for surface ${surfaceId}: ${result.sessionId}`);
  }

  /** Resend ACP state to newly connected clients. */
  resendState(): void {
    if (this.agentStatus === 'starting') return;
    this.sendStatus(this.agentStatus);

    // Resend all surface sessions
    for (const [surfaceId, session] of this.sessions) {
      this.sender.sendToSurface(surfaceId, {
        type: 'acp.session.created',
        sessionId: session.acpSessionId,
        surfaceId,
        capabilities: this.agentCapabilities,
      });
      for (const update of session.history) {
        this.sender.sendToSurface(surfaceId, {
          type: 'acp.session_update',
          sessionId: session.acpSessionId,
          surfaceId,
          update,
        });
      }
    }
  }

  private async handleSessionUpdate(params: SessionNotification): Promise<void> {
    const surfaceId = this.acpToSurface.get(params.sessionId);
    if (!surfaceId) {
      console.log(`[acp] sessionUpdate for unknown session ${params.sessionId}, dropping`);
      return;
    }

    const session = this.sessions.get(surfaceId);
    if (!session) return;

    session.history.push(params.update);
    if (!session.replaying) {
      this.persistSurfaceHistory(surfaceId);
    }

    if (session.replaying) return;
    this.sender.sendToSurface(surfaceId, {
      type: 'acp.session_update',
      sessionId: params.sessionId,
      surfaceId,
      update: params.update,
    });
  }

  private persistSurfaceHistory(surfaceId: string): void {
    const session = this.sessions.get(surfaceId);
    if (!session) return;

    mkdir(HISTORY_DIR, { recursive: true }).then(() => {
      writeFile(
        join(HISTORY_DIR, `${surfaceId}.json`),
        JSON.stringify({ sessionId: session.acpSessionId, history: session.history, cwd: session.cwd }),
        'utf-8',
      ).catch(() => {});
    }).catch(() => {});
  }

  /** Migrate legacy single-session history to first surface that requests a session. */
  private async migrateLegacyHistory(surfaceId: string, session: SurfaceSession): Promise<void> {
    try {
      const data = await readFile(LEGACY_HISTORY_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (!parsed.history || !Array.isArray(parsed.history) || parsed.history.length === 0) return;

      console.log(`[acp] Migrating ${parsed.history.length} legacy history entries to surface ${surfaceId}`);
      session.history = parsed.history;

      // Replay to web client
      for (const update of session.history) {
        this.sender.sendToSurface(surfaceId, {
          type: 'acp.session_update',
          sessionId: session.acpSessionId,
          surfaceId,
          update,
        });
      }

      this.persistSurfaceHistory(surfaceId);

      // Rename legacy file so it's only used once
      await rename(LEGACY_HISTORY_FILE, LEGACY_HISTORY_FILE + '.migrated');
    } catch {
      // No legacy file or parse error — that's fine
    }
  }

  private async loadSurfaceHistory(surfaceId: string): Promise<{ sessionId: string; history: SessionUpdate[]; cwd?: string } | null> {
    try {
      const data = await readFile(join(HISTORY_DIR, `${surfaceId}.json`), 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed.sessionId && Array.isArray(parsed.history)) {
        return { sessionId: parsed.sessionId, history: parsed.history, cwd: parsed.cwd };
      }
    } catch {
      // No persisted history for this surface
    }
    return null;
  }

  private handleRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return new Promise((resolve) => {
      const surfaceId = this.acpToSurface.get(params.sessionId);
      if (!surfaceId) {
        resolve({ outcome: { outcome: 'cancelled' } });
        return;
      }

      const requestId = params.toolCall.toolCallId;

      this.sender.sendToSurface(surfaceId, {
        type: 'acp.permission_request',
        sessionId: params.sessionId,
        surfaceId,
        requestId,
        toolName: params.toolCall.title ?? 'Unknown tool',
        toolCallId: params.toolCall.toolCallId,
        options: params.options,
      });

      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        resolve({ outcome: { outcome: 'cancelled' } });
      }, PERMISSION_TIMEOUT_MS);

      this.pendingPermissions.set(requestId, { resolve, timer, surfaceId });
    });
  }

  private async handleWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    try {
      await writeFile(params.path, params.content, 'utf-8');
      return {};
    } catch (err) {
      throw new Error(`Failed to write file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    try {
      const content = await readFile(params.path, 'utf-8');
      return { content };
    } catch (err) {
      throw new Error(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async handlePrompt(text: string, surfaceId: string): Promise<void> {
    console.log(`[acp] handlePrompt: surface=${surfaceId}, text="${text.slice(0, 50)}..."`);
    await this.ensureSession(surfaceId);

    const session = this.sessions.get(surfaceId);
    if (!this.connection || !session) {
      console.error('[acp] Cannot prompt: no active session for surface');
      return;
    }
    if (session.isPrompting) {
      console.warn('[acp] Prompt already in progress for this surface, ignoring');
      return;
    }

    // Inject terminal context if available
    let promptText = text;
    if (this.cmux) {
      try {
        const terminal = await this.cmux.readTerminalText(surfaceId);
        if (terminal) {
          const truncated = terminal.length > MAX_TERMINAL_CONTEXT_CHARS
            ? '[...truncated...]\n' + terminal.slice(-MAX_TERMINAL_CONTEXT_CHARS)
            : terminal;
          promptText = `<terminal-context>\n${truncated}\n</terminal-context>\n\n${text}`;
          console.log(`[acp] Injected terminal context (${terminal.length} chars) for surface ${surfaceId}`);
        }
      } catch {
        // Terminal read failed — send prompt without context
      }
    }

    console.log(`[acp] Sending prompt to session ${session.acpSessionId}`);

    session.isPrompting = true;
    try {
      const result: PromptResponse = await this.connection.prompt({
        sessionId: session.acpSessionId,
        prompt: [{ type: 'text', text: promptText }],
      });

      this.sender.sendToSurface(surfaceId, {
        type: 'acp.session_complete',
        sessionId: session.acpSessionId,
        surfaceId,
        stopReason: result.stopReason,
      });
    } catch (err) {
      console.error(`[acp] Prompt failed: ${err instanceof Error ? err.message : String(err)}`);
      this.sender.sendToSurface(surfaceId, {
        type: 'acp.session_complete',
        sessionId: session.acpSessionId,
        surfaceId,
        stopReason: 'error',
      });
    } finally {
      session.isPrompting = false;
    }
  }

  handlePermissionResponse(requestId: string, outcome: string): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingPermissions.delete(requestId);
    pending.resolve({
      outcome: { outcome: 'selected', optionId: outcome },
    });
  }

  async handleCancel(surfaceId: string): Promise<void> {
    const session = this.sessions.get(surfaceId);
    if (!this.connection || !session) return;
    await this.connection.cancel({ sessionId: session.acpSessionId });
  }

  async handleNewSession(surfaceId: string, cwd?: string): Promise<void> {
    if (this.sessions.has(surfaceId)) {
      const session = this.sessions.get(surfaceId)!;
      this.sender.sendToSurface(surfaceId, {
        type: 'acp.session.created',
        sessionId: session.acpSessionId,
        surfaceId,
        capabilities: this.agentCapabilities,
      });
      for (const update of session.history) {
        this.sender.sendToSurface(surfaceId, {
          type: 'acp.session_update',
          sessionId: session.acpSessionId,
          surfaceId,
          update,
        });
      }
      return;
    }
    await this.ensureSession(surfaceId, cwd);
  }

  /** Check if a session exists for the given surface. */
  hasSession(surfaceId: string): boolean {
    return this.sessions.has(surfaceId);
  }

  async dispose(): Promise<void> {
    for (const [id, pending] of this.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.pendingPermissions.clear();

    if (this.agentProcess) {
      this.agentProcess.stderr?.removeAllListeners();
      this.agentProcess.kill();
      this.agentProcess = null;
    }
    this.connection = null;
    this.sessions.clear();
    this.acpToSurface.clear();
  }
}
