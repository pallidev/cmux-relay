import { useState, useCallback, useEffect, useRef } from 'react';
import { useRelay } from '../hooks/useRelay';
import { useMobile } from '../hooks/useMobile';
import { MobileLayout } from './MobileLayout';
import { Terminal, writeToTerminal } from './Terminal';
import { getRelayUrl, getToastType } from '../lib/helpers';
import type { PaneInfo, CmuxNotification } from '@cmux-relay/shared';

const RELAY_URL = getRelayUrl();

export function Layout() {
  const isMobile = useMobile();

  // All hooks must be called before any conditional return
  const [token, setToken] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      localStorage.setItem('cmux-relay-token', urlToken);
      window.history.replaceState({}, '', window.location.pathname);
      return urlToken;
    }
    return localStorage.getItem('cmux-relay-token') || '';
  });
  const [submitted, setSubmitted] = useState(() => !!localStorage.getItem('cmux-relay-token'));
  const [showSidebar, setShowSidebar] = useState(true);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);

  const {
    status,
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
  } = useRelay(submitted ? RELAY_URL : '', submitted ? token : '');

  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const [toasts, setToasts] = useState<CmuxNotification[]>([]);
  const prevNotifCount = useRef(0);

  // Route output to the correct terminal instance
  onOutput(useCallback((surfaceId: string, data: string) => {
    writeToTerminal(surfaceId, data);
  }, []));

  // Show in-app toast when new notifications arrive
  useEffect(() => {
    if (notifications.length <= prevNotifCount.current) {
      prevNotifCount.current = notifications.length;
      return;
    }
    const newNotifs = notifications.slice(0, notifications.length - prevNotifCount.current);
    prevNotifCount.current = notifications.length;

    // Show toast popup
    setToasts(prev => [...prev, ...newNotifs]);
    setTimeout(() => {
      setToasts(prev => prev.length > newNotifs.length ? prev.slice(newNotifs.length) : []);
    }, 5000);
  }, [notifications]);

  // Browser notification support
  const pendingBrowserNotifs = useRef<CmuxNotification[]>([]);

  useEffect(() => {
    if (status === 'connected' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then((p) => {
        if (p === 'granted' && pendingBrowserNotifs.current.length > 0) {
          for (const n of pendingBrowserNotifs.current) {
            new Notification(n.title, { body: n.subtitle ? `${n.subtitle}: ${n.body}` : n.body, tag: n.id });
          }
          pendingBrowserNotifs.current = [];
        }
      });
    }
  }, [status]);

  // Keep onNotifications wired for browser notifications
  onNotifications(useCallback((newNotifs: CmuxNotification[]) => {
    for (const n of newNotifs) {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(n.title, { body: n.subtitle ? `${n.subtitle}: ${n.body}` : n.body, tag: n.id });
      } else {
        pendingBrowserNotifs.current.push(n);
      }
    }
  }, []));

  // Auto-select first workspace with panes on initial load
  useEffect(() => {
    if (selectedWorkspaceId) return;
    if (workspaces.length === 0 || panes.length === 0) return;

    const firstWsId = workspaces[0].id;
    setSelectedWorkspaceId(firstWsId);

    // Select all surfaces for panes in this workspace
    const wsPanes = panes.filter(p => p.workspaceId === firstWsId);
    for (const pane of wsPanes) {
      selectSurface(pane.selectedSurfaceId);
    }
  }, [panes, workspaces, selectedWorkspaceId, selectSurface]);

  // Mobile: delegate to MobileLayout after all hooks are called
  if (isMobile) return <MobileLayout />;

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    localStorage.setItem('cmux-relay-token', token);
    setSubmitted(true);
  };

  if (!submitted) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h1>cmux-relay</h1>
          <p>Monitor your cmux terminals from mobile</p>
          <form onSubmit={handleConnect}>
            <input
              type="text"
              placeholder="Enter token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoFocus
            />
            <button type="submit">Connect</button>
          </form>
        </div>
      </div>
    );
  }

  const handleSelectWorkspace = (workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
    // Select all pane surfaces for this workspace
    const wsPanes = panes.filter(p => p.workspaceId === workspaceId);
    if (wsPanes.length > 0) {
      for (const pane of wsPanes) {
        selectSurface(pane.selectedSurfaceId);
      }
    } else {
      // Fallback: select first surface
      const wsSurfaces = surfaces.filter(s => s.workspaceId === workspaceId);
      if (wsSurfaces.length > 0) {
        selectSurface(wsSurfaces[0].id);
      }
    }
  };

  // Get panes for the selected workspace (now available for ALL workspaces)
  const wsPanes = selectedWorkspaceId
    ? panes.filter(p => p.workspaceId === selectedWorkspaceId).sort((a, b) => a.index - b.index)
    : [];

  // Calculate actual pane bounding box
  const paneBounds = wsPanes.length > 0 ? wsPanes.reduce((acc, p) => ({
    minX: Math.min(acc.minX, p.frame.x),
    minY: Math.min(acc.minY, p.frame.y),
    maxX: Math.max(acc.maxX, p.frame.x + p.frame.width),
    maxY: Math.max(acc.maxY, p.frame.y + p.frame.height),
  }), { minX: Infinity, minY: Infinity, maxX: 0, maxY: 0 }) : null;

  // Surfaces for the selected workspace (fallback when no pane data)
  const wsSurfaces = selectedWorkspaceId
    ? surfaces.filter(s => s.workspaceId === selectedWorkspaceId && s.type === 'terminal')
    : [];

  const dismissToast = (i: number) => {
    setToasts(prev => prev.filter((_, idx) => idx !== i));
  };

  const clickToast = (n: CmuxNotification, i: number) => {
    if (n.workspaceId) setSelectedWorkspaceId(n.workspaceId);
    if (n.surfaceId) selectSurface(n.surfaceId);
    dismissToast(i);
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
          <span className="header-title">
            {workspaces.find(w => w.id === selectedWorkspaceId)?.title || 'cmux-relay'}
          </span>
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
                  <p className="hint">Start cmux to see your workspaces</p>
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
                /* Workspace with pane layout (all workspaces now have pane data) */
                <div className="pane-container">
                  {wsPanes.map((pane) => (
                    <PaneView
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
                /* Fallback: surface grid when no pane data available */
                <SurfaceListView
                  surfaces={wsSurfaces}
                  selectSurface={selectSurface}
                  sendInput={sendInput}
                  sendResize={sendResize}
                />
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

      {/* Toast notifications — top-right with slide-in animation */}
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((n, i) => {
            const toastType = getToastType(n);
            return (
              <div
                key={`${n.id}-${i}`}
                className={`toast toast-${toastType}`}
                onClick={() => clickToast(n, i)}
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

/** Single pane with optional tab bar */
function PaneView({
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

  // Sync with cmux selected surface when it changes externally
  useEffect(() => {
    setLocalSurfaceId(pane.selectedSurfaceId);
  }, [pane.selectedSurfaceId]);

  const handleTabClick = (surfaceId: string) => {
    setLocalSurfaceId(surfaceId);
    selectSurface(surfaceId);
  };

  const paneSurfaces = pane.surfaceIds
    .map(id => surfaces.find(s => s.id === id))
    .filter(Boolean) as { id: string; title: string; type: string }[];

  // Convert pixel frame to percentage using actual pane bounding box
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

/** Grid layout for non-active workspaces (surfaces shown side by side) */
function SurfaceListView({
  surfaces,
  selectSurface,
  sendInput,
  sendResize,
}: {
  surfaces: { id: string; title: string; type: string }[];
  selectSurface: (id: string) => void;
  sendInput: (surfaceId: string, data: string) => void;
  sendResize: (surfaceId: string, cols: number, rows: number) => void;
}) {
  return (
    <div className="surface-grid">
      {surfaces.map((s) => (
        <SurfaceCard
          key={s.id}
          surface={s}
          selectSurface={selectSurface}
          sendInput={sendInput}
          sendResize={sendResize}
        />
      ))}
    </div>
  );
}

function SurfaceCard({
  surface,
  selectSurface,
  sendInput,
  sendResize,
}: {
  surface: { id: string; title: string; type: string };
  selectSurface: (id: string) => void;
  sendInput: (surfaceId: string, data: string) => void;
  sendResize: (surfaceId: string, cols: number, rows: number) => void;
}) {
  const [isFocused, setIsFocused] = useState(false);

  const handleFocus = () => {
    setIsFocused(true);
    selectSurface(surface.id);
  };

  return (
    <div className={`pane ${isFocused ? 'focused' : ''}`}
      onFocus={handleFocus}
      onClick={handleFocus}
    >
      <div className="pane-tabs">
        <button className="pane-tab active">
          {surface.title || surface.id.slice(0, 8)}
        </button>
      </div>
      <div className="pane-terminal">
        <Terminal
          surfaceId={surface.id}
          onInput={(data) => sendInput(surface.id, data)}
          onResize={(cols, rows) => sendResize(surface.id, cols, rows)}
        />
      </div>
    </div>
  );
}
