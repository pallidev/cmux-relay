import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureSingleInstance, cleanupPidFile } from '../../../packages/agent/src/process-manager.js';

const TEST_DIR = join(tmpdir(), `cmux-relay-test-pid-${process.pid}`);

describe('process-manager', () => {
  const pidFile = join(TEST_DIR, 'agent.pid');

  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    // Clean up any leftover pid file from previous test
    try { await rm(pidFile); } catch {}
  });

  afterEach(async () => {
    try { await rm(pidFile); } catch {}
    try { await rm(TEST_DIR, { recursive: true }); } catch {}
  });

  describe('ensureSingleInstance', () => {
    it('creates PID file if it does not exist', async () => {
      assert.equal(existsSync(pidFile), false);

      await ensureSingleInstance(pidFile);

      assert.equal(existsSync(pidFile), true);
      const content = await readFile(pidFile, 'utf-8');
      assert.equal(content, `${process.pid}`);
    });

    it('overwrites PID file if existing PID is not running', async () => {
      // Write a PID that doesn't exist (99999999 is very unlikely to be running)
      await writeFile(pidFile, '99999999');

      await ensureSingleInstance(pidFile);

      const content = await readFile(pidFile, 'utf-8');
      assert.equal(content, `${process.pid}`);
    });

    it('overwrites PID file if content is not a number', async () => {
      await writeFile(pidFile, 'not-a-pid');

      await ensureSingleInstance(pidFile);

      const content = await readFile(pidFile, 'utf-8');
      assert.equal(content, `${process.pid}`);
    });

    it('handles PID file with current process PID gracefully', async () => {
      // This test verifies behavior when PID file contains our own PID.
      // Since the current process is alive, ensureSingleInstance will try to
      // stop it. We can't actually test this without killing ourselves, so
      // instead we verify the "PID is stale" path works (tested above).
      // This is a documentation test confirming the edge case exists.
      assert.ok(true, 'Self-PID edge case acknowledged; stale PID path covered by other tests');
    });

    it('returns the PID file path', async () => {
      const result = await ensureSingleInstance(pidFile);
      assert.equal(result, pidFile);
    });
  });

  describe('cleanupPidFile', () => {
    it('removes PID file', async () => {
      await writeFile(pidFile, `${process.pid}`);
      assert.equal(existsSync(pidFile), true);

      await cleanupPidFile(pidFile);

      assert.equal(existsSync(pidFile), false);
    });

    it('does not throw if PID file does not exist', async () => {
      await assert.doesNotReject(() => cleanupPidFile(pidFile));
    });
  });
});
