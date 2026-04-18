import type { WebSocket } from 'ws';
import { encodeMessage } from '@cmux-relay/shared';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createApiToken } from './db.js';

interface PendingPairing {
  code: string;
  agentWs: WebSocket;
  createdAt: number;
}

export class PairingRegistry {
  private pending = new Map<string, PendingPairing>();
  private wsToCode = new Map<WebSocket, string>();
  private webUrl: string;

  constructor(webUrl: string) {
    this.webUrl = webUrl;
    // Clean up expired pairings every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  createPairing(ws: WebSocket): { code: string; url: string } {
    const code = randomBytes(4).toString('hex').toUpperCase();
    const url = `${this.webUrl}/pair/${code}`;

    this.pending.set(code, { code, agentWs: ws, createdAt: Date.now() });
    this.wsToCode.set(ws, code);

    console.log(`[relay] Pairing created: code=${code}`);
    return { code, url };
  }

  approvePairing(code: string, userId: string, db: Database.Database): boolean {
    const pairing = this.pending.get(code);
    if (!pairing) return false;

    const rawToken = createApiToken(db, userId, `agent-${Date.now()}`);

    pairing.agentWs.send(encodeMessage({
      type: 'pairing.approved',
      token: rawToken,
    }));

    console.log(`[relay] Pairing approved: code=${code} user=${userId}`);
    this.pending.delete(code);
    this.wsToCode.delete(pairing.agentWs);
    return true;
  }

  rejectPairing(code: string): boolean {
    const pairing = this.pending.get(code);
    if (!pairing) return false;

    pairing.agentWs.send(encodeMessage({
      type: 'pairing.rejected',
      reason: 'Pairing was denied',
    }));

    console.log(`[relay] Pairing rejected: code=${code}`);
    this.pending.delete(code);
    this.wsToCode.delete(pairing.agentWs);
    return true;
  }

  getPairingInfo(code: string): { exists: boolean; code: string } {
    return { exists: this.pending.has(code), code };
  }

  removeByWs(ws: WebSocket): void {
    const code = this.wsToCode.get(ws);
    if (code) {
      this.pending.delete(code);
      this.wsToCode.delete(ws);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [code, pairing] of this.pending) {
      if (now - pairing.createdAt > 10 * 60 * 1000) {
        pairing.agentWs.send(encodeMessage({
          type: 'pairing.rejected',
          reason: 'Pairing expired',
        }));
        this.pending.delete(code);
        this.wsToCode.delete(pairing.agentWs);
      }
    }
  }
}
