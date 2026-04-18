/**
 * Agent end-to-end test: connects to REAL cmux socket and verifies data flow.
 * Requires cmux to be running.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CmuxClient } from '../packages/agent/src/cmux-client.js';
import { SessionStore } from '../packages/agent/src/session-store.js';
import { InputHandler } from '../packages/agent/src/input-handler.js';
import { handleClientMessage } from '../packages/agent/src/message-handler.js';
import type { RelayToClient } from '../packages/shared/src/protocol.js';

const CMUX_SOCKET = process.env.CMUX_SOCKET_PATH ||
  `${process.env.HOME}/Library/Application Support/cmux/cmux.sock`;

describe('Agent with real cmux socket', () => {
  let cmux: CmuxClient;
  let store: SessionStore;
  const sent: RelayToClient[] = [];
  const send = (msg: RelayToClient) => { sent.push(msg); };

  before(async () => {
    cmux = new CmuxClient(CMUX_SOCKET);
    await cmux.connect();
    console.log(`Connected to cmux at ${CMUX_SOCKET}`);

    store = new SessionStore();
  });

  after(() => {
    cmux?.disconnect();
  });

  it('lists workspaces', async () => {
    const workspaces = await cmux.listWorkspaces();
    console.log(`Workspaces: ${workspaces.map(w => w.title).join(', ')}`);
    assert.ok(workspaces.length > 0, 'Should have at least one workspace');
  });

  it('lists surfaces for first workspace', async () => {
    const workspaces = await cmux.listWorkspaces();
    const surfaces = await cmux.listSurfaces(workspaces[0].id);
    console.log(`Surfaces in "${workspaces[0].title}": ${surfaces.length}`);
    assert.ok(surfaces.length > 0, 'Should have at least one surface');
  });

  it('syncs workspace data to SessionStore', async () => {
    const workspaces = await cmux.listWorkspaces();
    store.updateWorkspaces(workspaces.map(w => ({ id: w.id, title: w.title })));

    for (const w of workspaces) {
      const surfaces = await cmux.listSurfaces(w.id);
      store.updateSurfaces(w.id, surfaces.map(s => ({
        id: s.id,
        title: s.title || '',
        type: s.type,
        workspaceId: w.id,
      })));
    }

    assert.ok(store.getAllWorkspaces().length > 0);
    const firstWs = store.getAllWorkspaces()[0];
    const wsSurfaces = store.getSurfacesForWorkspace(firstWs.id);
    assert.ok(wsSurfaces.length > 0, `Workspace "${firstWs.title}" should have surfaces`);
  });

  it('lists panes for first workspace', async () => {
    const workspaces = await cmux.listWorkspaces();
    const { panes, containerFrame } = await cmux.listPanes(workspaces[0].id);
    console.log(`Panes: ${panes.length}, container: ${containerFrame.width}x${containerFrame.height}`);
    assert.ok(panes.length > 0, 'Should have at least one pane');
    assert.ok(panes[0].surfaceIds.length > 0, 'Pane should have surface IDs');
  });

  it('reads terminal text from a terminal surface', async () => {
    const workspaces = await cmux.listWorkspaces();
    const surfaces = await cmux.listSurfaces(workspaces[0].id);
    const termSurface = surfaces.find(s => s.type === 'terminal');
    if (!termSurface) {
      console.log('No terminal surface found, skipping');
      return;
    }

    const text = await cmux.readTerminalText(termSurface.id);
    console.log(`Terminal text (${text.length} chars): ${text.slice(0, 80).replace(/\n/g, '\\n')}...`);
    assert.ok(text.length > 0, 'Should read some terminal content');
  });

  it('MessageHandler responds with workspaces on auth', async () => {
    sent.length = 0;
    await handleClientMessage(
      JSON.stringify({ type: 'auth', payload: { token: 'ignored-in-cloud-mode' } }),
      'test-client',
      { store, inputHandler: new InputHandler(cmux), cmux },
      send,
    );

    const wsMsg = sent.find(m => m.type === 'workspaces');
    assert.ok(wsMsg, 'Should send workspaces');
    assert.ok(wsMsg.payload!.workspaces.length > 0);
    console.log(`Auth sent ${sent.length} messages to client`);
  });

  it('MessageHandler handles surface.select with real terminal', async () => {
    sent.length = 0;
    const firstWs = store.getAllWorkspaces()[0];
    const wsSurfaces = store.getSurfacesForWorkspace(firstWs.id);
    const termSurface = wsSurfaces.find(s => s.type === 'terminal');
    if (!termSurface) {
      console.log('No terminal surface, skipping');
      return;
    }

    await handleClientMessage(
      JSON.stringify({ type: 'surface.select', surfaceId: termSurface.id }),
      'test-client',
      { store, inputHandler: new InputHandler(cmux), cmux },
      send,
    );

    const activeMsg = sent.find(m => m.type === 'surface.active');
    assert.ok(activeMsg, 'Should send surface.active');
    assert.equal(activeMsg.surfaceId, termSurface.id);

    const outputMsg = sent.find(m => m.type === 'output');
    if (outputMsg) {
      const decoded = Buffer.from(outputMsg.payload!.data, 'base64').toString('utf-8');
      console.log(`Scrollback output (${decoded.length} chars): ${decoded.slice(0, 60).replace(/\n/g, '\\n')}...`);
    }
    console.log(`surface.select sent ${sent.length} messages`);
  });

  it('InputHandler sends text to cmux', async () => {
    const workspaces = await cmux.listWorkspaces();
    const surfaces = await cmux.listSurfaces(workspaces[0].id);
    const termSurface = surfaces.find(s => s.type === 'terminal');
    if (!termSurface) return;

    const handler = new InputHandler(cmux);
    // Send a harmless echo command
    const input = Buffer.from('echo test-cmux-relay-agent\n').toString('base64');
    await handler.handleInput(termSurface.id, input);

    // Wait for cmux to process
    await new Promise(r => setTimeout(r, 300));

    const text = await cmux.readTerminalText(termSurface.id);
    assert.ok(text.includes('test-cmux-relay-agent'), `Terminal should contain "test-cmux-relay-agent", got: ${text.slice(-100)}`);
    console.log('Input forwarded and executed successfully');
  });
});
