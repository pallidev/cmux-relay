import type { WorkspaceInfo } from '@cmux-relay/shared';

interface SidebarProps {
  workspaces: WorkspaceInfo[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  emptyMessage?: string;
  emptyHint?: string;
}

export function Sidebar({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  emptyMessage = 'No workspaces',
  emptyHint = 'Start cmux to see your workspaces',
}: SidebarProps) {
  return (
    <aside className="sidebar">
      {workspaces.length === 0 ? (
        <div className="sidebar-empty">
          <p>{emptyMessage}</p>
          <p className="hint">{emptyHint}</p>
        </div>
      ) : (
        workspaces.map((w) => {
          const isActive = selectedWorkspaceId === w.id;
          return (
            <div key={w.id} className="workspace-group">
              <button
                className={`workspace-label ${isActive ? 'active' : ''}`}
                onClick={() => onSelectWorkspace(w.id)}
              >
                <span className="workspace-title">{w.title}</span>
              </button>
            </div>
          );
        })
      )}
    </aside>
  );
}
