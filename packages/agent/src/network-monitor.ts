import { EventEmitter } from 'node:events';
import { networkInterfaces as osNetworkInterfaces } from 'node:os';
import { resolve4 as dnsResolve4 } from 'node:dns';

const POLL_INTERVAL = 5_000;
const DEBOUNCE_COUNT = 2;
const SLEEP_THRESHOLD = 60_000;
const DNS_TIMEOUT = 5_000;

export interface NetworkMonitorOptions {
  pollInterval?: number;
  debounceCount?: number;
  sleepThreshold?: number;
  dnsTimeout?: number;
  now?: () => number;
  getInterfaces?: () => Record<string, Array<{ address: string; family: string; internal: boolean }>>;
  resolveDns?: (hostname: string, callback: (err: Error | null, addresses: string[]) => void) => void;
}

export class NetworkMonitor extends EventEmitter {
  private hostname: string;
  private pollInterval: number;
  private debounceCount: number;
  private sleepThreshold: number;
  private dnsTimeout: number;
  private now: () => number;
  private getInterfaces: () => Record<string, Array<{ address: string; family: string; internal: boolean }>>;
  private resolveDns: (hostname: string, callback: (err: Error | null, addresses: string[]) => void) => void;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastDigest = '';
  private lastResolvedIp: string | null = null;
  private changeCount = 0;
  private lastPollTime = 0;
  private active = false;

  constructor(hostname: string, opts?: NetworkMonitorOptions) {
    super();
    this.hostname = hostname;
    this.pollInterval = opts?.pollInterval ?? POLL_INTERVAL;
    this.debounceCount = opts?.debounceCount ?? DEBOUNCE_COUNT;
    this.sleepThreshold = opts?.sleepThreshold ?? SLEEP_THRESHOLD;
    this.dnsTimeout = opts?.dnsTimeout ?? DNS_TIMEOUT;
    this.now = opts?.now ?? (() => Date.now());
    this.getInterfaces = opts?.getInterfaces ?? (() => osNetworkInterfaces() as Record<string, Array<{ address: string; family: string; internal: boolean }>>);
    this.resolveDns = opts?.resolveDns ?? ((h, cb) => dnsResolve4(h, cb as (err: NodeJS.ErrnoException | null, addresses: string[]) => void));
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.lastDigest = this.computeDigest();
    this.lastPollTime = this.now();
    this.changeCount = 0;
    this.pollTimer = setInterval(() => this.poll(), this.pollInterval);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.active = false;
    this.changeCount = 0;
  }

  private poll(): void {
    const now = this.now();
    const elapsed = now - this.lastPollTime;
    this.lastPollTime = now;

    if (elapsed > this.sleepThreshold) {
      this.changeCount = 0;
      this.checkReachability();
      return;
    }

    const digest = this.computeDigest();
    if (digest === this.lastDigest) {
      this.changeCount = 0;
      return;
    }

    this.changeCount++;
    if (this.changeCount >= this.debounceCount) {
      this.lastDigest = digest;
      this.changeCount = 0;
      this.checkReachability();
    }
  }

  private checkReachability(): void {
    const timer = setTimeout(() => {
      this.emitNetworkChange();
    }, this.dnsTimeout);

    this.resolveDns(this.hostname, (err, addresses) => {
      clearTimeout(timer);
      if (err || addresses.length === 0) {
        this.emitNetworkChange();
        return;
      }

      const ip = addresses[0];
      if (this.lastResolvedIp !== null && ip === this.lastResolvedIp) {
        return;
      }
      this.lastResolvedIp = ip;
      this.emitNetworkChange();
    });
  }

  private emitNetworkChange(): void {
    this.emit('network-change');
  }

  computeDigest(): string {
    const interfaces = this.getInterfaces();
    const parts: string[] = [];
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.internal) continue;
        if (addr.family === 'IPv6' && addr.address.startsWith('fe80::')) continue;
        parts.push(`${name}:${addr.family}:${addr.address}`);
      }
    }
    parts.sort();
    return parts.join('|');
  }
}
