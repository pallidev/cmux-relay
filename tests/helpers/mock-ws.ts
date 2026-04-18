/**
 * Mock WebSocket for unit tests.
 * Records sent messages and simulates readyState.
 */
export class MockWebSocket {
  static OPEN = 1 as number;
  static CLOSED = 3 as number;

  // Also available as instance properties (mirrors ws library behavior)
  readonly OPEN = 1 as number;
  readonly CLOSED = 3 as number;

  readyState = 1 as number;
  sentMessages: string[] = [];
  private closeListeners: Array<(code?: number, reason?: string) => void> = [];
  private messageListeners: Array<(data: string) => void> = [];

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    for (const fn of this.closeListeners) fn(code, reason);
  }

  on(event: string, handler: (...args: any[]) => void): void {
    if (event === 'close') this.closeListeners.push(handler);
    if (event === 'message') this.messageListeners.push(handler);
  }

  off(event: string, handler: (...args: any[]) => void): void {
    if (event === 'close') this.closeListeners = this.closeListeners.filter(fn => fn !== handler);
    if (event === 'message') this.messageListeners = this.messageListeners.filter(fn => fn !== handler);
  }

  /** Simulate receiving a message from the other side */
  simulateMessage(data: string): void {
    for (const fn of this.messageListeners) fn(data);
  }

  /** Get parsed sent messages */
  getSentJSON(): unknown[] {
    return this.sentMessages.map(m => JSON.parse(m));
  }

  /** Clear recorded messages */
  clear(): void {
    this.sentMessages = [];
  }
}
