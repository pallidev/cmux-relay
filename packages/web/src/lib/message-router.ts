import type { WorkspaceInfo, SurfaceInfo, PaneInfo, FrameRect, CmuxNotification, EncryptedPayload } from '@cmux-relay/shared';
import type { RelayToClient } from '@cmux-relay/shared';

export type ConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'waiting-agent'
  | 'connected'
  | 'reconnecting'
  | 'error';

interface ClientE2ECryptoLike {
  isReady(): boolean;
  decryptOutput(payload: EncryptedPayload): Promise<string>;
}

export interface MessageRouterState {
  setWorkspaces: (ws: WorkspaceInfo[]) => void;
  setSurfaces: (updater: (prev: SurfaceInfo[]) => SurfaceInfo[]) => void;
  setPanes: (updater: (prev: PaneInfo[]) => PaneInfo[]) => void;
  setContainerFrames: (updater: (prev: Record<string, FrameRect>) => Record<string, FrameRect>) => void;
  setActiveSurfaceId: (id: string | null) => void;
  setActiveWorkspaceId: (id: string | null) => void;
  setNotifications: (updater: (prev: CmuxNotification[]) => CmuxNotification[]) => void;
  outputCallback: (surfaceId: string, data: string) => void;
  notificationCallback: (notifications: CmuxNotification[]) => void;
  e2eRef: { current: ClientE2ECryptoLike | null };
  activeSurfaceIdRef: { current: string | null };
  updatePhase: (p: ConnectionPhase) => void;
  clearConnectionTimeout: () => void;
  resetReconnectAttempt: () => void;
  acpCallback?: (msg: RelayToClient) => void;
}

export function createMessageRouter(state: MessageRouterState): (msg: RelayToClient) => void {
  return (msg: RelayToClient) => {
    switch (msg.type) {
      case 'workspaces':
        state.setWorkspaces(msg.payload.workspaces);
        state.updatePhase('connected');
        state.resetReconnectAttempt();
        state.clearConnectionTimeout();
        break;
      case 'surfaces':
        state.setSurfaces(prev => {
          const next = prev.filter(s => s.workspaceId !== msg.workspaceId);
          return [...next, ...msg.payload.surfaces];
        });
        // surfaces can arrive before workspaces; don't downgrade from 'connected'
        // but do clear the connection timeout — agent is alive
        state.clearConnectionTimeout();
        break;
      case 'panes':
        state.setPanes(prev => {
          const next = prev.filter(p => p.workspaceId !== msg.workspaceId);
          const incoming = (msg.payload.panes as PaneInfo[]).map(p => ({
            ...p,
            workspaceId: msg.workspaceId,
          }));
          return [...next, ...incoming];
        });
        if (msg.payload.containerFrame) {
          state.setContainerFrames(prev => ({
            ...prev,
            [msg.workspaceId]: msg.payload.containerFrame,
          }));
        }
        break;
      case 'surface.active':
        state.setActiveSurfaceId(msg.surfaceId);
        state.activeSurfaceIdRef.current = msg.surfaceId;
        state.setActiveWorkspaceId(msg.workspaceId);
        break;
      case 'output':
        if ('encrypted' in msg.payload && msg.payload.encrypted) {
          if (state.e2eRef.current?.isReady()) {
            state.e2eRef.current.decryptOutput(msg.payload as EncryptedPayload).then((decrypted) => {
              state.outputCallback(msg.surfaceId, decrypted);
            }).catch((err) => {
              console.error('[e2e] Decrypt failed:', err);
            });
          }
        } else {
          state.outputCallback(msg.surfaceId, (msg.payload as { data: string }).data);
        }
        break;
      case 'notifications':
        state.setNotifications(prev => {
          const existingIds = new Set(prev.map(n => n.id));
          const newOnes = msg.payload.notifications.filter((n: CmuxNotification) => !existingIds.has(n.id));
          return [...newOnes, ...prev];
        });
        state.notificationCallback(msg.payload.notifications);
        break;
      case 'error':
        console.error('Relay error:', msg.payload.message);
        break;
      case 'acp.agent_status':
      case 'acp.session.created':
      case 'acp.session_update':
      case 'acp.permission_request':
      case 'acp.session_complete':
        state.acpCallback?.(msg);
        break;
    }
  };
}
