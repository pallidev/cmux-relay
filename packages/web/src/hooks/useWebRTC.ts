import { useRef, useCallback } from 'react';
import type { RelayToClient, EncryptedPayload } from '@cmux-relay/shared';

interface ClientE2ECryptoLike {
  handleE2EAck(msg: unknown): Promise<void>;
  isReady(): boolean;
  decryptOutput(payload: EncryptedPayload): Promise<string>;
}

export interface UseWebRTCDeps {
  setTransport: (t: 'relay' | 'p2p') => void;
  setP2pStatus: (s: 'none' | 'attempting' | 'connected' | 'failed') => void;
  p2pTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  e2eRef: React.MutableRefObject<ClientE2ECryptoLike | null>;
  setE2eReady: (ready: boolean) => void;
  activeSurfaceIdRef: React.MutableRefObject<string | null>;
  sendViaWs: (data: string) => void;
  onMessage: (msg: RelayToClient) => void;
}

/**
 * Manages WebRTC PeerConnection and DataChannel lifecycle.
 * Provides handleOffer, handleIceCandidate, cleanupWebRTC, and sendViaTransport.
 */
export function useWebRTC(deps: UseWebRTCDeps) {
  const {
    setTransport, setP2pStatus, p2pTimeoutRef,
    e2eRef, setE2eReady, activeSurfaceIdRef,
    sendViaWs, onMessage,
  } = deps;

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);

  const cleanupWebRTC = useCallback(() => {
    if (dcRef.current) { dcRef.current.close(); dcRef.current = null; }
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    setTransport('relay');
  }, [setTransport]);

  const sendViaTransport = useCallback((data: string) => {
    if (dcRef.current && dcRef.current.readyState === 'open') {
      dcRef.current.send(data);
      return;
    }
    sendViaWs(data);
  }, [sendViaWs]);

  const handleOffer = useCallback((offer: RTCSessionDescriptionInit) => {
    cleanupWebRTC();
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });
    pcRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendViaWs(JSON.stringify({
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
        if (p2pTimeoutRef.current) { clearTimeout(p2pTimeoutRef.current); p2pTimeoutRef.current = null; }
        setP2pStatus('connected');
      };
      dc.onclose = () => {
        console.log('[webrtc] DataChannel closed — falling back to relay');
        dcRef.current = null;
        setTransport('relay');
        if (p2pTimeoutRef.current) { clearTimeout(p2pTimeoutRef.current); p2pTimeoutRef.current = null; }
        setP2pStatus('failed');
      };
      dc.onerror = (err) => {
        console.error('[webrtc] DataChannel error:', err);
        dcRef.current = null;
        setTransport('relay');
        if (p2pTimeoutRef.current) { clearTimeout(p2pTimeoutRef.current); p2pTimeoutRef.current = null; }
        setP2pStatus('failed');
      };
      dc.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'webrtc.ping') { dc.send('{"type":"webrtc.pong"}'); return; }
          if (msg.type === 'e2e.ack') {
            e2eRef.current?.handleE2EAck(msg).then(() => {
              setE2eReady(true);
              if (activeSurfaceIdRef.current) {
                dcRef.current?.send(JSON.stringify({ type: 'surface.select', surfaceId: activeSurfaceIdRef.current }));
              }
            }).catch((err: Error) => { console.error('[e2e] Handshake failed:', err); });
            return;
          }
          onMessage(msg);
        } catch (err) { console.error('[webrtc] Message parse error:', err); }
      };
    };

    pc.setRemoteDescription(offer).then(() => pc.createAnswer())
      .then((answer) => pc.setLocalDescription(answer))
      .then(() => {
        if (pc.localDescription) {
          sendViaWs(JSON.stringify({ type: 'webrtc.answer', sdp: pc.localDescription.sdp }));
        }
      }).catch((err) => {
        console.error('[webrtc] Answer creation failed:', err);
        pc.close(); pcRef.current = null;
      });
  }, [cleanupWebRTC, sendViaWs, setTransport, setP2pStatus, p2pTimeoutRef, e2eRef, setE2eReady, activeSurfaceIdRef, onMessage]);

  const handleIceCandidate = useCallback((candidate: RTCIceCandidateInit) => {
    if (pcRef.current) pcRef.current.addIceCandidate(candidate);
  }, []);

  return { pcRef, dcRef, sendViaTransport, cleanupWebRTC, handleOffer, handleIceCandidate };
}
