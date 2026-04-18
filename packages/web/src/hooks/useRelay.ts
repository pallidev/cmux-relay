import { useRef, useEffect, useState, useCallback } from 'react';
import type { WorkspaceInfo, SurfaceInfo, PaneInfo, FrameRect, CmuxNotification } from '@cmux-relay/shared';

type RelayStatus = 'connecting' | 'connected' | 'disconnected';

interface UseRelayOptions {
  url: string;
  token?: string;
  sessionId?: string;
}

export function useRelay({ url, token, sessionId }: UseRelayOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<RelayStatus>('disconnected');
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [surfaces, setSurfaces] = useState<SurfaceInfo[]>([]);
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const [containerFrames, setContainerFrames] = useState<Record<string, FrameRect>>({});
  const [activeSurfaceId, setActiveSurfaceId] = useState<string | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<CmuxNotification[]>([]);
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

    const ws = new WebSocket(url);
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      setStatus('connected');
      if (token) {
        ws.send(JSON.stringify({ type: 'auth', payload: { token } }));
      }
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
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
          outputCbRef.current(msg.surfaceId, msg.payload.data);
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

    ws.onclose = () => setStatus('disconnected');
    ws.onerror = () => setStatus('disconnected');

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [url, token, sessionId]);

  const selectSurface = useCallback((surfaceId: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'surface.select', surfaceId }));
  }, []);

  const requestWorkspaces = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: 'workspaces.list' }));
  }, []);

  const sendInput = useCallback((surfaceId: string, data: string) => {
    const bytes = new TextEncoder().encode(data);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    wsRef.current?.send(
      JSON.stringify({
        type: 'input',
        surfaceId,
        payload: { data: btoa(binary) },
      }),
    );
  }, []);

  const sendResize = useCallback((surfaceId: string, cols: number, rows: number) => {
    wsRef.current?.send(
      JSON.stringify({ type: 'resize', surfaceId, payload: { cols, rows } }),
    );
  }, []);

  return { status, workspaces, surfaces, panes, containerFrames, activeSurfaceId, activeWorkspaceId, notifications, selectSurface, requestWorkspaces, sendInput, sendResize, onOutput, onNotifications };
}
