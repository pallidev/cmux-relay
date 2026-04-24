/**
 * Tests for MobileLayout component behavior.
 *
 * Verifies:
 *   - Terminal component receives fitRows (not fixed cols)
 *   - CSS does not block native touch scrolling
 *   - No touch-action: none or pan-x that would block vertical scroll
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
  const cssSource = readFileSync(resolve(root, 'packages/web/src/index.css'), 'utf-8');

  it('does not pass cols prop to Terminal in mobile', () => {
    // In MobileLayout, Terminal should NOT have a cols prop
    // The only mention of cols should be in the onResize callback
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
    // Find .mobile-terminal-area block
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

  it('Terminal component does not set touch-action: none on container', () => {
    assert.ok(!terminalSource.includes('touchAction') && !terminalSource.includes('touch-action'),
      'Terminal component should not set touch-action CSS');
  });

  it('Terminal writeOutput uses scrollback-preserving ANSI sequences', () => {
    assert.ok(terminalSource.includes("write(`\\x1b[${t.rows};1H`)"),
      'Should move cursor to last row before pushing content into scrollback');
    assert.ok(terminalSource.includes("'\\n'.repeat(t.rows)"),
      'Should push rows into scrollback with newlines');
    assert.ok(terminalSource.includes("'\\x1b[H'"),
      'Should reset cursor to home position');
    assert.ok(terminalSource.includes("'\\x1b[J'"),
      'Should clear from cursor to end of screen');
  });
});
