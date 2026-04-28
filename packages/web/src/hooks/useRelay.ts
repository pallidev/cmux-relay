import { useRef, useEffect, useState, useCallback } from 'react';
import type { WorkspaceInfo, SurfaceInfo, PaneInfo, FrameRect, CmuxNotification, EncryptedPayload } from '@cmux-relay/shared';
import { ClientE2ECrypto } from '../lib/e2e-crypto';

type RelayStatus = 'connecting' | 'connected' | 'disconnected';

interface UseRelayOptions {
  url: string;
  token?: string;
  sessionId?: string;
  e2eEnabled?: boolean;
}

export function useRelay({ url, token, sessionId, e2eEnabled }: UseRelayOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const e2eRef = useRef<ClientE2ECrypto | null>(null);
  const [status, setStatus] = useState<RelayStatus>('disconnected');
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [surfaces, setSurfaces] = useState<SurfaceInfo[]>([]);
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const [containerFrames, setContainerFrames] = useState<Record<string, FrameRect>>({});
  const [activeSurfaceId, setActiveSurfaceId] = useState<string | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<CmuxNotification[]>([]);
  const [e2eReady, setE2eReady] = useState(false);
  const outputCbRef = useRef<(surfaceId: string, data: string) => void>(() => {});
  const notificationCbRef = useRef<(notifications: CmuxNotification[]) => void>(() => {});

  const onOutput = useCallback((cb: (surfaceId: string, data: string) => void) => {
    outputCbRef.current = cb;
  }, []);

  const onNotifications = useCallback((cb: (notifications: CmuxNotification[]) => void) => {
    notificationCbRef.current = cb;
  }, []);

  useEffect(() => {
    if (!url) return;

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let reconnectDelay = 1000;
    let hiddenAt = 0;

    const connect = async () => {
      if (disposed) return;

      const ws = new WebSocket(url);
      wsRef.current = ws;
      setStatus('connecting');

      ws.onopen = async () => {
        if (disposed) return;
        reconnectDelay = 1000;
        setStatus('connected');

        if (token) {
          ws.send(JSON.stringify({ type: 'auth', payload: { token } }));
        }

        if (e2eEnabled) {
          try {
            const e2e = new ClientE2ECrypto();
            const publicKey = await e2e.initialize();
            e2eRef.current = e2e;
            ws.send(JSON.stringify({ type: 'e2e.init', publicKey }));
          } catch (err) {
            console.error('[e2e] Key generation failed:', err);
          }
        }
      };

      ws.onmessage = async (event) => {
        if (disposed) return;
        const msg = JSON.parse(event.data as string);

        if (msg.type === 'e2e.ack') {
          try {
            await e2eRef.current?.handleE2EAck(msg);
            setE2eReady(true);
          } catch (err) {
            console.error('[e2e] Handshake failed:', err);
          }
          return;
        }

        switch (msg.type) {
          case 'workspaces':
            setWorkspaces(msg.payload.workspaces);
            break;
          case 'surfaces':
            setSurfaces(prev => {
              const next = prev.filter(s => s.workspaceId !== msg.workspaceId);
              return [...next, ...msg.payload.surfaces];
            });
            break;
          case 'panes':
            setPanes(prev => {
              const next = prev.filter(p => p.workspaceId !== msg.workspaceId);
              const incoming = (msg.payload.panes as PaneInfo[]).map(p => ({
                ...p,
                workspaceId: msg.workspaceId,
              }));
              return [...next, ...incoming];
            });
            if (msg.payload.containerFrame) {
              setContainerFrames(prev => ({
                ...prev,
                [msg.workspaceId]: msg.payload.containerFrame,
              }));
            }
            break;
          case 'surface.active':
            setActiveSurfaceId(msg.surfaceId);
            setActiveWorkspaceId(msg.workspaceId);
            break;
          case 'output':
            if (msg.payload.encrypted && e2eRef.current?.isReady()) {
              try {
                const decrypted = await e2eRef.current.decryptOutput(msg.payload as EncryptedPayload);
                outputCbRef.current(msg.surfaceId, decrypted);
              } catch (err) {
                console.error('[e2e] Decrypt failed:', err);
              }
            } else {
              outputCbRef.current(msg.surfaceId, msg.payload.data);
            }
            break;
          case 'notifications':
            setNotifications(prev => {
              const existingIds = new Set(prev.map(n => n.id));
              const newOnes = msg.payload.notifications.filter((n: CmuxNotification) => !existingIds.has(n.id));
              return [...newOnes, ...prev];
            });
            notificationCbRef.current(msg.payload.notifications);
            break;
          case 'error':
            console.error('Relay error:', msg.payload.message);
            break;
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        wsRef.current = null;
        setStatus('disconnected');
        setE2eReady(false);
        e2eRef.current = null;
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 10000);
      };

      ws.onerror = () => {
        if (disposed) return;
        setStatus('disconnected');
      };
    };

    connect();

    // Reconnect when page becomes visible after being hidden
    // Browsers/proxies may silently kill idle WebSocket connections while
    // readyState still reports OPEN. Force reconnect after 30s hidden.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !disposed) {
        const wasHiddenLong = hiddenAt > 0 && (Date.now() - hiddenAt) > 30_000;
        if (wasHiddenLong || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          if (wsRef.current) wsRef.current.close();
          clearTimeout(reconnectTimer);
          connect();
        }
      } else if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      document.removeEventListener('visibilitychange', onVisible);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [url, token, sessionId, e2eEnabled]);

  const selectSurface = useCallback((surfaceId: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'surface.select', surfaceId }));
  }, []);

  const requestWorkspaces = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: 'workspaces.list' }));
  }, []);

  const sendInput = useCallback(async (surfaceId: string, data: string) => {
    const bytes = new TextEncoder().encode(data);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const b64Data = btoa(binary);

    if (e2eRef.current?.isReady()) {
      const encrypted = await e2eRef.current.encryptInput(b64Data);
      wsRef.current?.send(
        JSON.stringify({
          type: 'input',
          surfaceId,
          payload: encrypted,
        }),
      );
    } else {
      wsRef.current?.send(
        JSON.stringify({
          type: 'input',
          surfaceId,
          payload: { data: b64Data },
        }),
      );
    }
  }, []);

  const sendResize = useCallback((surfaceId: string, cols: number, rows: number) => {
    wsRef.current?.send(
      JSON.stringify({ type: 'resize', surfaceId, payload: { cols, rows } }),
    );
  }, []);

  return { status, workspaces, surfaces, panes, containerFrames, activeSurfaceId, activeWorkspaceId, notifications, e2eReady, selectSurface, requestWorkspaces, sendInput, sendResize, onOutput, onNotifications };
}
