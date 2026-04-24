/**
 * Tests for MobileLayout component behavior.
 *
 * Verifies:
 *   - Terminal component receives fitRows (not fixed cols)
 *   - CSS does not block native touch scrolling
 *   - No touch-action: none or pan-x that would block vertical scroll
 *   - Sticky bottom auto-scroll (scrollToBottom only when at bottom)
 *   - Scroll panel controls (collapsible ↑/↓ buttons)
 *   - localStorage persistence for workspace/surface
 *
 * Since these are browser components, we test the source code directly
 * rather than rendering in JSDOM (which lacks xterm.js support).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('MobileLayout component', () => {
  const mobileSource = readFileSync(resolve(root, 'packages/web/src/components/MobileLayout.tsx'), 'utf-8');
  const terminalSource = readFileSync(resolve(root, 'packages/web/src/components/Terminal.tsx'), 'utf-8');
  const layoutSource = readFileSync(resolve(root, 'packages/web/src/components/Layout.tsx'), 'utf-8');
  const relaySource = readFileSync(resolve(root, 'packages/web/src/components/RelaySessionLayout.tsx'), 'utf-8');
  const cssSource = readFileSync(resolve(root, 'packages/web/src/index.css'), 'utf-8');

  it('does not pass cols prop to Terminal in mobile', () => {
    const terminalUsages = mobileSource.match(/<Terminal[\s\S]*?\/>/g) || [];
    for (const usage of terminalUsages) {
      assert.ok(!usage.includes('cols='), `MobileLayout Terminal should not have cols prop, found: ${usage.trim()}`);
    }
  });

  it('passes fitRows to Terminal for auto-sizing', () => {
    const terminalUsages = mobileSource.match(/<Terminal[\s\S]*?\/>/g) || [];
    assert.ok(terminalUsages.length > 0, 'Should have at least one Terminal usage');
    for (const usage of terminalUsages) {
      assert.ok(usage.includes('fitRows'), `MobileLayout Terminal should have fitRows prop, found: ${usage.trim()}`);
    }
  });

  it('Terminal component has scrollback enabled', () => {
    assert.ok(terminalSource.includes('scrollback:'), 'Terminal should set scrollback config');
    const match = terminalSource.match(/scrollback:\s*(\d+)/);
    assert.ok(match, 'Should find scrollback value');
    const scrollback = parseInt(match[1], 10);
    assert.ok(scrollback >= 1000, `Scrollback should be >= 1000, got ${scrollback}`);
  });

  it('Terminal writeOutput preserves scrollback (no \\x1b[2J)', () => {
    assert.ok(!terminalSource.includes('\\x1b[2J'), 'writeOutput should never use clear-screen escape');
    assert.ok(!terminalSource.includes('\x1b[2J'), 'writeOutput should never use clear-screen escape');
  });

  it('mobile-terminal-area CSS does not block vertical scrolling', () => {
    const areaMatch = cssSource.match(/\.mobile-terminal-area\s*\{[^}]*\}/);
    assert.ok(areaMatch, 'Should find .mobile-terminal-area CSS');
    const areaCss = areaMatch[0];

    assert.ok(!areaCss.includes('touch-action: none'), 'Should NOT have touch-action: none');
    assert.ok(!areaCss.includes('touch-action: pan-x'), 'Should NOT have touch-action: pan-x');
    assert.ok(!areaCss.includes('overflow-y: hidden'), 'Should NOT hide vertical overflow');
  });

  it('mobile-terminal-area uses overflow: hidden (xterm handles scroll)', () => {
    const areaMatch = cssSource.match(/\.mobile-terminal-area\s*\{[^}]*\}/);
    assert.ok(areaMatch, 'Should find .mobile-terminal-area CSS');
    const areaCss = areaMatch[0];

    assert.ok(areaCss.includes('overflow: hidden'), 'Should use overflow: hidden (xterm.js handles scrolling internally)');
  });

  it('Terminal container uses touch-action: pan-y for vertical scrolling', () => {
    assert.ok(terminalSource.includes("touchAction: 'pan-y'"),
      'Terminal container should set touch-action: pan-y for mobile vertical scrolling');
    assert.ok(!terminalSource.includes('touch-action: none') && !terminalSource.includes("touchAction: 'none'"),
      'Terminal should NOT block touch with touch-action: none');
  });

  it('Terminal writeOutput uses scrollback-preserving ANSI sequences', () => {
    assert.ok(terminalSource.includes("write(`\\x1b[${t.rows};1H`)"),
      'Should move cursor to last row before pushing content into scrollback');
    assert.ok(terminalSource.includes("previousText + '\\n'"),
      'Should push previous screen content into scrollback (not blank lines)');
    assert.ok(terminalSource.includes("'\\x1b[H'"),
      'Should reset cursor to home position');
    assert.ok(terminalSource.includes("'\\x1b[J'"),
      'Should clear from cursor to end of screen');
  });

  it('Terminal uses sticky bottom pattern (isAtBottomRef)', () => {
    assert.ok(terminalSource.includes('isAtBottomRef'), 'Should have isAtBottomRef for sticky bottom');
    assert.ok(terminalSource.includes('isAtBottomRef.current'), 'Should check isAtBottomRef before scrollToBottom');
    assert.ok(terminalSource.includes('buffer.viewportY'),
      'Should use buffer.viewportY for atBottom detection');
    assert.ok(terminalSource.includes('atBottom'),
      'Should compute atBottom from buffer state');
  });

  it('Terminal has collapsible scroll panel with scroll buttons', () => {
    assert.ok(terminalSource.includes('scrollPanelOpen'), 'Should have scrollPanelOpen state');
    assert.ok(terminalSource.includes('scrollToTop'), 'Should have scrollToTop function');
    assert.ok(terminalSource.includes('scrollToBottom'), 'Should have scrollToBottom function');
    assert.ok(terminalSource.includes('scrollUp'), 'Should have scrollUp function');
    assert.ok(terminalSource.includes('scrollDown'), 'Should have scrollDown function');
    assert.ok(terminalSource.includes('setScrollPanelOpen(false)'), 'Should be able to close panel');
    assert.ok(terminalSource.includes('setScrollPanelOpen(true)'), 'Should be able to open panel');
  });

  it('MobileLayout restores workspace and surface from localStorage', () => {
    assert.ok(mobileSource.includes("localStorage.getItem('cmux-relay-last-workspace')"),
      'Should initialize selectedWorkspaceId from localStorage');
    assert.ok(mobileSource.includes("localStorage.getItem('cmux-relay-last-surface')"),
      'Should initialize selectedSurfaceId from localStorage');
    assert.ok(mobileSource.includes("localStorage.setItem('cmux-relay-last-workspace'"),
      'Should persist workspace to localStorage');
    assert.ok(mobileSource.includes("localStorage.setItem('cmux-relay-last-surface'"),
      'Should persist surface to localStorage');
  });

  it('Layout (desktop local) restores workspace from localStorage', () => {
    assert.ok(layoutSource.includes("localStorage.getItem('cmux-relay-last-workspace')"),
      'Should initialize selectedWorkspaceId from localStorage');
    assert.ok(layoutSource.includes("localStorage.setItem('cmux-relay-last-workspace'"),
      'Should persist workspace to localStorage');
  });

  it('RelaySessionLayout (desktop cloud) restores workspace from localStorage', () => {
    assert.ok(relaySource.includes("localStorage.getItem('cmux-relay-last-workspace')"),
      'Should initialize selectedWorkspaceId from localStorage');
    assert.ok(relaySource.includes("localStorage.setItem('cmux-relay-last-workspace'"),
      'Should persist workspace to localStorage');
  });

  it('MobileLayout always calls selectSurface on data arrival', () => {
    assert.ok(mobileSource.includes('Always call selectSurface to ensure server sends output'),
      'Should always call selectSurface even when restoring from localStorage');
    assert.ok(mobileSource.includes('!workspaces.some(w => w.id === selectedWorkspaceId)'),
      'Should validate saved workspace still exists');
  });
});
