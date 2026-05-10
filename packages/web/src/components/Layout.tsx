import { useState, useCallback, useEffect, useRef } from 'react';
import { useRelay } from '../hooks/useRelay';
import { useMobile } from '../hooks/useMobile';
import { useWorkspaceSelection } from '../hooks/useWorkspaceSelection';
import { useNotificationToasts } from '../hooks/useNotifications';
import { MobileLayout } from './MobileLayout';
import { writeToTerminal } from './Terminal';
import { ConnectionOverlay } from './ConnectionOverlay';
import { StatusBar } from './StatusBar';
import { Sidebar } from './Sidebar';
import { NotificationPanel } from './NotificationPanel';
import { ToastContainer } from './ToastContainer';
import { PaneView, SurfaceListView } from './PaneView';
import { getRelayWsUrl } from '../lib/helpers';
import { registerServiceWorker, subscribePush, getPendingNavigation, onNavigateFromPush } from '../lib/push';
import { getJwtFromBrowser } from '../hooks/useAuth';
import type { CmuxNotification } from '@cmux-relay/shared';

const RELAY_URL = getRelayWsUrl();

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
    const stored = localStorage.getItem('cmux-relay-token');
    if (stored) return stored;
    return getJwtFromBrowser() ?? '';
  });
  const [submitted, setSubmitted] = useState(() => !!token);
  const [showSidebar, setShowSidebar] = useState(true);

  const {
    status,
    phase,
    highestPhase,
    reconnectAttempt,
    reconnectDelay,
    errorMessage,
    transport,
    p2pStatus,
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
  } = useRelay(submitted ? { url: RELAY_URL, token } : { url: '' });

  const {
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    handleSelectWorkspace,
  } = useWorkspaceSelection({ workspaces, panes, surfaces, selectSurface });

  const { toasts, dismissToast } = useNotificationToasts({ notifications });

  const [showNotifPanel, setShowNotifPanel] = useState(false);

  // Route output to the correct terminal instance
  onOutput(useCallback((surfaceId: string, data: string) => {
    writeToTerminal(surfaceId, data);
  }, []));

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
    getPendingNavigation().then((nav) => {
      if (nav) {
        if (nav.workspaceId) setSelectedWorkspaceId(nav.workspaceId);
        if (nav.surfaceId) selectSurface(nav.surfaceId);
      }
    });
    const cleanup = onNavigateFromPush((nav) => {
      if (nav.workspaceId) setSelectedWorkspaceId(nav.workspaceId);
      if (nav.surfaceId) selectSurface(nav.surfaceId);
    });
    return cleanup;
  }, []);

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

  const clickToast = (n: CmuxNotification, i: number) => {
    if (n.workspaceId) setSelectedWorkspaceId(n.workspaceId);
    if (n.surfaceId) selectSurface(n.surfaceId);
    dismissToast(i);
  };

  return (
    <>
      <div className="app">
        <StatusBar
          status={status}
          phase={phase}
          reconnectDelay={reconnectDelay}
          p2pStatus={p2pStatus}
          transport={transport}
          title={workspaces.find(w => w.id === selectedWorkspaceId)?.title || 'cmux-relay'}
          notifications={notifications}
          onToggleNotifications={() => setShowNotifPanel(v => !v)}
          showSidebar={showSidebar}
          onToggleSidebar={() => setShowSidebar(v => !v)}
        />

        <div className="app-body">
          {showNotifPanel && (
            <NotificationPanel
              notifications={notifications}
              onNavigate={(n) => {
                if (n.workspaceId) setSelectedWorkspaceId(n.workspaceId);
                if (n.surfaceId) selectSurface(n.surfaceId);
                setShowNotifPanel(false);
              }}
              onClose={() => setShowNotifPanel(false)}
            />
          )}
          {showSidebar && (
            <Sidebar
              workspaces={workspaces}
              selectedWorkspaceId={selectedWorkspaceId}
              onSelectWorkspace={handleSelectWorkspace}
              emptyHint="Start cmux to see your workspaces"
            />
          )}
          <main className="terminal-area">
            <ConnectionOverlay
              phase={phase}
              highestPhase={highestPhase}
              reconnectAttempt={reconnectAttempt}
              reconnectDelay={reconnectDelay}
              errorMessage={errorMessage}
              transport={transport}
            />
            {selectedWorkspaceId ? (
              wsPanes.length > 0 && paneBounds ? (
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

      <ToastContainer
        toasts={toasts}
        onDismiss={dismissToast}
        onClick={clickToast}
      />
    </>
  );
}
