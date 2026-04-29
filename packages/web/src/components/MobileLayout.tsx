import { useState, useCallback, useEffect, useRef } from 'react';
import { useRelay } from '../hooks/useRelay';
import { Terminal, writeToTerminal } from './Terminal';
import { getRelayWsUrl, getToastType } from '../lib/helpers';
import { registerServiceWorker, subscribePush, getPendingNavigation, onNavigateFromPush } from '../lib/push';
import type { CmuxNotification } from '@cmux-relay/shared';

const RELAY_URL = getRelayWsUrl();

export function MobileLayout({ relayWsUrl, onDisconnect }: { relayWsUrl?: string; onDisconnect?: () => void }) {
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
    workspaces,
    surfaces,
    panes,
    notifications,
    selectSurface,
    sendInput,
    sendResize,
    onOutput,
    onNotifications,
  } = useRelay(relayUrl ? { url: relayUrl, e2eEnabled: true } : { url: '' });

  const [toasts, setToasts] = useState<CmuxNotification[]>([]);
  const prevNotifCount = useRef(0);
  const userSelectedRef = useRef(false);
  const activeSurfaceIdRef = useRef<string | null>(null);
  const pendingBrowserNotifs = useRef<CmuxNotification[]>([]);

  // Notify parent only if still disconnected after a grace period (auto-reconnect handles it)
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (status === 'disconnected' && !disconnectTimerRef.current) {
      disconnectTimerRef.current = setTimeout(() => {
        onDisconnect?.();
        disconnectTimerRef.current = null;
      }, 15000);
    } else if (status !== 'disconnected' && disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
  }, [status, onDisconnect]);

  // Only process output for the selected surface
  onOutput(useCallback((surfaceId: string, data: string) => {
    if (surfaceId === activeSurfaceIdRef.current) {
      writeToTerminal(surfaceId, data);
    }
  }, []));

  // Browser notification + push subscription
  const [notifPermission, setNotifPermission] = useState(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );
  const pushInitialized = useRef(false);

  useEffect(() => {
    if (status !== 'connected' || pushInitialized.current) return;
    pushInitialized.current = true;

    // Auto-subscribe if already granted (no user gesture needed)
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      registerServiceWorker().then((reg) => {
        if (reg) subscribePush(reg);
      });
    }
  }, [status]);

  const handleEnableNotifications = async () => {
    if (typeof Notification === 'undefined') return;
    const p = await Notification.requestPermission();
    setNotifPermission(p);
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
        new Notification(n.title, { body: n.subtitle ? `${n.subtitle}: ${n.body}` : n.body, tag: n.id });
      } else {
        pendingBrowserNotifs.current.push(n);
      }
    }
  }, []));

  // Show in-app toast when new notifications arrive
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

  // Workspace navigation
  const goWorkspace = (direction: -1 | 1) => {
    const nextIndex = wsIndex + direction;
    if (nextIndex >= 0 && nextIndex < workspaces.length) {
      const nextWs = workspaces[nextIndex];
      setSelectedWorkspaceId(nextWs.id);
      setSelectedSurfaceId(null);
    }
  };

  const dismissToast = (i: number) => {
    setToasts(prev => prev.filter((_, idx) => idx !== i));
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
        {/* Header */}
        <header className="mobile-header">
          <button
            className="mobile-nav-btn"
            onClick={() => goWorkspace(-1)}
            disabled={wsIndex <= 0}
          >
            &#8249;
          </button>
          <span className="status">
            <span className={`status-dot ${status}`} />
          </span>
          <span className="mobile-header-title">
            {currentWs?.title || 'cmux-relay'}
          </span>
          <span className="mobile-ws-counter">
            {wsIndex >= 0 ? `${wsIndex + 1}/${workspaces.length}` : ''}
          </span>
          <button
            className="mobile-nav-btn"
            onClick={() => goWorkspace(1)}
            disabled={wsIndex < 0 || wsIndex >= workspaces.length - 1}
          >
            &#8250;
          </button>
          <a href="/" className="dashboard-btn" title="Dashboard">&#x2302;</a>
          {notifPermission === 'default' && (
            <button className="mobile-nav-btn notif-enable-btn" onClick={handleEnableNotifications} title="Enable notifications">&#x1F514;</button>
          )}
        </header>

        {/* Tab bar: surfaces in current workspace */}
        {wsSurfaces.length > 1 && (
          <div className="mobile-tab-bar">
            {wsSurfaces.map((s) => (
              <button
                key={s.id}
                className={`mobile-tab ${s.id === activeSurfaceId ? 'active' : ''}`}
                onClick={() => handleTabClick(s.id)}
              >
                {s.title || s.id.slice(0, 8)}
              </button>
            ))}
          </div>
        )}

        {/* Terminal area with horizontal scroll */}
        <div
          className="mobile-terminal-area"
        >
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
      </div>

      {/* Toast notifications */}
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
