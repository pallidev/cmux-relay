import { createConnection as createNetConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { PaneInfo, FrameRect, CmuxNotification } from '@cmux-relay/shared';

interface JsonRpcRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface CmuxWorkspace {
  id: string;
  title: string;
  index: number;
}

export interface CmuxSurface {
  id: string;
  title?: string;
  type: string;
  workspace_id: string;
}

export type CmuxConnectionState = 'disconnected' | 'connecting' | 'connected';

export class CmuxClient {
  private socketPath: string;
  private pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
  }>();
  private buffer = '';
  private sock: ReturnType<typeof createNetConnection> | null = null;
  private _state: CmuxConnectionState = 'disconnected';
  private onDisconnected?: () => void;

  constructor(socketPath?: string) {
    this.socketPath = socketPath || process.env.CMUX_SOCKET_PATH ||
      `${process.env.HOME}/Library/Application Support/cmux/cmux.sock`;
  }

  get state(): CmuxConnectionState {
    return this._state;
  }

  connect(onDisconnected?: () => void): Promise<void> {
    if (this._state === 'connecting' || this._state === 'connected') {
      return Promise.resolve();
    }
    this.onDisconnected = onDisconnected;

    return new Promise((resolve, reject) => {
      this._state = 'connecting';
      const sock = createNetConnection(this.socketPath);
      let settled = false;
      sock.on('connect', () => {
        console.log(`Connected to cmux socket: ${this.socketPath}`);
        this._state = 'connected';
        settled = true;
        resolve();
      });
      sock.on('error', (err) => {
        console.error(`cmux socket error: ${err.message}`);
        this._state = 'disconnected';
        if (!settled) {
          settled = true;
          reject(new Error(`Cannot connect to cmux socket at ${this.socketPath}: ${err.message}`));
        }
      });
      sock.on('close', () => {
        console.log('cmux socket closed');
        // Only reset state if this is still the active socket
        if (this.sock !== sock) return;
        const wasConnected = this._state === 'connected';
        this._state = 'disconnected';
        this.sock = null;
        // Reject all pending requests
        const entries = [...this.pending.values()];
        this.pending.clear();
        for (const pending of entries) {
          pending.reject(new Error('cmux socket closed'));
        }
        if (wasConnected && this.onDisconnected) {
          this.onDisconnected();
        }
      });
      sock.on('data', (chunk) => this.handleData(chunk.toString('utf-8')));

      this.sock = sock;
    });
  }

  isConnected(): boolean {
    return this._state === 'connected' && this.sock !== null && !this.sock.destroyed;
  }

  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const resp = JSON.parse(line) as JsonRpcResponse;
        if (resp.id) {
          const pending = this.pending.get(resp.id);
          if (pending) {
            this.pending.delete(resp.id);
            if (resp.ok) {
              pending.resolve(resp.result);
            } else {
              pending.reject(new Error(resp.error?.message || 'Unknown error'));
            }
          }
        }
        // Ignore notifications (responses without id)
      } catch {
        // ignore malformed lines
      }
    }
  }

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed || this._state !== 'connected') {
        reject(new Error('Not connected to cmux'));
        return;
      }

      const id = randomUUID();
      const req: JsonRpcRequest = { id, method, params: params || {} };
      this.pending.set(id, { resolve, reject });
      try {
        this.sock.write(JSON.stringify(req) + '\n');
      } catch (err) {
        this.pending.delete(id);
        reject(new Error(`Failed to write to cmux socket: ${err}`));
      }
    });
  }

  async listWorkspaces(): Promise<CmuxWorkspace[]> {
    const result = await this.send('workspace.list') as { workspaces: CmuxWorkspace[] };
    return result.workspaces || [];
  }

  async listSurfaces(workspaceId?: string): Promise<CmuxSurface[]> {
    const params: Record<string, unknown> = {};
    if (workspaceId) params.workspace_id = workspaceId;
    const result = await this.send('surface.list', params) as { surfaces: CmuxSurface[] };
    return result.surfaces || [];
  }

  async readTerminalText(surfaceId: string, scrollback = false): Promise<string> {
    const params: Record<string, unknown> = { surface_id: surfaceId };
    if (scrollback) params.scrollback = true;
    const result = await this.send('surface.read_text', params) as { base64: string };
    if (result.base64) {
      return Buffer.from(result.base64, 'base64').toString('utf-8');
    }
    return '';
  }

  async sendText(surfaceId: string, text: string): Promise<void> {
    await this.send('surface.send_text', { surface_id: surfaceId, text });
  }

  async sendKey(surfaceId: string, key: string): Promise<void> {
    await this.send('surface.send_key', { surface_id: surfaceId, key });
  }

  async listPanes(workspaceId?: string): Promise<{ panes: PaneInfo[]; containerFrame: FrameRect }> {
    const params: Record<string, unknown> = {};
    if (workspaceId) params.workspace_id = workspaceId;
    const result = await this.send('pane.list', params) as {
      panes: Array<{
        id?: string;
        ref?: string;
        index?: number;
        surface_ids: string[];
        selected_surface_id: string;
        columns?: number;
        rows?: number;
        cell_width_px?: number;
        cell_height_px?: number;
        pixel_frame: { x: number; y: number; width: number; height: number };
        focused: boolean;
      }>;
      container_frame?: { width: number; height: number };
      workspace_id?: string;
      workspace_ref?: string;
    };

    const wsId = workspaceId || result.workspace_id || '';
    const panes: PaneInfo[] = (result.panes || []).map((p, i) => ({
      id: p.id || p.ref || `pane-${i}`,
      index: p.index ?? i,
      surfaceIds: p.surface_ids,
      selectedSurfaceId: p.selected_surface_id,
      columns: p.columns || Math.floor(p.pixel_frame.width / (p.cell_width_px || 16)),
      rows: p.rows || Math.floor(p.pixel_frame.height / (p.cell_height_px || 34)),
      frame: p.pixel_frame,
      focused: p.focused,
      workspaceId: wsId,
    }));

    const containerFrame: FrameRect = {
      x: 0,
      y: 0,
      width: result.container_frame?.width ?? 1,
      height: result.container_frame?.height ?? 1,
    };

    return { panes, containerFrame };
  }

  async listNotifications(): Promise<CmuxNotification[]> {
    const result = await this.send('notification.list') as {
      notifications: Array<{
        id: string;
        title: string;
        subtitle?: string;
        body?: string;
        surface_id?: string;
        workspace_id?: string;
        is_read?: boolean;
      }>;
    };
    return (result.notifications || []).map(n => ({
      id: n.id,
      title: n.title,
      subtitle: n.subtitle || '',
      body: n.body || '',
      surfaceId: n.surface_id || '',
      workspaceId: n.workspace_id || '',
      isRead: n.is_read ?? false,
    }));
  }

  disconnect(): void {
    this._state = 'disconnected';
    if (this.sock) {
      this.sock.destroy();
      this.sock = null;
    }
  }
}
