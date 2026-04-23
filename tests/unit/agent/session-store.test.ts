import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../../../packages/agent/src/session-store.js';
import { MockWebSocket } from '../../helpers/mock-ws.js';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  // ─── Workspaces ───

  describe('updateWorkspaces / getAllWorkspaces', () => {
    it('starts with no workspaces', () => {
      assert.deepEqual(store.getAllWorkspaces(), []);
    });

    it('adds workspaces', () => {
      store.updateWorkspaces([
        { id: 'ws1', title: 'Workspace 1' },
        { id: 'ws2', title: 'Workspace 2' },
      ]);
      const ws = store.getAllWorkspaces();
      assert.equal(ws.length, 2);
      const ids = ws.map(w => w.id).sort();
      assert.deepEqual(ids, ['ws1', 'ws2']);
    });

    it('replaces workspaces on subsequent call', () => {
      store.updateWorkspaces([{ id: 'ws1', title: 'Old' }]);
      store.updateWorkspaces([{ id: 'ws2', title: 'New' }]);
      const ws = store.getAllWorkspaces();
      assert.equal(ws.length, 1);
      assert.equal(ws[0].id, 'ws2');
    });

    it('clears workspaces with empty array', () => {
      store.updateWorkspaces([{ id: 'ws1', title: 'A' }]);
      store.updateWorkspaces([]);
      assert.deepEqual(store.getAllWorkspaces(), []);
    });
  });

  // ─── Surfaces ───

  describe('updateSurfaces / getSurfacesForWorkspace / getSurface', () => {
    it('starts with no surfaces', () => {
      assert.deepEqual(store.getSurfacesForWorkspace('ws1'), []);
      assert.equal(store.getSurface('s1'), undefined);
    });

    it('adds surfaces for a workspace', () => {
      store.updateSurfaces('ws1', [
        { id: 's1', title: 'Terminal 1', type: 'terminal', workspaceId: 'ws1' },
        { id: 's2', title: 'Browser 1', type: 'browser', workspaceId: 'ws1' },
      ]);
      const surfaces = store.getSurfacesForWorkspace('ws1');
      assert.equal(surfaces.length, 2);
    });

    it('filters surfaces by workspaceId', () => {
      store.updateSurfaces('ws1', [
        { id: 's1', title: 'T1', type: 'terminal', workspaceId: 'ws1' },
      ]);
      store.updateSurfaces('ws2', [
        { id: 's2', title: 'T2', type: 'terminal', workspaceId: 'ws2' },
      ]);
      assert.equal(store.getSurfacesForWorkspace('ws1').length, 1);
      assert.equal(store.getSurfacesForWorkspace('ws1')[0].id, 's1');
      assert.equal(store.getSurfacesForWorkspace('ws2').length, 1);
      assert.equal(store.getSurfacesForWorkspace('ws2')[0].id, 's2');
    });

    it('replaces surfaces for the same workspace on subsequent call', () => {
      store.updateSurfaces('ws1', [
        { id: 's1', title: 'Old', type: 'terminal', workspaceId: 'ws1' },
      ]);
      store.updateSurfaces('ws1', [
        { id: 's2', title: 'New', type: 'terminal', workspaceId: 'ws1' },
      ]);
      const surfaces = store.getSurfacesForWorkspace('ws1');
      assert.equal(surfaces.length, 1);
      assert.equal(surfaces[0].id, 's2');
    });

    it('does not affect surfaces from other workspaces when updating one', () => {
      store.updateSurfaces('ws1', [
        { id: 's1', title: 'T1', type: 'terminal', workspaceId: 'ws1' },
      ]);
      store.updateSurfaces('ws2', [
        { id: 's2', title: 'T2', type: 'terminal', workspaceId: 'ws2' },
      ]);
      // Updating ws1 should not remove ws2 surfaces
      store.updateSurfaces('ws1', [
        { id: 's3', title: 'T3', type: 'terminal', workspaceId: 'ws1' },
      ]);
      assert.equal(store.getSurfacesForWorkspace('ws2').length, 1);
      assert.equal(store.getSurface('s2')?.title, 'T2');
    });

    it('getSurface returns individual surface by id', () => {
      store.updateSurfaces('ws1', [
        { id: 's1', title: 'My Term', type: 'terminal', workspaceId: 'ws1' },
      ]);
      const surf = store.getSurface('s1');
      assert.ok(surf);
      assert.equal(surf.title, 'My Term');
      assert.equal(surf.type, 'terminal');
    });

    it('getSurface returns undefined for unknown id', () => {
      assert.equal(store.getSurface('nonexistent'), undefined);
    });

    describe('getAllSurfaces', () => {
      it('returns empty iterator when no surfaces', () => {
        const entries = [...store.getAllSurfaces()];
        assert.deepEqual(entries, []);
      });

      it('returns all surfaces across workspaces', () => {
        store.updateSurfaces('ws1', [
          { id: 's1', title: 'T1', type: 'terminal', workspaceId: 'ws1' },
          { id: 's2', title: 'T2', type: 'terminal', workspaceId: 'ws1' },
        ]);
        store.updateSurfaces('ws2', [
          { id: 's3', title: 'T3', type: 'terminal', workspaceId: 'ws2' },
        ]);
        const entries = [...store.getAllSurfaces()];
        assert.equal(entries.length, 3);
        const ids = entries.map(([id]) => id).sort();
        assert.deepEqual(ids, ['s1', 's2', 's3']);
      });

      it('returns updated surfaces after workspace update', () => {
        store.updateSurfaces('ws1', [
          { id: 's1', title: 'Old', type: 'terminal', workspaceId: 'ws1' },
        ]);
        store.updateSurfaces('ws1', [
          { id: 's1', title: 'Updated', type: 'terminal', workspaceId: 'ws1' },
          { id: 's2', title: 'New', type: 'terminal', workspaceId: 'ws1' },
        ]);
        const entries = [...store.getAllSurfaces()];
        assert.equal(entries.length, 2);
        const s1 = entries.find(([id]) => id === 's1');
        assert.ok(s1);
        assert.equal(s1[1].title, 'Updated');
      });

      it('returns entries as [id, SurfaceInfo] pairs', () => {
        store.updateSurfaces('ws1', [
          { id: 's1', title: 'MyTerm', type: 'terminal', workspaceId: 'ws1' },
        ]);
        const entries = [...store.getAllSurfaces()];
        assert.equal(entries[0][0], 's1');
        assert.equal(entries[0][1].id, 's1');
        assert.equal(entries[0][1].type, 'terminal');
      });
    });

    it('clears surfaces for a workspace with empty array', () => {
      store.updateSurfaces('ws1', [
        { id: 's1', title: 'T1', type: 'terminal', workspaceId: 'ws1' },
      ]);
      store.updateSurfaces('ws1', []);
      assert.deepEqual(store.getSurfacesForWorkspace('ws1'), []);
    });
  });

  // ─── Panes ───

  describe('updatePanesForWorkspace / getPanesForWorkspace / getAllPanes / getAllWorkspaceIdsWithPanes / getContainerFrameForWorkspace / getContainerFrame', () => {
    const frame = { x: 0, y: 0, width: 1920, height: 1080 };
    const panes = [
      {
        id: 'pane-1',
        index: 0,
        surfaceIds: ['s1', 's2'],
        selectedSurfaceId: 's1',
        columns: 120,
        rows: 40,
        frame: { x: 0, y: 0, width: 960, height: 1080 },
        focused: true,
        workspaceId: 'ws1',
      },
    ];

    it('starts with no panes', () => {
      assert.deepEqual(store.getPanesForWorkspace('ws1'), []);
      assert.deepEqual(store.getAllPanes(), []);
      assert.deepEqual(store.getAllWorkspaceIdsWithPanes(), []);
    });

    it('stores panes for a workspace', () => {
      store.updatePanesForWorkspace('ws1', panes, frame);
      assert.deepEqual(store.getPanesForWorkspace('ws1'), panes);
    });

    it('returns default container frame when no panes stored', () => {
      assert.deepEqual(store.getContainerFrameForWorkspace('ws1'), { x: 0, y: 0, width: 1, height: 1 });
    });

    it('stores and retrieves container frame', () => {
      store.updatePanesForWorkspace('ws1', panes, frame);
      assert.deepEqual(store.getContainerFrameForWorkspace('ws1'), frame);
    });

    it('getAllPanes returns panes from all workspaces', () => {
      const panes2 = [
        {
          id: 'pane-2',
          index: 0,
          surfaceIds: ['s3'],
          selectedSurfaceId: 's3',
          columns: 80,
          rows: 24,
          frame: { x: 0, y: 0, width: 640, height: 480 },
          focused: false,
          workspaceId: 'ws2',
        },
      ];
      store.updatePanesForWorkspace('ws1', panes, frame);
      store.updatePanesForWorkspace('ws2', panes2, { x: 0, y: 0, width: 640, height: 480 });

      const all = store.getAllPanes();
      assert.equal(all.length, 2);
    });

    it('getAllWorkspaceIdsWithPanes returns workspace ids that have panes', () => {
      store.updatePanesForWorkspace('ws1', panes, frame);
      store.updatePanesForWorkspace('ws2', [], frame);

      const ids = store.getAllWorkspaceIdsWithPanes();
      assert.deepEqual(ids, ['ws1', 'ws2']);
    });

    it('getContainerFrame returns first available frame', () => {
      const frame2 = { x: 10, y: 10, width: 800, height: 600 };
      store.updatePanesForWorkspace('ws1', panes, frame);
      store.updatePanesForWorkspace('ws2', [], frame2);

      // Map iteration order, but should return one of the frames
      const result = store.getContainerFrame();
      assert.ok(result === frame || result === frame2);
    });

    it('getContainerFrame returns default when no frames stored', () => {
      assert.deepEqual(store.getContainerFrame(), { x: 0, y: 0, width: 1, height: 1 });
    });

    it('replaces panes for a workspace on subsequent call', () => {
      const newPanes = [
        {
          id: 'pane-new',
          index: 0,
          surfaceIds: ['s4'],
          selectedSurfaceId: 's4',
          columns: 200,
          rows: 60,
          frame: { x: 0, y: 0, width: 1920, height: 1080 },
          focused: true,
          workspaceId: 'ws1',
        },
      ];
      store.updatePanesForWorkspace('ws1', panes, frame);
      store.updatePanesForWorkspace('ws1', newPanes, frame);
      assert.deepEqual(store.getPanesForWorkspace('ws1'), newPanes);
    });
  });

  // ─── Clients ───

  describe('registerClient / unregisterClient / disconnectAllClients / authenticateClient / isClientAuthenticated', () => {
    it('starts with no clients', () => {
      assert.equal(store.isClientAuthenticated('c1'), false);
    });

    it('registers a client', () => {
      const ws = new MockWebSocket();
      store.registerClient('c1', ws as any);
      assert.equal(store.isClientAuthenticated('c1'), false);
    });

    it('authenticates a client', () => {
      const ws = new MockWebSocket();
      store.registerClient('c1', ws as any);
      store.authenticateClient('c1');
      assert.equal(store.isClientAuthenticated('c1'), true);
    });

    it('returns false for non-existent client authentication', () => {
      assert.equal(store.isClientAuthenticated('unknown'), false);
    });

    it('unregisters a client', () => {
      const ws = new MockWebSocket();
      store.registerClient('c1', ws as any);
      store.unregisterClient('c1');
      assert.equal(store.isClientAuthenticated('c1'), false);
      assert.equal(store.getActiveSurface('c1'), null);
    });

    it('disconnectAllClients closes all WebSocket connections and removes them', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      store.registerClient('c1', ws1 as any);
      store.registerClient('c2', ws2 as any);
      store.authenticateClient('c1');
      store.authenticateClient('c2');

      store.disconnectAllClients();

      assert.equal(ws1.readyState, 3);
      assert.equal(ws2.readyState, 3);
      assert.equal(store.isClientAuthenticated('c1'), false);
      assert.equal(store.isClientAuthenticated('c2'), false);
    });

    it('authenticateClient is a no-op for non-existent client', () => {
      store.authenticateClient('ghost');
      assert.equal(store.isClientAuthenticated('ghost'), false);
    });
  });

  // ─── Active Surface ───

  describe('setActiveSurface / getActiveSurface / getActiveSurfaceIds', () => {
    it('returns null for client with no active surface', () => {
      const ws = new MockWebSocket();
      store.registerClient('c1', ws as any);
      assert.equal(store.getActiveSurface('c1'), null);
    });

    it('sets and gets active surface', () => {
      const ws = new MockWebSocket();
      store.registerClient('c1', ws as any);
      store.setActiveSurface('c1', 'surf-1', 'ws1');
      assert.equal(store.getActiveSurface('c1'), 'surf-1');
    });

    it('getActiveSurfaceIds returns Set of all active surface ids', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      store.registerClient('c1', ws1 as any);
      store.registerClient('c2', ws2 as any);
      store.setActiveSurface('c1', 'surf-A', 'ws1');
      store.setActiveSurface('c2', 'surf-B', 'ws1');

      const ids = store.getActiveSurfaceIds();
      assert.deepEqual(ids, new Set(['surf-A', 'surf-B']));
    });

    it('getActiveSurfaceIds excludes clients with no active surface', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      store.registerClient('c1', ws1 as any);
      store.registerClient('c2', ws2 as any);
      store.setActiveSurface('c1', 'surf-A', 'ws1');
      // c2 has no active surface

      const ids = store.getActiveSurfaceIds();
      assert.deepEqual(ids, new Set(['surf-A']));
    });

    it('setActiveSurface is a no-op for non-existent client', () => {
      store.setActiveSurface('ghost', 'surf-1', 'ws1');
      assert.equal(store.getActiveSurface('ghost'), null);
    });

    it('getActiveSurface returns null for non-existent client', () => {
      assert.equal(store.getActiveSurface('ghost'), null);
    });
  });

  // ─── Notifications ───

  describe('updateNotifications / getAllNotifications', () => {
    it('starts with no notifications', () => {
      assert.deepEqual(store.getAllNotifications(), []);
    });

    it('stores notifications', () => {
      const notifs = [
        {
          id: 'n1',
          title: 'Test',
          subtitle: 'Sub',
          body: 'Body text',
          surfaceId: 's1',
          workspaceId: 'ws1',
          isRead: false,
        },
      ];
      store.updateNotifications(notifs);
      assert.deepEqual(store.getAllNotifications(), notifs);
    });

    it('replaces notifications on subsequent call', () => {
      store.updateNotifications([
        { id: 'n1', title: 'Old', subtitle: '', body: '', surfaceId: '', workspaceId: '', isRead: false },
      ]);
      store.updateNotifications([
        { id: 'n2', title: 'New', subtitle: '', body: '', surfaceId: '', workspaceId: '', isRead: false },
      ]);
      const notifs = store.getAllNotifications();
      assert.equal(notifs.length, 1);
      assert.equal(notifs[0].id, 'n2');
    });

    it('clears notifications with empty array', () => {
      store.updateNotifications([
        { id: 'n1', title: 'X', subtitle: '', body: '', surfaceId: '', workspaceId: '', isRead: false },
      ]);
      store.updateNotifications([]);
      assert.deepEqual(store.getAllNotifications(), []);
    });
  });

  // ─── Broadcast ───

  describe('broadcastToClients', () => {
    it('sends message to all authenticated clients with readyState OPEN', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      store.registerClient('c1', ws1 as any);
      store.registerClient('c2', ws2 as any);
      store.authenticateClient('c1');
      store.authenticateClient('c2');

      store.broadcastToClients({ type: 'workspaces', payload: { workspaces: [] } });

      const msgs1 = ws1.getSentJSON();
      const msgs2 = ws2.getSentJSON();
      assert.equal(msgs1.length, 1);
      assert.equal(msgs2.length, 1);
      assert.equal(msgs1[0].type, 'workspaces');
      assert.equal(msgs2[0].type, 'workspaces');
    });

    it('skips unauthenticated clients', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      store.registerClient('c1', ws1 as any);
      store.registerClient('c2', ws2 as any);
      store.authenticateClient('c1');
      // c2 is NOT authenticated

      store.broadcastToClients({ type: 'workspaces', payload: { workspaces: [] } });

      assert.equal(ws1.getSentJSON().length, 1);
      assert.equal(ws2.getSentJSON().length, 0);
    });

    it('skips clients with readyState !== OPEN', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      store.registerClient('c1', ws1 as any);
      store.registerClient('c2', ws2 as any);
      store.authenticateClient('c1');
      store.authenticateClient('c2');

      ws2.readyState = 3; // CLOSED

      store.broadcastToClients({ type: 'workspaces', payload: { workspaces: [] } });

      assert.equal(ws1.getSentJSON().length, 1);
      assert.equal(ws2.getSentJSON().length, 0);
    });

    it('sends JSON-stringified message', () => {
      const ws = new MockWebSocket();
      store.registerClient('c1', ws as any);
      store.authenticateClient('c1');

      const msg = { type: 'output', surfaceId: 's1', payload: { data: 'abc' } };
      store.broadcastToClients(msg);

      assert.equal(ws.sentMessages.length, 1);
      assert.equal(ws.sentMessages[0], JSON.stringify(msg));
    });
  });

  // ─── Send to clients with surface ───

  describe('sendToClientsWithSurface', () => {
    it('sends only to clients watching the specified surface', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      store.registerClient('c1', ws1 as any);
      store.registerClient('c2', ws2 as any);
      store.authenticateClient('c1');
      store.authenticateClient('c2');
      store.setActiveSurface('c1', 'surf-A', 'ws1');
      store.setActiveSurface('c2', 'surf-B', 'ws1');

      const msg = { type: 'output', surfaceId: 'surf-A', payload: { data: 'hello' } };
      store.sendToClientsWithSurface('surf-A', msg);

      assert.equal(ws1.getSentJSON().length, 1);
      assert.equal(ws2.getSentJSON().length, 0);
    });

    it('sends to multiple clients watching the same surface', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      store.registerClient('c1', ws1 as any);
      store.registerClient('c2', ws2 as any);
      store.authenticateClient('c1');
      store.authenticateClient('c2');
      store.setActiveSurface('c1', 'surf-A', 'ws1');
      store.setActiveSurface('c2', 'surf-A', 'ws1');

      const msg = { type: 'output', surfaceId: 'surf-A', payload: { data: 'hello' } };
      store.sendToClientsWithSurface('surf-A', msg);

      assert.equal(ws1.getSentJSON().length, 1);
      assert.equal(ws2.getSentJSON().length, 1);
    });

    it('skips unauthenticated clients even with matching surface', () => {
      const ws = new MockWebSocket();
      store.registerClient('c1', ws as any);
      // NOT authenticated
      store.setActiveSurface('c1', 'surf-A', 'ws1');

      store.sendToClientsWithSurface('surf-A', { type: 'output', surfaceId: 'surf-A', payload: { data: 'x' } });
      assert.equal(ws.getSentJSON().length, 0);
    });

    it('skips clients with closed WebSocket even with matching surface', () => {
      const ws = new MockWebSocket();
      store.registerClient('c1', ws as any);
      store.authenticateClient('c1');
      store.setActiveSurface('c1', 'surf-A', 'ws1');
      ws.readyState = 3;

      store.sendToClientsWithSurface('surf-A', { type: 'output', surfaceId: 'surf-A', payload: { data: 'x' } });
      assert.equal(ws.getSentJSON().length, 0);
    });

    it('does not send to clients watching a different surface', () => {
      const ws = new MockWebSocket();
      store.registerClient('c1', ws as any);
      store.authenticateClient('c1');
      store.setActiveSurface('c1', 'surf-A', 'ws1');

      store.sendToClientsWithSurface('surf-B', { type: 'output', surfaceId: 'surf-B', payload: { data: 'x' } });
      assert.equal(ws.getSentJSON().length, 0);
    });
  });
});
