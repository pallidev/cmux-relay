import { useState, useCallback, useEffect, useRef } from 'react';
import { useRelay } from '../hooks/useRelay';
import { Terminal, writeToTerminal } from './Terminal';
import { getRelayWsUrl, getToastType } from '../lib/helpers';
import type { CmuxNotification } from '@cmux-relay/shared';

const RELAY_URL = getRelayWsUrl();

export function MobileLayout({ relayWsUrl }: { relayWsUrl?: string }) {
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
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [selectedSurfaceId, setSelectedSurfaceId] = useState<string | null>(null);

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
  } = useRelay(relayUrl ? { url: relayUrl } : { url: '' });

  const [toasts, setToasts] = useState<CmuxNotification[]>([]);
  const prevNotifCount = useRef(0);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const isSwiping = useRef(false);
  const userSelectedRef = useRef(false);
  const activeSurfaceIdRef = useRef<string | null>(null);

  // Only process output for the selected surface
  onOutput(useCallback((surfaceId: string, data: string) => {
    if (surfaceId === activeSurfaceIdRef.current) {
      writeToTerminal(surfaceId, data);
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

  // Auto-select first workspace when data arrives
  useEffect(() => {
    if (selectedWorkspaceId) return;
    if (workspaces.length === 0) return;
    setSelectedWorkspaceId(workspaces[0].id);
  }, [workspaces, selectedWorkspaceId]);

  // Reset manual selection flag on workspace change
  useEffect(() => {
    userSelectedRef.current = false;
  }, [selectedWorkspaceId]);

  // Select surfaces for current workspace (mirrors desktop Layout logic)
  useEffect(() => {
    if (!selectedWorkspaceId) return;

    const wsPanes = panes.filter(p => p.workspaceId === selectedWorkspaceId);
    const wsSurfaces = surfaces.filter(
      s => s.workspaceId === selectedWorkspaceId && s.type === 'terminal'
    );

    // Pick best surface: focused pane → first pane → first surface
    const focusedPane = wsPanes.find(p => p.focused);
    let targetId: string | null = null;

    if (wsPanes.length > 0) {
      targetId = focusedPane?.selectedSurfaceId || wsPanes[0].selectedSurfaceId;
    } else if (wsSurfaces.length > 0) {
      targetId = wsSurfaces[0].id;
    }

    if (targetId && targetId !== selectedSurfaceId && !userSelectedRef.current) {
      selectSurface(targetId);
      setSelectedSurfaceId(targetId);
    }
  }, [selectedWorkspaceId, panes, surfaces]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Touch handlers for swipe
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    isSwiping.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const dx = e.touches[0].clientX - touchStartX.current;
    const dy = e.touches[0].clientY - touchStartY.current;
    // Only track horizontal swipes
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      isSwiping.current = true;
      setSwipeOffset(dx * 0.3);
    }
  };

  const handleTouchEnd = () => {
    if (isSwiping.current) {
      const threshold = 50;
      if (swipeOffset < -threshold) goWorkspace(1);
      else if (swipeOffset > threshold) goWorkspace(-1);
    }
    setSwipeOffset(0);
    isSwiping.current = false;
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
      <div className="mobile-app">
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

        {/* Terminal area with swipe support */}
        <div
          className="mobile-terminal-area"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{
            transform: `translateX(${swipeOffset}px)`,
            transition: swipeOffset === 0 ? 'transform 0.25s ease' : 'none',
          }}
        >
          {activeSurface ? (
            <Terminal
              surfaceId={activeSurface.id}
              cols={wsPanes.find(p => p.selectedSurfaceId === activeSurface.id)?.columns}
              rows={wsPanes.find(p => p.selectedSurfaceId === activeSurface.id)?.rows}
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
