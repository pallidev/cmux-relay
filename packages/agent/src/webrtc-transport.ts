import * as nodeDataChannel from 'node-datachannel';

const CHUNK_SIZE = 14_500; // Under Safari's 16KB SCTP limit (with JSON overhead)
const BUFFER_LIMIT = 64 * 1024; // 64KB — Safari buffers aggressively much earlier than Chrome

interface PendingChunks {
  chunks: Map<number, string>;
  total: number;
}

export class WebRTCTransport {
  private pc: nodeDataChannel.PeerConnection | null = null;
  private dc: nodeDataChannel.DataChannel | null = null;
  private onMessageCb: ((msg: string) => void) | null = null;
  private onOpenCb: (() => void) | null = null;
  private onErrorCb: ((err: Error) => void) | null = null;
  private onIceCandidateCb: ((candidate: string, mid: string) => void) | null = null;
  private isConnected = false;
  private recvChunks = new Map<string, PendingChunks>();

  createOffer(): { sdp: string } {
    this.pc = new nodeDataChannel.PeerConnection('cmux-relay', {
      iceServers: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
    });

    this.setupPeerConnectionHandlers();

    // node-datachannel defaults: ordered=true, maxRetransmits=unlimited (reliable)
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
        const reassembled = this.reassemble(msg);
        if (reassembled !== null) {
          this.onMessageCb?.(reassembled);
        }
      }
    });
  }

  send(message: string): boolean {
    if (!this.dc || !this.isConnected) return false;
    try {
      // Skip P2P if buffer is backed up — Safari SCTP congestion starts early
      if (this.dc.bufferedAmount() > BUFFER_LIMIT) return false;

      if (message.length <= CHUNK_SIZE) {
        this.dc.sendMessage(message);
      } else {
        const msgId = Math.random().toString(36).slice(2, 10);
        const total = Math.ceil(message.length / CHUNK_SIZE);
        for (let i = 0; i < total; i++) {
          const d = message.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          this.dc.sendMessage(JSON.stringify({ __chunk: true, id: msgId, n: total, i, d }));
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private reassemble(msg: string): string | null {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.__chunk) {
        const { id, n, i, d } = parsed;
        if (!this.recvChunks.has(id)) {
          this.recvChunks.set(id, { chunks: new Map(), total: n });
        }
        const pending = this.recvChunks.get(id)!;
        pending.chunks.set(i, d);
        if (pending.chunks.size === pending.total) {
          let result = '';
          for (let j = 0; j < pending.total; j++) {
            result += pending.chunks.get(j)!;
          }
          this.recvChunks.delete(id);
          return result;
        }
        return null;
      }
    } catch {
      // Not a chunk envelope — pass through as regular message
    }
    return msg;
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
    this.recvChunks.clear();
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
    this.onMessageCb = null;
    this.onOpenCb = null;
    this.onErrorCb = null;
    this.onIceCandidateCb = null;
  }
}
