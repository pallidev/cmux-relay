import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  generateEcdhKeyPair,
  exportPublicKey,
  importPublicKey,
  exportPrivateKeyJwk,
  importPrivateKeyJwk,
  deriveSessionKey,
  importAesKey,
  exportAesKey,
  aesEncrypt,
  aesDecrypt,
  generateSessionKey,
  base64Encode,
  base64Decode,
} from '@cmux-relay/shared';
import type { E2EAckMessage, EncryptedPayload } from '@cmux-relay/shared';

const KEY_DIR = join(homedir(), '.cmux-relay');
const KEY_FILE = join(KEY_DIR, 'e2e-keys.json');

interface StoredKeys {
  privateKeyJwk: JsonWebKey;
  publicKeyBase64: string;
}

export class AgentE2ECrypto {
  private keyPair: CryptoKeyPair | null = null;
  private sessionKey: CryptoKey | null = null;
  private sessionKeyRaw: Uint8Array | null = null;

  async initialize(): Promise<void> {
    const stored = await this.loadKeys();
    if (stored) {
      const privateKey = await importPrivateKeyJwk(stored.privateKeyJwk);
      const publicKey = await importPublicKey(stored.publicKeyBase64);
      this.keyPair = { privateKey, publicKey } as CryptoKeyPair;
    } else {
      this.keyPair = await generateEcdhKeyPair();
      await this.saveKeys();
    }

    this.sessionKeyRaw = generateSessionKey();
    this.sessionKey = await importAesKey(this.sessionKeyRaw);
  }

  async handleE2EInit(clientPublicKeyBase64: string): Promise<E2EAckMessage> {
    if (!this.keyPair || !this.sessionKey || !this.sessionKeyRaw) {
      throw new Error('E2E not initialized');
    }

    const clientPubKey = await importPublicKey(clientPublicKeyBase64);
    const kek = await deriveSessionKey(
      this.keyPair.privateKey,
      clientPubKey,
      'cmux-relay-kek',
    );

    const { iv, data } = await aesEncrypt(kek, this.sessionKeyRaw);

    return {
      type: 'e2e.ack',
      agentPublicKey: await exportPublicKey(this.keyPair.publicKey),
      encryptedSessionKey: base64Encode(data),
      iv: base64Encode(iv),
    };
  }

  async encryptOutput(base64Data: string): Promise<EncryptedPayload> {
    if (!this.sessionKey) throw new Error('E2E not initialized');
    const plaintext = base64Decode(base64Data);
    const { iv, data } = await aesEncrypt(this.sessionKey, plaintext);
    return { encrypted: true, iv: base64Encode(iv), data: base64Encode(data) };
  }

  async decryptInput(payload: EncryptedPayload): Promise<string> {
    if (!this.sessionKey) throw new Error('E2E not initialized');
    const iv = base64Decode(payload.iv);
    const ciphertext = base64Decode(payload.data);
    const plaintext = await aesDecrypt(this.sessionKey, iv, ciphertext);
    return base64Encode(plaintext);
  }

  isReady(): boolean {
    return this.sessionKey !== null;
  }

  private async loadKeys(): Promise<StoredKeys | null> {
    try {
      const raw = await readFile(KEY_FILE, 'utf-8');
      return JSON.parse(raw) as StoredKeys;
    } catch {
      return null;
    }
  }

  private async saveKeys(): Promise<void> {
    if (!this.keyPair) return;
    await mkdir(KEY_DIR, { recursive: true });
    const stored: StoredKeys = {
      privateKeyJwk: await exportPrivateKeyJwk(this.keyPair.privateKey),
      publicKeyBase64: await exportPublicKey(this.keyPair.publicKey),
    };
    await writeFile(KEY_FILE, JSON.stringify(stored), { mode: 0o600 });
  }
}
