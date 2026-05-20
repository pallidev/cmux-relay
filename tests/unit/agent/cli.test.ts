import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../../../packages/agent/src/cli.js';

describe('parseCliArgs', () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save relevant env vars
    for (const key of [
      'CMUX_RELAY_PORT', 'CMUX_RELAY_HOST', 'CMUX_RELAY_TLS_CERT',
      'CMUX_RELAY_TLS_KEY', 'CMUX_RELAY_TOKEN', 'CMUX_RELAY_URL',
      'CMUX_ACP_COMMAND', 'CMUX_ACP_ARGS', 'CMUX_ACP_NAME',
    ]) {
      origEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(origEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
  });

  it('returns defaults with empty argv', () => {
    const opts = parseCliArgs([]);
    assert.equal(opts.isLocal, false);
    assert.equal(opts.port, 8080);
    assert.equal(opts.host, '0.0.0.0');
    assert.equal(opts.cmuxSocket, '');
    assert.equal(opts.tlsCert, '');
    assert.equal(opts.tlsKey, '');
    assert.equal(opts.apiToken, '');
    assert.equal(opts.relayUrl, 'wss://relay.gateway.myaddr.io/ws/agent');
    assert.equal(opts.acpCommand, '');
    assert.deepEqual(opts.acpArgs, []);
    assert.equal(opts.acpName, '');
  });

  it('parses --local flag', () => {
    const opts = parseCliArgs(['--local']);
    assert.equal(opts.isLocal, true);
  });

  it('parses --port', () => {
    const opts = parseCliArgs(['--port', '9090']);
    assert.equal(opts.port, 9090);
  });

  it('parses --host', () => {
    const opts = parseCliArgs(['--host', '127.0.0.1']);
    assert.equal(opts.host, '127.0.0.1');
  });

  it('parses --socket', () => {
    const opts = parseCliArgs(['--socket', '/tmp/custom.sock']);
    assert.equal(opts.cmuxSocket, '/tmp/custom.sock');
  });

  it('parses --tls-cert and --tls-key', () => {
    const opts = parseCliArgs(['--tls-cert', '/path/cert.pem', '--tls-key', '/path/key.pem']);
    assert.equal(opts.tlsCert, '/path/cert.pem');
    assert.equal(opts.tlsKey, '/path/key.pem');
  });

  it('parses --token', () => {
    const opts = parseCliArgs(['--token', 'my-secret-token']);
    assert.equal(opts.apiToken, 'my-secret-token');
  });

  it('parses --relay-url', () => {
    const opts = parseCliArgs(['--relay-url', 'wss://custom.relay.io/ws']);
    assert.equal(opts.relayUrl, 'wss://custom.relay.io/ws');
  });

  it('reads CMUX_RELAY_PORT env var', () => {
    process.env.CMUX_RELAY_PORT = '7070';
    const opts = parseCliArgs([]);
    assert.equal(opts.port, 7070);
  });

  it('CLI --port overrides env var', () => {
    process.env.CMUX_RELAY_PORT = '7070';
    const opts = parseCliArgs(['--port', '6060']);
    assert.equal(opts.port, 6060);
  });

  it('reads CMUX_RELAY_HOST env var', () => {
    process.env.CMUX_RELAY_HOST = '192.168.1.1';
    const opts = parseCliArgs([]);
    assert.equal(opts.host, '192.168.1.1');
  });

  it('reads CMUX_RELAY_TLS_CERT and CMUX_RELAY_TLS_KEY env vars', () => {
    process.env.CMUX_RELAY_TLS_CERT = '/env/cert.pem';
    process.env.CMUX_RELAY_TLS_KEY = '/env/key.pem';
    const opts = parseCliArgs([]);
    assert.equal(opts.tlsCert, '/env/cert.pem');
    assert.equal(opts.tlsKey, '/env/key.pem');
  });

  it('reads CMUX_RELAY_TOKEN env var', () => {
    process.env.CMUX_RELAY_TOKEN = 'env-token';
    const opts = parseCliArgs([]);
    assert.equal(opts.apiToken, 'env-token');
  });

  it('reads CMUX_RELAY_URL env var', () => {
    process.env.CMUX_RELAY_URL = 'wss://env.relay.io/ws';
    const opts = parseCliArgs([]);
    assert.equal(opts.relayUrl, 'wss://env.relay.io/ws');
  });

  it('parses combined local mode with all options', () => {
    const opts = parseCliArgs([
      '--local',
      '--port', '9999',
      '--host', '0.0.0.0',
      '--socket', '/tmp/cmux.sock',
      '--tls-cert', '/cert.pem',
      '--tls-key', '/key.pem',
      '--token', 'abc123',
      '--relay-url', 'wss://custom/ws',
    ]);
    assert.equal(opts.isLocal, true);
    assert.equal(opts.port, 9999);
    assert.equal(opts.host, '0.0.0.0');
    assert.equal(opts.cmuxSocket, '/tmp/cmux.sock');
    assert.equal(opts.tlsCert, '/cert.pem');
    assert.equal(opts.tlsKey, '/key.pem');
    assert.equal(opts.apiToken, 'abc123');
    assert.equal(opts.relayUrl, 'wss://custom/ws');
  });

  it('returns empty string for flag without value', () => {
    const opts = parseCliArgs(['--port']);
    assert.equal(opts.port, 8080); // falls back to default since value is empty
  });

  it('ignores unknown flags', () => {
    const opts = parseCliArgs(['--unknown-flag', 'value', '--local']);
    assert.equal(opts.isLocal, true);
    assert.equal(opts.port, 8080);
  });

  // ─── ACP options ───

  describe('ACP options', () => {
    it('parses --acp-command', () => {
      const opts = parseCliArgs(['--acp-command', 'claude-agent-acp']);
      assert.equal(opts.acpCommand, 'claude-agent-acp');
      assert.equal(opts.acpName, 'claude-agent-acp');
    });

    it('parses --acp-command with --acp-args', () => {
      const opts = parseCliArgs(['--acp-command', 'codex-acp', '--acp-args', '--model,o3']);
      assert.equal(opts.acpCommand, 'codex-acp');
      assert.deepEqual(opts.acpArgs, ['--model', 'o3']);
    });

    it('parses --acp-name for custom display name', () => {
      const opts = parseCliArgs(['--acp-command', 'claude-agent-acp', '--acp-name', 'Claude']);
      assert.equal(opts.acpName, 'Claude');
    });

    it('derives acpName from acp-command when --acp-name not set', () => {
      const opts = parseCliArgs(['--acp-command', '@anthropic/claude-agent']);
      assert.equal(opts.acpName, 'claude-agent');
    });

    it('reads CMUX_ACP_COMMAND env var', () => {
      process.env.CMUX_ACP_COMMAND = 'claude-agent-acp';
      const opts = parseCliArgs([]);
      assert.equal(opts.acpCommand, 'claude-agent-acp');
    });

    it('reads CMUX_ACP_ARGS env var', () => {
      process.env.CMUX_ACP_ARGS = '--verbose,--model,sonnet';
      const opts = parseCliArgs([]);
      assert.deepEqual(opts.acpArgs, ['--verbose', '--model', 'sonnet']);
    });

    it('reads CMUX_ACP_NAME env var', () => {
      process.env.CMUX_ACP_NAME = 'My Agent';
      const opts = parseCliArgs([]);
      assert.equal(opts.acpName, 'My Agent');
    });

    it('CLI flags override env vars', () => {
      process.env.CMUX_ACP_COMMAND = 'env-agent';
      const opts = parseCliArgs(['--acp-command', 'cli-agent']);
      assert.equal(opts.acpCommand, 'cli-agent');
    });

    it('returns empty acpCommand by default', () => {
      const opts = parseCliArgs([]);
      assert.equal(opts.acpCommand, '');
      assert.deepEqual(opts.acpArgs, []);
      assert.equal(opts.acpName, '');
    });
  });
});
