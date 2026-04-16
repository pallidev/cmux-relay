import type { CmuxNotification } from '@cmux-relay/shared';

/** Auto-detect WebSocket URL from current page host */
export function getRelayUrl(): string {
  const { protocol, hostname, port } = window.location;
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
  const wsPort = port || (protocol === 'https:' ? '443' : '80');
  // In dev mode (Vite on 3000), the WebSocket server is on 8080
  if (port === '3000' || port === '3001') {
    return `ws://${hostname}:8080`;
  }
  return `${wsProtocol}//${hostname}:${wsPort}`;
}

/** Determine toast type from notification content for color-coding */
export function getToastType(n: CmuxNotification): string {
  const t = (n.title + ' ' + (n.body ?? '')).toLowerCase();
  if (t.includes('error') || t.includes('fail')) return 'error';
  if (t.includes('success') || t.includes('done') || t.includes('complete')) return 'success';
  if (t.includes('warn')) return 'warning';
  return 'info';
}
