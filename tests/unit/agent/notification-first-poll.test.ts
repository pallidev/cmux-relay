import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Notification first-poll suppression', () => {
  const indexSource = readFileSync(resolve(root, 'packages/agent/src/index.ts'), 'utf-8');

  it('declares firstPoll flag before pollNotifications', () => {
    assert.match(indexSource, /let\s+firstPoll\s*=\s*true/, 'Should declare firstPoll = true');
  });

  it('skips broadcasting on first poll', () => {
    assert.match(indexSource, /!firstPoll/, 'Should check !firstPoll before broadcasting');
  });

  it('sets firstPoll to false after first poll', () => {
    assert.match(indexSource, /firstPoll\s*=\s*false/, 'Should set firstPoll = false');
  });

  it('firstPoll flag exists in both local and cloud mode', () => {
    const matches = indexSource.match(/let\s+firstPoll\s*=\s*true/g);
    assert.ok(matches, 'Should have firstPoll declarations');
    assert.equal(matches!.length, 2, 'Should have firstPoll in both local and cloud mode');
  });

  it('still stores notifications on first poll', () => {
    // updateNotifications should be called regardless of firstPoll
    const updateCalls = indexSource.match(/store\.updateNotifications\(notifications\)/g);
    assert.ok(updateCalls, 'Should call updateNotifications');
    assert.equal(updateCalls!.length, 2, 'Should update store in both modes');
  });
});
