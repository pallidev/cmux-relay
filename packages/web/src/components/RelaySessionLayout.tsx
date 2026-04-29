import { useState, useCallback, useEffect, useRef } from 'react';
import { useRelay } from '../hooks/useRelay';
import { useMobile } from '../hooks/useMobile';
import { MobileLayout } from './MobileLayout';
import { Terminal, writeToTerminal } from './Terminal';
import { getRelayWsUrl, getToastType } from '../lib/helpers';
import { registerServiceWorker, subscribePush, getPendingNavigation, getPendingNavigationFromStorage, onNavigateFromPush } from '../lib/push';
import type { PaneInfo, CmuxNotification } from '@cmux-relay/shared';

export function RelaySessionLayout({ sessionId, onDisconnect }: { sessionId: string; onDisconnect?: () => void }) {
  const isMobile = useMobile();
  const [jwt] = useState<string>(() => {
    const match = document.cookie.match(/(?:^|;\s*)relay_jwt=([^;]+)/);
    return match ? match[1] : '';
  });

  const wsUrl = jwt
    ? `${getRelayWsUrl()}/ws/client?session=${sessionId}&token=${encodeURIComponent(jwt)}`
    : `${getRelayWsUrl()}/ws/client?session=${sessionId}`;

  if (isMobile) return <MobileLayout relayWsUrl={wsUrl} onDisconnect={onDisconnect} />;

  return <RelaySessionInner wsUrl={wsUrl} onDisconnect={onDisconnect} />;
}

