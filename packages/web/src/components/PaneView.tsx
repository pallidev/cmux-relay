import { useState } from 'react';
import type { PaneInfo } from '@cmux-relay/shared';
import { Terminal } from './Terminal';

interface PaneBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PaneViewProps {
  pane: PaneInfo;
  bounds: PaneBounds | null;
  surfaces: { id: string; title: string; type: string }[];
  selectSurface: (id: string) => void;
  sendInput: (surfaceId: string, data: string) => void;
  sendResize: (surfaceId: string, cols: number, rows: number) => void;
}

export function PaneView({
  pane,
  bounds,
  surfaces,
  selectSurface,
  sendInput,
  sendResize,
}: PaneViewProps) {
  const [localSurfaceId, setLocalSurfaceId] = useState(pane.selectedSurfaceId);

  const handleTabClick = (surfaceId: string) => {
    setLocalSurfaceId(surfaceId);
    selectSurface(surfaceId);
  };

  const paneSurfaces = pane.surfaceIds
    .map(id => surfaces.find(s => s.id === id))
    .filter(Boolean) as { id: string; title: string; type: string }[];

  // Convert pixel frame to percentage using actual pane bounding box
  const b = bounds || { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const contentW = b.maxX - b.minX;
  const contentH = b.maxY - b.minY;
  const left = ((pane.frame.x - b.minX) / contentW) * 100;
  const top = ((pane.frame.y - b.minY) / contentH) * 100;
  const width = (pane.frame.width / contentW) * 100;
  const height = (pane.frame.height / contentH) * 100;

  return (
    <div
      className={`pane ${pane.focused ? 'focused' : ''}`}
      style={{
        position: 'absolute',
        left: `${left}%`,
        top: `${top}%`,
        width: `${width}%`,
        height: `${height}%`,
      }}
    >
      <div className="pane-tabs">
        {paneSurfaces.map((s) => (
          <button
            key={s.id}
            className={`pane-tab ${s.id === localSurfaceId ? 'active' : ''}`}
            onClick={() => handleTabClick(s.id)}
          >
            {s.title || s.id.slice(0, 8)}
          </button>
        ))}
      </div>
      <div className="pane-terminal">
        <Terminal
          surfaceId={localSurfaceId}
          cols={pane.columns}
          rows={pane.rows}
          onInput={(data) => sendInput(localSurfaceId, data)}
          onResize={(cols, rows) => sendResize(localSurfaceId, cols, rows)}
        />
      </div>
    </div>
  );
}

/** Grid layout for non-active workspaces (surfaces shown side by side) */
interface SurfaceListViewProps {
  surfaces: { id: string; title: string; type: string }[];
  selectSurface: (id: string) => void;
  sendInput: (surfaceId: string, data: string) => void;
  sendResize: (surfaceId: string, cols: number, rows: number) => void;
}

export function SurfaceListView({
  surfaces,
  selectSurface,
  sendInput,
  sendResize,
}: SurfaceListViewProps) {
  return (
    <div className="surface-grid">
      {surfaces.map((s) => (
        <SurfaceCard
          key={s.id}
          surface={s}
          selectSurface={selectSurface}
          sendInput={sendInput}
          sendResize={sendResize}
        />
      ))}
    </div>
  );
}

interface SurfaceCardProps {
  surface: { id: string; title: string; type: string };
  selectSurface: (id: string) => void;
  sendInput: (surfaceId: string, data: string) => void;
  sendResize: (surfaceId: string, cols: number, rows: number) => void;
}

function SurfaceCard({
  surface,
  selectSurface,
  sendInput,
  sendResize,
}: SurfaceCardProps) {
  const [isFocused, setIsFocused] = useState(false);

  const handleFocus = () => {
    setIsFocused(true);
    selectSurface(surface.id);
  };

  return (
    <div className={`pane ${isFocused ? 'focused' : ''}`}
      onFocus={handleFocus}
      onClick={handleFocus}
    >
      <div className="pane-tabs">
        <button className="pane-tab active">
          {surface.title || surface.id.slice(0, 8)}
        </button>
      </div>
      <div className="pane-terminal">
        <Terminal
          surfaceId={surface.id}
          onInput={(data) => sendInput(surface.id, data)}
          onResize={(cols, rows) => sendResize(surface.id, cols, rows)}
        />
      </div>
    </div>
  );
}
