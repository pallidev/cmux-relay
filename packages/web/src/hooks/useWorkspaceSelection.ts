/**
 * Workspace auto-selection hook with localStorage persistence.
 *
 * Centralises the duplicated workspace selection + persistence logic from
 * Layout.tsx, MobileLayout.tsx, and RelaySessionLayout.tsx.
 */

import { useState, useEffect, useCallback } from 'react';
import type { WorkspaceInfo, PaneInfo, SurfaceInfo } from '@cmux-relay/shared';

const STORAGE_KEY = 'cmux-relay-last-workspace';

export interface UseWorkspaceSelectionOpts {
  workspaces: WorkspaceInfo[];
  panes: PaneInfo[];
  surfaces?: SurfaceInfo[];
  selectSurface: (id: string) => void;
}

export interface UseWorkspaceSelectionResult {
  selectedWorkspaceId: string | null;
  setSelectedWorkspaceId: (id: string | null) => void;
  handleSelectWorkspace: (id: string) => void;
}

/**
 * Select panes/surfaces for a given workspace.
 * Pure function extracted for testability.
 */
export function selectWorkspaceSurfaces(
  workspaceId: string,
  panes: PaneInfo[],
  surfaces: SurfaceInfo[],
  selectSurface: (id: string) => void,
): void {
  const wsPanes = panes.filter(p => p.workspaceId === workspaceId);
  if (wsPanes.length > 0) {
    for (const pane of wsPanes) {
      selectSurface(pane.selectedSurfaceId);
    }
  } else {
    const wsSurfaces = surfaces.filter(s => s.workspaceId === workspaceId);
    if (wsSurfaces.length > 0) {
      selectSurface(wsSurfaces[0].id);
    }
  }
}

/**
 * Determine the initial workspace ID:
 * 1. Try localStorage value
 * 2. Validate it still exists in the workspace list
 * 3. Fall back to null (auto-select will pick the first one)
 */
export function getInitialWorkspaceId(workspaces: WorkspaceInfo[]): string | null {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && workspaces.some(w => w.id === stored)) {
    return stored;
  }
  return null;
}

export function useWorkspaceSelection(opts: UseWorkspaceSelectionOpts): UseWorkspaceSelectionResult {
  const { workspaces, panes, surfaces = [], selectSurface } = opts;

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    () => getInitialWorkspaceId(workspaces),
  );

  // Auto-select first workspace when data arrives + select surfaces
  useEffect(() => {
    if (selectedWorkspaceId) {
      // Verify saved workspace still exists
      if (workspaces.length > 0 && !workspaces.some(w => w.id === selectedWorkspaceId)) {
        const firstWsId = workspaces[0].id;
        setSelectedWorkspaceId(firstWsId);
        return;
      }
      // Still select surfaces for the saved workspace
      if (panes.length > 0) {
        const wsPanes = panes.filter(p => p.workspaceId === selectedWorkspaceId);
        for (const pane of wsPanes) {
          selectSurface(pane.selectedSurfaceId);
        }
      }
      return;
    }
    if (workspaces.length === 0 || panes.length === 0) return;

    const firstWsId = workspaces[0].id;
    setSelectedWorkspaceId(firstWsId);

    // Select all surfaces for panes in this workspace
    const wsPanes = panes.filter(p => p.workspaceId === firstWsId);
    for (const pane of wsPanes) {
      selectSurface(pane.selectedSurfaceId);
    }
  }, [panes, workspaces, selectedWorkspaceId, selectSurface]);

  // Persist workspace selection
  useEffect(() => {
    if (selectedWorkspaceId) {
      localStorage.setItem(STORAGE_KEY, selectedWorkspaceId);
    }
  }, [selectedWorkspaceId]);

  const handleSelectWorkspace = useCallback((workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
    selectWorkspaceSurfaces(workspaceId, panes, surfaces, selectSurface);
  }, [panes, surfaces, selectSurface]);

  return {
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    handleSelectWorkspace,
  };
}
