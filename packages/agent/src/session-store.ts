import type { WorkspaceInfo, SurfaceInfo, PaneInfo, FrameRect, CmuxNotification } from '@cmux-relay/shared';
import type { WebSocket } from 'ws';

interface ClientConnection {
  ws: WebSocket;
  activeSurfaceId: string | null;
  activeWorkspaceId: string | null;
  authenticated: boolean;
}

/**
 * Manages local workspaces/surfaces and connected web clients.
 */
export class SessionStore {
  private workspaces = new Map<string, WorkspaceInfo>();
  private surfaces = new Map<string, SurfaceInfo>();
  private panesByWorkspace = new Map<string, PaneInfo[]>();
  private containerFrames = new Map<string, FrameRect>();
  private clients = new Map<string, ClientConnection>();
  private notifications: CmuxNotification[] = [];

  // ─── Workspaces ───

  updateWorkspaces(workspaces: WorkspaceInfo[]): void {
    this.workspaces.clear();
    for (const w of workspaces) {
      this.workspaces.set(w.id, w);
    }
  }

  getAllWorkspaces(): WorkspaceInfo[] {
    return [...this.workspaces.values()];
  }

  // ─── Surfaces ───

  updateSurfaces(workspaceId: string, surfaces: SurfaceInfo[]): void {
    // Remove old surfaces for this workspace
    for (const [id, s] of this.surfaces) {
      if (s.workspaceId === workspaceId) this.surfaces.delete(id);
    }
    for (const s of surfaces) {
      this.surfaces.set(s.id, s);
    }
  }

  getSurfacesForWorkspace(workspaceId: string): SurfaceInfo[] {
    return [...this.surfaces.values()].filter(s => s.workspaceId === workspaceId);
  }

  getSurface(surfaceId: string): SurfaceInfo | undefined {
    return this.surfaces.get(surfaceId);
  }

  // ─── Panes (per workspace) ───

  updatePanesForWorkspace(workspaceId: string, panes: PaneInfo[], containerFrame: FrameRect): void {
    this.panesByWorkspace.set(workspaceId, panes);
    this.containerFrames.set(workspaceId, containerFrame);
  }

  getPanesForWorkspace(workspaceId: string): PaneInfo[] {
    return this.panesByWorkspace.get(workspaceId) || [];
  }

  getAllWorkspaceIdsWithPanes(): string[] {
    return [...this.panesByWorkspace.keys()];
  }

  getContainerFrameForWorkspace(workspaceId: string): FrameRect {
    return this.containerFrames.get(workspaceId) || { x: 0, y: 0, width: 1, height: 1 };
  }

  getAllPanes(): PaneInfo[] {
    const all: PaneInfo[] = [];
    for (const panes of this.panesByWorkspace.values()) {
      all.push(...panes);
    }
    return all;
  }

  getContainerFrame(): FrameRect {
    // Return first available frame for backward compat
    for (const frame of this.containerFrames.values()) return frame;
    return { x: 0, y: 0, width: 1, height: 1 };
  }

  // ─── Clients ───

  registerClient(clientId: string, ws: WebSocket): void {
    this.clients.set(clientId, { ws, activeSurfaceId: null, activeWorkspaceId: null, authenticated: false });
  }

  disconnectAllClients(): void {
    for (const [id, client] of this.clients) {
      client.ws.close(4002, 'Replaced by new connection');
      this.clients.delete(id);
    }
  }

  unregisterClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  authenticateClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) client.authenticated = true;
  }

  isClientAuthenticated(clientId: string): boolean {
    return this.clients.get(clientId)?.authenticated ?? false;
  }

  setActiveSurface(clientId: string, surfaceId: string, workspaceId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.activeSurfaceId = surfaceId;
      client.activeWorkspaceId = workspaceId;
    }
  }

  getActiveSurface(clientId: string): string | null {
    return this.clients.get(clientId)?.activeSurfaceId ?? null;
  }

  getActiveSurfaceIds(): Set<string> {
    const ids = new Set<string>();
    for (const client of this.clients.values()) {
      if (client.activeSurfaceId) ids.add(client.activeSurfaceId);
    }
    return ids;
  }

  // ─── Notifications ───

  updateNotifications(notifications: CmuxNotification[]): void {
    this.notifications = notifications;
  }

  getAllNotifications(): CmuxNotification[] {
    return this.notifications;
  }

  // ─── Broadcast ───

  broadcastToClients(message: unknown): void {
    const data = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (!client.authenticated) continue;
      if (client.ws.readyState === 1) {
        client.ws.send(data);
      }
    }
  }

  sendToClientsWithSurface(surfaceId: string, message: unknown): void {
    const data = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (!client.authenticated) continue;
      if (client.activeSurfaceId === surfaceId && client.ws.readyState === 1) {
        client.ws.send(data);
      }
    }
  }
}
