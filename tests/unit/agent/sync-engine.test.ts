import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine } from '../../../packages/agent/src/sync-engine.js';
import type { Broadcaster } from '../../../packages/agent/src/sync-engine.js';
import type { CmuxClient, CmuxWorkspace, CmuxSurface } from '../../../packages/agent/src/cmux-client.js';
import { SessionStore } from '../../../packages/agent/src/session-store.js';
import type { RelayToClient } from '@cmux-relay/shared';

// ─── Helpers ───

function createMockCmux(options: {
  workspaces?: CmuxWorkspace[];
  surfaces?: Map<string, CmuxSurface[]>;
  notifications?: Array<{ id: string; title: string; subtitle: string; body: string; surfaceId: string; workspaceId: string; isRead: boolean }>;
  terminalText?: string;
  panesResult?: { panes: any[]; containerFrame: any };
}): CmuxClient {
  return {
    isConnected: () => true,
    listWorkspaces: async () => options.workspaces ?? [],
    listSurfaces: async (wsId?: string) => options.surfaces?.get(wsId ?? '') ?? [],
    listNotifications: async () => options.notifications ?? [],
    readTerminalText: async () => options.terminalText ?? '',
    listPanes: async () => options.panesResult ?? { panes: [], containerFrame: { x: 0, y: 0, width: 1, height: 1 } },
  } as unknown as CmuxClient;
}

function createRecorder(): { recorder: Broadcaster; messages: RelayToClient[]; surfaceMessages: Map<string, RelayToClient[]> } {
  const messages: RelayToClient[] = [];
  const surfaceMessages = new Map<string, RelayToClient[]>();
  const recorder: Broadcaster = {
    broadcast(msg: RelayToClient) {
      messages.push(msg);
    },
    sendToSurface(surfaceId: string, msg: RelayToClient) {
      let list = surfaceMessages.get(surfaceId);
      if (!list) {
        list = [];
        surfaceMessages.set(surfaceId, list);
      }
      list.push(msg);
    },
  };
  return { recorder, messages, surfaceMessages };
}

// ─── Tests ───

