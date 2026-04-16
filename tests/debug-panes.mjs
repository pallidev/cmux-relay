import { CmuxClient } from '../packages/server/src/cmux-client.js';

const cmux = new CmuxClient();

async function main() {
  await cmux.connect();

  const workspaces = await cmux.listWorkspaces();
  console.log('Workspaces:');
  for (const w of workspaces) {
    console.log(`  ${w.id}: "${w.title}"`);
  }

  const { panes, containerFrame } = await cmux.listPanes();
  console.log(`\nContainer frame: ${JSON.stringify(containerFrame)}`);
  console.log(`\nPanes (${panes.length}):`);
  for (const p of panes) {
    console.log(`  Pane ${p.index}: id=${p.id}`);
    console.log(`    dims: ${p.columns}x${p.rows}`);
    console.log(`    frame: ${JSON.stringify(p.frame)}`);
    console.log(`    surfaceIds: ${JSON.stringify(p.surfaceIds)}`);
    console.log(`    selectedSurfaceId: ${p.selectedSurfaceId}`);
    console.log(`    focused: ${p.focused}`);
    console.log(`    workspaceId: ${p.workspaceId}`);

    // percentage calc
    const cf = containerFrame;
    const left = (p.frame.x / cf.width) * 100;
    const top = (p.frame.y / cf.height) * 100;
    const width = (p.frame.width / cf.width) * 100;
    const height = (p.frame.height / cf.height) * 100;
    console.log(`    % left=${left.toFixed(1)}% top=${top.toFixed(1)}% w=${width.toFixed(1)}% h=${height.toFixed(1)}%`);
  }

  cmux.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
