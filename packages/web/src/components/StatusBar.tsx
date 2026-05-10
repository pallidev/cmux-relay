import type { ConnectionPhase } from '../hooks/useRelay';

type TransportType = 'relay' | 'p2p';
type P2PStatus = 'none' | 'attempting' | 'connected' | 'failed';

interface StatusBarProps {
  status: 'connecting' | 'connected' | 'disconnected';
  phase: ConnectionPhase;
  reconnectDelay: number;
  p2pStatus: P2PStatus;
  transport: TransportType;
  title: string;
  notifications: { length: number };
  onToggleNotifications: () => void;
  /** Optional: sidebar toggle button (desktop layouts) */
  showSidebar?: boolean;
  onToggleSidebar?: () => void;
  /** Optional: workspace navigation (mobile layout) */
  onPrevWorkspace?: () => void;
  onNextWorkspace?: () => void;
  prevDisabled?: boolean;
  nextDisabled?: boolean;
  wsCounter?: string;
  /** Optional: dashboard link (relay layouts) */
  showDashboard?: boolean;
  /** Optional: notification permission prompt (mobile) */
  notifPermission?: 'default' | 'granted' | 'denied' | 'unsupported';
  onEnableNotifications?: () => void;
}

export function getStatusText(
  status: 'connecting' | 'connected' | 'disconnected',
  phase: ConnectionPhase,
  p2pStatus: P2PStatus,
  reconnectDelay: number,
): string {
  if (status === 'connected') {
    return p2pStatus === 'attempting' ? 'P2P 연결 시도 중...' : '';
  }
  if (phase === 'reconnecting') return `재연결 (${Math.ceil(reconnectDelay / 1000)}s)`;
  if (phase === 'connecting') return 'WebSocket 연결 중...';
  if (phase === 'waiting-agent') return 'Agent 대기...';
  if (status === 'disconnected') return '연결 끊김';
  return '연결 중...';
}

export function StatusBar({
  status,
  phase,
  reconnectDelay,
  p2pStatus,
  transport,
  title,
  notifications,
  onToggleNotifications,
  showSidebar,
  onToggleSidebar,
  onPrevWorkspace,
  onNextWorkspace,
  prevDisabled,
  nextDisabled,
  wsCounter,
  showDashboard,
  notifPermission,
  onEnableNotifications,
}: StatusBarProps) {
  const isMobile = !!onPrevWorkspace;
  const statusText = getStatusText(status, phase, p2pStatus, reconnectDelay);

  if (isMobile) {
    return (
      <header className="mobile-header">
        <button
          className="mobile-nav-btn"
          onClick={onPrevWorkspace}
          disabled={prevDisabled}
        >
          &#8249;
        </button>
        <span className="status">
          <span className={`status-dot ${status}`} />
          <span className="status-text">{statusText}</span>
        </span>
        <span className={`transport-badge ${transport}`}>{transport === 'p2p' ? 'P2P' : 'Relay'}</span>
        <span className="mobile-header-title">{title}</span>
        {wsCounter && <span className="mobile-ws-counter">{wsCounter}</span>}
        <button
          className="mobile-nav-btn"
          onClick={onNextWorkspace}
          disabled={nextDisabled}
        >
          &#8250;
        </button>
        {showDashboard && <a href="/" className="dashboard-btn" title="Dashboard">&#x2302;</a>}
        {notifPermission === 'default' && onEnableNotifications && (
          <button className="mobile-nav-btn notif-enable-btn" onClick={onEnableNotifications} title="Enable notifications">&#x1F514;</button>
        )}
      </header>
    );
  }

  return (
    <header className="app-header">
      {onToggleSidebar && (
        <button className="menu-btn" onClick={onToggleSidebar}>
          {showSidebar ? '✕' : '☰'}
        </button>
      )}
      <span className="status">
        <span className={`status-dot ${status}`} />
        <span className="status-text">{statusText}</span>
      </span>
      <span className={`transport-badge ${transport}`}>{transport === 'p2p' ? 'P2P' : 'Relay'}</span>
      <span className="header-title">{title}</span>
      {showDashboard && <a href="/" className="dashboard-btn" title="Dashboard">&#x2302;</a>}
      <button className="notif-bell" onClick={onToggleNotifications}>
        &#x1F514;
        {notifications.length > 0 && <span className="notif-badge">{notifications.length}</span>}
      </button>
    </header>
  );
}
