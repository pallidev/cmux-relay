/**
 * Tests for notification click → surface navigation.
 *
 * Verifies:
 *   - Browser notifications include workspaceId/surfaceId data for click navigation
 *   - Service Worker opens /terminal (not /) when no client exists
 *   - Service Worker sends NAVIGATE postMessage with workspaceId/surfaceId
 *   - MobileLayout and RelaySessionLayout use registration.showNotification()
 *   - Service Worker saves pending navigation to IndexedDB
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Notification click navigation', () => {
  const swSource = readFileSync(resolve(root, 'packages/web/public/sw.js'), 'utf-8');
  const mobileSource = readFileSync(resolve(root, 'packages/web/src/components/MobileLayout.tsx'), 'utf-8');
  const relaySource = readFileSync(resolve(root, 'packages/web/src/components/RelaySessionLayout.tsx'), 'utf-8');
  const pushSource = readFileSync(resolve(root, 'packages/web/src/lib/push.ts'), 'utf-8');

  describe('Service Worker (sw.js)', () => {
    it('opens /terminal when no existing client', () => {
      assert.ok(
        swSource.includes("self.clients.openWindow('/terminal')"),
        'SW should open /terminal (not /) when no client exists so navigation data is consumed',
      );
      assert.ok(
        !swSource.includes("self.clients.openWindow('/')"),
        'SW should NOT open / (root) — terminal page handles pending navigation',
      );
    });

    it('sends NAVIGATE postMessage with workspaceId and surfaceId on notification click', () => {
      assert.ok(
        swSource.includes("type: 'NAVIGATE'"),
        'notificationclick handler should send NAVIGATE message type',
      );
      assert.ok(
        swSource.includes('client.postMessage') && swSource.includes('workspaceId') && swSource.includes('surfaceId'),
        'NAVIGATE message should include workspaceId and surfaceId',
      );
    });

    it('saves pending navigation to IndexedDB when no client exists', () => {
      assert.ok(
        swSource.includes('savePendingNavigation'),
        'Should save pending navigation when no client exists',
      );
      assert.ok(
        swSource.includes(".put(data, 'latest')"),
        'Should save navigation data to IndexedDB with key "latest"',
      );
    });

    it('push event includes workspaceId and surfaceId in notification data', () => {
      assert.ok(
        swSource.includes('workspaceId: data.workspaceId') && swSource.includes('surfaceId: data.surfaceId'),
        'Push notification data should include workspaceId and surfaceId from payload',
      );
    });

    it('focuses existing client before sending navigation', () => {
      assert.ok(
        swSource.includes('client.focus()'),
        'Should focus existing client window on notification click',
      );
    });
  });

  describe('MobileLayout', () => {
    it('stores service worker registration in a ref', () => {
      assert.ok(
        mobileSource.includes('swRegRef'),
        'Should store SW registration ref for showNotification',
      );
    });

    it('uses registration.showNotification() instead of new Notification() for main callback', () => {
      assert.ok(
        mobileSource.includes('reg.showNotification'),
        'onNotifications should use reg.showNotification() for navigation data',
      );
      assert.ok(
        mobileSource.includes('workspaceId: n.workspaceId') && mobileSource.includes('surfaceId: n.surfaceId'),
        'showNotification should include workspaceId and surfaceId in data',
      );
    });

    it('falls back to new Notification() when SW registration unavailable', () => {
      assert.ok(
        mobileSource.includes('} else {') && mobileSource.includes('new Notification('),
        'Should fall back to new Notification() when swRegRef is null',
      );
    });

    it('stores registration after registerServiceWorker resolves', () => {
      const regStorePattern = /registerServiceWorker\(\)\.then\(\(reg\)[\s\S]*?swRegRef\.current\s*=\s*reg/g;
      assert.ok(
        regStorePattern.test(mobileSource),
        'Should store SW registration in swRegRef after registration',
      );
    });

    it('handles pending navigation from push notification click', () => {
      assert.ok(
        mobileSource.includes('getPendingNavigation'),
        'Should check IndexedDB for pending navigation on mount',
      );
      assert.ok(
        mobileSource.includes('onNavigateFromPush'),
        'Should listen for NAVIGATE messages from service worker',
      );
    });

    it('navigates on NAVIGATE message by setting workspace and surface', () => {
      const navBlock = mobileSource.match(/onNavigateFromPush\(\(nav\)[\s\S]*?\}\)/);
      assert.ok(navBlock, 'Should find onNavigateFromPush callback');
      const block = navBlock[0];
      assert.ok(block.includes('setSelectedWorkspaceId'), 'Should set workspace on navigate');
      assert.ok(block.includes('setSelectedSurfaceId'), 'Should set surface on navigate');
      assert.ok(block.includes('selectSurface'), 'Should call selectSurface on navigate');
    });
  });

  describe('RelaySessionLayout', () => {
    it('stores service worker registration in a ref', () => {
      assert.ok(
        relaySource.includes('swRegRef'),
        'Should store SW registration ref for showNotification',
      );
    });

    it('uses registration.showNotification() for notifications', () => {
      assert.ok(
        relaySource.includes('reg.showNotification'),
        'Should use reg.showNotification() for navigation data',
      );
      assert.ok(
        relaySource.includes('workspaceId: n.workspaceId') && relaySource.includes('surfaceId: n.surfaceId'),
        'showNotification should include workspaceId and surfaceId',
      );
    });

    it('handles pending navigation from push notification click', () => {
      assert.ok(
        relaySource.includes('getPendingNavigation'),
        'Should check IndexedDB for pending navigation',
      );
      assert.ok(
        relaySource.includes('onNavigateFromPush'),
        'Should listen for NAVIGATE messages from service worker',
      );
    });
  });

  describe('push.ts — navigation helpers', () => {
    it('exports onNavigateFromPush for NAVIGATE message handling', () => {
      assert.ok(
        pushSource.includes('export function onNavigateFromPush'),
        'Should export onNavigateFromPush',
      );
      assert.ok(
        pushSource.includes("event.data?.type === 'NAVIGATE'"),
        'Should listen for NAVIGATE message type',
      );
    });

    it('exports getPendingNavigation for IndexedDB pending nav', () => {
      assert.ok(
        pushSource.includes('export async function getPendingNavigation'),
        'Should export getPendingNavigation for reading pending nav from IndexedDB',
      );
    });

    it('deletes pending navigation after reading', () => {
      assert.ok(
        pushSource.includes("store.delete('latest')"),
        'Should delete pending nav from IndexedDB after reading to prevent stale navigation',
      );
    });
  });
});
