import { useRef, useEffect, useState, useCallback } from 'react';
import type { WorkspaceInfo, SurfaceInfo, PaneInfo, FrameRect, CmuxNotification, EncryptedPayload } from '@cmux-relay/shared';
import { ClientE2ECrypto } from '../lib/e2e-crypto';

type RelayStatus = 'connecting' | 'connected' | 'disconnected';
type TransportType = 'relay' | 'p2p';

interface UseRelayOptions {
  url: string;
  token?: string;
  sessionId?: string;
  e2eEnabled?: boolean;
}

export function useRelay({ url, token, sessionId, e2eEnabled }: UseRelayOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const e2eRef = useRef<ClientE2ECrypto | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const [status, setStatus] = useState<RelayStatus>('disconnected');
  const [transport, setTransport] = useState<TransportType>('relay');
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [surfaces, setSurfaces] = useState<SurfaceInfo[]>([]);
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const [containerFrames, setContainerFrames] = useState<Record<string, FrameRect>>({});
  const [activeSurfaceId, setActiveSurfaceId] = useState<string | null>(null);
  const activeSurfaceIdRef = useRef<string | null>(null);
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

  const handleMessage = (msg: any) => {
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
        activeSurfaceIdRef.current = msg.surfaceId;
        setActiveWorkspaceId(msg.workspaceId);
        break;
      case 'output':
        if (msg.payload.encrypted) {
          if (e2eRef.current?.isReady()) {
            e2eRef.current.decryptOutput(msg.payload as EncryptedPayload).then((decrypted) => {
              outputCbRef.current(msg.surfaceId, decrypted);
            }).catch((err) => {
              console.error('[e2e] Decrypt failed:', err);
            });
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

  const sendViaTransport = useCallback((data: string) => {
    // Prefer WebRTC DataChannel when available
    if (dcRef.current && dcRef.current.readyState === 'open') {
      dcRef.current.send(data);
      return;
    }
    wsRef.current?.send(data);
  }, []);

  useEffect(() => {
    if (!url) return;

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let reconnectDelay = 1000;
    let hiddenAt = 0;

    const setupWebRTC = (offer: RTCSessionDescriptionInit) => {
      if (disposed) return;

      cleanupWebRTC();

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });
      pcRef.current = pc;

      pc.onicecandidate = (event) => {
        if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'webrtc.ice-candidate',
            candidate: event.candidate.candidate,
            mid: event.candidate.sdpMid || '',
          }));
        }
      };

      pc.ondatachannel = (event) => {
        const dc = event.channel;
        dcRef.current = dc;

        dc.onopen = () => {
          console.log('[webrtc] DataChannel open — P2P active');
          setTransport('p2p');
        };

        dc.onclose = () => {
          console.log('[webrtc] DataChannel closed — falling back to relay');
          dcRef.current = null;
          setTransport('relay');
        };

        dc.onerror = (err) => {
          console.error('[webrtc] DataChannel error:', err);
          dcRef.current = null;
          setTransport('relay');
        };

        dc.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'e2e.ack') {
              e2eRef.current?.handleE2EAck(msg).then(() => {
                setE2eReady(true);
                if (activeSurfaceIdRef.current) {
                  dcRef.current?.send(JSON.stringify({ type: 'surface.select', surfaceId: activeSurfaceIdRef.current }));
                }
              }).catch((err: Error) => {
                console.error('[e2e] Handshake failed:', err);
              });
              return;
            }
            handleMessage(msg);
          } catch (err) {
            console.error('[webrtc] Message parse error:', err);
          }
        };
      };

      pc.setRemoteDescription(offer).then(() => {
        return pc.createAnswer();
      }).then((answer) => {
        return pc.setLocalDescription(answer);
      }).then(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN && pc.localDescription) {
          wsRef.current.send(JSON.stringify({
            type: 'webrtc.answer',
            sdp: pc.localDescription.sdp,
          }));
        }
      }).catch((err) => {
        console.error('[webrtc] Answer creation failed:', err);
        pc.close();
        pcRef.current = null;
      });
    };

    const cleanupWebRTC = () => {
      if (dcRef.current) {
        dcRef.current.close();
        dcRef.current = null;
      }
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      setTransport('relay');
    };

    const connect = async () => {
      if (disposed) return;

      let e2e: ClientE2ECrypto | null = null;
      let e2ePublicKey: string | null = null;
      if (e2eEnabled) {
        try {
          e2e = new ClientE2ECrypto();
          e2ePublicKey = await e2e.initialize();
        } catch (err) {
          console.error('[e2e] Key generation failed:', err);
        }
      }

      const ws = new WebSocket(url);
      wsRef.current = ws;
      setStatus('connecting');

      ws.onopen = () => {
        if (disposed) return;
        reconnectDelay = 1000;
        setStatus('connected');

        if (token) {
          ws.send(JSON.stringify({ type: 'auth', payload: { token } }));
        }

        if (e2e && e2ePublicKey) {
          e2eRef.current = e2e;
          ws.send(JSON.stringify({ type: 'e2e.init', publicKey: e2ePublicKey }));
        }
      };

      ws.onmessage = async (event) => {
        if (disposed) return;
        const msg = JSON.parse(event.data as string);

        if (msg.type === 'webrtc.offer') {
          console.log('[webrtc] Offer received from agent');
          setupWebRTC({ type: 'offer', sdp: msg.sdp });
          return;
        }

        if (msg.type === 'webrtc.ice-candidate') {
          if (pcRef.current) {
            pcRef.current.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid });
          }
          return;
        }

        if (msg.type === 'e2e.ack') {
          try {
            await e2eRef.current?.handleE2EAck(msg);
            setE2eReady(true);
            // Re-select active surface to get fresh (decryptable) terminal output
            if (activeSurfaceIdRef.current) {
              sendViaTransport(JSON.stringify({ type: 'surface.select', surfaceId: activeSurfaceIdRef.current }));
            }
          } catch (err) {
            console.error('[e2e] Handshake failed:', err);
          }
          return;
        }

        handleMessage(msg);
      };

      ws.onclose = () => {
        if (disposed) return;
        wsRef.current = null;
        setStatus('disconnected');
        setE2eReady(false);
        e2eRef.current = null;
        cleanupWebRTC();
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 10000);
      };

      ws.onerror = () => {
        if (disposed) return;
        setStatus('disconnected');
      };
    };

    connect();

    const forceReconnect = () => {
      clearTimeout(reconnectTimer);
      const oldWs = wsRef.current;
      wsRef.current = null;
      if (oldWs) {
        oldWs.onclose = null;
        oldWs.close();
      }
      cleanupWebRTC();
      setStatus('disconnected');
      setE2eReady(false);
      e2eRef.current = null;
      reconnectDelay = 1000;
      setTimeout(connect, 300);
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !disposed) {
        const wasHidden = hiddenAt > 0 && (Date.now() - hiddenAt) > 3_000;
        if (wasHidden || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          forceReconnect();
        } else if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'workspaces.list' }));
          if (activeSurfaceIdRef.current) {
            wsRef.current.send(JSON.stringify({ type: 'surface.select', surfaceId: activeSurfaceIdRef.current }));
          }
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
      cleanupWebRTC();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [url, token, sessionId, e2eEnabled]);

  const selectSurface = useCallback((surfaceId: string) => {
    sendViaTransport(JSON.stringify({ type: 'surface.select', surfaceId }));
  }, [sendViaTransport]);

  const requestWorkspaces = useCallback(() => {
    sendViaTransport(JSON.stringify({ type: 'workspaces.list' }));
  }, [sendViaTransport]);

  const sendInput = useCallback(async (surfaceId: string, data: string) => {
    const bytes = new TextEncoder().encode(data);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const b64Data = btoa(binary);

    if (e2eRef.current?.isReady()) {
      const encrypted = await e2eRef.current.encryptInput(b64Data);
      sendViaTransport(
        JSON.stringify({
          type: 'input',
          surfaceId,
          payload: encrypted,
        }),
      );
    } else {
      sendViaTransport(
        JSON.stringify({
          type: 'input',
          surfaceId,
          payload: { data: b64Data },
        }),
      );
    }
  }, [sendViaTransport]);

  const sendResize = useCallback((surfaceId: string, cols: number, rows: number) => {
    sendViaTransport(
      JSON.stringify({ type: 'resize', surfaceId, payload: { cols, rows } }),
    );
  }, [sendViaTransport]);

  return { status, transport, workspaces, surfaces, panes, containerFrames, activeSurfaceId, activeWorkspaceId, notifications, e2eReady, selectSurface, requestWorkspaces, sendInput, sendResize, onOutput, onNotifications };
}
