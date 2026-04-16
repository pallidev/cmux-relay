import { WebSocket } from 'ws';
import { generateClientToken } from '../packages/server/src/auth.js';

const WS_URL = 'ws://localhost:8080';

const token = generateClientToken();
console.log('Token:', token);

const ws = new WebSocket(WS_URL);
const messages = [];

ws.on('open', () => {
  console.log('Connected, sending auth...');
  ws.send(JSON.stringify({ type: 'auth', payload: { token } }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  messages.push(msg);
  console.log(`\n[${msg.type}]`, JSON.stringify(msg).slice(0, 500));

  if (msg.type === 'workspaces') {
    // Request workspaces list explicitly
    ws.send(JSON.stringify({ type: 'workspaces.list' }));
  }

  if (msg.type === 'output') {
    const bytes = Buffer.from(msg.payload.data, 'base64');
    const text = bytes.toString('utf-8');
    console.log(`  Output for ${msg.surfaceId} (${text.length} chars):\n${text.slice(0, 200)}`);
  }
});

ws.on('error', (e) => console.error('WS error:', e.message));
ws.on('close', () => console.log('WS closed'));

// Collect for 5 seconds then dump
setTimeout(() => {
  console.log('\n\n=== SUMMARY ===');
  console.log('Total messages:', messages.length);
  const types = messages.map(m => m.type);
  console.log('Types:', [...new Set(types)]);

  const workspaces = messages.find(m => m.type === 'workspaces');
  if (workspaces) {
    console.log('\nWorkspaces:', JSON.stringify(workspaces.payload.workspaces, null, 2));
  }

  const paneMessages = messages.filter(m => m.type === 'panes');
  if (paneMessages.length > 0) {
    for (const pm of paneMessages) {
      console.log(`\nPanes for workspace ${pm.workspaceId}:`);
      console.log('  containerFrame:', JSON.stringify(pm.payload.containerFrame));
      for (const p of pm.payload.panes) {
        console.log(`  Pane ${p.id}: ${p.columns}x${p.rows}, workspaceId=${p.workspaceId}`);
        console.log(`    frame: ${JSON.stringify(p.frame)}`);
        console.log(`    surfaceIds: ${JSON.stringify(p.surfaceIds)}`);
        console.log(`    selectedSurfaceId: ${p.selectedSurfaceId}`);
      }
    }
  } else {
    console.log('\n⚠️  NO PANE MESSAGES RECEIVED');
  }

  const surfaceMessages = messages.filter(m => m.type === 'surfaces');
  if (surfaceMessages.length > 0) {
    for (const sm of surfaceMessages) {
      console.log(`\nSurfaces for workspace ${sm.workspaceId}:`);
      for (const s of sm.payload.surfaces) {
        console.log(`  ${s.id}: title="${s.title}", type=${s.type}, ws=${s.workspaceId}`);
      }
    }
  }

  ws.close();
  process.exit(0);
}, 5000);
