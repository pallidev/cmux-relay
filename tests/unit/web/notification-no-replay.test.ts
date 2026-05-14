/**
 * Regression tests: notifications must NOT replay on web client connect/reconnect.
 *
 * Guards against the bug where the same notification toast appeared every time
 * the web client refreshed or reconnected.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// ─── Agent: local mode auth must not send notifications ───

describe('Notification replay prevention', () => {
  describe('agent: local mode auth (ws-server.ts)', () => {
    const source = readFileSync(resolve(root, 'packages/agent/src/ws-server.ts'), 'utf-8');

    it('does not call getAllNotifications in auth handler', () => {
      const authBlock = extractAuthBlock(source);
      assert.ok(authBlock, 'should find auth handler block');
      assert.ok(
        !authBlock.includes('getAllNotifications'),
        'auth handler must NOT call store.getAllNotifications()',
      );
    });

    it('does not send notifications message type in auth handler', () => {
      const authBlock = extractAuthBlock(source);
      assert.ok(authBlock, 'should find auth handler block');
      assert.ok(
        !authBlock.includes("type: 'notifications'"),
        'auth handler must NOT send notifications message',
      );
    });
  });

  describe('agent: cloud mode auth (message-handler.ts)', () => {
    const source = readFileSync(resolve(root, 'packages/agent/src/message-handler.ts'), 'utf-8');

    it('does not call getAllNotifications in auth handler', () => {
      const authBlock = extractAuthBlock(source);
      assert.ok(authBlock, 'should find auth handler block');
      assert.ok(
        !authBlock.includes('getAllNotifications'),
        'auth handler must NOT call store.getAllNotifications()',
      );
    });

    it('does not send notifications message type in auth handler', () => {
      const authBlock = extractAuthBlock(source);
      assert.ok(authBlock, 'should find auth handler block');
      assert.ok(
        !authBlock.includes("type: 'notifications'"),
        'auth handler must NOT send notifications message',
      );
    });
  });

  describe('agent: onClientConnected must not trigger pollNotifications', () => {
    const cloudMode = readFileSync(resolve(root, 'packages/agent/src/cloud-mode.ts'), 'utf-8');

    it('cloud-mode onClientConnected does not call pollNotifications', () => {
      const onClientBlock = extractCallback(cloudMode, 'onClientConnected');
      assert.ok(onClientBlock, 'should find onClientConnected callback');
      assert.ok(
        !onClientBlock.includes('pollNotifications'),
        'onClientConnected must NOT call pollNotifications()',
      );
    });
  });

  describe('agent: SyncEngine first poll suppression', () => {
    const source = readFileSync(resolve(root, 'packages/agent/src/sync-engine.ts'), 'utf-8');

    it('guards broadcast with !firstNotificationPoll', () => {
      assert.match(
        source,
        /!this\.firstNotificationPoll/,
        'broadcast must be guarded by !this.firstNotificationPoll',
      );
    });

    it('sets firstNotificationPoll to false after poll', () => {
      assert.match(
        source,
        /this\.firstNotificationPoll\s*=\s*false/,
        'must set firstNotificationPoll = false',
      );
    });
  });

  describe('web client: settle window suppresses toasts', () => {
    const source = readFileSync(resolve(root, 'packages/web/src/hooks/useNotifications.ts'), 'utf-8');

    it('defines SETTLE_MS constant', () => {
      assert.match(source, /SETTLE_MS\s*=\s*\d+/, 'must define SETTLE_MS');
    });

    it('exports shouldShowToast function', () => {
      assert.match(source, /export function shouldShowToast/, 'must export shouldShowToast');
    });

    it('useNotificationToasts calls shouldShowToast', () => {
      assert.match(
        source,
        /shouldShowToast\(connectedAt/,
        'hook must call shouldShowToast with connectedAt',
      );
    });

    it('skips toast when shouldShowToast returns false', () => {
      assert.match(
        source,
        /if\s*\(\s*!shouldShowToast/,
        'must skip toast when shouldShowToast returns false',
      );
    });
  });
});

// ─── Helpers ───

function extractAuthBlock(source: string): string | null {
  // Extract from "if (msg.type === 'auth')" to the next closing "return;"
  const match = source.match(
    /if\s*\(\s*msg\.type\s*===\s*['"]auth['"]\s*\)\s*\{([\s\S]*?)^\s{0,4}\}\s*$/m,
  );
  return match ? match[1] : null;
}

function extractCallback(source: string, callbackName: string): string | null {
  const regex = new RegExp(
    `${callbackName}\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*\\{([\\s\\S]*?)\\}\\s*\\)`,
  );
  const match = source.match(regex);
  return match ? match[1] : null;
}
