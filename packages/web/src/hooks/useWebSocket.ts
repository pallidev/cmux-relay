import { useRef, useEffect } from 'react';
import { ClientE2ECrypto } from '../lib/e2e-crypto';
import type { ConnectionPhase } from '../lib/message-router';
import type { RelayToClient } from '@cmux-relay/shared';

export interface WebSocketLifecycleCallbacks {
  updatePhase: (p: ConnectionPhase) => void;
  updateHighestPhase: (p: ConnectionPhase | null) => void;
  setReconnectAttempt: (updater: (prev: number) => number) => void;
  setReconnectDelay: (delay: number) => void;
  setErrorMessage: (msg: string | null) => void;
  setE2eReady: (ready: boolean) => void;
  phaseRef: React.MutableRefObject<ConnectionPhase>;
  highestPhaseRef: React.MutableRefObject<ConnectionPhase | null>;
  connectionTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  e2eRef: React.MutableRefObject<ClientE2ECrypto | null>;
  onMessage: (msg: RelayToClient) => void;
  onOpen: (ws: WebSocket) => void;
  onClose: () => void;
}

const PHASE_ORDER: ConnectionPhase[] = ['connecting', 'waiting-agent', 'connected'];

export function phaseIndex(p: ConnectionPhase | null): number {
  if (p === null) return -1;
  const i = PHASE_ORDER.indexOf(p);
  return i >= 0 ? i : -1;
}

/**
 * Manages WebSocket connection lifecycle: connect, reconnect, ping/pong,
 * visibility change, network-online, and page-resume events.
 */
