import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  initDatabase,
  findUserByGithubId,
  upsertUser,
  createApiToken,
  validateApiToken,
  listApiTokens,
  deleteApiToken,
} from '../../../packages/relay/src/db.js';
import type Database from 'better-sqlite3';

describe('Database functions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  // ─── initDatabase ───

  it('initDatabase creates tables without error', () => {
    // Already called in beforeEach; verify tables exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);
    assert.ok(names.includes('users'));
    assert.ok(names.includes('api_tokens'));
  });

  // ─── upsertUser ───

  it('upsertUser creates new user', () => {
    const user = upsertUser(db, 'github-42', 'alice', 'https://avatar.example.com/alice.png');
    assert.ok(user.id);
    assert.equal(user.github_id, 'github-42');
    assert.equal(user.username, 'alice');
    assert.equal(user.avatar_url, 'https://avatar.example.com/alice.png');
    assert.ok(user.created_at);
  });

  it('upsertUser updates existing user (same github_id, new username)', () => {
    const created = upsertUser(db, 'github-99', 'bob', null);
    const updated = upsertUser(db, 'github-99', 'robert', 'https://avatar.example.com/robert.png');

    assert.equal(updated.id, created.id, 'Should keep same user id');
    assert.equal(updated.username, 'robert');
    assert.equal(updated.avatar_url, 'https://avatar.example.com/robert.png');
  });

  // ─── findUserByGithubId ───

  it('findUserByGithubId returns user', () => {
    upsertUser(db, 'github-100', 'charlie', null);
    const user = findUserByGithubId(db, 'github-100');
    assert.ok(user);
    assert.equal(user.username, 'charlie');
  });

  it('findUserByGithubId returns undefined for unknown id', () => {
    const user = findUserByGithubId(db, 'nonexistent');
    assert.equal(user, undefined);
  });

  // ─── createApiToken ───

  it('createApiToken returns sk_crx_ prefixed token', () => {
    const user = upsertUser(db, 'github-200', 'dave', null);
    const token = createApiToken(db, user.id, 'test-token');
    assert.ok(token.startsWith('sk_crx_'));
    // Token should be reasonably long: "sk_crx_" + 64 hex chars = 71 chars
    assert.ok(token.length > 70);
  });

  it('createApiToken stores token without name', () => {
    const user = upsertUser(db, 'github-201', 'eve', null);
    const token = createApiToken(db, user.id);
    assert.ok(token.startsWith('sk_crx_'));

    const tokens = listApiTokens(db, user.id);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].name, null);
  });

  // ─── validateApiToken ───

  it('validateApiToken returns user for valid token', () => {
    const user = upsertUser(db, 'github-300', 'frank', null);
    const token = createApiToken(db, user.id, 'session');

    const validated = validateApiToken(db, token);
    assert.ok(validated);
    assert.equal(validated.id, user.id);
    assert.equal(validated.username, 'frank');
  });

  it('validateApiToken returns undefined for invalid token', () => {
    const result = validateApiToken(db, 'sk_crx_invalid_token');
    assert.equal(result, undefined);
  });

  it('validateApiToken returns undefined for empty string', () => {
    const result = validateApiToken(db, '');
    assert.equal(result, undefined);
  });

  it('validateApiToken updates last_used_at', () => {
    const user = upsertUser(db, 'github-400', 'grace', null);
    const token = createApiToken(db, user.id, 'used');

    // Before validation, last_used_at should be null
    const tokensBefore = listApiTokens(db, user.id);
    assert.equal(tokensBefore[0].last_used_at, null);

    validateApiToken(db, token);

    // After validation, last_used_at should be set
    const tokensAfter = listApiTokens(db, user.id);
    assert.ok(tokensAfter[0].last_used_at, 'last_used_at should be set after validation');
  });

  // ─── listApiTokens ───

  it('listApiTokens returns tokens for user', () => {
    const user = upsertUser(db, 'github-500', 'heidi', null);
    createApiToken(db, user.id, 'token-a');
    createApiToken(db, user.id, 'token-b');

    const tokens = listApiTokens(db, user.id);
    assert.equal(tokens.length, 2);

    const names = tokens.map(t => t.name).sort();
    assert.deepEqual(names, ['token-a', 'token-b']);
  });

  it('listApiTokens returns empty array for user with no tokens', () => {
    const user = upsertUser(db, 'github-501', 'ivan', null);
    const tokens = listApiTokens(db, user.id);
    assert.equal(tokens.length, 0);
  });

  // ─── deleteApiToken ───

  it('deleteApiToken removes token', () => {
    const user = upsertUser(db, 'github-600', 'judy', null);
    createApiToken(db, user.id, 'keep');
    const deleteToken = createApiToken(db, user.id, 'delete-me');

    const tokensBefore = listApiTokens(db, user.id);
    assert.equal(tokensBefore.length, 2);

    // Find the token id for the one to delete
    const tokenRow = tokensBefore.find(t => t.name === 'delete-me');
    assert.ok(tokenRow);

    const result = deleteApiToken(db, user.id, tokenRow.id);
    assert.equal(result, true);

    const tokensAfter = listApiTokens(db, user.id);
    assert.equal(tokensAfter.length, 1);
    assert.equal(tokensAfter[0].name, 'keep');
  });

  it('deleteApiToken returns false for wrong user', () => {
    const user1 = upsertUser(db, 'github-700', 'karl', null);
    const user2 = upsertUser(db, 'github-701', 'larry', null);
    createApiToken(db, user1.id, 'owned-by-karl');

    const karlTokens = listApiTokens(db, user1.id);
    assert.equal(karlTokens.length, 1);

    // Larry tries to delete Karl's token
    const result = deleteApiToken(db, user2.id, karlTokens[0].id);
    assert.equal(result, false);

    // Karl's token should still exist
    const afterTokens = listApiTokens(db, user1.id);
    assert.equal(afterTokens.length, 1);
  });

  it('deleteApiToken returns false for non-existent token', () => {
    const user = upsertUser(db, 'github-800', 'mike', null);
    const result = deleteApiToken(db, user.id, 'nonexistent-token-id');
    assert.equal(result, false);
  });
});
