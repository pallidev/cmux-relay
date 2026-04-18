import type { WorkspaceInfo, SurfaceInfo, PaneInfo, FrameRect, CmuxNotification } from './types.js';

// ─── Client → Server ───

export interface AuthMessage {
  type: 'auth';
  payload: { token: string };
}

export interface WorkspacesListMessage {
  type: 'workspaces.list';
}

export interface SurfaceSelectMessage {
  type: 'surface.select';
  surfaceId: string;
}

export interface InputMessage {
  type: 'input';
  surfaceId: string;
  payload: { data: string }; // base64-encoded input bytes
}

export interface ResizeMessage {
  type: 'resize';
  surfaceId: string;
  payload: { cols: number; rows: number };
}

export type ClientOutgoing =
  | AuthMessage
  | WorkspacesListMessage
  | SurfaceSelectMessage
  | InputMessage
  | ResizeMessage;

// ─── Server → Client ───

export interface RelayOutputMessage {
  type: 'output';
  surfaceId: string;
  payload: { data: string };
}

export interface RelayWorkspacesMessage {
  type: 'workspaces';
  payload: { workspaces: WorkspaceInfo[] };
}

export interface RelaySurfacesMessage {
  type: 'surfaces';
  workspaceId: string;
  payload: { surfaces: SurfaceInfo[] };
}

export interface RelaySurfaceActiveMessage {
  type: 'surface.active';
  surfaceId: string;
  workspaceId: string;
}

export interface RelayPanesMessage {
  type: 'panes';
  workspaceId: string;
  payload: { panes: PaneInfo[]; containerFrame: FrameRect };
}

export interface RelayNotificationsMessage {
  type: 'notifications';
  payload: { notifications: CmuxNotification[] };
}

export interface RelayErrorMessage {
  type: 'error';
  payload: { message: string };
}

export type RelayToClient =
  | RelayOutputMessage
  | RelayWorkspacesMessage
  | RelaySurfacesMessage
  | RelaySurfaceActiveMessage
  | RelayPanesMessage
  | RelayNotificationsMessage
  | RelayErrorMessage;

// ─── Agent → Relay ───

export interface AgentRegisterMessage {
  type: 'agent.register';
}

export interface AgentDataMessage {
  type: 'agent.data';
  payload: RelayToClient;
}

export interface AgentHeartbeatMessage {
  type: 'agent.heartbeat';
}

export interface AgentPairMessage {
  type: 'agent.pair';
}

export type AgentOutgoing =
  | AgentRegisterMessage
  | AgentDataMessage
  | AgentHeartbeatMessage
  | AgentPairMessage;

// ─── Relay → Agent ───

export interface SessionCreatedMessage {
  type: 'session.created';
  sessionId: string;
}

export interface ClientConnectedMessage {
  type: 'client.connected';
}

export interface ClientDisconnectedMessage {
  type: 'client.disconnected';
}

export interface ClientDataMessage {
  type: 'client.data';
  payload: ClientOutgoing;
}

export interface PairingWaitMessage {
  type: 'pairing.wait';
  code: string;
  url: string;
}

export interface PairingApprovedMessage {
  type: 'pairing.approved';
  token: string;
}

export interface PairingRejectedMessage {
  type: 'pairing.rejected';
  reason: string;
}

export type RelayToAgent =
  | SessionCreatedMessage
  | ClientConnectedMessage
  | ClientDisconnectedMessage
  | ClientDataMessage
  | PairingWaitMessage
  | PairingApprovedMessage
  | PairingRejectedMessage;

// ─── Helpers ───

export function encodeMessage(msg: unknown): string {
  return JSON.stringify(msg);
}

export function decodeMessage<T = unknown>(data: string): T {
  return JSON.parse(data) as T;
}