describe('SyncEngine', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  describe('syncAll', () => {
    it('calls cmux APIs and broadcasts workspaces + surfaces + panes', async () => {
      const cmux = createMockCmux({
        workspaces: [
          { id: 'ws1', title: 'My Workspace', index: 0 },
        ],
        surfaces: new Map([
          ['ws1', [
            { id: 's1', title: 'Terminal 1', type: 'terminal', workspace_id: 'ws1' },
          ]],
        ]),
        panesResult: {
          panes: [{
            id: 'pane-1', index: 0, surfaceIds: ['s1'], selectedSurfaceId: 's1',
            columns: 80, rows: 24, frame: { x: 0, y: 0, width: 800, height: 600 },
            focused: true, workspaceId: 'ws1',
          }],
          containerFrame: { x: 0, y: 0, width: 800, height: 600 },
        },
      });

      const { recorder, messages } = createRecorder();
      const engine = new SyncEngine(cmux, store, recorder);

      await engine.syncAll();

      // Store should have workspaces
      const ws = store.getAllWorkspaces();
      assert.equal(ws.length, 1);
      assert.equal(ws[0].id, 'ws1');

      // Store should have surfaces
      const surf = store.getSurface('s1');
      assert.ok(surf);
      assert.equal(surf.type, 'terminal');

      // Should broadcast surfaces, workspaces, panes
      const types = messages.map(m => m.type);
      assert.ok(types.includes('surfaces'), 'should broadcast surfaces');
      assert.ok(types.includes('workspaces'), 'should broadcast workspaces');
      assert.ok(types.includes('panes'), 'should broadcast panes');

      // Check workspaces broadcast
      const wsMsg = messages.find(m => m.type === 'workspaces');
      assert.ok(wsMsg);
      assert.deepEqual((wsMsg as any).payload.workspaces[0].id, 'ws1');

      // Check surfaces broadcast
      const surfMsg = messages.find(m => m.type === 'surfaces');
      assert.ok(surfMsg);
      assert.equal((surfMsg as any).workspaceId, 'ws1');
      assert.equal((surfMsg as any).payload.surfaces[0].id, 's1');
    });

    it('does nothing when cmux is not connected', async () => {
      const cmux = {
        isConnected: () => false,
        listWorkspaces: async () => { throw new Error('should not be called'); },
      } as unknown as CmuxClient;

      const { recorder, messages } = createRecorder();
      const engine = new SyncEngine(cmux, store, recorder);

      await engine.syncAll();
      assert.equal(messages.length, 0);
    });

    it('handles panes sync failure gracefully', async () => {
      const cmux = createMockCmux({
        workspaces: [{ id: 'ws1', title: 'WS', index: 0 }],
        surfaces: new Map([['ws1', []]]),
      });
      // Override listPanes to throw
      (cmux as any).listPanes = async () => { throw new Error('pane error'); };

      const { recorder, messages } = createRecorder();
      const engine = new SyncEngine(cmux, store, recorder);

      // Should not throw
      await engine.syncAll();

      // Still should have broadcasted workspaces
      const types = messages.map(m => m.type);
      assert.ok(types.includes('workspaces'));
    });
  });

  describe('pollNotifications', () => {
    it('stores notifications but does not broadcast on first poll', async () => {
      const cmux = createMockCmux({
        notifications: [
          { id: 'n1', title: 'Test', subtitle: '', body: '', surfaceId: '', workspaceId: '', isRead: false },
        ],
      });

      const { recorder, messages } = createRecorder();
      const engine = new SyncEngine(cmux, store, recorder);

      await engine.pollNotifications();

      // Store should have notifications
      assert.equal(store.getAllNotifications().length, 1);

      // No broadcast on first poll
      assert.equal(messages.length, 0);
    });

    it('broadcasts only new notifications on subsequent polls', async () => {
      let callCount = 0;
      const notifications = [
        { id: 'n1', title: 'First', subtitle: '', body: '', surfaceId: '', workspaceId: '', isRead: false },
        { id: 'n2', title: 'Second', subtitle: '', body: '', surfaceId: '', workspaceId: '', isRead: false },
      ];

      const cmux = {
        isConnected: () => true,
        listNotifications: async () => {
          callCount++;
          if (callCount === 1) return [notifications[0]];
          return notifications;
        },
      } as unknown as CmuxClient;

      const { recorder, messages } = createRecorder();
      const engine = new SyncEngine(cmux, store, recorder);

      // First poll — no broadcast
      await engine.pollNotifications();
      assert.equal(messages.length, 0);

      // Second poll — only n2 is new
      await engine.pollNotifications();
      assert.equal(messages.length, 1);
      assert.equal(messages[0].type, 'notifications');
      const notifMsg = messages[0] as { type: string; payload: { notifications: Array<{ id: string }> } };
      assert.equal(notifMsg.payload.notifications.length, 1);
      assert.equal(notifMsg.payload.notifications[0].id, 'n2');
    });

    it('does not re-broadcast already seen notification IDs', async () => {
      const notification = { id: 'n1', title: 'Same', subtitle: '', body: '', surfaceId: '', workspaceId: '', isRead: false };

      const cmux = createMockCmux({ notifications: [notification] });
      const { recorder, messages } = createRecorder();
      const engine = new SyncEngine(cmux, store, recorder);

      await engine.pollNotifications(); // first poll, no broadcast
      await engine.pollNotifications(); // same notification, already known, no new ones
      assert.equal(messages.length, 0);
    });

    it('does nothing when cmux is not connected', async () => {
      const cmux = {
        isConnected: () => false,
        listNotifications: async () => { throw new Error('should not be called'); },
      } as unknown as CmuxClient;

      const { recorder, messages } = createRecorder();
      const engine = new SyncEngine(cmux, store, recorder);

      await engine.pollNotifications();
      assert.equal(messages.length, 0);
    });
  });

  describe('pollTerminal', () => {
    it('sends output for active terminal surfaces via broadcaster.sendToSurface', async () => {
      const cmux = createMockCmux({ terminalText: 'hello world' });
      const { recorder, surfaceMessages } = createRecorder();
      const engine = new SyncEngine(cmux, store, recorder);

      // Add a terminal surface to the store
      store.updateSurfaces('ws1', [
        { id: 's1', title: 'Term', type: 'terminal', workspaceId: 'ws1' },
      ]);

      await engine.pollTerminal({
        getActiveSurfaceIds: () => new Set(['s1']),
        getPtySurfaceId: () => null,
      });

      const s1Messages = surfaceMessages.get('s1');
      assert.ok(s1Messages, 'should have messages for surface s1');
      assert.equal(s1Messages.length, 1);
      assert.equal(s1Messages[0].type, 'output');
    });

    it('skips surfaces handled by PTY capture', async () => {
      const cmux = createMockCmux({ terminalText: 'hello' });
      const { recorder, surfaceMessages } = createRecorder();
      const engine = new SyncEngine(cmux, store, recorder);

      store.updateSurfaces('ws1', [
        { id: 's1', title: 'Term', type: 'terminal', workspaceId: 'ws1' },
      ]);

      await engine.pollTerminal({
        getActiveSurfaceIds: () => new Set(['s1']),
        getPtySurfaceId: () => 's1', // s1 is PTY-captured
      });

      assert.equal(surfaceMessages.get('s1'), undefined);
    });

    it('deduplicates identical output', async () => {
      const cmux = createMockCmux({ terminalText: 'same content' });
      const { recorder, surfaceMessages } = createRecorder();
      const engine = new SyncEngine(cmux, store, recorder);

      store.updateSurfaces('ws1', [
        { id: 's1', title: 'Term', type: 'terminal', workspaceId: 'ws1' },
      ]);

      const options = {
        getActiveSurfaceIds: () => new Set(['s1']),
        getPtySurfaceId: () => null,
      };

      // First poll
      await engine.pollTerminal(options);
      // Second poll with same content — should be deduplicated
      await engine.pollTerminal(options);

      const s1Messages = surfaceMessages.get('s1');
      assert.ok(s1Messages);
      assert.equal(s1Messages.length, 1, 'should only send once for identical content');
    });

    it('does nothing when no active surfaces', async () => {
      const cmux = createMockCmux({ terminalText: 'hello' });
      const { recorder, surfaceMessages } = createRecorder();
      const engine = new SyncEngine(cmux, store, recorder);

      await engine.pollTerminal({
        getActiveSurfaceIds: () => new Set(),
        getPtySurfaceId: () => null,
      });

      assert.equal(surfaceMessages.size, 0);
    });

    it('skips non-terminal surfaces', async () => {
      const cmux = createMockCmux({ terminalText: 'hello' });
      const { recorder, surfaceMessages } = createRecorder();
      const engine = new SyncEngine(cmux, store, recorder);

      store.updateSurfaces('ws1', [
        { id: 's1', title: 'Browser', type: 'browser', workspaceId: 'ws1' },
      ]);

      await engine.pollTerminal({
        getActiveSurfaceIds: () => new Set(['s1']),
        getPtySurfaceId: () => null,
      });

      assert.equal(surfaceMessages.size, 0);
    });

    it('skips when hasClients returns false', async () => {
      const cmux = createMockCmux({ terminalText: 'hello' });
      const { recorder, surfaceMessages } = createRecorder();
      const engine = new SyncEngine(cmux, store, recorder, {
        hasClients: () => false,
      });

      store.updateSurfaces('ws1', [
        { id: 's1', title: 'Term', type: 'terminal', workspaceId: 'ws1' },
      ]);

      await engine.pollTerminal({
        getActiveSurfaceIds: () => new Set(['s1']),
        getPtySurfaceId: () => null,
      });

      assert.equal(surfaceMessages.size, 0);
    });
  });

  describe('stop', () => {
    it('clears all intervals', async () => {
      const cmux = createMockCmux({});
      const { recorder } = createRecorder();
      const engine = new SyncEngine(cmux, store, recorder);

      engine.startPeriodicSync(5000);
      engine.startPollNotifications(2000);
      engine.startPollTerminal(1000, {
        getActiveSurfaceIds: () => new Set(),
        getPtySurfaceId: () => null,
      });

      // stop should not throw
      engine.stop();

      // Calling stop again should also be safe
      engine.stop();
    });
  });

  describe('clearLastOutput', () => {
    it('allows previously sent output to be sent again', async () => {
      const cmux = createMockCmux({ terminalText: 'hello' });
      const { recorder, surfaceMessages } = createRecorder();
      const engine = new SyncEngine(cmux, store, recorder);

      store.updateSurfaces('ws1', [
        { id: 's1', title: 'Term', type: 'terminal', workspaceId: 'ws1' },
      ]);

      const options = {
        getActiveSurfaceIds: () => new Set(['s1']),
        getPtySurfaceId: () => null,
      };

      // First poll sends
      await engine.pollTerminal(options);
      // Second poll is deduplicated
      await engine.pollTerminal(options);
      assert.equal(surfaceMessages.get('s1')!.length, 1);

      // Clear dedup state
      engine.clearLastOutput();

      // Now same content should be sent again
      await engine.pollTerminal(options);
      assert.equal(surfaceMessages.get('s1')!.length, 2);
    });
  });
});
