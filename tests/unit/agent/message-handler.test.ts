import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleClientMessage } from '../../../packages/agent/src/message-handler.js';
import type { MessageHandlerDeps } from '../../../packages/agent/src/message-handler.js';
import { SessionStore } from '../../../packages/agent/src/session-store.js';
import type { IInputHandler } from '../../../packages/agent/src/input-handler.js';
import type { CmuxClient } from '../../../packages/agent/src/cmux-client.js';
import type { RelayToClient } from '@cmux-relay/shared';

function createMockInputHandler(): IInputHandler & {
  inputs: Array<{ surfaceId: string; data: string }>;
  resizes: Array<{ surfaceId: string; cols: number; rows: number }>;
} {
  const inputs: Array<{ surfaceId: string; data: string }> = [];
  const resizes: Array<{ surfaceId: string; cols: number; rows: number }> = [];
  return {
    inputs,
    resizes,
    async handleInput(surfaceId: string, data: string) {
      inputs.push({ surfaceId, data });
    },
    async handleResize(surfaceId: string, cols: number, rows: number) {
      resizes.push({ surfaceId, cols, rows });
    },
  };
}

function createMockCmux(): {
  client: Partial<CmuxClient>;
  calls: Record<string, any[][]>;
} {
  const calls: Record<string, any[][]> = {
    sendText: [],
    readTerminalText: [],
  };

  return {
    calls,
    client: {
      async readTerminalText(surfaceId: string, scrollback?: boolean) {
        calls.readTerminalText.push([surfaceId, scrollback]);
        return 'terminal output text';
      },
      async sendText(surfaceId: string, text: string) {
        calls.sendText.push([surfaceId, text]);
      },
    },
  };
}

