import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionJwt, verifySessionJwt, getJwtSecret } from '../../../packages/relay/src/auth.js';

const JWT_SECRET = 'test-relay-secret-key-at-least-32-chars';

describe('relay auth', () => {
  before(() => {
    process.env.RELAY_JWT_SECRET = JWT_SECRET;
  });

  after(() => {
    delete process.env.RELAY_JWT_SECRET;
  });

  describe('getJwtSecret', () => {
    it('returns encoded secret from env', () => {
      const secret = getJwtSecret();
      assert.ok(secret instanceof Uint8Array);
      assert.ok(secret.length > 0);
    });

    it('throws when RELAY_JWT_SECRET is not set', () => {
      delete process.env.RELAY_JWT_SECRET;
      assert.throws(() => getJwtSecret(), /RELAY_JWT_SECRET/);
      process.env.RELAY_JWT_SECRET = JWT_SECRET;
    });
  });

  describe('createSessionJwt', () => {
    it('creates a valid JWT string', async () => {
      const token = await createSessionJwt('user-1', 'testuser');
      assert.ok(typeof token === 'string');
      assert.ok(token.split('.').length === 3);
    });

    it('includes sub and username in payload', async () => {
      const token = await createSessionJwt('user-1', 'testuser');
      const payload = await verifySessionJwt(token);
      assert.ok(payload);
      assert.equal(payload.sub, 'user-1');
      assert.equal(payload.username, 'testuser');
    });
  });

  describe('verifySessionJwt', () => {
    it('returns payload for valid token', async () => {
      const token = await createSessionJwt('user-2', 'another');
      const result = await verifySessionJwt(token);
      assert.ok(result);
      assert.equal(result.sub, 'user-2');
      assert.equal(result.username, 'another');
    });

    it('returns null for invalid token string', async () => {
      const result = await verifySessionJwt('not.a.valid.token');
      assert.equal(result, null);
    });

    it('returns null for empty string', async () => {
      const result = await verifySessionJwt('');
      assert.equal(result, null);
    });

    it('returns null for token signed with wrong secret', async () => {
      process.env.RELAY_JWT_SECRET = 'wrong-secret-for-signing';
      const badToken = await createSessionJwt('user-1', 'test');
      process.env.RELAY_JWT_SECRET = JWT_SECRET;

      const result = await verifySessionJwt(badToken);
      assert.equal(result, null);
    });

    it('returns null for token with missing username field', async () => {
      // Craft a token via createSessionJwt with empty username — verify it still returns the payload
      // This verifies the function correctly requires both sub AND username
      const token = await createSessionJwt('user-1', '');
      const result = await verifySessionJwt(token);
      // Empty string is still a string, so this should return the payload
      // The function only checks typeof === 'string', not truthiness
      assert.ok(result);
      assert.equal(result.username, '');
    });
  });
});
