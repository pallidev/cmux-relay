import * as nodeDataChannel from 'node-datachannel';

const PING_INTERVAL = 30_000;
const PING_TIMEOUT = 10_000;

export class WebRTCTransport {
  private pc: nodeDataChannel.PeerConnection | null = null;
  private dc: nodeDataChannel.DataChannel | null = null;
  private onMessageCb: ((msg: string) => void) | null = null;
  private onOpenCb: (() => void) | null = null;
  private onErrorCb: ((err: Error) => void) | null = null;
  private onIceCandidateCb: ((candidate: string, mid: string) => void) | null = null;
  private isConnected = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pingInterval: number;
  private readonly pingTimeout: number;

  constructor(opts?: { pingInterval?: number; pingTimeout?: number }) {
    this.pingInterval = opts?.pingInterval ?? PING_INTERVAL;
    this.pingTimeout = opts?.pingTimeout ?? PING_TIMEOUT;
  }

  createOffer(): { sdp: string } {
    this.pc = new nodeDataChannel.PeerConnection('cmux-relay', {
      iceServers: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
    });

    this.setupPeerConnectionHandlers();

    this.dc = this.pc.createDataChannel('terminal');
    this.setupDataChannelHandlers();

    this.pc.setLocalDescription('offer');

    const desc = this.pc.localDescription();
    if (!desc?.sdp) {
      throw new Error('Failed to create SDP offer');
    }

    return { sdp: desc.sdp };
  }

  onIceCandidate(cb: (candidate: string, mid: string) => void): void {
    this.onIceCandidateCb = cb;
  }

  handleAnswer(sdp: string): void {
    if (!this.pc) return;
    const state = this.pc.signalingState();
    if (state !== 'have-local-offer') {
      console.warn(`[webrtc] Ignoring answer in signaling state: ${state}`);
      return;
    }
    try {
      this.pc.setRemoteDescription(sdp, 'answer');
    } catch (err: any) {
      console.warn(`[webrtc] Failed to set remote answer: ${err.message}`);
    }
  }

  addIceCandidate(candidate: string, mid: string): void {
    this.pc?.addRemoteCandidate(candidate, mid);
  }

  private setupPeerConnectionHandlers(): void {
    if (!this.pc) return;

    this.pc.onStateChange((state) => {
      console.log(`[webrtc] PeerConnection state: ${state}`);
      if (state === 'disconnected' || state === 'failed') {
        this.isConnected = false;
        this.onErrorCb?.(new Error(`WebRTC ${state}`));
      }
    });

    this.pc.onLocalCandidate((candidate, mid) => {
      this.onIceCandidateCb?.(candidate, mid);
    });

    this.pc.onDataChannel((dc) => {
      console.log(`[webrtc] DataChannel received: ${dc.getLabel()}`);
      this.dc = dc;
      this.setupDataChannelHandlers();
    });
  }

  private setupDataChannelHandlers(): void {
    if (!this.dc) return;

    this.dc.onOpen(() => {
      console.log('[webrtc] DataChannel open');
      this.isConnected = true;
      this.startKeepalive();
      this.onOpenCb?.();
    });

    this.dc.onClosed(() => {
      console.log('[webrtc] DataChannel closed');
      this.isConnected = false;
      this.onErrorCb?.(new Error('DataChannel closed'));
    });

    this.dc.onError((err) => {
      console.error(`[webrtc] DataChannel error: ${err}`);
      this.isConnected = false;
      this.onErrorCb?.(new Error(`DataChannel error: ${err}`));
    });

    this.dc.onMessage((msg) => {
      if (typeof msg === 'string') {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === 'webrtc.pong') {
            this.clearPongTimeout();
            return;
          }
        } catch { /* not JSON, pass through */ }
        this.onMessageCb?.(msg);
      }
    });
  }

  send(message: string): boolean {
    if (!this.dc || !this.isConnected) return false;
    try {
      // Skip P2P if buffer is backed up (>1MB), fall back to relay
      if (this.dc.bufferedAmount() > 1024 * 1024) return false;
      this.dc.sendMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  onMessage(handler: (msg: string) => void): void {
    this.onMessageCb = handler;
  }

  onOpen(handler: () => void): void {
    this.onOpenCb = handler;
  }

  onError(handler: (err: Error) => void): void {
    this.onErrorCb = handler;
  }

  isActive(): boolean {
    return this.isConnected;
  }

  close(): void {
    this.isConnected = false;
    this.stopKeepalive();
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
    this.onMessageCb = null;
    this.onOpenCb = null;
    this.onErrorCb = null;
    this.onIceCandidateCb = null;
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.pingTimer = setInterval(() => {
      if (!this.dc || !this.isConnected) return;
      try {
        this.dc.sendMessage('{"type":"webrtc.ping"}');
        this.clearPongTimeout();
        this.pongTimer = setTimeout(() => {
          console.warn('[webrtc] Keepalive timeout — no pong received');
          this.isConnected = false;
          this.stopKeepalive();
          this.onErrorCb?.(new Error('Keepalive timeout'));
        }, this.pingTimeout);
      } catch {
        this.stopKeepalive();
      }
    }, this.pingInterval);
  }

  private stopKeepalive(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimeout();
  }

  private clearPongTimeout(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }
}
