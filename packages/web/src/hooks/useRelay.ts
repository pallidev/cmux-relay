import { useRef, useEffect, useState, useCallback } from 'react';
import type { WorkspaceInfo, SurfaceInfo, PaneInfo, FrameRect, CmuxNotification, E2EAckMessage } from '@cmux-relay/shared';
import { ClientE2ECrypto } from '../lib/e2e-crypto';
import { createMessageRouter, type ConnectionPhase } from '../lib/message-router';
import { useWebSocket } from './useWebSocket';
import { useWebRTC } from './useWebRTC';

// Re-export types for backward compatibility
export type { ConnectionPhase } from '../lib/message-router';

type RelayStatus = 'connecting' | 'connected' | 'disconnected';
type P2PStatus = 'none' | 'attempting' | 'connected' | 'failed';

interface UseRelayOptions {
  url: string;
  token?: string;
  sessionId?: string;
  e2eEnabled?: boolean;
}

export function useRelay({ url, token, sessionId, e2eEnabled }: UseRelayOptions) {
  // --- State ---
  const e2eRef = useRef<ClientE2ECrypto | null>(null);
  const [phase, setPhase] = useState<ConnectionPhase>('idle');
  const [highestPhase, setHighestPhase] = useState<ConnectionPhase | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [reconnectDelay, setReconnectDelay] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transport, setTransport] = useState<'relay' | 'p2p'>('relay');
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [surfaces, setSurfaces] = useState<SurfaceInfo[]>([]);
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const [containerFrames, setContainerFrames] = useState<Record<string, FrameRect>>({});
  const [activeSurfaceId, setActiveSurfaceId] = useState<string | null>(null);
  const activeSurfaceIdRef = useRef<string | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<CmuxNotification[]>([]);
  const [e2eReady, setE2eReady] = useState(false);
  const phaseRef = useRef<ConnectionPhase>('idle');
  const highestPhaseRef = useRef<ConnectionPhase | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const p2pTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [p2pStatus, setP2pStatus] = useState<P2PStatus>('none');

  const status: RelayStatus = phase === 'connected' ? 'connected'
    : phase === 'idle' || phase === 'error' ? 'disconnected' : 'connecting';

  const outputCbRef = useRef<(surfaceId: string, data: string) => void>(() => {});
  const notificationCbRef = useRef<(notifications: CmuxNotification[]) => void>(() => {});
  const onOutput = useCallback((cb: (surfaceId: string, data: string) => void) => { outputCbRef.current = cb; }, []);
  const onNotifications = useCallback((cb: (notifications: CmuxNotification[]) => void) => { notificationCbRef.current = cb; }, []);

  const updatePhase = useCallback((p: ConnectionPhase) => { phaseRef.current = p; setPhase(p); }, []);
  const updateHighestPhase = useCallback((p: ConnectionPhase | null) => { highestPhaseRef.current = p; setHighestPhase(p); }, []);

  // --- Message router (pure function from message-router.ts) ---
  const routeMessage = useCallback(() => createMessageRouter({
    setWorkspaces, setSurfaces, setPanes, setContainerFrames,
    setActiveSurfaceId, setActiveWorkspaceId, setNotifications,
    outputCallback: (surfaceId, data) => outputCbRef.current(surfaceId, data),
    notificationCallback: (notifs) => notificationCbRef.current(notifs),
    e2eRef, activeSurfaceIdRef,
    updatePhase: (p) => { updatePhase(p); if (p === 'connected') updateHighestPhase('connected'); },
    clearConnectionTimeout: () => { if (connectionTimeoutRef.current) { clearTimeout(connectionTimeoutRef.current); connectionTimeoutRef.current = null; } },
    resetReconnectAttempt: () => setReconnectAttempt(0),
  }), [updatePhase, updateHighestPhase])();

  // sendViaWs placeholder — will be set after useWebSocket provides wsRef
  const sendViaWsRef = useRef<(data: string) => void>(() => {});

  // --- WebRTC (uses sendViaWsRef to avoid circular dependency) ---
  const { sendViaTransport, cleanupWebRTC, handleOffer, handleIceCandidate } = useWebRTC({
    setTransport, setP2pStatus, p2pTimeoutRef,
    e2eRef, setE2eReady, activeSurfaceIdRef,
    sendViaWs: (data: string) => sendViaWsRef.current(data),
    onMessage: routeMessage,
  });

  // E2E ack handler (used by both WS and WebRTC paths)
  const onE2EAck = useCallback(async (msg: E2EAckMessage) => {
    await e2eRef.current?.handleE2EAck(msg);
    setE2eReady(true);
    if (activeSurfaceIdRef.current) {
      sendViaTransport(JSON.stringify({ type: 'surface.select', surfaceId: activeSurfaceIdRef.current }));
    }
  }, [sendViaTransport]);

  // --- WebSocket connection (delegates to useWebSocket hook) ---
  const wsRef = useWebSocket(url, token, sessionId, e2eEnabled, {
    updatePhase, updateHighestPhase,
    setReconnectAttempt, setReconnectDelay, setErrorMessage, setE2eReady,
    phaseRef, highestPhaseRef, connectionTimeoutRef, e2eRef,
    onOpen: (ws) => { /* E2E init is handled inside useWebSocket */ },
    onMessage: (msg) => {
      if (msg.type === 'webrtc.offer') {
        console.log('[webrtc] Offer received from agent');
        setP2pStatus('attempting');
        handleOffer({ type: 'offer', sdp: msg.sdp });
        if (p2pTimeoutRef.current) clearTimeout(p2pTimeoutRef.current);
        p2pTimeoutRef.current = setTimeout(() => {
          console.warn('[webrtc] P2P timeout — using relay');
          setP2pStatus('failed');
        }, 10_000);
        return;
      }
      if (msg.type === 'webrtc.ice-candidate') {
        handleIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid });
        return;
      }
      if (msg.type === 'e2e.ack') {
        onE2EAck(msg).catch((err) => console.error('[e2e] Handshake failed:', err));
        return;
      }
      routeMessage(msg);
    },
    onClose: () => { cleanupWebRTC(); },
  });

  // Wire up sendViaWs now that we have wsRef
  sendViaWsRef.current = useCallback((data: string) => { wsRef.current?.send(data); }, []);

  // --- Action methods ---
  const selectSurface = useCallback((surfaceId: string) => {
    sendViaTransport(JSON.stringify({ type: 'surface.select', surfaceId }));
  }, [sendViaTransport]);

  const requestWorkspaces = useCallback(() => {
    sendViaTransport(JSON.stringify({ type: 'workspaces.list' }));
  }, [sendViaTransport]);

  const sendInput = useCallback(async (surfaceId: string, data: string) => {
    const bytes = new TextEncoder().encode(data);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64Data = btoa(binary);
    if (e2eRef.current?.isReady()) {
      const encrypted = await e2eRef.current.encryptInput(b64Data);
      sendViaTransport(JSON.stringify({ type: 'input', surfaceId, payload: encrypted }));
    } else {
      sendViaTransport(JSON.stringify({ type: 'input', surfaceId, payload: { data: b64Data } }));
    }
  }, [sendViaTransport]);

  const sendResize = useCallback((surfaceId: string, cols: number, rows: number) => {
    sendViaTransport(JSON.stringify({ type: 'resize', surfaceId, payload: { cols, rows } }));
  }, [sendViaTransport]);

  return { status, phase, highestPhase, reconnectAttempt, reconnectDelay, errorMessage, transport, p2pStatus, workspaces, surfaces, panes, containerFrames, activeSurfaceId, activeWorkspaceId, notifications, e2eReady, selectSurface, requestWorkspaces, sendInput, sendResize, onOutput, onNotifications };
}
