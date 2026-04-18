import { GitHub, generateState } from 'arctic';
import { upsertUser, type UserRecord } from './db.js';
import type Database from 'better-sqlite3';

let github: GitHub | null = null;

function getGitHub(): GitHub {
  if (!github) {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET env vars are required');
    }
    github = new GitHub(clientId, clientSecret, null);
  }
  return github;
}

export function getAuthorizationUrl(): { url: URL; state: string } {
  const state = generateState();
  const url = getGitHub().createAuthorizationURL(state, ['read:user', 'user:email']);
  return { url, state };
}

export async function handleCallback(db: Database.Database, code: string): Promise<UserRecord> {
  const gh = getGitHub();
  const tokens = await gh.validateAuthorizationCode(code);
  const accessToken = tokens.accessToken();

  const userResponse = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'cmux-relay' },
  });
  if (!userResponse.ok) throw new Error(`GitHub API error: ${userResponse.status}`);
  const ghUser = await userResponse.json() as { id: number; login: string; avatar_url?: string };

  return upsertUser(db, String(ghUser.id), ghUser.login, ghUser.avatar_url ?? null);
}
