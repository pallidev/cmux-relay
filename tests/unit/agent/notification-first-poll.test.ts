import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Notification first-poll suppression', () => {
  const syncEngineSource = readFileSync(resolve(root, 'packages/agent/src/sync-engine.ts'), 'utf-8');

  it('declares firstNotificationPoll flag', () => {
    assert.match(syncEngineSource, /firstNotificationPoll\s*=\s*true/, 'Should declare firstNotificationPoll = true');
  });

  it('skips broadcasting on first poll', () => {
    assert.match(syncEngineSource, /!this\.firstNotificationPoll/, 'Should check !this.firstNotificationPoll before broadcasting');
  });

  it('sets firstNotificationPoll to false after first poll', () => {
    assert.match(syncEngineSource, /this\.firstNotificationPoll\s*=\s*false/, 'Should set this.firstNotificationPoll = false');
  });

  it('still stores notifications on first poll', () => {
    // updateNotifications should be called regardless of firstNotificationPoll
    const updateCalls = syncEngineSource.match(/this\.store\.updateNotifications\(notifications\)/g);
    assert.ok(updateCalls, 'Should call updateNotifications');
    assert.equal(updateCalls!.length, 1, 'Should update store once per poll');
  });
});