describe('handleClientMessage', () => {
  let store: SessionStore;
  let inputHandler: ReturnType<typeof createMockInputHandler>;
  let sentMessages: RelayToClient[];

  function createDeps(cmux?: Partial<CmuxClient>): MessageHandlerDeps {
    return {
      store,
      inputHandler,
      cmux: cmux as CmuxClient | undefined,
    };
  }

  function send(msg: RelayToClient): void {
    sentMessages.push(msg);
  }

  function sendMessage(data: string, deps?: MessageHandlerDeps): Promise<void> {
    return handleClientMessage(data, 'client-1', deps ?? createDeps(), send);
  }

  beforeEach(() => {
    store = new SessionStore();
    inputHandler = createMockInputHandler();
    sentMessages = [];
  });

  // ─── Auth ───

  describe('auth', () => {
    it('sends workspaces, surfaces, panes, and notifications on auth', async () => {
      store.updateWorkspaces([{ id: 'ws1', title: 'Workspace 1' }]);
      store.updateSurfaces('ws1', [
        { id: 's1', title: 'Terminal', type: 'terminal', workspaceId: 'ws1' },
      ]);
      store.updatePanesForWorkspace('ws1', [
        {
          id: 'pane-1',
          index: 0,
          surfaceIds: ['s1'],
          selectedSurfaceId: 's1',
          columns: 120,
          rows: 40,
          frame: { x: 0, y: 0, width: 960, height: 1080 },
          focused: true,
          workspaceId: 'ws1',
        },
      ], { x: 0, y: 0, width: 1920, height: 1080 });
      store.updateNotifications([
        {
          id: 'n1',
          title: 'Alert',
          subtitle: 'Sub',
          body: 'Body',
          surfaceId: 's1',
          workspaceId: 'ws1',
          isRead: false,
        },
      ]);

      await sendMessage(JSON.stringify({ type: 'auth', payload: { token: 'any' } }));

      const types = sentMessages.map(m => m.type);
      assert.ok(types.includes('workspaces'));
      assert.ok(types.includes('surfaces'));
      assert.ok(types.includes('panes'));
      assert.ok(types.includes('notifications'));
    });

    it('sends surfaces for each workspace', async () => {
      store.updateWorkspaces([
        { id: 'ws1', title: 'W1' },
        { id: 'ws2', title: 'W2' },
      ]);
      store.updateSurfaces('ws1', [
        { id: 's1', title: 'T1', type: 'terminal', workspaceId: 'ws1' },
      ]);
      store.updateSurfaces('ws2', [
        { id: 's2', title: 'T2', type: 'terminal', workspaceId: 'ws2' },
      ]);

      await sendMessage(JSON.stringify({ type: 'auth', payload: { token: 'any' } }));

      const surfacesMsgs = sentMessages.filter(m => m.type === 'surfaces');
      assert.equal(surfacesMsgs.length, 2);

      const workspaceIds = surfacesMsgs.map(m => (m as any).workspaceId).sort();
      assert.deepEqual(workspaceIds, ['ws1', 'ws2']);
    });

    it('sends panes for each workspace', async () => {
      store.updateWorkspaces([{ id: 'ws1', title: 'W1' }]);
      store.updatePanesForWorkspace('ws1', [
        {
          id: 'pane-1',
          index: 0,
          surfaceIds: ['s1'],
          selectedSurfaceId: 's1',
          columns: 80,
          rows: 24,
          frame: { x: 0, y: 0, width: 800, height: 600 },
          focused: true,
          workspaceId: 'ws1',
        },
      ], { x: 0, y: 0, width: 800, height: 600 });

      await sendMessage(JSON.stringify({ type: 'auth', payload: { token: 'any' } }));

      const panesMsgs = sentMessages.filter(m => m.type === 'panes');
      assert.equal(panesMsgs.length, 1);
      const panesMsg = panesMsgs[0] as any;
      assert.equal(panesMsg.workspaceId, 'ws1');
      assert.equal(panesMsg.payload.panes.length, 1);
    });

    it('does not send notifications when store has none', async () => {
      store.updateWorkspaces([{ id: 'ws1', title: 'W1' }]);
      store.updateNotifications([]);

      await sendMessage(JSON.stringify({ type: 'auth', payload: { token: 'any' } }));

      const notifMsgs = sentMessages.filter(m => m.type === 'notifications');
      assert.equal(notifMsgs.length, 0);
    });
  });

  // ─── workspaces.list ───

  describe('workspaces.list', () => {
    it('returns current workspaces', async () => {
      store.updateWorkspaces([
        { id: 'ws1', title: 'Alpha' },
        { id: 'ws2', title: 'Beta' },
      ]);

      await sendMessage(JSON.stringify({ type: 'workspaces.list' }));

      assert.equal(sentMessages.length, 1);
      const msg = sentMessages[0] as any;
      assert.equal(msg.type, 'workspaces');
      assert.equal(msg.payload.workspaces.length, 2);
      const titles = msg.payload.workspaces.map((w: any) => w.title).sort();
      assert.deepEqual(titles, ['Alpha', 'Beta']);
    });

    it('returns empty array when no workspaces', async () => {
      await sendMessage(JSON.stringify({ type: 'workspaces.list' }));

      assert.equal(sentMessages.length, 1);
      const msg = sentMessages[0] as any;
      assert.equal(msg.type, 'workspaces');
      assert.deepEqual(msg.payload.workspaces, []);
    });
  });

  // ─── surface.select ───

  describe('surface.select', () => {
    beforeEach(() => {
      store.updateWorkspaces([{ id: 'ws1', title: 'Workspace' }]);
      store.updateSurfaces('ws1', [
        { id: 's1', title: 'Terminal', type: 'terminal', workspaceId: 'ws1' },
        { id: 's2', title: 'Browser', type: 'browser', workspaceId: 'ws1' },
      ]);
    });

    it('sends surface.active and surfaces for existing surface', async () => {
      await sendMessage(JSON.stringify({ type: 'surface.select', surfaceId: 's1' }));

      const types = sentMessages.map(m => m.type);
      assert.ok(types.includes('surface.active'));
      assert.ok(types.includes('surfaces'));

      const activeMsg = sentMessages.find(m => m.type === 'surface.active') as any;
      assert.equal(activeMsg.surfaceId, 's1');
      assert.equal(activeMsg.workspaceId, 'ws1');

      const surfacesMsg = sentMessages.find(m => m.type === 'surfaces') as any;
      assert.equal(surfacesMsg.workspaceId, 'ws1');
      assert.equal(surfacesMsg.payload.surfaces.length, 2);
    });

    it('reads scrollback via cmux for terminal surface', async () => {
      const mock = createMockCmux();

      await sendMessage(
        JSON.stringify({ type: 'surface.select', surfaceId: 's1' }),
        createDeps(mock.client as CmuxClient),
      );

      // Should have sent output from readTerminalText
      const outputMsg = sentMessages.find(m => m.type === 'output') as any;
      assert.ok(outputMsg, 'should send output message for terminal surface');
      assert.equal(outputMsg.surfaceId, 's1');

      assert.equal(mock.calls.readTerminalText.length, 1);
      assert.equal(mock.calls.readTerminalText[0][0], 's1');
      assert.equal(mock.calls.readTerminalText[0][1], true); // scrollback = true
    });

    it('does not read scrollback for non-terminal surface', async () => {
      const mock = createMockCmux();

      await sendMessage(
        JSON.stringify({ type: 'surface.select', surfaceId: 's2' }),
        createDeps(mock.client as CmuxClient),
      );

      // s2 is 'browser' type, no scrollback
      assert.equal(mock.calls.readTerminalText.length, 0);

      // But should still send surface.active and surfaces
      const types = sentMessages.map(m => m.type);
      assert.ok(types.includes('surface.active'));
      assert.ok(types.includes('surfaces'));
    });

    it('does nothing for non-existent surface', async () => {
      await sendMessage(JSON.stringify({ type: 'surface.select', surfaceId: 'nonexistent' }));

      assert.equal(sentMessages.length, 0);
    });

    it('does not read scrollback when no cmux available', async () => {
      await sendMessage(JSON.stringify({ type: 'surface.select', surfaceId: 's1' }));

      // No cmux, so should still send active/surfaces but no output
      const types = sentMessages.map(m => m.type);
      assert.ok(types.includes('surface.active'));
      assert.ok(types.includes('surfaces'));
      assert.ok(!types.includes('output'));
    });
  });

  // ─── input ───

  describe('input', () => {
    it('forwards to InputHandler and sends output', async () => {
      const mock = createMockCmux();
      store.updateWorkspaces([{ id: 'ws1', title: 'W' }]);
      store.updateSurfaces('ws1', [
        { id: 's1', title: 'T', type: 'terminal', workspaceId: 'ws1' },
      ]);

      const inputB64 = Buffer.from('ls\n').toString('base64');
      await sendMessage(
        JSON.stringify({ type: 'input', surfaceId: 's1', payload: { data: inputB64 } }),
        createDeps(mock.client as CmuxClient),
      );

      assert.equal(inputHandler.inputs.length, 1);
      assert.equal(inputHandler.inputs[0].surfaceId, 's1');
      assert.equal(inputHandler.inputs[0].data, inputB64);

      // After input, reads terminal and sends output
      assert.equal(mock.calls.readTerminalText.length, 1);
      assert.equal(mock.calls.readTerminalText[0][0], 's1');

      const outputMsg = sentMessages.find(m => m.type === 'output') as any;
      assert.ok(outputMsg);
      assert.equal(outputMsg.surfaceId, 's1');
    });

    it('forwards input without output when no cmux', async () => {
      store.updateWorkspaces([{ id: 'ws1', title: 'W' }]);
      store.updateSurfaces('ws1', [
        { id: 's1', title: 'T', type: 'terminal', workspaceId: 'ws1' },
      ]);

      const inputB64 = Buffer.from('ls\n').toString('base64');
      await sendMessage(JSON.stringify({ type: 'input', surfaceId: 's1', payload: { data: inputB64 } }));

      assert.equal(inputHandler.inputs.length, 1);
      const outputMsgs = sentMessages.filter(m => m.type === 'output');
      assert.equal(outputMsgs.length, 0);
    });

    it('forwards input without output for non-terminal surface', async () => {
      const mock = createMockCmux();
      store.updateWorkspaces([{ id: 'ws1', title: 'W' }]);
      store.updateSurfaces('ws1', [
        { id: 's1', title: 'B', type: 'browser', workspaceId: 'ws1' },
      ]);

      const inputB64 = Buffer.from('text').toString('base64');
      await sendMessage(
        JSON.stringify({ type: 'input', surfaceId: 's1', payload: { data: inputB64 } }),
        createDeps(mock.client as CmuxClient),
      );

      assert.equal(inputHandler.inputs.length, 1);
      assert.equal(mock.calls.readTerminalText.length, 0);
    });
  });

  // ─── resize ───

  describe('resize', () => {
    it('forwards to InputHandler', async () => {
      await sendMessage(JSON.stringify({ type: 'resize', surfaceId: 's1', payload: { cols: 120, rows: 50 } }));

      assert.equal(inputHandler.resizes.length, 1);
      assert.equal(inputHandler.resizes[0].surfaceId, 's1');
      assert.equal(inputHandler.resizes[0].cols, 120);
      assert.equal(inputHandler.resizes[0].rows, 50);
    });

    it('does not send any response', async () => {
      await sendMessage(JSON.stringify({ type: 'resize', surfaceId: 's1', payload: { cols: 80, rows: 24 } }));
      assert.equal(sentMessages.length, 0);
    });
  });

  // ─── Invalid messages ───

  describe('invalid messages', () => {
    it('ignores invalid JSON', async () => {
      await sendMessage('not valid json{{{');
      assert.equal(sentMessages.length, 0);
    });

    it('ignores unknown message type', async () => {
      await sendMessage(JSON.stringify({ type: 'unknown.type' }));
      assert.equal(sentMessages.length, 0);
    });

    it('ignores empty string', async () => {
      await sendMessage('');
      assert.equal(sentMessages.length, 0);
    });
  });
});
