import { useState, useCallback, useEffect, useRef } from 'react';
import { useRelay } from '../hooks/useRelay';
import { useNotificationToasts } from '../hooks/useNotifications';
import { useAcpChat } from '../hooks/useAcpChat';
import { Terminal, writeToTerminal } from './Terminal';
import { ChatView } from './ChatView';
import { ConnectionOverlay } from './ConnectionOverlay';
import { StatusBar } from './StatusBar';
import { ToastContainer } from './ToastContainer';
import { getRelayWsUrl } from '../lib/helpers';
import { registerServiceWorker, subscribePush, getPendingNavigation, onNavigateFromPush } from '../lib/push';
import type { CmuxNotification } from '@cmux-relay/shared';

type SurfaceViewMode = "terminal" | "chat";
type SurfaceViewMap = Record<string, SurfaceViewMode>;

const RELAY_URL = getRelayWsUrl();

export function MobileLayout({ relayWsUrl, onDisconnect, onRetry }: { relayWsUrl?: string; onDisconnect?: () => void; onRetry?: () => void }) {
  const [appHeight, setAppHeight] = useState(() =>
    window.visualViewport ? window.visualViewport.height : window.innerHeight
  );

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setAppHeight(vv.height);
      // Prevent browser from scrolling page when keyboard appears
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

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
  const [submitted, setSubmitted] = useState(() => !!localStorage.getItem('cmux-relay-token') || !!relayWsUrl);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    () => localStorage.getItem('cmux-relay-last-workspace')
  );
  const [selectedSurfaceId, setSelectedSurfaceId] = useState<string | null>(
    () => localStorage.getItem('cmux-relay-last-surface')
  );

  const relayUrl = relayWsUrl || (submitted ? RELAY_URL : '');

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
    notifications,
    selectSurface,
    sendInput,
    sendResize,
    sendRaw,
    onOutput,
    onNotifications,
    onAcpMessage,
  } = useRelay(relayUrl ? { url: relayUrl, e2eEnabled: true, onSessionExpired: onRetry } : { url: '' });

  // ACP chat hook — activeSurfaceId에 해당하는 서피스의 상태 반환
  const {
    messages: acpMessages,
    isProcessing: acpProcessing,
    permissionRequest: acpPermission,
    agentStatus: acpAgentStatus,
    agentName: acpAgentName,
    acpSessionId,
    handleAcpMessage,
    sendPrompt: acpSendPrompt,
    respondToPermission: acpRespondPermission,
    cancel: acpCancel,
    ensureSession: acpEnsureSession,
    getSurfaceHasSession,
  } = useAcpChat(sendRaw, selectedSurfaceId);

  // Wire ACP messages from useRelay to useAcpChat
  onAcpMessage(useCallback((msg) => handleAcpMessage(msg), [handleAcpMessage]));

  const hasAcp = acpAgentStatus != null;
  const [surfaceViews, setSurfaceViews] = useState<SurfaceViewMap>(() => {
    try {
      return JSON.parse(localStorage.getItem("cmux-relay-surface-views") || "{}");
    } catch {
      return {} as SurfaceViewMap;
    }
  });
  const setSurfaceView = (surfaceId: string, view: SurfaceViewMode) => {
    setSurfaceViews(prev => {
      const next = { ...prev, [surfaceId]: view };
      localStorage.setItem("cmux-relay-surface-views", JSON.stringify(next));
      return next;
    });
  };
  const activeSurfaceView: SurfaceViewMode = "terminal";

  const connectedAtRef = useRef<number | undefined>(undefined);
  if (phase === 'connected' && connectedAtRef.current === undefined) {
    connectedAtRef.current = Date.now();
  }
  if (phase !== 'connected') {
    connectedAtRef.current = undefined;
  }

  const { toasts, dismissToast } = useNotificationToasts({ notifications, connectedAt: connectedAtRef.current });

  const userSelectedRef = useRef(false);
  const activeSurfaceIdRef = useRef<string | null>(null);
  const pendingBrowserNotifs = useRef<CmuxNotification[]>([]);
  const swRegRef = useRef<ServiceWorkerRegistration | null>(null);

  // Notify parent only if still disconnected after a grace period (auto-reconnect handles it)
  // But don't trigger on permanent errors (those show their own UI)
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (phase === 'error') {
      // Permanent error — don't trigger disconnect loop, show error UI instead
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
      return;
    }
    if (status === 'disconnected' && phase === 'reconnecting' && !disconnectTimerRef.current) {
      disconnectTimerRef.current = setTimeout(() => {
        onDisconnect?.();
        disconnectTimerRef.current = null;
      }, 15000);
    } else if (status !== 'disconnected' && disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
  }, [status, phase, onDisconnect]);

  // Only process output for the selected surface
  onOutput(useCallback((surfaceId: string, data: string) => {
    if (surfaceId === activeSurfaceIdRef.current) {
      writeToTerminal(surfaceId, data);
    }
  }, []));

  // Browser notification + push subscription
  const [notifPermission, setNotifPermission] = useState<'default' | 'granted' | 'denied' | 'unsupported'>(() =>
    typeof Notification !== 'undefined' ? Notification.permission as 'default' | 'granted' | 'denied' : 'unsupported'
  );
  const pushInitialized = useRef(false);

  useEffect(() => {
    if (status !== 'connected' || pushInitialized.current) return;
    pushInitialized.current = true;

    // Auto-subscribe if already granted (no user gesture needed)
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      registerServiceWorker().then((reg) => {
        if (reg) {
          swRegRef.current = reg;
          subscribePush(reg);
        }
      });
    }
  }, [status]);

  const handleEnableNotifications = async () => {
    if (typeof Notification === 'undefined') return;
    const p = await Notification.requestPermission();
    setNotifPermission(p);
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
  };

  // Handle pending navigation from push notification click
  useEffect(() => {
    getPendingNavigation().then((nav) => {
      if (nav) {
        if (nav.workspaceId) setSelectedWorkspaceId(nav.workspaceId);
        if (nav.surfaceId) {
          setSelectedSurfaceId(nav.surfaceId);
        }
      }
    });

    // Listen for navigation messages from service worker (app already open)
    const cleanup = onNavigateFromPush((nav) => {
      if (nav.workspaceId) setSelectedWorkspaceId(nav.workspaceId);
      if (nav.surfaceId) {
        setSelectedSurfaceId(nav.surfaceId);
        selectSurface(nav.surfaceId);
      }
    });
    return cleanup;
  }, []);

  // Browser notification callback
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

  // Auto-select first workspace when data arrives (only if no saved state)
  useEffect(() => {
    if (selectedWorkspaceId) {
      // Verify saved workspace still exists
      if (workspaces.length > 0 && !workspaces.some(w => w.id === selectedWorkspaceId)) {
        setSelectedWorkspaceId(workspaces[0].id);
      }
      return;
    }
    if (workspaces.length === 0) return;
    setSelectedWorkspaceId(workspaces[0].id);
  }, [workspaces, selectedWorkspaceId]);

  // Persist workspace selection
  useEffect(() => {
    if (selectedWorkspaceId) {
      localStorage.setItem('cmux-relay-last-workspace', selectedWorkspaceId);
    }
  }, [selectedWorkspaceId]);

  // Reset manual selection flag on workspace change
  useEffect(() => {
    userSelectedRef.current = false;
  }, [selectedWorkspaceId]);

  // Select surfaces for current workspace (mirrors desktop Layout logic)
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (surfaces.length === 0 && panes.length === 0) return;

    const wsPanes = panes.filter(p => p.workspaceId === selectedWorkspaceId);
    const wsSurfaces = surfaces.filter(
      s => s.workspaceId === selectedWorkspaceId && s.type === 'terminal'
    );

    if (wsSurfaces.length === 0) return;

    // Pick best surface: saved → focused pane → first pane → first surface
    const focusedPane = wsPanes.find(p => p.focused);
    let targetId: string | null = null;

    // Prefer saved surface if it exists in this workspace
    const savedSurfaceId = selectedSurfaceId;
    if (savedSurfaceId && wsSurfaces.some(s => s.id === savedSurfaceId)) {
      targetId = savedSurfaceId;
    } else if (wsPanes.length > 0) {
      targetId = focusedPane?.selectedSurfaceId || wsPanes[0].selectedSurfaceId;
    } else {
      targetId = wsSurfaces[0].id;
    }

    if (!targetId) return;

    // Always call selectSurface to ensure server sends output
    selectSurface(targetId);
    if (targetId !== selectedSurfaceId) {
      setSelectedSurfaceId(targetId);
    }
  }, [selectedWorkspaceId, panes, surfaces]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist surface selection
  useEffect(() => {
    if (selectedSurfaceId) {
      localStorage.setItem('cmux-relay-last-surface', selectedSurfaceId);
    }
  }, [selectedSurfaceId]);

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    localStorage.setItem('cmux-relay-token', token);
    setSubmitted(true);
  };

  // Login screen
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

  // Current workspace data
  const wsIndex = workspaces.findIndex(w => w.id === selectedWorkspaceId);
  const currentWs = workspaces[wsIndex];
  const wsSurfaces = selectedWorkspaceId
    ? surfaces.filter(s => s.workspaceId === selectedWorkspaceId && s.type === 'terminal')
    : [];

  // Active pane surface (prefer focused pane, fallback to selectedSurfaceId)
  const wsPanes = selectedWorkspaceId
    ? panes.filter(p => p.workspaceId === selectedWorkspaceId).sort((a, b) => a.index - b.index)
    : [];
  const focusedPane = wsPanes.find(p => p.focused);
  const activeSurfaceId = selectedSurfaceId
    || focusedPane?.selectedSurfaceId
    || wsSurfaces[0]?.id
    || null;
  const activeSurface = wsSurfaces.find(s => s.id === activeSurfaceId);
  activeSurfaceIdRef.current = activeSurfaceId;
  const currentSurfaceView: SurfaceViewMode = (activeSurfaceId && surfaceViews[activeSurfaceId]) || "terminal";

  // Workspace navigation
  const goWorkspace = (direction: -1 | 1) => {
    const nextIndex = wsIndex + direction;
    if (nextIndex >= 0 && nextIndex < workspaces.length) {
      const nextWs = workspaces[nextIndex];
      setSelectedWorkspaceId(nextWs.id);
      setSelectedSurfaceId(null);
    }
  };

  const clickToast = (n: CmuxNotification, i: number) => {
    if (n.workspaceId) setSelectedWorkspaceId(n.workspaceId);
    if (n.surfaceId) {
      setSelectedSurfaceId(n.surfaceId);
      selectSurface(n.surfaceId);
    }
    dismissToast(i);
  };

  const handleTabClick = (surfaceId: string) => {
    userSelectedRef.current = true;
    setSelectedSurfaceId(surfaceId);
    selectSurface(surfaceId);
  };

  return (
    <>
      <div className="mobile-app" style={{ height: `${appHeight}px` }}>
        <StatusBar
          status={status}
          phase={phase}
          reconnectDelay={reconnectDelay}
          p2pStatus={p2pStatus}
          transport={transport}
          title={currentWs?.title || 'cmux-relay'}
          notifications={notifications}
          onToggleNotifications={() => {}}
          onPrevWorkspace={() => goWorkspace(-1)}
          onNextWorkspace={() => goWorkspace(1)}
          prevDisabled={wsIndex <= 0}
          nextDisabled={wsIndex < 0 || wsIndex >= workspaces.length - 1}
          wsCounter={wsIndex >= 0 ? `${wsIndex + 1}/${workspaces.length}` : ''}
          showDashboard
          notifPermission={notifPermission}
          onEnableNotifications={handleEnableNotifications}
        />

        {/* Tab bar: surfaces in current workspace with per-surface terminal/chat toggle */}
        {wsSurfaces.length > 0 && (
          <div className="mobile-tab-bar">
            {wsSurfaces.map((s) => {
              const sView = surfaceViews[s.id] || 'terminal';
              const isActive = s.id === activeSurfaceId;
              return (
                <button
                  key={s.id}
                  className={`mobile-tab ${isActive ? 'active' : ''}`}
                  onClick={() => handleTabClick(s.id)}
                  style={isActive && hasAcp ? { position: 'relative', paddingRight: 24 } : undefined}
                >
                  {s.title || s.id.slice(0, 8)}
                  {isActive && hasAcp && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        const nextView = sView === 'terminal' ? 'chat' : 'terminal';
                        if (nextView === 'chat') acpEnsureSession(s.id);
                        setSurfaceView(s.id, nextView);
                      }}
                      style={{
                        position: 'absolute',
                        right: 4,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        fontSize: 10,
                        color: sView === 'chat' ? '#89b4fa' : '#6c7086',
                        cursor: 'pointer',
                        padding: '0 2px',
                      }}
                    >
                      {sView === 'chat' ? 'T' : '💬'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Content area */}
        {currentSurfaceView === "chat" && hasAcp ? (
          <div className="mobile-terminal-area">
            <ChatView
              messages={acpMessages}
              isProcessing={acpProcessing}
              agentStatus={acpAgentStatus}
              agentName={acpAgentName}
              permissionRequest={acpPermission}
              canSend={!!acpSessionId}
              onSendPrompt={acpSendPrompt}
              onCancel={acpCancel}
              onPermissionResponse={acpRespondPermission}
            />
          </div>
        ) : (
          <div className="mobile-terminal-area">
            <ConnectionOverlay
              phase={phase}
              highestPhase={highestPhase}
              reconnectAttempt={reconnectAttempt}
              reconnectDelay={reconnectDelay}
              errorMessage={errorMessage}
              transport={transport}
              onRetry={onRetry}
            />
            {activeSurface ? (
              <Terminal
                surfaceId={activeSurface.id}
                fitRows
                onInput={(data) => sendInput(activeSurface.id, data)}
                onResize={(cols, rows) => sendResize(activeSurface.id, cols, rows)}
              />
            ) : (
              <div className="no-pane-hint">
                <p>{workspaces.length === 0 ? 'Start cmux to see terminals' : 'Loading...'}</p>
              </div>
            )}
          </div>
        )}
      </div>

      <ToastContainer
        toasts={toasts}
        onDismiss={dismissToast}
        onClick={clickToast}
      />
    </>
  );
}
