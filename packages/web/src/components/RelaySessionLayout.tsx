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
import { PaneView } from './PaneView';
import { Terminal } from './Terminal';
import { getRelayWsUrl } from '../lib/helpers';
import { registerServiceWorker, subscribePush, getPendingNavigation, getPendingNavigationFromStorage, onNavigateFromPush } from '../lib/push';
import { getJwtFromBrowser } from '../hooks/useAuth';
import type { CmuxNotification } from '@cmux-relay/shared';

export function RelaySessionLayout({ sessionId, onDisconnect, onRetry }: { sessionId: string; onDisconnect?: () => void; onRetry?: () => void }) {
  const isMobile = useMobile();
  const [jwt] = useState<string>(() => getJwtFromBrowser() ?? '');

  const wsUrl = jwt
    ? `${getRelayWsUrl()}/ws/client?session=${sessionId}&token=${encodeURIComponent(jwt)}`
    : `${getRelayWsUrl()}/ws/client?session=${sessionId}`;

  if (isMobile) return <MobileLayout relayWsUrl={wsUrl} onDisconnect={onDisconnect} onRetry={onRetry} />;

  return <RelaySessionInner wsUrl={wsUrl} onDisconnect={onDisconnect} onRetry={onRetry} />;
}

function RelaySessionInner({ wsUrl, onDisconnect, onRetry }: { wsUrl: string; onDisconnect?: () => void; onRetry?: () => void }) {
  const [showSidebar, setShowSidebar] = useState(true);
  const [showNotifPanel, setShowNotifPanel] = useState(false);

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
  } = useRelay({ url: wsUrl, e2eEnabled: true });

  const {
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    handleSelectWorkspace,
  } = useWorkspaceSelection({ workspaces, panes, surfaces, selectSurface });

  const { toasts, dismissToast } = useNotificationToasts({ notifications });

  // Track if we already notified parent about this disconnect cycle
  const notifiedDisconnect = useRef(false);

  useEffect(() => {
    // Only trigger disconnect callback once per disconnect cycle
    // Not on every reconnect attempt, and not on permanent errors
    if (status === 'disconnected' && phase === 'reconnecting') {
      if (!notifiedDisconnect.current) {
        notifiedDisconnect.current = true;
        onDisconnect?.();
      }
    } else if (status === 'connected') {
      notifiedDisconnect.current = false;
    }
  }, [status, phase, onDisconnect]);

  onOutput(useCallback((surfaceId: string, data: string) => {
    writeToTerminal(surfaceId, data);
  }, []));

  // Browser notification + push subscription
  const pendingBrowserNotifs = useRef<CmuxNotification[]>([]);
  const pushInitialized = useRef(false);
  const swRegRef = useRef<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (status !== 'connected' || pushInitialized.current) return;
    pushInitialized.current = true;

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(async (p) => {
        if (p === 'granted') {
          const reg = await registerServiceWorker();
          if (reg) {
            swRegRef.current = reg;
            await subscribePush(reg);
          }
          if (pendingBrowserNotifs.current.length > 0) {
            for (const n of pendingBrowserNotifs.current) {
              if (swRegRef.current) {
                swRegRef.current.showNotification(n.title, {
                  body: n.subtitle ? `${n.subtitle}: ${n.body}` : n.body,
                  tag: n.id,
                  data: { workspaceId: n.workspaceId || null, surfaceId: n.surfaceId || null },
                  icon: '/icon-192.png',
                  badge: '/icon-192.png',
                });
              } else {
                new Notification(n.title, { body: n.subtitle ? `${n.subtitle}: ${n.body}` : n.body, tag: n.id });
              }
            }
            pendingBrowserNotifs.current = [];
          }
        }
      });
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      registerServiceWorker().then((reg) => {
        if (reg) {
          swRegRef.current = reg;
          subscribePush(reg);
        }
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
        const reg = swRegRef.current;
        if (reg) {
          reg.showNotification(n.title, {
            body: n.subtitle ? `${n.subtitle}: ${n.body}` : n.body,
            tag: n.id,
            data: { workspaceId: n.workspaceId || null, surfaceId: n.surfaceId || null },
            icon: '/icon-192.png',
            badge: '/icon-192.png',
          });
        } else {
          new Notification(n.title, { body: n.subtitle ? `${n.subtitle}: ${n.body}` : n.body, tag: n.id });
        }
      } else {
        pendingBrowserNotifs.current.push(n);
      }
    }
  }, []));

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
          showDashboard
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
              emptyHint="Waiting for agent connection..."
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
              onRetry={onRetry}
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

      <ToastContainer
        toasts={toasts}
        onDismiss={dismissToast}
      />
    </>
  );
}
