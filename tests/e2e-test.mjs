import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';

const TOKEN = process.argv[2] || '';
const WEB_URL = 'http://localhost:3000';
const WS_URL = 'ws://localhost:8080';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const results = [];

  function log(name, pass, detail = '') {
    const icon = pass ? '✅' : '❌';
    const msg = detail ? ` — ${detail}` : '';
    console.log(`  ${icon} ${name}${msg}`);
    results.push({ name, pass, detail });
  }

  // ── Test 1: Login page loads ──
  console.log('\n▶ E2E Tests\n');
  try {
    await page.goto(WEB_URL, { waitUntil: 'networkidle', timeout: 10000 });
    const hasInput = await page.locator('input[placeholder="Enter token"]').isVisible();
    log('Login page loads', hasInput);
  } catch (e) {
    log('Login page loads', false, e.message);
  }

  // ── Test 2: Authentication ──
  try {
    await page.goto(`${WEB_URL}/?token=${TOKEN}`, { waitUntil: 'networkidle', timeout: 10000 });
    // URL should be cleaned up (no token in URL)
    const url = page.url();
    const tokenCleaned = !url.includes('token=');
    log('Token cleaned from URL', tokenCleaned, `URL: ${url}`);
  } catch (e) {
    log('Authentication', false, e.message);
  }

  // Wait for WebSocket connection and data
  await page.waitForTimeout(2000);

  // ── Test 3: WebSocket connected ──
  try {
    const statusDot = page.locator('.status-dot');
    const isConnected = await statusDot.evaluate(el => el.classList.contains('connected'));
    log('WebSocket connected', isConnected);
  } catch (e) {
    log('WebSocket connected', false, e.message);
  }

  // ── Test 4: Workspaces visible ──
  try {
    const wsButtons = page.locator('.workspace-label');
    const count = await wsButtons.count();
    log(`Workspaces visible (${count})`, count > 0);
    if (count > 0) {
      const texts = await wsButtons.allTextContents();
      log('Workspace titles', true, texts.join(', '));
    }
  } catch (e) {
    log('Workspaces visible', false, e.message);
  }

  // ── Test 5: Auto-select active workspace ──
  try {
    await page.waitForTimeout(3000);

    // Active workspace should be auto-selected (highlighted in sidebar)
    const activeWs = page.locator('.workspace-label.active');
    const hasActive = await activeWs.count() > 0;
    log('Active workspace auto-selected', hasActive);

    // Content should render without manual click
    const xterms = page.locator('.xterm');
    const xtermCount = await xterms.count();
    log(`xterm auto-rendered (${xtermCount})`, xtermCount > 0);

    // Check ALL panes have content
    const allRows = page.locator('.xterm-rows');
    const rowCount = await allRows.count();
    let filledCount = 0;
    for (let i = 0; i < rowCount; i++) {
      const text = await allRows.nth(i).evaluate(el => el.textContent?.trim() || '');
      if (text.length > 0) filledCount++;
    }
    log(`All panes have content`, filledCount === rowCount, `${filledCount}/${rowCount} panes with content`);
  } catch (e) {
    log('Auto-select active workspace', false, e.message);
  }

  // ── Test 6: Terminal content visible ──
  try {
    await page.waitForTimeout(2000); // Wait for polling data
    const xtermContent = page.locator('.xterm-rows').first();
    const hasContent = await xtermContent.evaluate(el => el.textContent?.trim().length > 0);
    log('Terminal content visible', hasContent);

    if (hasContent) {
      const text = await xtermContent.evaluate(el => el.textContent?.trim().slice(0, 100));
      log('Terminal preview', true, text);
    }
  } catch (e) {
    log('Terminal content visible', false, e.message);
  }

  // ── Test 7: Tab switching + multi-workspace ──
  try {
    // Click second workspace (mynote - should have pane layout as active cmux workspace)
    const wsButtons = page.locator('.workspace-label');
    const wsCount = await wsButtons.count();
    if (wsCount >= 2) {
      await wsButtons.nth(1).click();
      await page.waitForTimeout(1500);

      const xterms2 = page.locator('.xterm');
      const xtermCount2 = await xterms2.count();
      log('Second workspace renders', xtermCount2 > 0, `workspace "mynote": ${xtermCount2} xterm instance(s)`);

      // Tab switching
      const firstTabBar = page.locator('.pane-tabs').first();
      const firstBarTabs = firstTabBar.locator('.pane-tab');
      const firstBarTabCount = await firstBarTabs.count();
      if (firstBarTabCount > 1) {
        const secondTab = firstBarTabs.nth(1);
        const tabTitle = await secondTab.textContent();
        await secondTab.click();
        await page.waitForTimeout(500);
        const activeTab = firstTabBar.locator('.pane-tab.active');
        const activeText = await activeTab.textContent();
        log('Tab switching works', activeText === tabTitle, `Active: "${activeText}", Clicked: "${tabTitle}"`);
      } else {
        log('Tab switching', true, `First pane has ${firstBarTabCount} tab(s)`);
      }
    } else {
      log('Tab switching', true, 'Not enough workspaces');
    }
  } catch (e) {
    log('Tab switching', false, e.message);
  }

  // ── Test 8: Non-active workspace (freeswitch) shows grid ──
  try {
    const wsButtons = page.locator('.workspace-label');
    const wsCount = await wsButtons.count();
    // freeswitch is the 4th workspace
    if (wsCount >= 4) {
      await wsButtons.nth(3).click();
      await page.waitForTimeout(2000);

      const surfaceGrid = page.locator('.surface-grid');
      const hasGrid = await surfaceGrid.count() > 0;
      log('Non-active workspace: grid layout', hasGrid);

      const xterms = page.locator('.xterm');
      const xtermCount = await xterms.count();
      log(`Non-active workspace: ${xtermCount} terminals`, xtermCount > 1);

      // All surface tabs should show
      const tabBars = page.locator('.surface-grid .pane-tabs');
      const tabBarCount = await tabBars.count();
      log(`Non-active workspace: ${tabBarCount} tab bars`, tabBarCount > 0, `${tabBarCount} tabs visible`);
    } else {
      log('Non-active workspace grid', true, 'Not enough workspaces');
    }
  } catch (e) {
    log('Non-active workspace grid', false, e.message);
  }

  // ── Test 8: Input focus & send ──
  try {
    // Click on xterm area to focus (works for both pane and surface list view)
    const xtermEl = page.locator('.xterm').first();
    await xtermEl.click({ timeout: 5000 });
    await page.waitForTimeout(300);

    // Type something
    await page.keyboard.type('echo test123');
    await page.waitForTimeout(1000);

    // Check if xterm received the input
    const content = await page.locator('.xterm-rows').first().evaluate(el => el.textContent);
    const inputSent = content.includes('echo test123');
    log('Keyboard input sent', inputSent, inputSent ? 'Input visible in terminal' : 'Input not reflected');
  } catch (e) {
    log('Keyboard input', false, e.message);
  }

  // ── Test 9: WebSocket protocol (backend check) ──
  try {
    const ws = new WebSocket(WS_URL);
    const wsMessages = [];

    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', payload: { token: TOKEN } }));
      });
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        wsMessages.push(msg);
        if (wsMessages.length >= 3) {
          ws.close();
          resolve();
        }
      });
      ws.on('error', reject);
      setTimeout(() => { ws.close(); resolve(); }, 5000);
    });

    const hasWorkspaces = wsMessages.some(m => m.type === 'workspaces');
    const hasSurfaces = wsMessages.some(m => m.type === 'surfaces');
    const hasPanes = wsMessages.some(m => m.type === 'panes');
    const hasOutput = wsMessages.some(m => m.type === 'output');
    log('WS: workspaces message', hasWorkspaces);
    log('WS: surfaces message', hasSurfaces);
    log('WS: panes message', hasPanes);
    log('WS: output received', hasOutput);

    if (hasWorkspaces) {
      const wsMsg = wsMessages.find(m => m.type === 'workspaces');
      log('WS: workspace count', true, `${wsMsg.payload.workspaces.length} workspaces`);
    }
    if (hasPanes) {
      const paneMsg = wsMessages.find(m => m.type === 'panes');
      log('WS: pane count', true, `${paneMsg.payload.panes.length} panes`);
      if (paneMsg.payload.panes.length > 0) {
        const p = paneMsg.payload.panes[0];
        log('WS: pane dimensions', true, `${p.columns}x${p.rows}, frame: ${p.frame?.width}x${p.frame?.height}`);
      }
    }
  } catch (e) {
    log('WebSocket protocol', false, e.message);
  }

  // ── Test 10: Screenshot ──
  try {
    await page.screenshot({ path: 'tests/e2e-screenshot.png', fullPage: true });
    log('Screenshot saved', true, 'tests/e2e-screenshot.png');
  } catch (e) {
    log('Screenshot', false, e.message);
  }

  // Summary
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

  await browser.exit();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
