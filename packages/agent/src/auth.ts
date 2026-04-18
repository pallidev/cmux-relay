import jwt from 'jsonwebtoken';

function getSecret(): string {
  return process.env.CMUX_RELAY_JWT_SECRET || 'cmux-relay-dev-secret';
}

export function generateToken(): string {
  return jwt.sign({ role: 'agent', iat: Math.floor(Date.now() / 1000) }, getSecret());
}

export function verifyToken(token: string): { role: string } | null {
  try {
    return jwt.verify(token, getSecret()) as { role: string };
  } catch {
    return null;
  }
}

export function generateClientToken(): string {
  return jwt.sign({ role: 'client', iat: Math.floor(Date.now() / 1000) }, getSecret());
}
