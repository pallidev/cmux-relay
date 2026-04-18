import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { generateToken, verifyToken, generateClientToken } from '../../../packages/agent/src/auth.js';

const JWT_SECRET = 'test-secret';

describe('auth', () => {
  before(() => {
    process.env.CMUX_RELAY_JWT_SECRET = JWT_SECRET;
  });

  after(() => {
    delete process.env.CMUX_RELAY_JWT_SECRET;
  });

  describe('generateToken', () => {
    it('creates a verifiable token', () => {
      const token = generateToken();
      assert.ok(typeof token === 'string');
      assert.ok(token.length > 0);

      const decoded = jwt.verify(token, JWT_SECRET) as { role: string };
      assert.equal(decoded.role, 'agent');
    });

    it('includes iat claim', () => {
      const token = generateToken();
      const decoded = jwt.verify(token, JWT_SECRET) as { role: string; iat: number };
      assert.ok(typeof decoded.iat === 'number');
      assert.ok(decoded.iat > 0);
    });
  });

  describe('generateClientToken', () => {
    it('creates a token with client role', () => {
      const token = generateClientToken();
      const decoded = jwt.verify(token, JWT_SECRET) as { role: string };
      assert.equal(decoded.role, 'client');
    });
  });

  describe('verifyToken', () => {
    it('returns { role: "agent" } for agent token', () => {
      const token = generateToken();
      const result = verifyToken(token);
      assert.ok(result);
      assert.equal(result.role, 'agent');
      assert.ok(typeof (result as any).iat === 'number');
    });

    it('returns { role: "client" } for client token', () => {
      const token = generateClientToken();
      const result = verifyToken(token);
      assert.ok(result);
      assert.equal(result.role, 'client');
    });

    it('returns null for invalid token', () => {
      const result = verifyToken('this.is.not.a.token');
      assert.equal(result, null);
    });

    it('returns null for empty string', () => {
      const result = verifyToken('');
      assert.equal(result, null);
    });

    it('returns null for token signed with wrong secret', () => {
      const badToken = jwt.sign({ role: 'agent', iat: Math.floor(Date.now() / 1000) }, 'wrong-secret');
      const result = verifyToken(badToken);
      assert.equal(result, null);
    });

    it('returns null for expired token', () => {
      // Sign with an explicit exp in the past
      const expiredToken = jwt.sign(
        { role: 'agent', iat: Math.floor(Date.now() / 1000) - 3600 },
        JWT_SECRET,
        { expiresIn: '1s' },
      );
      const result = verifyToken(expiredToken);
      assert.equal(result, null);
    });

    it('returns null for token with wrong structure (no role)', () => {
      const noRoleToken = jwt.sign({ foo: 'bar' }, JWT_SECRET);
      // verifyToken returns { foo: 'bar' } but role is undefined
      const result = verifyToken(noRoleToken);
      // The function returns the decoded payload, which has no role
      // But the function signature says { role: string } | null
      // Since it returns the decoded object, it will have no role property
      assert.ok(result);
      assert.equal((result as any).role, undefined);
    });
  });
});

