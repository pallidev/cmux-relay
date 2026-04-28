import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
  randomBytes,
} from '../../../packages/shared/src/crypto.js';

describe('crypto', () => {
  describe('base64', () => {
    it('round-trips Uint8Array', () => {
      const data = new Uint8Array([72, 101, 108, 108, 111]);
      assert.equal(base64Encode(data), 'SGVsbG8=');
      assert.deepEqual(base64Decode('SGVsbG8='), data);
    });

    it('round-trips ArrayBuffer', () => {
      const data = new Uint8Array([0, 255, 128, 1]).buffer;
      const encoded = base64Encode(data);
      assert.deepEqual(base64Decode(encoded), new Uint8Array([0, 255, 128, 1]));
    });

    it('handles empty input', () => {
      assert.equal(base64Encode(new Uint8Array(0)), '');
      assert.deepEqual(base64Decode(''), new Uint8Array(0));
    });
  });

  describe('ECDH', () => {
    it('generates and exports key pair', async () => {
      const pair = await generateEcdhKeyPair();
      const pubB64 = await exportPublicKey(pair.publicKey);
      assert.ok(typeof pubB64 === 'string');
      assert.ok(pubB64.length > 0);
    });

    it('imports exported public key', async () => {
      const pair = await generateEcdhKeyPair();
      const pubB64 = await exportPublicKey(pair.publicKey);
      const imported = await importPublicKey(pubB64);
      assert.ok(imported.type === 'public');
    });

    it('round-trips private key as JWK', async () => {
      const pair = await generateEcdhKeyPair();
      const jwk = await exportPrivateKeyJwk(pair.privateKey);
      assert.equal(jwk.kty, 'EC');
      const imported = await importPrivateKeyJwk(jwk);
      assert.ok(imported.type === 'private');
    });

    it('both sides derive the same session key', async () => {
      const alice = await generateEcdhKeyPair();
      const bob = await generateEcdhKeyPair();

      const aliceKey = await deriveSessionKey(alice.privateKey, bob.publicKey, 'test-info');
      const bobKey = await deriveSessionKey(bob.privateKey, alice.publicKey, 'test-info');

      const aliceRaw = await exportAesKey(aliceKey);
      const bobRaw = await exportAesKey(bobKey);
      assert.deepEqual(aliceRaw, bobRaw);
    });

    it('different info produces different keys', async () => {
      const alice = await generateEcdhKeyPair();
      const bob = await generateEcdhKeyPair();

      const key1 = await deriveSessionKey(alice.privateKey, bob.publicKey, 'info-a');
      const key2 = await deriveSessionKey(alice.privateKey, bob.publicKey, 'info-b');

      const raw1 = await exportAesKey(key1);
      const raw2 = await exportAesKey(key2);
      assert.ok(!raw1.every((b, i) => b === raw2[i]));
    });
  });

  describe('AES-256-GCM', () => {
    it('encrypts and decrypts', async () => {
      const key = await importAesKey(generateSessionKey());
      const plaintext = new TextEncoder().encode('Hello, World!');
      const { iv, data } = await aesEncrypt(key, plaintext);
      const decrypted = await aesDecrypt(key, iv, data);
      assert.deepEqual(decrypted, plaintext);
    });

    it('fails with wrong key', async () => {
      const key1 = await importAesKey(generateSessionKey());
      const key2 = await importAesKey(generateSessionKey());
      const plaintext = new TextEncoder().encode('secret');
      const { iv, data } = await aesEncrypt(key1, plaintext);
      await assert.rejects(() => aesDecrypt(key2, iv, data));
    });

    it('fails with wrong IV', async () => {
      const key = await importAesKey(generateSessionKey());
      const plaintext = new TextEncoder().encode('secret');
      const { data } = await aesEncrypt(key, plaintext);
      const wrongIv = randomBytes(12);
      await assert.rejects(() => aesDecrypt(key, wrongIv, data));
    });

    it('produces different ciphertext for same plaintext', async () => {
      const key = await importAesKey(generateSessionKey());
      const plaintext = new TextEncoder().encode('same data');
      const enc1 = await aesEncrypt(key, plaintext);
      const enc2 = await aesEncrypt(key, plaintext);
      // Random IVs mean different ciphertext
      assert.ok(!enc1.data.every((b, i) => b === enc2.data[i]));
    });
  });

  describe('E2E full handshake', () => {
    it('agent encrypts, client decrypts (output flow)', async () => {
      // Simulate agent side
      const agentPair = await generateEcdhKeyPair();
      const sessionKeyRaw = generateSessionKey();
      const sessionKey = await importAesKey(sessionKeyRaw);

      // Simulate client side
      const clientPair = await generateEcdhKeyPair();
      const clientPubB64 = await exportPublicKey(clientPair.publicKey);

      // Agent receives e2e.init, derives KEK, encrypts session key
      const clientPub = await importPublicKey(clientPubB64);
      const kek = await deriveSessionKey(agentPair.privateKey, clientPub, 'cmux-relay-kek');
      const { iv, data: encryptedSK } = await aesEncrypt(kek, sessionKeyRaw);

      // Client receives e2e.ack, derives KEK, decrypts session key
      const agentPubB64 = await exportPublicKey(agentPair.publicKey);
      const agentPub = await importPublicKey(agentPubB64);
      const clientKek = await deriveSessionKey(clientPair.privateKey, agentPub, 'cmux-relay-kek');
      const decryptedSK = await aesDecrypt(clientKek, iv, encryptedSK);
      const clientSessionKey = await importAesKey(decryptedSK);

      // Agent encrypts terminal output
      const terminalText = 'ls -la\n';
      const b64Data = Buffer.from(terminalText).toString('base64');
      const outputPlaintext = new TextEncoder().encode(b64Data);
      const encrypted = await aesEncrypt(sessionKey, outputPlaintext);

      // Client decrypts terminal output
      const decrypted = await aesDecrypt(clientSessionKey, encrypted.iv, encrypted.data);
      const decryptedB64 = new TextDecoder().decode(decrypted);
      assert.equal(decryptedB64, b64Data);
      assert.equal(Buffer.from(decryptedB64, 'base64').toString(), terminalText);
    });

    it('client encrypts, agent decrypts (input flow)', async () => {
      const agentPair = await generateEcdhKeyPair();
      const sessionKeyRaw = generateSessionKey();
      const sessionKey = await importAesKey(sessionKeyRaw);

      const clientPair = await generateEcdhKeyPair();
      const clientPubB64 = await exportPublicKey(clientPair.publicKey);
      const clientPub = await importPublicKey(clientPubB64);
      const kek = await deriveSessionKey(agentPair.privateKey, clientPub, 'cmux-relay-kek');
      const { iv, data: encryptedSK } = await aesEncrypt(kek, sessionKeyRaw);

      const agentPubB64 = await exportPublicKey(agentPair.publicKey);
      const agentPub = await importPublicKey(agentPubB64);
      const clientKek = await deriveSessionKey(clientPair.privateKey, agentPub, 'cmux-relay-kek');
      const decryptedSK = await aesDecrypt(clientKek, iv, encryptedSK);
      const clientSessionKey = await importAesKey(decryptedSK);

      // Client encrypts input
      const inputData = 'git status\n';
      const b64Input = Buffer.from(inputData).toString('base64');
      const inputPlaintext = new TextEncoder().encode(b64Input);
      const encrypted = await aesEncrypt(clientSessionKey, inputPlaintext);

      // Agent decrypts input
      const decrypted = await aesDecrypt(sessionKey, encrypted.iv, encrypted.data);
      const decryptedB64 = new TextDecoder().decode(decrypted);
      assert.equal(decryptedB64, b64Input);
    });
  });
});