function RelaySessionInner({ wsUrl, onDisconnect }: { wsUrl: string; onDisconnect?: () => void }) {
  const [showSidebar, setShowSidebar] = useState(true);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    () => localStorage.getItem('cmux-relay-last-workspace')
  );
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const [toasts, setToasts] = useState<CmuxNotification[]>([]);
  const prevNotifCount = useRef(0);

  const {
    status,
    transport,
    workspaces,
    surfaces,
    panes,
    containerFrames,
    notifications,
    selectSurface,
    sendInput,
    sendResize,
    onOutput,
    onNotifications,
  } = useRelay({ url: wsUrl, e2eEnabled: true });

  useEffect(() => {
    if (status === 'disconnected') onDisconnect?.();
  }, [status, onDisconnect]);

  onOutput(useCallback((surfaceId: string, data: string) => {
    writeToTerminal(surfaceId, data);
  }, []));

  useEffect(() => {
    if (notifications.length <= prevNotifCount.current) {
      prevNotifCount.current = notifications.length;
      return;
    }
    const newNotifs = notifications.slice(0, notifications.length - prevNotifCount.current);
    prevNotifCount.current = notifications.length;
    setToasts(prev => [...prev, ...newNotifs]);
    setTimeout(() => {
      setToasts(prev => prev.length > newNotifs.length ? prev.slice(newNotifs.length) : []);
    }, 5000);
  }, [notifications]);

  // Browser notification + push subscription
  const pendingBrowserNotifs = useRef<CmuxNotification[]>([]);
  const pushInitialized = useRef(false);

  useEffect(() => {
    if (status !== 'connected' || pushInitialized.current) return;
    pushInitialized.current = true;

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(async (p) => {
        if (p === 'granted') {
          const reg = await registerServiceWorker();
          if (reg) await subscribePush(reg);
          if (pendingBrowserNotifs.current.length > 0) {
            for (const n of pendingBrowserNotifs.current) {
              new Notification(n.title, { body: n.subtitle ? `${n.subtitle}: ${n.body}` : n.body, tag: n.id });
            }
            pendingBrowserNotifs.current = [];
          }
        }
      });
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      registerServiceWorker().then((reg) => {
        if (reg) subscribePush(reg);
      });
    }
  }, [status]);

  // Handle pending navigation from push notification click
  useEffect(() => {
    // Check localStorage first (set by DashboardPage during redirect)
    const storedNav = getPendingNavigationFromStorage();
    if (storedNav) {
      if (storedNav.workspaceId) setSelectedWorkspaceId(storedNav.workspaceId);
      if (storedNav.surfaceId) selectSurface(storedNav.surfaceId);
    } else {
      // Direct IndexedDB check (PWA opened fresh)
      getPendingNavigation().then((nav) => {
        if (nav) {
          if (nav.workspaceId) setSelectedWorkspaceId(nav.workspaceId);
          if (nav.surfaceId) selectSurface(nav.surfaceId);
        }
      });
    }
    const cleanup = onNavigateFromPush((nav) => {
      if (nav.workspaceId) setSelectedWorkspaceId(nav.workspaceId);
      if (nav.surfaceId) selectSurface(nav.surfaceId);
    });
    return cleanup;
  }, []);

  onNotifications(useCallback((newNotifs: CmuxNotification[]) => {
    for (const n of newNotifs) {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(n.title, { body: n.subtitle ? `${n.subtitle}: ${n.body}` : n.body, tag: n.id });
      } else {
        pendingBrowserNotifs.current.push(n);
      }
    }
  }, []));

  useEffect(() => {
    if (selectedWorkspaceId) {
      // Verify saved workspace still exists
      if (workspaces.length > 0 && !workspaces.some(w => w.id === selectedWorkspaceId)) {
        const firstWsId = workspaces[0].id;
        setSelectedWorkspaceId(firstWsId);
        return;
      }
      // Still select surfaces for the saved workspace
      if (panes.length > 0) {
        const wsPanes = panes.filter(p => p.workspaceId === selectedWorkspaceId);
        for (const pane of wsPanes) {
          selectSurface(pane.selectedSurfaceId);
        }
      }
      return;
    }
    if (workspaces.length === 0 || panes.length === 0) return;
    const firstWsId = workspaces[0].id;
    setSelectedWorkspaceId(firstWsId);
    const wsPanes = panes.filter(p => p.workspaceId === firstWsId);
    for (const pane of wsPanes) {
      selectSurface(pane.selectedSurfaceId);
    }
  }, [panes, workspaces, selectedWorkspaceId, selectSurface]);

  // Persist workspace selection
  useEffect(() => {
    if (selectedWorkspaceId) {
      localStorage.setItem('cmux-relay-last-workspace', selectedWorkspaceId);
    }
  }, [selectedWorkspaceId]);

  const handleSelectWorkspace = (workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
    const wsPanes = panes.filter(p => p.workspaceId === workspaceId);
    if (wsPanes.length > 0) {
      for (const pane of wsPanes) {
        selectSurface(pane.selectedSurfaceId);
      }
    } else {
      const wsSurfaces = surfaces.filter(s => s.workspaceId === workspaceId);
      if (wsSurfaces.length > 0) {
        selectSurface(wsSurfaces[0].id);
      }
    }
  };

  const wsPanes = selectedWorkspaceId
    ? panes.filter(p => p.workspaceId === selectedWorkspaceId).sort((a, b) => a.index - b.index)
    : [];

  const paneBounds = wsPanes.length > 0 ? wsPanes.reduce((acc, p) => ({
    minX: Math.min(acc.minX, p.frame.x),
    minY: Math.min(acc.minY, p.frame.y),
    maxX: Math.max(acc.maxX, p.frame.x + p.frame.width),
    maxY: Math.max(acc.maxY, p.frame.y + p.frame.height),
  }), { minX: Infinity, minY: Infinity, maxX: 0, maxY: 0 }) : null;

  const wsSurfaces = selectedWorkspaceId
    ? surfaces.filter(s => s.workspaceId === selectedWorkspaceId && s.type === 'terminal')
    : [];

  const dismissToast = (i: number) => {
    setToasts(prev => prev.filter((_, idx) => idx !== i));
  };

  return (
    <>
      <div className="app">
        <header className="app-header">
          <button className="menu-btn" onClick={() => setShowSidebar(!showSidebar)}>
            {showSidebar ? '\u2715' : '\u2630'}
          </button>
          <span className="status">
            <span className={`status-dot ${status}`} />
          </span>
          <span className={`transport-badge ${transport}`}>{transport === 'p2p' ? 'P2P' : 'Relay'}</span>
          <span className="header-title">
            {workspaces.find(w => w.id === selectedWorkspaceId)?.title || 'cmux-relay'}
          </span>
          <a href="/" className="dashboard-btn" title="Dashboard">&#x2302;</a>
          <button className="notif-bell" onClick={() => setShowNotifPanel(v => !v)}>
            &#x1F514;
            {notifications.length > 0 && <span className="notif-badge">{notifications.length}</span>}
          </button>
        </header>

        <div className="app-body">
          {showNotifPanel && (
            <div className="notif-panel">
              <div className="notif-panel-header">
                <span>Notifications</span>
                {notifications.length > 0 && (
                  <button className="notif-clear-btn" onClick={() => setShowNotifPanel(false)}>Clear</button>
                )}
              </div>
              {notifications.length === 0 ? (
                <div className="notif-empty">No notifications</div>
              ) : (
                <div className="notif-list">
                  {notifications.map((n) => (
                    <button
                      key={n.id}
                      className={`notif-item ${n.isRead ? 'read' : 'unread'}`}
                      onClick={() => {
                        if (n.workspaceId) setSelectedWorkspaceId(n.workspaceId);
                        if (n.surfaceId) selectSurface(n.surfaceId);
                        setShowNotifPanel(false);
                      }}
                    >
                      <div className="notif-item-title">{n.title}</div>
                      {n.subtitle && <div className="notif-item-sub">{n.subtitle}</div>}
                      {n.body && <div className="notif-item-body">{n.body}</div>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {showSidebar && (
            <aside className="sidebar">
              {workspaces.length === 0 ? (
                <div className="sidebar-empty">
                  <p>No workspaces</p>
                  <p className="hint">Waiting for agent connection...</p>
                </div>
              ) : (
                workspaces.map((w) => {
                  const isActive = selectedWorkspaceId === w.id;
                  return (
                    <div key={w.id} className="workspace-group">
                      <button
                        className={`workspace-label ${isActive ? 'active' : ''}`}
                        onClick={() => handleSelectWorkspace(w.id)}
                      >
                        <span className="workspace-title">{w.title}</span>
                      </button>
                    </div>
                  );
                })
              )}
            </aside>
          )}
          <main className="terminal-area">
            {selectedWorkspaceId ? (
              wsPanes.length > 0 && paneBounds ? (
                <div className="pane-container">
                  {wsPanes.map((pane) => (
                    <RelayPaneView
                      key={pane.id}
                      pane={pane}
                      bounds={paneBounds}
                      surfaces={surfaces}
                      selectSurface={selectSurface}
                      sendInput={sendInput}
                      sendResize={sendResize}
                    />
                  ))}
                </div>
              ) : wsSurfaces.length > 0 ? (
                <div className="surface-grid">
                  {wsSurfaces.map((s) => (
                    <div key={s.id} className="pane" onClick={() => selectSurface(s.id)}>
                      <div className="pane-tabs">
                        <button className="pane-tab active">{s.title || s.id.slice(0, 8)}</button>
                      </div>
                      <div className="pane-terminal">
                        <Terminal
                          surfaceId={s.id}
                          onInput={(data) => sendInput(s.id, data)}
                          onResize={(cols, rows) => sendResize(s.id, cols, rows)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="no-pane-hint">
                  <p>Loading terminals...</p>
                </div>
              )
            ) : (
              <div className="no-pane-hint">
                <p>Select a workspace to view terminals</p>
              </div>
            )}
          </main>
        </div>
      </div>

      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((n, i) => {
            const toastType = getToastType(n);
            return (
              <div
                key={`${n.id}-${i}`}
                className={`toast toast-${toastType}`}
                onClick={() => dismissToast(i)}
              >
                <span className="toast-icon">
                  {n.title.toLowerCase().includes('claude') ? '\uD83E\uDD16' : '\uD83D\uDD14'}
                </span>
                <div className="toast-content">
                  <div className="toast-title">{n.title}</div>
                  {n.subtitle && <div className="toast-sub">{n.subtitle}</div>}
                  {n.body && <div className="toast-body">{n.body}</div>}
                </div>
                <button
                  className="toast-close"
                  onClick={(e) => { e.stopPropagation(); dismissToast(i); }}
                  aria-label="Dismiss"
                >
                  &times;
                </button>
                <div className="toast-progress" />
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function RelayPaneView({
  pane,
  bounds,
  surfaces,
  selectSurface,
  sendInput,
  sendResize,
}: {
  pane: PaneInfo;
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  surfaces: { id: string; title: string; type: string }[];
  selectSurface: (id: string) => void;
  sendInput: (surfaceId: string, data: string) => void;
  sendResize: (surfaceId: string, cols: number, rows: number) => void;
}) {
  const [localSurfaceId, setLocalSurfaceId] = useState(pane.selectedSurfaceId);

  const handleTabClick = (surfaceId: string) => {
    setLocalSurfaceId(surfaceId);
    selectSurface(surfaceId);
  };

  const paneSurfaces = pane.surfaceIds
    .map(id => surfaces.find(s => s.id === id))
    .filter(Boolean) as { id: string; title: string; type: string }[];

  const b = bounds || { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const contentW = b.maxX - b.minX;
  const contentH = b.maxY - b.minY;
  const left = ((pane.frame.x - b.minX) / contentW) * 100;
  const top = ((pane.frame.y - b.minY) / contentH) * 100;
  const width = (pane.frame.width / contentW) * 100;
  const height = (pane.frame.height / contentH) * 100;

  return (
    <div
      className={`pane ${pane.focused ? 'focused' : ''}`}
      style={{
        position: 'absolute',
        left: `${left}%`,
        top: `${top}%`,
        width: `${width}%`,
        height: `${height}%`,
      }}
    >
      <div className="pane-tabs">
        {paneSurfaces.map((s) => (
          <button
            key={s.id}
            className={`pane-tab ${s.id === localSurfaceId ? 'active' : ''}`}
            onClick={() => handleTabClick(s.id)}
          >
            {s.title || s.id.slice(0, 8)}
          </button>
        ))}
      </div>
      <div className="pane-terminal">
        <Terminal
          surfaceId={localSurfaceId}
          cols={pane.columns}
          rows={pane.rows}
          onInput={(data) => sendInput(localSurfaceId, data)}
          onResize={(cols, rows) => sendResize(localSurfaceId, cols, rows)}
        />
      </div>
    </div>
  );
}