export function useWebSocket(
  url: string,
  token: string | undefined,
  sessionId: string | undefined,
  e2eEnabled: boolean | undefined,
  cb: WebSocketLifecycleCallbacks,
): React.MutableRefObject<WebSocket | null> {
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!url) return;

    let disposed = false;
    let isConnecting = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = 1000;
    let consecutiveTimeouts = 0;
    let consecutiveErrors = 0;
    let hiddenAt = 0;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let pongTimer: ReturnType<typeof setTimeout> | null = null;
    const MAX_RECONNECT_ATTEMPTS = 30;

    const connect = async () => {
      if (disposed || isConnecting) return;
      isConnecting = true;

      let e2e: ClientE2ECrypto | null = null;
      let e2ePublicKey: string | null = null;
      if (e2eEnabled) {
        try { e2e = new ClientE2ECrypto(); e2ePublicKey = await e2e.initialize(); }
        catch (err) { console.error('[e2e] Key generation failed:', err); }
      }

      const ws = new WebSocket(url);
      wsRef.current = ws;
      cb.updatePhase('connecting');

      ws.onopen = () => {
        if (disposed) return;
        isConnecting = false;
        consecutiveErrors = 0;
        reconnectDelay = 1000;
        cb.updatePhase('waiting-agent');
        cb.setErrorMessage(null);

        if (token) ws.send(JSON.stringify({ type: 'auth', payload: { token } }));
        if (e2e && e2ePublicKey) {
          cb.e2eRef.current = e2e;
          ws.send(JSON.stringify({ type: 'e2e.init', publicKey: e2ePublicKey }));
        }

        if (cb.connectionTimeoutRef.current) clearTimeout(cb.connectionTimeoutRef.current);
        cb.connectionTimeoutRef.current = setTimeout(() => {
          if (cb.phaseRef.current !== 'connected' && !disposed) {
            consecutiveTimeouts++;
            if (consecutiveTimeouts >= 5) {
              console.error(`[relay] Agent not responding after ${consecutiveTimeouts} timeouts — giving up`);
              cb.updatePhase('error');
              cb.setErrorMessage('Agent가 응답하지 않습니다. Agent가 실행 중인지 확인해주세요.');
              const oldWs = wsRef.current;
              wsRef.current = null;
              if (oldWs) { oldWs.onclose = null; oldWs.close(); }
              return;
            }
            const delay = Math.min(2000 * Math.pow(1.5, Math.min(consecutiveTimeouts - 1, 5)), 30_000);
            console.warn(`[relay] Connection timeout (#${consecutiveTimeouts}) — forcing reconnect in ${delay}ms`);
            forceReconnect(delay);
          }
        }, 30_000);

        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'ping' }));
            if (pongTimer) clearTimeout(pongTimer);
            pongTimer = setTimeout(() => {
              console.warn('[relay] Pong timeout — forcing reconnect');
              forceReconnect();
            }, 10_000);
          }
        }, 25_000);

        cb.onOpen(ws);
      };

      ws.onmessage = async (event) => {
        if (disposed) return;
        if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
        const msg = JSON.parse(event.data as string);
        cb.onMessage(msg);
        if (msg.type === 'workspaces') {
          consecutiveTimeouts = 0;
          consecutiveErrors = 0;
        }
      };

      ws.onclose = (event) => {
        if (disposed) return;
        isConnecting = false;
        wsRef.current = null;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

        const currentPhaseIdx = phaseIndex(cb.phaseRef.current);
        if (currentPhaseIdx > phaseIndex(cb.highestPhaseRef.current)) {
          cb.updateHighestPhase(cb.phaseRef.current);
        }

        consecutiveErrors++;
        cb.setReconnectAttempt(prev => prev + 1);

        if (consecutiveErrors > MAX_RECONNECT_ATTEMPTS) {
          console.error(`[relay] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — stopping`);
          cb.updatePhase('error');
          cb.setErrorMessage('서버에 연결할 수 없습니다. 나중에 다시 시도해주세요.');
          cb.setE2eReady(false);
          cb.e2eRef.current = null;
          cb.onClose();
          return;
        }

        // Session not found (1008) or auth failure — don't keep retrying
        if (event.code === 1008) {
          console.error(`[relay] Server rejected connection (${event.code}): ${event.reason}`);
          cb.updatePhase('error');
          cb.setErrorMessage(event.reason || '세션을 찾을 수 없습니다. Agent가 실행 중인지 확인해주세요.');
          cb.setE2eReady(false);
          cb.e2eRef.current = null;
          cb.onClose();
          return;
        }

        // Normal close with reason — show error, don't loop
        if (event.code === 1000 && event.reason) {
          cb.updatePhase('error');
          cb.setErrorMessage(event.reason);
          cb.setE2eReady(false);
          cb.e2eRef.current = null;
          cb.onClose();
          return;
        }

        const delay = event.code !== 1000
          ? Math.min(1000 + Math.random() * 1000, reconnectDelay)  // 1-2s initial, then backoff
          : reconnectDelay;

        cb.setReconnectDelay(delay);
        cb.updatePhase('reconnecting');
        reconnectTimer = setTimeout(connect, delay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);  // gentler backoff, max 30s

        cb.setE2eReady(false);
        cb.e2eRef.current = null;
        cb.onClose();
      };

      ws.onerror = () => {
        if (disposed) return;
        isConnecting = false;
        // Don't set error phase here — onclose will follow and handle reconnection
        // This prevents the error→close→reconnect flicker
      };
    };

    connect();

    const forceReconnect = (delay = 300) => {
      if (disposed || isConnecting) return;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
      if (cb.connectionTimeoutRef.current) { clearTimeout(cb.connectionTimeoutRef.current); cb.connectionTimeoutRef.current = null; }
      const oldWs = wsRef.current;
      wsRef.current = null;
      if (oldWs) { oldWs.onclose = null; oldWs.close(); }
      cb.onClose();
      cb.updatePhase('reconnecting');
      cb.setReconnectDelay(delay);
      cb.setE2eReady(false);
      cb.e2eRef.current = null;
      reconnectDelay = Math.max(delay, 1000);
      reconnectTimer = setTimeout(connect, delay);
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !disposed) {
        const wasHidden = hiddenAt > 0 && (Date.now() - hiddenAt) > 1_000;
        const wsOk = wsRef.current && wsRef.current.readyState === WebSocket.OPEN;
        if (wasHidden || !wsOk) { forceReconnect(); }
        else if (wsOk) {
          wsRef.current!.send(JSON.stringify({ type: 'workspaces.list' }));
          if (cb.connectionTimeoutRef.current) clearTimeout(cb.connectionTimeoutRef.current);
          cb.connectionTimeoutRef.current = setTimeout(() => {
            if (cb.phaseRef.current !== 'connected' && !disposed) {
              console.warn('[relay] Liveness check failed — forcing reconnect');
              forceReconnect();
            }
          }, 5_000);
        }
      } else if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); }
    };
    document.addEventListener('visibilitychange', onVisible);

    const onOnline = () => { if (!disposed) { console.log('[relay] Network online — forcing reconnect'); forceReconnect(); } };
    window.addEventListener('online', onOnline);

    const onResume = () => { if (!disposed) { console.log('[relay] Page resumed from freeze — forcing reconnect'); forceReconnect(); } };
    document.addEventListener('resume', onResume);

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (pongTimer) clearTimeout(pongTimer);
      if (cb.connectionTimeoutRef.current) clearTimeout(cb.connectionTimeoutRef.current);
      cb.connectionTimeoutRef.current = null;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('resume', onResume);
      cb.onClose();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [url, token, sessionId, e2eEnabled]);

  return wsRef;
}
