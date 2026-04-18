import type { CmuxNotification } from '@cmux-relay/shared';

declare const __VITE_RELAY_WS_URL__: string;
declare const __VITE_RELAY_HTTP_URL__: string;

export function getRelayWsUrl(): string {
  if (__VITE_RELAY_WS_URL__) return __VITE_RELAY_WS_URL__;

  const { protocol, hostname, port } = window.location;
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
  const wsPort = port || (protocol === 'https:' ? '443' : '80');
  if (port === '3000' || port === '3001') {
    return `ws://${hostname}:8080`;
  }
  return `${wsProtocol}//${hostname}:${wsPort}`;
}

export function getRelayHttpUrl(): string {
  if (__VITE_RELAY_HTTP_URL__) return __VITE_RELAY_HTTP_URL__;
  const { protocol, hostname, port } = window.location;
  if (port === '3000') return 'http://localhost:3001';
  return `${protocol}//${hostname}${port ? ':' + port : ''}`;
}

export function getSessionIdFromPath(): string | null {
  const match = window.location.pathname.match(/^\/s\/([a-zA-Z0-9]+)$/);
  return match ? match[1] : null;
}

export function isRelayMode(): boolean {
  return !!getSessionIdFromPath();
}

export function getToastType(n: CmuxNotification): string {
  const t = (n.title + ' ' + (n.body ?? '')).toLowerCase();
  if (t.includes('error') || t.includes('fail')) return 'error';
  if (t.includes('success') || t.includes('done') || t.includes('complete')) return 'success';
  if (t.includes('warn')) return 'warning';
  return 'info';
}
