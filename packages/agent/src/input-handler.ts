import type { CmuxClient } from './cmux-client.js';

export interface IInputHandler {
  handleInput(sessionId: string, data: string): Promise<void>;
  handleResize(sessionId: string, cols: number, rows: number): Promise<void>;
}

/**
 * Handles input from web clients and forwards to cmux.
 */
export class InputHandler implements IInputHandler {
  private cmux: CmuxClient;

  constructor(cmux: CmuxClient) {
    this.cmux = cmux;
  }

  async handleInput(sessionId: string, data: string): Promise<void> {
    try {
      const decoded = Buffer.from(data, 'base64').toString('utf-8');
      await this.cmux.sendText(sessionId, decoded);
    } catch (err) {
      console.error(`Failed to send input to ${sessionId}:`, err);
    }
  }

  async handleResize(sessionId: string, cols: number, rows: number): Promise<void> {
    console.log(`Resize request for ${sessionId}: ${cols}x${rows}`);
  }
}
