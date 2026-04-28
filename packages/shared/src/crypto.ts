// E2E encryption utilities using Web Crypto API (zero-dependency)
// Works in both Node.js 18+ (globalThis.crypto) and browsers (window.crypto)

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };
const AES_ALGO = 'AES-GCM';
const IV_LENGTH = 12;

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

function toBuffer(input: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(input);
  return copy.buffer as ArrayBuffer;
}

// ─── ECDH Key Management ───

export async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return subtle().generateKey(ECDH_PARAMS, true, ['deriveBits']);
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const raw = await subtle().exportKey('raw', key);
  return base64Encode(raw);
}

export async function importPublicKey(base64: string): Promise<CryptoKey> {
  const raw = base64Decode(base64);
  return subtle().importKey('raw', toBuffer(raw), ECDH_PARAMS, true, []);
}

export async function exportPrivateKeyJwk(key: CryptoKey): Promise<JsonWebKey> {
  return subtle().exportKey('jwk', key);
}

export async function importPrivateKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', jwk, ECDH_PARAMS, true, ['deriveBits']);
}

// ─── Key Derivation ───

export async function deriveSessionKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  info: string,
): Promise<CryptoKey> {
  const sharedBits = await subtle().deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256,
  );

  const hkdfKey = await subtle().importKey(
    'raw',
    sharedBits,
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  );

  const keyBits = await subtle().deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    hkdfKey,
    256,
  );

  return subtle().importKey(
    'raw',
    keyBits,
    { name: AES_ALGO },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey(
    'raw',
    toBuffer(rawKey),
    { name: AES_ALGO },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function exportAesKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await subtle().exportKey('raw', key);
  return new Uint8Array(raw);
}

// ─── AES-256-GCM ───

export async function aesEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ iv: Uint8Array; data: Uint8Array }> {
  const iv = randomBytes(IV_LENGTH);
  const ciphertext = await subtle().encrypt(
    { name: AES_ALGO, iv: toBuffer(iv) },
    key,
    toBuffer(plaintext),
  );
  return { iv, data: new Uint8Array(ciphertext) };
}

export async function aesDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const plaintext = await subtle().decrypt(
    { name: AES_ALGO, iv: toBuffer(iv) },
    key,
    toBuffer(ciphertext),
  );
  return new Uint8Array(plaintext);
}

// ─── Helpers ───

export function randomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

export function generateSessionKey(): Uint8Array {
  return randomBytes(32);
}

export function base64Encode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
