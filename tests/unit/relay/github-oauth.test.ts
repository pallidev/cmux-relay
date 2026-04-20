import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock, type Mock } from 'node:test';
import { getAuthorizationUrl, handleCallback } from '../../../packages/relay/src/github-oauth.js';
import { initDatabase } from '../../../packages/relay/src/db.js';
import type Database from 'better-sqlite3';

const ENV = {
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
};

describe('github-oauth', () => {
  let db: Database.Database;

  before(() => {
    Object.entries(ENV).forEach(([k, v]) => { process.env[k] = v; });
    db = initDatabase(':memory:');
  });

  after(() => {
    Object.keys(ENV).forEach(k => delete process.env[k]);
    db.close();
  });

  describe('getAuthorizationUrl', () => {
    it('returns a URL with github.com host', () => {
      const { url, state } = getAuthorizationUrl();
      assert.ok(url instanceof URL);
      assert.equal(url.host, 'github.com');
      assert.ok(url.searchParams.has('client_id'));
      assert.ok(typeof state === 'string');
      assert.ok(state.length > 0);
    });

    it('includes correct scopes', () => {
      const { url } = getAuthorizationUrl();
      const scope = url.searchParams.get('scope');
      assert.ok(scope);
      assert.ok(scope.includes('read:user'));
      assert.ok(scope.includes('user:email'));
    });

    it('includes state parameter matching returned state', () => {
      const { url, state } = getAuthorizationUrl();
      assert.equal(url.searchParams.get('state'), state);
    });
  });

  describe('handleCallback', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      mock.reset();
    });

    it('creates user from GitHub callback', async () => {
      const accessToken = 'ghp_test123';
      const ghUser = { id: 42, login: 'testuser', avatar_url: 'https://avatar.url' };

      // Mock fetch for GitHub API
      globalThis.fetch = mock.fn(() =>
        Promise.resolve(new Response(JSON.stringify(ghUser), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      ) as unknown as typeof globalThis.fetch;

      // We need to also mock arctic's validateAuthorizationCode.
      // Since arctic is imported internally, we mock fetch for the token exchange too.
      // Arctic's validateAuthorizationCode calls https://github.com/login/oauth/access_token
      // Let's mock it to handle both calls
      const fetchMock = globalThis.fetch as unknown as Mock<typeof globalThis.fetch>;
      fetchMock.mock.mockImplementation((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('login/oauth/access_token')) {
          return Promise.resolve(new Response(
            JSON.stringify({ access_token: accessToken, token_type: 'bearer' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ));
        }
        // GitHub API user call
        return Promise.resolve(new Response(
          JSON.stringify(ghUser),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ));
      });

      const user = await handleCallback(db, 'test-code');
      assert.equal(user.github_id, '42');
      assert.equal(user.username, 'testuser');
      assert.equal(user.avatar_url, 'https://avatar.url');
    });

    it('throws on GitHub API error', async () => {
      globalThis.fetch = mock.fn(() =>
        Promise.resolve(new Response('Unauthorized', { status: 401 }))
      ) as unknown as typeof globalThis.fetch;

      const fetchMock = globalThis.fetch as unknown as Mock<typeof globalThis.fetch>;
      fetchMock.mock.mockImplementation((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('login/oauth/access_token')) {
          return Promise.resolve(new Response(
            JSON.stringify({ access_token: 'token', token_type: 'bearer' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ));
        }
        return Promise.resolve(new Response('Unauthorized', { status: 401 }));
      });

      await assert.rejects(() => handleCallback(db, 'bad-code'), /GitHub API error/);
    });
  });
});
