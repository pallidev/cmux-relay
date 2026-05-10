import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readAndEncodeTerminal, readTerminalAndSend } from '../../../packages/agent/src/terminal-reader.js';
import type { RelayToClient } from '@cmux-relay/shared';

function createMockCmux(overrides?: {
  readResult?: string;
  shouldThrow?: boolean;
}): {
  client: { readTerminalText: (surfaceId: string, scrollback?: boolean) => Promise<string> };
  calls: Array<{ surfaceId: string; scrollback?: boolean }>;
} {
  const calls: Array<{ surfaceId: string; scrollback?: boolean }> = [];
  return {
    calls,
    client: {
      async readTerminalText(surfaceId: string, scrollback?: boolean): Promise<string> {
        calls.push({ surfaceId, scrollback });
        if (overrides?.shouldThrow) {
          throw new Error('cmux read failed');
        }
        return overrides?.readResult ?? 'hello terminal';
      },
    },
  };
}

describe('readAndEncodeTerminal', () => {
  it('returns base64-encoded data when cmux returns text', async () => {
    const mock = createMockCmux({ readResult: 'terminal output' });
    const result = await readAndEncodeTerminal(mock.client as any, 'surf-1');

    assert.ok(result, 'should return a result');
    assert.equal(result.data, Buffer.from('terminal output').toString('base64'));
    assert.deepEqual(mock.calls, [{ surfaceId: 'surf-1', scrollback: undefined }]);
  });

  it('returns null when cmux returns empty string', async () => {
    const mock = createMockCmux({ readResult: '' });
    const result = await readAndEncodeTerminal(mock.client as any, 'surf-1');

    assert.equal(result, null);
  });

  it('returns null when cmux throws an error', async () => {
    const mock = createMockCmux({ shouldThrow: true });
    const result = await readAndEncodeTerminal(mock.client as any, 'surf-1');

    assert.equal(result, null);
  });

  it('passes scrollback parameter to cmux', async () => {
    const mock = createMockCmux({ readResult: 'with scrollback' });
    await readAndEncodeTerminal(mock.client as any, 'surf-1', true);

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].scrollback, true);
  });

  it('passes scrollback=false when explicitly set', async () => {
    const mock = createMockCmux({ readResult: 'no scrollback' });
    await readAndEncodeTerminal(mock.client as any, 'surf-1', false);

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].scrollback, false);
  });
});

describe('readTerminalAndSend', () => {
  let sentMessages: RelayToClient[];

  beforeEach(() => {
    sentMessages = [];
  });

  function send(msg: RelayToClient): void {
    sentMessages.push(msg);
  }

  it('sends output message with correct format', async () => {
    const mock = createMockCmux({ readResult: 'hello' });
    await readTerminalAndSend(mock.client as any, 'surf-1', send);

    assert.equal(sentMessages.length, 1);
    const msg = sentMessages[0];
    assert.equal(msg.type, 'output');
    if (msg.type === 'output') {
      assert.equal(msg.surfaceId, 'surf-1');
      const payload = msg.payload as { data: string };
      assert.equal(payload.data, Buffer.from('hello').toString('base64'));
    }
  });

  it('does not send when cmux returns empty string', async () => {
    const mock = createMockCmux({ readResult: '' });
    await readTerminalAndSend(mock.client as any, 'surf-1', send);

    assert.equal(sentMessages.length, 0);
  });

  it('does not send when cmux throws', async () => {
    const mock = createMockCmux({ shouldThrow: true });
    await readTerminalAndSend(mock.client as any, 'surf-1', send);

    assert.equal(sentMessages.length, 0);
  });

  it('passes scrollback option to readAndEncodeTerminal', async () => {
    const mock = createMockCmux({ readResult: 'data' });
    await readTerminalAndSend(mock.client as any, 'surf-1', send, { scrollback: false });

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].scrollback, false);
  });

  it('adds delay before reading when delay option is set', async () => {
    const mock = createMockCmux({ readResult: 'data' });
    const before = Date.now();
    await readTerminalAndSend(mock.client as any, 'surf-1', send, { delay: 50 });
    const elapsed = Date.now() - before;

    // Should have waited at least ~50ms (allow some tolerance)
    assert.ok(elapsed >= 40, `expected >= 40ms, got ${elapsed}ms`);
    assert.equal(sentMessages.length, 1);
  });

  it('does not delay when no delay option', async () => {
    const mock = createMockCmux({ readResult: 'data' });
    const before = Date.now();
    await readTerminalAndSend(mock.client as any, 'surf-1', send);
    const elapsed = Date.now() - before;

    // Should be very fast (< 20ms)
    assert.ok(elapsed < 20, `expected < 20ms, got ${elapsed}ms`);
  });
});
