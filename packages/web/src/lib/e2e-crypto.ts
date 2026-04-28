import {
  generateEcdhKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSessionKey,
  importAesKey,
  aesEncrypt,
  aesDecrypt,
  base64Encode,
  base64Decode,
} from '@cmux-relay/shared';
import type { E2EAckMessage, EncryptedPayload } from '@cmux-relay/shared';

export class ClientE2ECrypto {
  private keyPair: CryptoKeyPair | null = null;
  private sessionKey: CryptoKey | null = null;

  async initialize(): Promise<string> {
    this.keyPair = await generateEcdhKeyPair();
    return exportPublicKey(this.keyPair.publicKey);
  }

  async handleE2EAck(ack: E2EAckMessage): Promise<void> {
    if (!this.keyPair) throw new Error('E2E not initialized');

    const agentPubKey = await importPublicKey(ack.agentPublicKey);
    const kek = await deriveSessionKey(
      this.keyPair.privateKey,
      agentPubKey,
      'cmux-relay-kek',
    );

    const iv = base64Decode(ack.iv);
    const ciphertext = base64Decode(ack.encryptedSessionKey);
    const rawKey = await aesDecrypt(kek, iv, ciphertext);
    this.sessionKey = await importAesKey(rawKey);
  }

  async encryptInput(base64Data: string): Promise<EncryptedPayload> {
    if (!this.sessionKey) throw new Error('E2E session not established');
    const plaintext = base64Decode(base64Data);
    const { iv, data } = await aesEncrypt(this.sessionKey, plaintext);
    return { encrypted: true, iv: base64Encode(iv), data: base64Encode(data) };
  }

  async decryptOutput(payload: EncryptedPayload): Promise<string> {
    if (!this.sessionKey) throw new Error('E2E session not established');
    const iv = base64Decode(payload.iv);
    const ciphertext = base64Decode(payload.data);
    const plaintext = await aesDecrypt(this.sessionKey, iv, ciphertext);
    return base64Encode(plaintext);
  }

  isReady(): boolean {
    return this.sessionKey !== null;
  }
}
