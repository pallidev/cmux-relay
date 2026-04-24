import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PairingRegistry } from '../../../packages/relay/src/pairing-registry.js';
import { initDatabase } from '../../../packages/relay/src/db.js';
import { MockWebSocket } from '../../helpers/mock-ws.js';
import type Database from 'better-sqlite3';

describe('PairingRegistry', () => {
  let registry: PairingRegistry;
  let db: Database.Database;

  beforeEach(() => {
    // Use fake timers to prevent the setInterval from interfering with tests
    // and to avoid dangling timers
    const originalSetInterval = globalThis.setInterval;
    // Suppress the cleanup interval by making it a no-op for test isolation
    registry = new PairingRegistry('https://relay.example.com');
    db = initDatabase(':memory:');
  });

  afterEach(() => {
    registry.close();
    db.close();
  });

  it('createPairing creates valid code and URL', () => {
    const ws = new MockWebSocket();
    const result = registry.createPairing(ws as any);

    // Code should be 8-char uppercase hex
    assert.match(result.code, /^[0-9A-F]{8}$/);
    assert.equal(result.url, `https://relay.example.com/pair/${result.code}`);
  });

  it('createPairing stores the pairing', () => {
    const ws = new MockWebSocket();
    const { code } = registry.createPairing(ws as any);

    const info = registry.getPairingInfo(code);
    assert.equal(info.exists, true);
    assert.equal(info.code, code);
  });

  it('approvePairing sends token to agent', () => {
    const ws = new MockWebSocket();

    // Need a user in the DB for createApiToken
    const user = upsertTestUser(db, '12345', 'testuser');

    const { code } = registry.createPairing(ws as any);
    const result = registry.approvePairing(code, user.id, db);

    assert.equal(result, true);

    // Agent should receive pairing.approved with a token
    const msgs = ws.getSentJSON();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].type, 'pairing.approved');
    assert.match((msgs[0] as any).token, /^sk_crx_/);

    // Pairing should be removed after approval
    const info = registry.getPairingInfo(code);
    assert.equal(info.exists, false);
  });

  it('approvePairing returns false for invalid code', () => {
    const user = upsertTestUser(db, '12345', 'testuser');
    const result = registry.approvePairing('INVALID1', user.id, db);
    assert.equal(result, false);
  });

  it('rejectPairing sends rejection to agent', () => {
    const ws = new MockWebSocket();
    const { code } = registry.createPairing(ws as any);

    const result = registry.rejectPairing(code);

    assert.equal(result, true);

    const msgs = ws.getSentJSON();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].type, 'pairing.rejected');
    assert.equal((msgs[0] as any).reason, 'Pairing was denied');

    // Pairing should be removed after rejection
    const info = registry.getPairingInfo(code);
    assert.equal(info.exists, false);
  });

  it('rejectPairing returns false for invalid code', () => {
    const result = registry.rejectPairing('INVALID1');
    assert.equal(result, false);
  });

  it('getPairingInfo returns exists=true for active pairing', () => {
    const ws = new MockWebSocket();
    const { code } = registry.createPairing(ws as any);

    const info = registry.getPairingInfo(code);
    assert.equal(info.exists, true);
    assert.equal(info.code, code);
  });

  it('getPairingInfo returns exists=false after approval', () => {
    const ws = new MockWebSocket();
    const user = upsertTestUser(db, '12345', 'testuser');
    const { code } = registry.createPairing(ws as any);

    registry.approvePairing(code, user.id, db);

    const info = registry.getPairingInfo(code);
    assert.equal(info.exists, false);
  });

  it('getPairingInfo returns exists=false for unknown code', () => {
    const info = registry.getPairingInfo('00000000');
    assert.equal(info.exists, false);
  });

  it('removeByWs cleans up pairing', () => {
    const ws = new MockWebSocket();
    const { code } = registry.createPairing(ws as any);

    // Verify it exists
    assert.equal(registry.getPairingInfo(code).exists, true);

    registry.removeByWs(ws as any);

    // Should be removed
    assert.equal(registry.getPairingInfo(code).exists, false);
  });

  it('removeByWs is no-op for unknown ws', () => {
    const unknownWs = new MockWebSocket();
    // Should not throw
    registry.removeByWs(unknownWs as any);
  });

  it('multiple pairings are independent', () => {
    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();

    const p1 = registry.createPairing(ws1 as any);
    const p2 = registry.createPairing(ws2 as any);

    assert.notEqual(p1.code, p2.code);
    assert.equal(registry.getPairingInfo(p1.code).exists, true);
    assert.equal(registry.getPairingInfo(p2.code).exists, true);

    // Reject first, second should still exist
    registry.rejectPairing(p1.code);
    assert.equal(registry.getPairingInfo(p1.code).exists, false);
    assert.equal(registry.getPairingInfo(p2.code).exists, true);
  });
});

// Helper: insert a test user directly into the DB
function upsertTestUser(db: Database.Database, githubId: string, username: string) {
  return db.prepare(
    'INSERT INTO users (id, github_id, username) VALUES (?, ?, ?) RETURNING *',
  ).get(crypto.randomUUID(), githubId, username) as any;
}
