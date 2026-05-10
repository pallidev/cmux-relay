/**
 * Tests for useWorkspaceSelection — pure helper functions.
 *
 * Tests the extracted pure logic:
 *   - getInitialWorkspaceId: localStorage-backed initial ID with validation
 *   - selectWorkspaceSurfaces: pane/surface selection for a workspace
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceInfo, PaneInfo, SurfaceInfo } from '@cmux-relay/shared';

// Import pure functions for testing
import {
  getInitialWorkspaceId,
  selectWorkspaceSurfaces,
} from '../../../packages/web/src/hooks/useWorkspaceSelection.ts';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

// @ts-expect-error - mock global
globalThis.localStorage = localStorageMock;

describe('useWorkspaceSelection — pure helpers', () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  describe('getInitialWorkspaceId', () => {
    it('returns stored workspace ID if it exists in the workspace list', () => {
      localStorageMock.setItem('cmux-relay-last-workspace', 'ws-1');
      const workspaces: WorkspaceInfo[] = [
        { id: 'ws-1', title: 'Workspace 1' },
        { id: 'ws-2', title: 'Workspace 2' },
      ];
      const result = getInitialWorkspaceId(workspaces);
      assert.equal(result, 'ws-1');
    });

    it('returns null if stored workspace ID does not exist in the workspace list', () => {
      localStorageMock.setItem('cmux-relay-last-workspace', 'ws-deleted');
      const workspaces: WorkspaceInfo[] = [
        { id: 'ws-1', title: 'Workspace 1' },
      ];
      const result = getInitialWorkspaceId(workspaces);
      assert.equal(result, null);
    });

    it('returns null if nothing is stored in localStorage', () => {
      const workspaces: WorkspaceInfo[] = [
        { id: 'ws-1', title: 'Workspace 1' },
      ];
      const result = getInitialWorkspaceId(workspaces);
      assert.equal(result, null);
    });

    it('returns null if workspace list is empty', () => {
      localStorageMock.setItem('cmux-relay-last-workspace', 'ws-1');
      const result = getInitialWorkspaceId([]);
      assert.equal(result, null);
    });
  });

  describe('selectWorkspaceSurfaces', () => {
    it('calls selectSurface for each pane\'s selectedSurfaceId', () => {
      const selected: string[] = [];
      const selectSurface = (id: string) => { selected.push(id); };

      const panes: PaneInfo[] = [
        {
          id: 'pane-1',
          index: 0,
          surfaceIds: ['s-1', 's-2'],
          selectedSurfaceId: 's-1',
          columns: 80,
          rows: 24,
          frame: { x: 0, y: 0, width: 400, height: 300 },
          focused: true,
          workspaceId: 'ws-1',
        },
        {
          id: 'pane-2',
          index: 1,
          surfaceIds: ['s-3'],
          selectedSurfaceId: 's-3',
          columns: 80,
          rows: 24,
          frame: { x: 400, y: 0, width: 400, height: 300 },
          focused: false,
          workspaceId: 'ws-1',
        },
      ];

      selectWorkspaceSurfaces('ws-1', panes, [], selectSurface);

      assert.deepEqual(selected, ['s-1', 's-3']);
    });

    it('ignores panes from other workspaces', () => {
      const selected: string[] = [];
      const selectSurface = (id: string) => { selected.push(id); };

      const panes: PaneInfo[] = [
        {
          id: 'pane-1',
          index: 0,
          surfaceIds: ['s-1'],
          selectedSurfaceId: 's-1',
          columns: 80,
          rows: 24,
          frame: { x: 0, y: 0, width: 800, height: 600 },
          focused: true,
          workspaceId: 'ws-1',
        },
        {
          id: 'pane-2',
          index: 0,
          surfaceIds: ['s-2'],
          selectedSurfaceId: 's-2',
          columns: 80,
          rows: 24,
          frame: { x: 0, y: 0, width: 800, height: 600 },
          focused: false,
          workspaceId: 'ws-2',
        },
      ];

      selectWorkspaceSurfaces('ws-1', panes, [], selectSurface);

      assert.deepEqual(selected, ['s-1']);
    });

    it('falls back to first surface when no panes exist for workspace', () => {
      const selected: string[] = [];
      const selectSurface = (id: string) => { selected.push(id); };

      const surfaces: SurfaceInfo[] = [
        { id: 's-1', title: 'Terminal 1', type: 'terminal', workspaceId: 'ws-1' },
        { id: 's-2', title: 'Terminal 2', type: 'terminal', workspaceId: 'ws-1' },
      ];

      selectWorkspaceSurfaces('ws-1', [], surfaces, selectSurface);

      assert.deepEqual(selected, ['s-1']);
    });

    it('does nothing when no panes or surfaces exist for workspace', () => {
      const selected: string[] = [];
      const selectSurface = (id: string) => { selected.push(id); };

      selectWorkspaceSurfaces('ws-1', [], [], selectSurface);

      assert.equal(selected.length, 0);
    });
  });
});
