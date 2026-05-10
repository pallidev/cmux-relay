/**
 * Tests for useAuth — JWT cookie parsing utilities.
 *
 * Tests the pure function getJwtFromCookie() which is the core logic
 * extracted from App.tsx, Layout.tsx, MobileLayout.tsx, RelaySessionLayout.tsx, and push.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// We import the pure function directly for testing
// The hook is just a thin wrapper around it
import { getJwtFromCookie } from '../../../packages/web/src/hooks/useAuth.ts';

describe('useAuth — getJwtFromCookie', () => {
  it('extracts JWT from relay_jwt cookie', () => {
    const result = getJwtFromCookie('relay_jwt=abc123');
    assert.equal(result, 'abc123');
  });

  it('extracts JWT when other cookies precede it', () => {
    const result = getJwtFromCookie('other=foo; relay_jwt=token456; lang=en');
    assert.equal(result, 'token456');
  });

  it('extracts JWT when it is the first cookie with leading semicolon-space', () => {
    // The regex matches (^|;\s*) so "relay_jwt=..." at start works
    const result = getJwtFromCookie('relay_jwt=startoken');
    assert.equal(result, 'startoken');
  });

  it('returns null when relay_jwt cookie is absent', () => {
    const result = getJwtFromCookie('other=foo; lang=en');
    assert.equal(result, null);
  });

  it('returns null for empty cookie string', () => {
    const result = getJwtFromCookie('');
    assert.equal(result, null);
  });

  it('does not match partial cookie names', () => {
    // Should NOT match "xrelay_jwt" or "relay_jwt_extra"
    const result1 = getJwtFromCookie('xrelay_jwt=bad');
    assert.equal(result1, null);

    // But should match relay_jwt followed by =
    const result2 = getJwtFromCookie('relay_jwt=good');
    assert.equal(result2, 'good');
  });

  it('handles JWT with dots (typical JWT format)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def';
    const result = getJwtFromCookie(`relay_jwt=${jwt}`);
    assert.equal(result, jwt);
  });

  it('handles JWT with base64 characters', () => {
    const jwt = 'abc+/=DEF123';
    const result = getJwtFromCookie(`relay_jwt=${jwt}`);
    assert.equal(result, jwt);
  });

  it('extracts only the value up to the next semicolon', () => {
    const result = getJwtFromCookie('relay_jwt=val123; other=foo');
    assert.equal(result, 'val123');
  });

  it('returns null when relay_jwt cookie has empty value', () => {
    // Regex requires at least one non-semicolon char, so empty value returns null
    const result = getJwtFromCookie('relay_jwt=; other=foo');
    assert.equal(result, null);
  });
});
