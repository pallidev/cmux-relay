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

export interface EncryptedPayload {
  encrypted: true;
  iv: string;
  data: string;
}

export interface InputMessage {
  type: 'input';
  surfaceId: string;
  payload: { data: string } | EncryptedPayload;
}

export interface ResizeMessage {
  type: 'resize';
  surfaceId: string;
  payload: { cols: number; rows: number };
}

export interface WebRTCAnswerMessage {
  type: 'webrtc.answer';
  sdp: string;
}

export interface WebRTCIceCandidateMessage {
  type: 'webrtc.ice-candidate';
  candidate: string;
  mid: string;
}

// ─── ACP Client → Agent ───

export interface AcpNewSessionMessage {
  type: 'acp.new_session';
  surfaceId: string;
  cwd?: string;
}

export interface AcpPromptMessage {
  type: 'acp.prompt';
  sessionId: string;
  surfaceId: string;
  text: string;
}

export interface AcpPermissionResponseMessage {
  type: 'acp.permission_response';
  sessionId: string;
  surfaceId: string;
  requestId: string;
  outcome: string;
}

export interface AcpCancelMessage {
  type: 'acp.cancel';
  sessionId: string;
  surfaceId: string;
}

export type ClientOutgoing =
  | AuthMessage
  | WorkspacesListMessage
  | SurfaceSelectMessage
  | InputMessage
  | ResizeMessage
  | E2EInitMessage
  | WebRTCAnswerMessage
  | WebRTCIceCandidateMessage
  | AcpNewSessionMessage
  | AcpPromptMessage
  | AcpPermissionResponseMessage
  | AcpCancelMessage
  | { type: 'ping' };

// ─── Server → Client ───

export interface RelayOutputMessage {
  type: 'output';
  surfaceId: string;
  payload: { data: string } | EncryptedPayload;
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

export interface E2EInitMessage {
  type: 'e2e.init';
  publicKey: string;
}

export interface E2EAckMessage {
  type: 'e2e.ack';
  agentPublicKey: string;
  encryptedSessionKey: string;
  iv: string;
}

export interface WebRTCOfferMessage {
  type: 'webrtc.offer';
  sdp: string;
}

export interface WebRTCAnswerToClientMessage {
  type: 'webrtc.answer';
  sdp: string;
}

export interface WebRTCIceCandidateToClientMessage {
  type: 'webrtc.ice-candidate';
  candidate: string;
  mid: string;
}

// ─── ACP Agent → Client ───

export interface AcpAgentStatusMessage {
  type: 'acp.agent_status';
  status: 'starting' | 'ready' | 'error';
  agentName: string;
  error?: string;
  surfaceId?: string;
}

export interface AcpSessionCreatedMessage {
  type: 'acp.session.created';
  sessionId: string;
  surfaceId: string;
  capabilities: unknown;
}

export interface AcpSessionUpdateMessage {
  type: 'acp.session_update';
  sessionId: string;
  surfaceId: string;
  update: unknown;
}

export interface AcpPermissionRequestMessage {
  type: 'acp.permission_request';
  sessionId: string;
  surfaceId: string;
  requestId: string;
  toolName: string;
  toolCallId: string;
  options: unknown[];
}

export interface AcpSessionCompleteMessage {
  type: 'acp.session_complete';
  sessionId: string;
  surfaceId: string;
  stopReason: string;
}

export type RelayToClient =
  | RelayOutputMessage
  | RelayWorkspacesMessage
  | RelaySurfacesMessage
  | RelaySurfaceActiveMessage
  | RelayPanesMessage
  | RelayNotificationsMessage
  | RelayErrorMessage
  | E2EAckMessage
  | WebRTCOfferMessage
  | WebRTCAnswerToClientMessage
  | WebRTCIceCandidateToClientMessage
  | AcpAgentStatusMessage
  | AcpSessionCreatedMessage
  | AcpSessionUpdateMessage
  | AcpPermissionRequestMessage
  | AcpSessionCompleteMessage;

// ─── Agent → Relay ───

export interface AgentRegisterMessage {
  type: 'agent.register';
}

export interface AgentDataMessage {
  type: 'agent.data';
  payload: RelayToClient;
  targetClient?: string;
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
  clientId: string;
}

export interface ClientDisconnectedMessage {
  type: 'client.disconnected';
  clientId: string;
}

export interface ClientDataMessage {
  type: 'client.data';
  payload: ClientOutgoing;
  clientId: string;
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
