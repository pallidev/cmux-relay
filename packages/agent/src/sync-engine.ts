import type { CmuxClient, CmuxWorkspace, CmuxSurface } from './cmux-client.js';
import type { SessionStore } from './session-store.js';
import type { WorkspaceInfo, SurfaceInfo, PaneInfo, RelayToClient } from '@cmux-relay/shared';

/**
 * Abstraction over how messages reach clients.
 * LocalBroadcaster uses SessionStore's WebSocket clients.
 * CloudBroadcaster sends through the relay connection.
 */
export interface Broadcaster {
  broadcast(msg: RelayToClient): void;
  sendToSurface(surfaceId: string, msg: RelayToClient): void;
}

/** Options for terminal polling */
export interface TerminalPollOptions {
  /** Returns the currently active surface id(s) — only these are polled. */
  getActiveSurfaceIds: () => Set<string>;
  /** Returns the surface id handled by PTY capture (skipped during polling). */
  getPtySurfaceId: () => string | null;
}

/**
 * Unified sync engine that replaces the duplicated syncAll/pollNotifications/pollTerminal
 * logic previously inlined in both local and cloud mode.
 */
export class SyncEngine {
  private cmux: CmuxClient;
  private store: SessionStore;
  private broadcaster: Broadcaster;
  private knownNotificationIds = new Set<string>();
  private firstNotificationPoll = true;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private notificationInterval: ReturnType<typeof setInterval> | null = null;
  private terminalInterval: ReturnType<typeof setInterval> | null = null;
  private pollRunning = false;
  private lastOutput = new Map<string, string>();
  private hasClientsCheck: (() => boolean) | null;

  constructor(
    cmux: CmuxClient,
    store: SessionStore,
    broadcaster: Broadcaster,
    options?: { hasClients?: () => boolean },
  ) {
    this.cmux = cmux;
    this.store = store;
    this.broadcaster = broadcaster;
    this.hasClientsCheck = options?.hasClients ?? null;
  }

  // ─── Full sync ───

  async syncAll(): Promise<void> {
    try {
      if (!this.cmux.isConnected()) return;

      const workspaces = await this.cmux.listWorkspaces();
      const wsInfos: WorkspaceInfo[] = workspaces.map(w => ({
        id: w.id,
        title: w.title,
      }));

      this.store.updateWorkspaces(wsInfos);

      for (const w of workspaces) {
        const surfaces = await this.cmux.listSurfaces(w.id);
        const surfInfos: SurfaceInfo[] = surfaces.map(s => ({
          id: s.id,
          title: s.title || '',
          type: s.type,
          workspaceId: w.id,
        }));
        this.store.updateSurfaces(w.id, surfInfos);
        this.broadcaster.broadcast({
          type: 'surfaces',
          workspaceId: w.id,
          payload: { surfaces: surfInfos },
        });
      }

      this.broadcaster.broadcast({
        type: 'workspaces',
        payload: { workspaces: this.store.getAllWorkspaces() },
      });

      for (const w of workspaces) {
        try {
          const { panes, containerFrame } = await this.cmux.listPanes(w.id);
          const typedPanes: PaneInfo[] = panes.map(p => ({
            ...p,
            workspaceId: w.id,
          }));
          this.store.updatePanesForWorkspace(w.id, typedPanes, containerFrame);
          this.broadcaster.broadcast({
            type: 'panes',
            workspaceId: w.id,
            payload: { panes: typedPanes, containerFrame },
          });
        } catch (err) {
          console.error(`Failed to sync panes for workspace ${w.id}:`, err);
        }
      }
    } catch (err) {
      console.error('Failed to sync:', err);
    }
  }

  // ─── Periodic sync ───

  startPeriodicSync(interval: number): void {
    this.syncInterval = setInterval(() => { void this.syncAll(); }, interval);
  }

  // ─── Notification polling ───

  async pollNotifications(): Promise<void> {
    try {
      if (!this.cmux.isConnected()) return;
      const notifications = await this.cmux.listNotifications();
      const newNotifications = notifications.filter(n => !this.knownNotificationIds.has(n.id));

      this.knownNotificationIds.clear();
      for (const n of notifications) {
        this.knownNotificationIds.add(n.id);
      }

      this.store.updateNotifications(notifications);
      if (!this.firstNotificationPoll && newNotifications.length > 0) {
        console.log(`New cmux notifications: ${newNotifications.map(n => n.title).join(', ')}`);
        this.broadcaster.broadcast({
          type: 'notifications',
          payload: { notifications: newNotifications },
        });
      }
      this.firstNotificationPoll = false;
    } catch {
      // ignore polling errors
    }
  }

  startPollNotifications(interval: number): void {
    this.notificationInterval = setInterval(() => { void this.pollNotifications(); }, interval);
  }

  // ─── Terminal polling ───

  async pollTerminal(options: TerminalPollOptions): Promise<void> {
    if (this.pollRunning) return;
    this.pollRunning = true;
    try {
      if (!this.cmux.isConnected()) return;
      if (this.hasClientsCheck && !this.hasClientsCheck()) return;

      const activeIds = options.getActiveSurfaceIds();
      if (activeIds.size === 0) return;

      const ptySurfaceId = options.getPtySurfaceId();

      for (const surfaceId of activeIds) {
        if (surfaceId === ptySurfaceId) continue;
        const surface = this.store.getSurface(surfaceId);
        if (surface?.type === 'terminal') {
          const text = await this.cmux.readTerminalText(surfaceId);
          if (text) {
            const b64 = Buffer.from(text).toString('base64');
            if (this.lastOutput.get(surfaceId) !== b64) {
              this.lastOutput.set(surfaceId, b64);
              this.broadcaster.sendToSurface(surfaceId, {
                type: 'output',
                surfaceId,
                payload: { data: b64 },
              });
            }
          }
        }
      }
    } catch {
      // ignore polling errors
    } finally {
      this.pollRunning = false;
    }
  }

  startPollTerminal(interval: number, options: TerminalPollOptions): void {
    this.terminalInterval = setInterval(() => { void this.pollTerminal(options); }, interval);
  }

  // ─── Output dedup ───

  /** Clear output dedup state (e.g. when a new client connects) */
  clearLastOutput(): void {
    this.lastOutput.clear();
  }

  // ─── Lifecycle ───

  stop(): void {
    if (this.syncInterval !== null) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.notificationInterval !== null) {
      clearInterval(this.notificationInterval);
      this.notificationInterval = null;
    }
    if (this.terminalInterval !== null) {
      clearInterval(this.terminalInterval);
      this.terminalInterval = null;
    }
  }
}
