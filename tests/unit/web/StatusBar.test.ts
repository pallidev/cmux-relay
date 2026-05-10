/**
 * Tests for StatusBar — getStatusText pure function.
 *
 * Tests the status display logic extracted from the duplicated status bar
 * in Layout.tsx, MobileLayout.tsx, and RelaySessionLayout.tsx.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getStatusText } from '../../../packages/web/src/components/StatusBar.tsx';

describe('StatusBar — getStatusText', () => {
  it('returns empty string when connected with no P2P attempt', () => {
    const result = getStatusText('connected', 'connected', 'none', 0);
    assert.equal(result, '');
  });

  it('returns P2P attempting message when connected but P2P is attempting', () => {
    const result = getStatusText('connected', 'connected', 'attempting', 0);
    assert.equal(result, 'P2P 연결 시도 중...');
  });

  it('returns reconnecting message with delay in seconds', () => {
    const result = getStatusText('disconnected', 'reconnecting', 'none', 5000);
    assert.equal(result, '재연결 (5s)');
  });

  it('rounds up reconnect delay', () => {
    const result = getStatusText('disconnected', 'reconnecting', 'none', 100);
    assert.equal(result, '재연결 (1s)');
  });

  it('returns connecting message', () => {
    const result = getStatusText('connecting', 'connecting', 'none', 0);
    assert.equal(result, 'WebSocket 연결 중...');
  });

  it('returns waiting-agent message', () => {
    const result = getStatusText('connecting', 'waiting-agent', 'none', 0);
    assert.equal(result, 'Agent 대기...');
  });

  it('returns disconnected message', () => {
    const result = getStatusText('disconnected', 'idle', 'none', 0);
    assert.equal(result, '연결 끊김');
  });

  it('returns default connecting text for unknown state', () => {
    const result = getStatusText('connecting', 'idle', 'none', 0);
    assert.equal(result, '연결 중...');
  });
});
