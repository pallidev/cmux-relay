/** cmux workspace — contains multiple surfaces (tabs) */
export interface WorkspaceInfo {
  id: string;
  title: string;
}

/** cmux surface — a tab within a workspace (terminal or browser) */
export interface SurfaceInfo {
  id: string;
  title: string;
  type: string; // 'terminal' | 'browser'
  workspaceId: string;
}

/** Pixel frame for positioning */
export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** cmux pane — a split panel containing one or more surface tabs */
export interface PaneInfo {
  id: string;
  index: number;
  surfaceIds: string[];
  selectedSurfaceId: string;
  columns: number;
  rows: number;
  frame: FrameRect;
  focused: boolean;
  workspaceId: string;
}

/** cmux notification from the notification.list RPC */
export interface CmuxNotification {
  id: string;
  title: string;
  subtitle: string;
  body: string;
  surfaceId: string;
  workspaceId: string;
  isRead: boolean;
}

/** Relay server config */
export interface RelayConfig {
  port: number;
  host: string;
  jwtSecret: string;
}
