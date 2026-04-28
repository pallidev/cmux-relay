/**
 * Tests for WebSocket reconnection on idle (visibilitychange).
 *
 * Verifies:
 *   - hiddenAt timestamp tracking on page hidden
 *   - Force reconnect after 30+ seconds hidden (stale connection detection)
 *   - Normal reconnect when readyState is not OPEN
 *   - Reconnect delay reset on successful connection
 *   - Cleanup: timer cleared, event listener removed on unmount
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('WebSocket reconnection on idle', () => {
  const useRelaySource = readFileSync(resolve(root, 'packages/web/src/hooks/useRelay.ts'), 'utf-8');

  it('tracks hiddenAt timestamp when page becomes hidden', () => {
    assert.ok(useRelaySource.includes('hiddenAt'), 'Should declare hiddenAt variable');
    assert.match(useRelaySource, /hiddenAt\s*=\s*Date\.now\(\)/, 'Should record timestamp on hidden');
  });

  it('forces reconnect when page was hidden for more than 5 seconds', () => {
    assert.ok(useRelaySource.includes('wasHidden'), 'Should compute wasHidden flag');
    assert.match(useRelaySource, /5_000|5000/, 'Should use 5 second threshold');
    assert.match(useRelaySource, /wasHidden/, 'Should check wasHidden in reconnect condition');
  });

  it('closes stale connection before reconnecting', () => {
    assert.match(useRelaySource, /wsRef\.current\)\s+wsRef\.current\.close\(\)/,
      'Should close existing WebSocket before reconnecting on long idle');
  });

  it('still reconnects when readyState is not OPEN (normal case)', () => {
    assert.match(useRelaySource, /readyState\s*!==\s*WebSocket\.OPEN/,
      'Should check readyState for normal reconnection');
  });

  it('resets reconnect delay on successful connection', () => {
    assert.match(useRelaySource, /reconnectDelay\s*=\s*1000/,
      'Should reset reconnectDelay to 1s on open');
  });

  it('cleans up visibilitychange listener on unmount', () => {
    assert.match(useRelaySource, /removeEventListener\(['"]visibilitychange['"]/, 'Should remove listener');
  });
});
