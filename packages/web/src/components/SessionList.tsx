import type { WorkspaceInfo, SurfaceInfo } from '@cmux-relay/shared';

interface SessionListProps {
  workspaces: WorkspaceInfo[];
  surfaces: SurfaceInfo[];
  activeSurfaceId: string | null;
  activeWorkspaceId: string | null;
  expandedWorkspace: string | null;
  onToggleWorkspace: (id: string) => void;
  onSelectSurface: (id: string) => void;
}

export function SessionList({
  workspaces,
  surfaces,
  activeSurfaceId,
  activeWorkspaceId,
  expandedWorkspace,
  onToggleWorkspace,
  onSelectSurface,
}: SessionListProps) {
  if (workspaces.length === 0) {
    return (
      <div className="session-list-empty">
        <p>No workspaces</p>
        <p className="hint">Start cmux to see your workspaces</p>
      </div>
    );
  }

  return (
    <div className="session-list">
      {workspaces.map((w) => {
        const isExpanded = expandedWorkspace === w.id;
        const isActive = activeWorkspaceId === w.id;
        const wsSurfaces = surfaces.filter(s => s.workspaceId === w.id);

        return (
          <div key={w.id} className="workspace-group">
            <button
              className={`workspace-item ${isActive ? 'active' : ''}`}
              onClick={() => onToggleWorkspace(w.id)}
            >
              <span className="workspace-arrow">{isExpanded ? '▾' : '▸'}</span>
              <span className="workspace-title">{w.title}</span>
              {wsSurfaces.length > 0 && (
                <span className="workspace-count">{wsSurfaces.length}</span>
              )}
            </button>
            {isExpanded && wsSurfaces.map((s) => (
              <button
                key={s.id}
                className={`surface-item ${s.id === activeSurfaceId ? 'active' : ''}`}
                onClick={() => onSelectSurface(s.id)}
              >
                <span className="surface-type">{s.type === 'terminal' ? '⌨' : '🌐'}</span>
                <span className="surface-title">{s.title || s.id.slice(0, 8)}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
