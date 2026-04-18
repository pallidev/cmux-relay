import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InputHandler } from '../../../packages/agent/src/input-handler.js';
import type { CmuxClient } from '../../../packages/agent/src/cmux-client.js';

function createMockCmux(): {
  client: Partial<CmuxClient>;
  sendTextCalls: Array<{ surfaceId: string; text: string }>;
} {
  const sendTextCalls: Array<{ surfaceId: string; text: string }> = [];
  return {
    sendTextCalls,
    client: {
      async sendText(surfaceId: string, text: string) {
        sendTextCalls.push({ surfaceId, text });
      },
    },
  };
}

function createFailingCmux(): Partial<CmuxClient> {
  return {
    async sendText() {
      throw new Error('cmux connection lost');
    },
  };
}

describe('InputHandler', () => {
  let mock: ReturnType<typeof createMockCmux>;
  let handler: InputHandler;

  beforeEach(() => {
    mock = createMockCmux();
    handler = new InputHandler(mock.client as CmuxClient);
  });

  describe('handleInput', () => {
    it('decodes base64 and calls cmux.sendText', async () => {
      const input = Buffer.from('ls -la\n').toString('base64');
      await handler.handleInput('surf-1', input);

      assert.equal(mock.sendTextCalls.length, 1);
      assert.equal(mock.sendTextCalls[0].surfaceId, 'surf-1');
      assert.equal(mock.sendTextCalls[0].text, 'ls -la\n');
    });

    it('decodes empty base64 string', async () => {
      const input = Buffer.from('').toString('base64');
      await handler.handleInput('surf-1', input);

      assert.equal(mock.sendTextCalls.length, 1);
      assert.equal(mock.sendTextCalls[0].text, '');
    });

    it('decodes multi-byte UTF-8 characters', async () => {
      const text = 'echo "안녕하세요"\n';
      const input = Buffer.from(text).toString('base64');
      await handler.handleInput('surf-1', input);

      assert.equal(mock.sendTextCalls.length, 1);
      assert.equal(mock.sendTextCalls[0].text, text);
    });

    it('decodes special characters and control sequences', async () => {
      const text = '\x1b[A'; // Up arrow escape sequence
      const input = Buffer.from(text).toString('base64');
      await handler.handleInput('surf-1', input);

      assert.equal(mock.sendTextCalls.length, 1);
      assert.equal(mock.sendTextCalls[0].text, text);
    });

    it('silently catches cmux errors', async () => {
      const failingHandler = new InputHandler(createFailingCmux() as CmuxClient);
      const input = Buffer.from('test').toString('base64');

      // Should not throw
      await failingHandler.handleInput('surf-1', input);
    });
  });

  describe('handleResize', () => {
    it('does not throw', async () => {
      // handleResize just logs, should never throw
      await handler.handleResize('surf-1', 120, 50);
    });

    it('handles zero dimensions', async () => {
      await handler.handleResize('surf-1', 0, 0);
    });

    it('handles large dimensions', async () => {
      await handler.handleResize('surf-1', 9999, 9999);
    });
  });
});
