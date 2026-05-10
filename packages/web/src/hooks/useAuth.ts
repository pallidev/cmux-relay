/**
 * JWT cookie parsing utilities.
 *
 * Extracts the relay_jwt token from document.cookie, used across
 * App.tsx, Layout.tsx, MobileLayout.tsx, RelaySessionLayout.tsx, and push.ts.
 */

const JWT_COOKIE_NAME = 'relay_jwt';
const JWT_COOKIE_REGEX = /(?:^|;\s*)relay_jwt=([^;]+)/;

/** Extract JWT from document.cookie (pure function for testability) */
export function getJwtFromCookie(cookieString: string): string | null {
  const match = cookieString.match(JWT_COOKIE_REGEX);
  return match ? match[1] : null;
}

/** Extract JWT from the browser's document.cookie */
export function getJwtFromBrowser(): string | null {
  if (typeof document === 'undefined') return null;
  return getJwtFromCookie(document.cookie);
}
