import { SignJWT, jwtVerify } from 'jose';

const JWT_ALG = 'HS256';

export function getJwtSecret(): Uint8Array {
  const secret = process.env.RELAY_JWT_SECRET || 'cmux-relay-dev-secret';
  return new TextEncoder().encode(secret);
}

export async function createSessionJwt(userId: string, username: string): Promise<string> {
  return new SignJWT({ sub: userId, username })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(getJwtSecret());
}

export async function verifySessionJwt(token: string): Promise<{ sub: string; username: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (typeof payload.sub !== 'string' || typeof payload.username !== 'string') return null;
    return { sub: payload.sub, username: payload.username };
  } catch {
    return null;
  }
}
