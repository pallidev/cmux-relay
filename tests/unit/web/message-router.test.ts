/**
 * Tests for createMessageRouter — pure function message routing.
 *
 * Tests each message type handler:
 *   - workspaces -> setWorkspaces + phase update
 *   - surfaces -> merge by workspaceId
 *   - panes -> merge by workspaceId + containerFrame
 *   - surface.active -> setActiveSurfaceId + setActiveWorkspaceId
 *   - output -> plain and encrypted handling
 *   - notifications -> merge + callback
 *   - error -> console.error
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceInfo, SurfaceInfo, PaneInfo, FrameRect, CmuxNotification, EncryptedPayload } from '@cmux-relay/shared';

import { createMessageRouter } from '../../../packages/web/src/lib/message-router.ts';
import type { MessageRouterState } from '../../../packages/web/src/lib/message-router.ts';

function makeState(): MessageRouterState & {
  outputCalls: Array<{ surfaceId: string; data: string }>;
  notificationCalls: CmuxNotification[][];
  phaseUpdates: string[];
  connectionTimeoutCleared: boolean;
  reconnectAttemptReset: boolean;
} {
  return {
    workspaces: [] as WorkspaceInfo[],
    surfaces: [] as SurfaceInfo[],
    panes: [] as PaneInfo[],
    containerFrames: {} as Record<string, FrameRect>,
    activeSurfaceId: null as string | null,
    activeWorkspaceId: null as string | null,
    notifications: [] as CmuxNotification[],
    outputCalls: [] as Array<{ surfaceId: string; data: string }>,
    notificationCalls: [] as CmuxNotification[][],
    phaseUpdates: [] as string[],
    connectionTimeoutCleared: false,
    reconnectAttemptReset: false,
    setWorkspaces(this: any, ws: WorkspaceInfo[]) { this.workspaces = ws; },
    setSurfaces(this: any, updater: (prev: SurfaceInfo[]) => SurfaceInfo[]) { this.surfaces = updater(this.surfaces); },
    setPanes(this: any, updater: (prev: PaneInfo[]) => PaneInfo[]) { this.panes = updater(this.panes); },
    setContainerFrames(this: any, updater: (prev: Record<string, FrameRect>) => Record<string, FrameRect>) { this.containerFrames = updater(this.containerFrames); },
    setActiveSurfaceId(this: any, id: string | null) { this.activeSurfaceId = id; },
    setActiveWorkspaceId(this: any, id: string | null) { this.activeWorkspaceId = id; },
    setNotifications(this: any, updater: (prev: CmuxNotification[]) => CmuxNotification[]) { this.notifications = updater(this.notifications); },
    outputCallback(surfaceId: string, data: string) { this.outputCalls.push({ surfaceId, data }); },
    notificationCallback(notifs: CmuxNotification[]) { this.notificationCalls.push(notifs); },
    e2eRef: { current: null },
    activeSurfaceIdRef: { current: null },
    updatePhase(p: any) { this.phaseUpdates.push(p); },
    clearConnectionTimeout() { this.connectionTimeoutCleared = true; },
    resetReconnectAttempt() { this.reconnectAttemptReset = true; },
  };
}

describe('createMessageRouter', () => {
  it('handles workspaces message', () => {
    const ctx = makeState();
    const { routeMessage: router } = createMessageRouter(ctx);

    router({
      type: 'workspaces',
      payload: {
        workspaces: [
          { id: 'ws-1', title: 'Workspace 1' },
          { id: 'ws-2', title: 'Workspace 2' },
        ],
      },
    } as any);

    assert.equal(ctx.workspaces.length, 2);
    assert.equal((ctx.workspaces as WorkspaceInfo[])[0].id, 'ws-1');
    assert.equal((ctx.workspaces as WorkspaceInfo[])[1].title, 'Workspace 2');
    assert.deepEqual(ctx.phaseUpdates, ['connected']);
    assert.equal(ctx.connectionTimeoutCleared, true);
    assert.equal(ctx.reconnectAttemptReset, true);
  });

  it('handles surfaces message — merges by workspaceId', () => {
    const ctx = makeState();
    // Pre-populate with surfaces from ws-1 and ws-2
    ctx.surfaces = [
      { id: 's-1', title: 'Old Surface', type: 'terminal', workspaceId: 'ws-1' },
      { id: 's-3', title: 'Other WS', type: 'terminal', workspaceId: 'ws-2' },
    ];
    const { routeMessage: router } = createMessageRouter(ctx);

    // Replace ws-1 surfaces, keep ws-2
    router({
      type: 'surfaces',
      workspaceId: 'ws-1',
      payload: {
        surfaces: [
          { id: 's-1', title: 'Updated Surface', type: 'terminal', workspaceId: 'ws-1' },
          { id: 's-2', title: 'New Surface', type: 'terminal', workspaceId: 'ws-1' },
        ],
      },
    } as any);

    const surfaces = ctx.surfaces as SurfaceInfo[];
    assert.equal(surfaces.length, 3);
    // ws-2 surface preserved
    assert.ok(surfaces.find(s => s.id === 's-3'));
    // ws-1 old surface replaced
    assert.ok(surfaces.find(s => s.id === 's-1' && s.title === 'Updated Surface'));
    // New surface added
    assert.ok(surfaces.find(s => s.id === 's-2'));
  });

  it('handles panes message — merges by workspaceId with containerFrame', () => {
    const ctx = makeState();
    const { routeMessage: router } = createMessageRouter(ctx);

    const frame: FrameRect = { x: 0, y: 0, width: 800, height: 600 };

    router({
      type: 'panes',
      workspaceId: 'ws-1',
      payload: {
        panes: [
          {
            id: 'p-1', index: 0, surfaceIds: ['s-1'], selectedSurfaceId: 's-1',
            columns: 80, rows: 24, frame, focused: true,
          },
        ],
        containerFrame: frame,
      },
    } as any);

    const panes = ctx.panes as PaneInfo[];
    assert.equal(panes.length, 1);
    assert.equal(panes[0].workspaceId, 'ws-1');
    assert.deepEqual(ctx.containerFrames['ws-1'], frame);
  });

  it('handles panes message — replaces existing panes for workspaceId', () => {
    const ctx = makeState();
    ctx.panes = [
      { id: 'p-1', index: 0, surfaceIds: ['s-1'], selectedSurfaceId: 's-1', columns: 80, rows: 24, frame: { x: 0, y: 0, width: 400, height: 600 }, focused: true, workspaceId: 'ws-1' },
      { id: 'p-2', index: 0, surfaceIds: ['s-3'], selectedSurfaceId: 's-3', columns: 80, rows: 24, frame: { x: 0, y: 0, width: 800, height: 600 }, focused: true, workspaceId: 'ws-2' },
    ];
    const { routeMessage: router } = createMessageRouter(ctx);

    router({
      type: 'panes',
      workspaceId: 'ws-1',
      payload: {
        panes: [
          {
            id: 'p-1-new', index: 0, surfaceIds: ['s-1', 's-2'], selectedSurfaceId: 's-1',
            columns: 80, rows: 24, frame: { x: 0, y: 0, width: 400, height: 300 }, focused: true,
          },
        ],
        containerFrame: undefined as any,
      },
    } as any);

    const panes = ctx.panes as PaneInfo[];
    // ws-2 pane preserved, ws-1 pane replaced
    assert.equal(panes.length, 2);
    assert.ok(panes.find(p => p.id === 'p-2'));
    assert.ok(panes.find(p => p.id === 'p-1-new' && p.workspaceId === 'ws-1'));
  });

  it('handles surface.active message', () => {
    const ctx = makeState();
    const { routeMessage: router } = createMessageRouter(ctx);

    router({
      type: 'surface.active',
      surfaceId: 's-42',
      workspaceId: 'ws-1',
    } as any);

    assert.equal(ctx.activeSurfaceId, 's-42');
    assert.equal(ctx.activeSurfaceIdRef.current, 's-42');
    assert.equal(ctx.activeWorkspaceId, 'ws-1');
  });

  it('handles output message — unencrypted', () => {
    const ctx = makeState();
    const { routeMessage: router } = createMessageRouter(ctx);

    router({
      type: 'output',
      surfaceId: 's-1',
      payload: { data: 'SGVsbG8gV29ybGQ=' },
    } as any);

    assert.equal(ctx.outputCalls.length, 1);
    assert.equal(ctx.outputCalls[0].surfaceId, 's-1');
    assert.equal(ctx.outputCalls[0].data, 'SGVsbG8gV29ybGQ=');
  });

  it('handles output message — encrypted without E2E ready (no output)', () => {
    const ctx = makeState();
    const { routeMessage: router } = createMessageRouter(ctx);

    router({
      type: 'output',
      surfaceId: 's-1',
      payload: { encrypted: true, iv: 'abc', data: 'xyz' } as EncryptedPayload,
    } as any);

    // No E2E crypto available — should not call outputCallback
    assert.equal(ctx.outputCalls.length, 0);
  });

  it('handles output message — encrypted with E2E ready', async () => {
    const ctx = makeState();
    ctx.e2eRef.current = {
      isReady: () => true,
      decryptOutput: async (payload: EncryptedPayload) => 'decrypted-data',
    };
    const { routeMessage: router } = createMessageRouter(ctx);

    router({
      type: 'output',
      surfaceId: 's-1',
      payload: { encrypted: true, iv: 'abc', data: 'xyz' } as EncryptedPayload,
    } as any);

    // Wait for async decrypt
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(ctx.outputCalls.length, 1);
    assert.equal(ctx.outputCalls[0].surfaceId, 's-1');
    assert.equal(ctx.outputCalls[0].data, 'decrypted-data');
  });

  it('handles notifications message — dedupes by id', () => {
    const ctx = makeState();
    ctx.notifications = [
      { id: 'n-1', title: 'Old', subtitle: '', body: '', surfaceId: 's-1', workspaceId: 'ws-1', isRead: true },
    ];
    const { routeMessage: router } = createMessageRouter(ctx);

    router({
      type: 'notifications',
      payload: {
        notifications: [
          { id: 'n-1', title: 'Old Updated', subtitle: '', body: '', surfaceId: 's-1', workspaceId: 'ws-1', isRead: true },
          { id: 'n-2', title: 'New', subtitle: '', body: 'body', surfaceId: 's-2', workspaceId: 'ws-1', isRead: false },
        ],
      },
    } as any);

    const notifs = ctx.notifications as CmuxNotification[];
    // n-1 already exists so only n-2 is new — new ones prepended
    assert.equal(notifs.length, 2);
    assert.equal(notifs[0].id, 'n-2');
    assert.equal(notifs[1].id, 'n-1');

    // Callback receives ALL notifications (not filtered)
    assert.equal(ctx.notificationCalls.length, 1);
    assert.equal(ctx.notificationCalls[0].length, 2);
  });

  it('handles error message', () => {
    const ctx = makeState();
    const { routeMessage: router } = createMessageRouter(ctx);

    // Capture console.error calls
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: any[]) => errors.push(args.join(' '));

    try {
      router({
        type: 'error',
        payload: { message: 'Something went wrong' },
      } as any);
      assert.equal(errors.length, 1);
      assert.ok(errors[0].includes('Something went wrong'));
    } finally {
      console.error = origError;
    }
  });

  it('ignores unknown message types', () => {
    const ctx = makeState();
    const { routeMessage: router } = createMessageRouter(ctx);

    // Should not throw or call any state setters
    router({ type: 'unknown.message' } as any);
    assert.equal((ctx.workspaces as WorkspaceInfo[]).length, 0);
    assert.equal(ctx.outputCalls.length, 0);
    assert.equal(ctx.phaseUpdates.length, 0);
  });
});
