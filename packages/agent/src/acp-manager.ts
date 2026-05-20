import { ChildProcess, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { Writable, Readable } from 'node:stream';
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

type SendToWeb = (msg: RelayToClient) => void;

const PERMISSION_TIMEOUT_MS = 60_000;

export class AcpManager {
  private agentProcess: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private acpSessionId: string | null = null;
  private sendToWeb: SendToWeb;
  private config: AcpAgentConfig;
  private pendingPermissions = new Map<string, {
    resolve: (response: RequestPermissionResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private isPrompting = false;
  private agentStatus: 'starting' | 'ready' | 'error' = 'starting';
  private agentError: string | undefined;
  private sessionHistory: SessionUpdate[] = [];

  constructor(config: AcpAgentConfig, sendToWeb: SendToWeb) {
    this.config = config;
    this.sendToWeb = sendToWeb;
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

      console.log(`[acp] Initialized: protocol v${initResult.protocolVersion}, agent=${initResult.agentInfo?.name ?? this.config.name}`);

      // Try to resume the most recent session, fall back to new session
      await this.resumeOrCreateSession();

      this.sendToWeb({
        type: 'acp.session.created',
        sessionId: this.acpSessionId!,
        capabilities: initResult.agentCapabilities,
      });

      this.sendStatus('ready');

      console.log(`[acp] Session active: ${this.acpSessionId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[acp] Initialization failed: ${message}`);
      this.agentError = message;
      this.sendStatus('error');
    }
  }

  private sendStatus(status: 'starting' | 'ready' | 'error'): void {
    this.agentStatus = status;
    this.sendToWeb({
      type: 'acp.agent_status',
      status,
      agentName: this.config.name,
      ...(status === 'error' && this.agentError ? { error: this.agentError } : {}),
    });
  }

  /** Resend current ACP state to newly connected clients. */
  resendState(): void {
    if (this.agentStatus === 'starting' && !this.acpSessionId) return;
    this.sendStatus(this.agentStatus);
    if (this.acpSessionId) {
      this.sendToWeb({
        type: 'acp.session.created',
        sessionId: this.acpSessionId,
        capabilities: {},
      });
      // Replay session history so new clients see the conversation
      for (const update of this.sessionHistory) {
        this.sendToWeb({
          type: 'acp.session_update',
          sessionId: this.acpSessionId,
          update,
        });
      }
    }
  }

  private async handleSessionUpdate(params: SessionNotification): Promise<void> {
    if (!this.acpSessionId) return;
    this.sessionHistory.push(params.update);
    this.sendToWeb({
      type: 'acp.session_update',
      sessionId: this.acpSessionId,
      update: params.update,
    });
  }

  private handleRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return new Promise((resolve) => {
      if (!this.acpSessionId) {
        resolve({ outcome: { outcome: 'cancelled' } });
        return;
      }

      const requestId = params.toolCall.toolCallId;

      this.sendToWeb({
        type: 'acp.permission_request',
        sessionId: this.acpSessionId,
        requestId,
        toolName: params.toolCall.title ?? 'Unknown tool',
        toolCallId: params.toolCall.toolCallId,
        options: params.options,
      });

      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        resolve({ outcome: { outcome: 'cancelled' } });
      }, PERMISSION_TIMEOUT_MS);

      this.pendingPermissions.set(requestId, { resolve, timer });
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

  async handlePrompt(text: string): Promise<void> {
    if (!this.connection || !this.acpSessionId) {
      console.error('[acp] Cannot prompt: no active session');
      return;
    }
    if (this.isPrompting) {
      console.warn('[acp] Prompt already in progress, ignoring');
      return;
    }

    this.isPrompting = true;
    try {
      const result: PromptResponse = await this.connection.prompt({
        sessionId: this.acpSessionId,
        prompt: [{ type: 'text', text }],
      });

      this.sendToWeb({
        type: 'acp.session_complete',
        sessionId: this.acpSessionId,
        stopReason: result.stopReason,
      });
    } catch (err) {
      console.error(`[acp] Prompt failed: ${err instanceof Error ? err.message : String(err)}`);
      this.sendToWeb({
        type: 'acp.session_complete',
        sessionId: this.acpSessionId ?? '',
        stopReason: 'error',
      });
    } finally {
      this.isPrompting = false;
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

  async handleCancel(): Promise<void> {
    if (!this.connection || !this.acpSessionId) return;
    await this.connection.cancel({ sessionId: this.acpSessionId });
  }

  async handleNewSession(cwd?: string): Promise<void> {
    if (!this.connection) return;

    try {
      const result = await this.connection.newSession({
        cwd: cwd || process.cwd(),
        mcpServers: [],
      });
      this.acpSessionId = result.sessionId;
      this.sessionHistory = [];

      this.sendToWeb({
        type: 'acp.session.created',
        sessionId: this.acpSessionId,
        capabilities: {},
      });
    } catch (err) {
      console.error(`[acp] New session failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async resumeOrCreateSession(): Promise<void> {
    if (!this.connection) return;

    try {
      // listSessions may not be supported — check capabilities
      const listResult = await this.connection.listSessions({
        cwd: process.cwd(),
      });

      if (listResult.sessions.length > 0) {
        // Pick the most recently updated session
        const sorted = listResult.sessions.sort((a, b) => {
          const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return bTime - aTime;
        });
        const latest = sorted[0];

        try {
          // Prefer loadSession — replays conversation history through sessionUpdate
          await this.connection.loadSession({
            sessionId: latest.sessionId,
            cwd: process.cwd(),
            mcpServers: [],
          });
          this.acpSessionId = latest.sessionId;
          console.log(`[acp] Loaded session with history: ${this.acpSessionId} (${latest.title ?? 'untitled'})`);
          return;
        } catch {
          // loadSession not supported, try resumeSession (no history)
          try {
            await this.connection.resumeSession({
              sessionId: latest.sessionId,
              cwd: process.cwd(),
            });
            this.acpSessionId = latest.sessionId;
            console.log(`[acp] Resumed session (no history): ${this.acpSessionId} (${latest.title ?? 'untitled'})`);
            return;
          } catch {
            // Both failed, fall through to newSession
          }
        }
      }
    } catch (err) {
      // listSessions not supported or failed — that's fine, create new
      console.log(`[acp] Session list unavailable, creating new session`);
    }

    // Fall back to creating a new session
    const sessionResult: NewSessionResponse = await this.connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    this.acpSessionId = sessionResult.sessionId;
    console.log(`[acp] New session created: ${this.acpSessionId}`);
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
    this.acpSessionId = null;
  }
}
