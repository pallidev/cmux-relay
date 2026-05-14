/**
 * Tests for useNotifications — pure helper functions.
 *
 * Tests the extracted pure logic:
 *   - detectNewNotifications: compare current vs previous notification count
 *   - scheduleToastDismissal: auto-dismissal timing (logic only, not setTimeout)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CmuxNotification } from '@cmux-relay/shared';

import {
  detectNewNotifications,
  shouldShowToast,
} from '../../../packages/web/src/hooks/useNotifications.ts';

function makeNotif(id: string): CmuxNotification {
  return {
    id,
    title: `Notification ${id}`,
    subtitle: '',
    body: 'Test body',
    surfaceId: 's-1',
    workspaceId: 'ws-1',
    isRead: false,
  };
}

describe('useNotifications — detectNewNotifications', () => {
  it('returns empty array when count has not increased', () => {
    const notifs = [makeNotif('1'), makeNotif('2')];
    const result = detectNewNotifications(notifs, 2);
    assert.deepEqual(result.newNotifs, []);
    assert.equal(result.newPrevCount, 2);
  });

  it('returns empty array when count has decreased (notifications cleared)', () => {
    const notifs = [makeNotif('1')];
    const result = detectNewNotifications(notifs, 3);
    assert.deepEqual(result.newNotifs, []);
    assert.equal(result.newPrevCount, 1);
  });

  it('detects new notifications added at the beginning of the array', () => {
    // The relay protocol prepends new notifications
    const notifs = [makeNotif('3'), makeNotif('2'), makeNotif('1')];
    const result = detectNewNotifications(notifs, 2);
    assert.equal(result.newNotifs.length, 1);
    assert.equal(result.newNotifs[0].id, '3');
    assert.equal(result.newPrevCount, 3);
  });

  it('detects multiple new notifications', () => {
    const notifs = [makeNotif('5'), makeNotif('4'), makeNotif('3'), makeNotif('2'), makeNotif('1')];
    const result = detectNewNotifications(notifs, 3);
    assert.equal(result.newNotifs.length, 2);
    assert.equal(result.newNotifs[0].id, '5');
    assert.equal(result.newNotifs[1].id, '4');
    assert.equal(result.newPrevCount, 5);
  });

  it('handles initial state (prevCount = 0)', () => {
    const notifs = [makeNotif('1'), makeNotif('2')];
    const result = detectNewNotifications(notifs, 0);
    assert.equal(result.newNotifs.length, 2);
    assert.equal(result.newPrevCount, 2);
  });

  it('handles empty notifications array', () => {
    const result = detectNewNotifications([], 0);
    assert.deepEqual(result.newNotifs, []);
    assert.equal(result.newPrevCount, 0);
  });

  it('handles empty array with positive prevCount', () => {
    const result = detectNewNotifications([], 3);
    assert.deepEqual(result.newNotifs, []);
    assert.equal(result.newPrevCount, 0);
  });
});

describe('useNotifications — shouldShowToast (settle window)', () => {
  it('returns false when connectedAt is undefined (not connected)', () => {
    assert.equal(shouldShowToast(undefined, 10000), false);
  });

  it('returns false when connection is too recent (within settle window)', () => {
    const connectedAt = 10000;
    assert.equal(shouldShowToast(connectedAt, 10001), false);
    assert.equal(shouldShowToast(connectedAt, 11999), false);
  });

  it('returns true after settle window has passed', () => {
    const connectedAt = 10000;
    assert.equal(shouldShowToast(connectedAt, 12001), true);
    assert.equal(shouldShowToast(connectedAt, 20000), true);
  });
});
