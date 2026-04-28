import Database from 'better-sqlite3';
import { randomBytes, createHash } from 'node:crypto';

export interface UserRecord {
  id: string;
  github_id: string;
  username: string;
  avatar_url: string | null;
  created_at: string;
}

export interface ApiTokenRecord {
  id: string;
  user_id: string;
  token_hash: string;
  name: string | null;
  last_used_at: string | null;
  created_at: string;
}

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      github_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      avatar_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token_hash TEXT UNIQUE NOT NULL,
      name TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth_key TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);
  `);

  return db;
}

export function findUserByGithubId(db: Database.Database, githubId: string): UserRecord | undefined {
  return db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) as UserRecord | undefined;
}

export function upsertUser(db: Database.Database, githubId: string, username: string, avatarUrl: string | null): UserRecord {
  const existing = findUserByGithubId(db, githubId);
  if (existing) {
    db.prepare('UPDATE users SET username = ?, avatar_url = ? WHERE id = ?').run(username, avatarUrl, existing.id);
    return { ...existing, username, avatar_url: avatarUrl };
  }

  const id = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO users (id, github_id, username, avatar_url) VALUES (?, ?, ?, ?)').run(id, githubId, username, avatarUrl);
  return { id, github_id: githubId, username, avatar_url: avatarUrl, created_at: new Date().toISOString() };
}

export function createApiToken(db: Database.Database, userId: string, name?: string): string {
  const rawToken = `sk_crx_${randomBytes(32).toString('hex')}`;
  const tokenHash = hashToken(rawToken);
  const id = randomBytes(16).toString('hex');

  db.prepare('INSERT INTO api_tokens (id, user_id, token_hash, name) VALUES (?, ?, ?, ?)').run(id, userId, tokenHash, name ?? null);
  return rawToken;
}

export function validateApiToken(db: Database.Database, rawToken: string): UserRecord | undefined {
  const tokenHash = hashToken(rawToken);
  const tokenRow = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(tokenHash) as ApiTokenRecord | undefined;
  if (!tokenRow) return undefined;

  db.prepare('UPDATE api_tokens SET last_used_at = datetime(\'now\') WHERE id = ?').run(tokenRow.id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(tokenRow.user_id) as UserRecord;
}

export interface ApiTokenPublic {
  id: string;
  user_id: string;
  name: string | null;
  last_used_at: string | null;
  created_at: string;
}

export function listApiTokens(db: Database.Database, userId: string): ApiTokenPublic[] {
  const rows = db.prepare('SELECT id, user_id, name, last_used_at, created_at FROM api_tokens WHERE user_id = ?').all(userId);
  return rows as unknown as ApiTokenPublic[];
}

export function deleteApiToken(db: Database.Database, userId: string, tokenId: string): boolean {
  const result = db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(tokenId, userId);
  return result.changes > 0;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface PushSubscriptionRecord {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
  user_agent: string | null;
  created_at: string;
}

export function upsertPushSubscription(
  db: Database.Database,
  userId: string,
  endpoint: string,
  p256dh: string,
  authKey: string,
  userAgent?: string,
): string {
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE push_subscriptions SET p256dh = ?, auth_key = ?, user_agent = ? WHERE id = ?')
      .run(p256dh, authKey, userAgent ?? null, existing.id);
    return existing.id;
  }
  const id = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth_key, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, userId, endpoint, p256dh, authKey, userAgent ?? null);
  return id;
}

export function getPushSubscriptionsForUser(db: Database.Database, userId: string): PushSubscriptionRecord[] {
  return db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId) as PushSubscriptionRecord[];
}

export function deletePushSubscription(db: Database.Database, userId: string, endpoint: string): boolean {
  const result = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
  return result.changes > 0;
}
