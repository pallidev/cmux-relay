import { SessionStore } from './session-store.js';
import type { IInputHandler } from './input-handler.js';
import type { CmuxClient } from './cmux-client.js';
import { readTerminalAndSend } from './terminal-reader.js';
import type { ClientOutgoing, RelayToClient } from '@cmux-relay/shared';
import { decodeMessage } from '@cmux-relay/shared';

export interface MessageHandlerDeps {
  store: SessionStore;
  inputHandler: IInputHandler;
  cmux?: CmuxClient;
}

export type SendFn = (msg: RelayToClient) => void;

export async function handleClientMessage(
  data: string,
  clientId: string,
  deps: MessageHandlerDeps,
  send: SendFn,
): Promise<void> {
  let msg: ClientOutgoing;
  try {
    msg = decodeMessage<ClientOutgoing>(data);
  } catch {
    return;
  }

  if (msg.type === 'auth') {
    // In cloud mode, auth is handled by the relay server
    // Send initial state (no notifications — those are real-time only)
    send({ type: 'workspaces', payload: { workspaces: deps.store.getAllWorkspaces() } });
    for (const w of deps.store.getAllWorkspaces()) {
      send({ type: 'surfaces', workspaceId: w.id, payload: { surfaces: deps.store.getSurfacesForWorkspace(w.id) } });
    }
    for (const w of deps.store.getAllWorkspaces()) {
      const wsPanes = deps.store.getPanesForWorkspace(w.id);
      const containerFrame = deps.store.getContainerFrameForWorkspace(w.id);
      send({ type: 'panes', workspaceId: w.id, payload: { panes: wsPanes, containerFrame } });
    }
    console.log(`[agent] Cloud client initialized`);
    return;
  }

  switch (msg.type) {
    case 'workspaces.list': {
      send({ type: 'workspaces', payload: { workspaces: deps.store.getAllWorkspaces() } });
      break;
    }

    case 'surface.select': {
      const surface = deps.store.getSurface(msg.surfaceId);
      if (surface) {
        deps.store.setActiveSurface(clientId, msg.surfaceId, surface.workspaceId);
        send({ type: 'surface.active', surfaceId: msg.surfaceId, workspaceId: surface.workspaceId });
        send({
          type: 'surfaces',
          workspaceId: surface.workspaceId,
          payload: { surfaces: deps.store.getSurfacesForWorkspace(surface.workspaceId) },
        });
        if (surface.type === 'terminal' && deps.cmux) {
          await readTerminalAndSend(deps.cmux, msg.surfaceId, send, { scrollback: false });
        }
      }
      break;
    }

    case 'input': {
      await deps.inputHandler.handleInput(msg.surfaceId, msg.payload.data);
      if (deps.cmux) {
        const surface = deps.store.getSurface(msg.surfaceId);
        if (surface?.type === 'terminal') {
          await readTerminalAndSend(deps.cmux, msg.surfaceId, send, { delay: 50 });
        }
      }
      break;
    }

    case 'resize': {
      deps.inputHandler.handleResize(msg.surfaceId, msg.payload.cols, msg.payload.rows);
      break;
    }
  }
}
