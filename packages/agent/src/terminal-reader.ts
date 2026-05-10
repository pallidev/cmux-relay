import type { CmuxClient } from './cmux-client.js';
import type { RelayToClient } from '@cmux-relay/shared';

/**
 * Read terminal text from cmux and encode it as base64.
 * Returns null if the text is empty or an error occurs.
 */
export async function readAndEncodeTerminal(
  cmux: CmuxClient,
  surfaceId: string,
  scrollback?: boolean,
): Promise<{ data: string } | null> {
  try {
    const text = await cmux.readTerminalText(surfaceId, scrollback);
    if (!text) return null;
    return { data: Buffer.from(text).toString('base64') };
  } catch {
    return null;
  }
}

/**
 * Read terminal text, encode as base64, and send as an output message.
 * Optionally waits before reading (useful for input-then-read patterns).
 */
export async function readTerminalAndSend(
  cmux: CmuxClient,
  surfaceId: string,
  send: (msg: RelayToClient) => void,
  opts?: { delay?: number; scrollback?: boolean },
): Promise<void> {
  if (opts?.delay) {
    await new Promise(r => setTimeout(r, opts.delay));
  }
  const encoded = await readAndEncodeTerminal(cmux, surfaceId, opts?.scrollback);
  if (encoded) {
    send({
      type: 'output',
      surfaceId,
      payload: { data: encoded.data },
    });
  }
}
