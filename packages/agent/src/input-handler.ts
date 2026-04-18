import type { CmuxClient } from './cmux-client.js';
import type { SessionStore } from './session-store.js';
import type { PaneInfo } from '@cmux-relay/shared';

export interface IInputHandler {
  handleInput(sessionId: string, data: string): Promise<void>;
  handleResize(surfaceId: string, cols: number, rows: number): Promise<void>;
  resizeForMobile(surfaceId: string, cols: number, rows: number): Promise<void>;
  restoreAllMobileSizes(): Promise<void>;
}

/**
 * Handles input from web clients and forwards to cmux.
 */
export class InputHandler implements IInputHandler {
  private cmux: CmuxClient;
  private store: SessionStore;
  private originalDimensions = new Map<string, { columns: number; rows: number }>();

  constructor(cmux: CmuxClient, store: SessionStore) {
    this.cmux = cmux;
    this.store = store;
  }

  async handleInput(sessionId: string, data: string): Promise<void> {
    try {
      const decoded = Buffer.from(data, 'base64').toString('utf-8');
      await this.cmux.sendText(sessionId, decoded);
    } catch (err) {
      console.error(`Failed to send input to ${sessionId}:`, err);
    }
  }

  async handleResize(surfaceId: string, cols: number, rows: number): Promise<void> {
    const pane = this.findPaneForSurface(surfaceId);
    if (!pane) {
      console.warn(`Resize: no pane found for surface ${surfaceId}`);
      return;
    }
    try {
      await this.cmux.resizePane(pane.id, cols, rows);
    } catch (err) {
      console.error(`Failed to resize pane ${pane.id}:`, err);
    }
  }

  async resizeForMobile(surfaceId: string, cols: number, rows: number): Promise<void> {
    const pane = this.findPaneForSurface(surfaceId);
    if (!pane) {
      console.warn(`Mobile resize: no pane found for surface ${surfaceId}`);
      return;
    }
    // Save original dimensions only once (first mobile resize)
    if (!this.originalDimensions.has(pane.id)) {
      this.originalDimensions.set(pane.id, { columns: pane.columns, rows: pane.rows });
      console.log(`Saved original dimensions for pane ${pane.id}: ${pane.columns}x${pane.rows}`);
    }
    try {
      await this.cmux.resizePane(pane.id, cols, rows);
      console.log(`Mobile resized pane ${pane.id} to ${cols}x${rows}`);
    } catch (err) {
      console.error(`Failed to mobile-resize pane ${pane.id}:`, err);
    }
  }

  async restoreAllMobileSizes(): Promise<void> {
    for (const [paneId, dims] of this.originalDimensions) {
      try {
        await this.cmux.resizePane(paneId, dims.columns, dims.rows);
        console.log(`Restored pane ${paneId} to ${dims.columns}x${dims.rows}`);
      } catch (err) {
        console.error(`Failed to restore pane ${paneId}:`, err);
      }
    }
    this.originalDimensions.clear();
  }

  private findPaneForSurface(surfaceId: string): PaneInfo | undefined {
    return this.store.getAllPanes().find(p => p.surfaceIds.includes(surfaceId));
  }
}
