import { ChildProcess, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
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

interface SurfaceSession {
  acpSessionId: string;
  history: SessionUpdate[];
  isPrompting: boolean;
}

export interface AcpSender {
  broadcast: (msg: RelayToClient) => void;
  sendToSurface: (surfaceId: string, msg: RelayToClient) => void;
}

const PERMISSION_TIMEOUT_MS = 60_000;
const RELAY_DIR = join(homedir(), '.cmux-relay');
const HISTORY_DIR = join(RELAY_DIR, 'acp-history');
const LEGACY_HISTORY_FILE = join(RELAY_DIR, 'acp-history.json');

export class AcpManager {
  private agentProcess: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private sender: AcpSender;
  private config: AcpAgentConfig;
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

  constructor(config: AcpAgentConfig, sender: AcpSender) {
    this.config = config;
    this.sender = sender;
  }

  async initialize(): Promise<void> {
    this.sendStatus('starting');

    try {
      this.agentProcess = spawn(this.config.command, this.config.args, {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env, ...this.config.env },
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

  /** Ensure a session exists for the given surface. Creates one lazily if needed. */
  async ensureSession(surfaceId: string, cwd?: string): Promise<void> {
    if (this.sessions.has(surfaceId)) return;
    if (!this.connection) return;

    try {
      // Try to resume a persisted session for this surface
      const persisted = await this.loadSurfaceHistory(surfaceId);
      if (persisted?.sessionId) {
        try {
          // Set mapping before loadSession so sessionUpdate callbacks during replay route correctly
          const acpSessionId = persisted.sessionId;
          this.acpToSurface.set(acpSessionId, surfaceId);
          const surfaceSession: SurfaceSession = {
            acpSessionId,
            history: [],
            isPrompting: false,
          };
          this.sessions.set(surfaceId, surfaceSession);

          await this.connection.loadSession({
            sessionId: acpSessionId,
            cwd: cwd || process.cwd(),
            mcpServers: [],
          });
          console.log(`[acp] Loaded session for surface ${surfaceId}: ${acpSessionId} (${persisted.history.length} history entries from disk)`);
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
            this.sessions.set(surfaceId, {
              acpSessionId: unclaimed.sessionId,
              history: [],
              isPrompting: false,
            });
            await this.connection.loadSession({
              sessionId: unclaimed.sessionId,
              cwd: cwd || process.cwd(),
              mcpServers: [],
            });
            console.log(`[acp] Loaded existing session for surface ${surfaceId}: ${unclaimed.sessionId} (${unclaimed.title ?? 'untitled'})`);
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
    this.persistSurfaceHistory(surfaceId);

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
        JSON.stringify({ sessionId: session.acpSessionId, history: session.history }),
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

  private async loadSurfaceHistory(surfaceId: string): Promise<{ sessionId: string; history: SessionUpdate[] } | null> {
    try {
      const data = await readFile(join(HISTORY_DIR, `${surfaceId}.json`), 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed.sessionId && Array.isArray(parsed.history)) {
        return { sessionId: parsed.sessionId, history: parsed.history };
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
    console.log(`[acp] Sending prompt to session ${session.acpSessionId}`);

    session.isPrompting = true;
    try {
      const result: PromptResponse = await this.connection.prompt({
        sessionId: session.acpSessionId,
        prompt: [{ type: 'text', text }],
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
      this.agentProcess.kill();
      this.agentProcess = null;
    }
    this.connection = null;
    this.sessions.clear();
    this.acpToSurface.clear();
  }
}
