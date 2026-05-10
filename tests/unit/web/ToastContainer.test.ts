/**
 * Tests for ToastContainer — getToastType pure function.
 *
 * Tests the toast type classification logic that determines the visual style
 * of toast notifications (error, success, warning, info).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getToastType } from '../../../packages/web/src/lib/helpers.ts';
import type { CmuxNotification } from '@cmux-relay/shared';

function makeNotif(overrides: Partial<CmuxNotification> = {}): CmuxNotification {
  return {
    id: 'test-1',
    title: 'Test Notification',
    subtitle: '',
    body: 'Test body',
    surfaceId: 's-1',
    workspaceId: 'ws-1',
    isRead: false,
    ...overrides,
  };
}

describe('ToastContainer — getToastType', () => {
  it('returns "error" for title containing "error"', () => {
    const result = getToastType(makeNotif({ title: 'Error occurred' }));
    assert.equal(result, 'error');
  });

  it('returns "error" for body containing "error"', () => {
    const result = getToastType(makeNotif({ body: 'Something went wrong: error code 500' }));
    assert.equal(result, 'error');
  });

  it('returns "error" for title containing "fail"', () => {
    const result = getToastType(makeNotif({ title: 'Task failed' }));
    assert.equal(result, 'error');
  });

  it('returns "error" for body containing "fail"', () => {
    const result = getToastType(makeNotif({ body: 'Build failed unexpectedly' }));
    assert.equal(result, 'error');
  });

  it('returns "success" for title containing "success"', () => {
    const result = getToastType(makeNotif({ title: 'Success!' }));
    assert.equal(result, 'success');
  });

  it('returns "success" for body containing "done"', () => {
    const result = getToastType(makeNotif({ body: 'Task is done' }));
    assert.equal(result, 'success');
  });

  it('returns "success" for title containing "complete"', () => {
    const result = getToastType(makeNotif({ title: 'Process complete' }));
    assert.equal(result, 'success');
  });

  it('returns "warning" for title containing "warn"', () => {
    const result = getToastType(makeNotif({ title: 'Warning: low disk' }));
    assert.equal(result, 'warning');
  });

  it('returns "warning" for body containing "warn"', () => {
    const result = getToastType(makeNotif({ body: 'Warning threshold reached' }));
    assert.equal(result, 'warning');
  });

  it('returns "info" for neutral notifications', () => {
    const result = getToastType(makeNotif({ title: 'Claude Code', body: 'Running analysis...' }));
    assert.equal(result, 'info');
  });

  it('returns "info" for empty title and body', () => {
    const result = getToastType(makeNotif({ title: '', body: '' }));
    assert.equal(result, 'info');
  });

  it('is case-insensitive', () => {
    const result = getToastType(makeNotif({ title: 'ERROR: Big Problem' }));
    assert.equal(result, 'error');
  });
});
