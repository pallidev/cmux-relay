/**
 * Tests for mobile terminal control keys and scroll fix.
 *
 * Verifies:
 *   - Control key buttons exist (Enter, Backspace, Tab, Esc, Arrows, Ctrl)
 *   - Control keys send correct escape sequences
 *   - Ctrl mode sends correct control characters (C-c, C-d, etc.)
 *   - Mobile input bar prevents browser scroll on focus
 *   - MobileLayout prevents scroll on visualViewport resize
 *   - Terminal height adjusts for control key row (calc(100% - 78px))
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Mobile terminal control keys', () => {
  const terminalSource = readFileSync(resolve(root, 'packages/web/src/components/Terminal.tsx'), 'utf-8');

  it('has Enter key button sending carriage return', () => {
    assert.ok(terminalSource.includes("sendKey('\\r')"), 'Should have Enter key sending \\r');
    assert.ok(terminalSource.includes('>\u21B5<') || terminalSource.includes('>↵<'), 'Should display ↵ label');
  });

  it('has Backspace key button sending DEL', () => {
    assert.ok(terminalSource.includes("sendKey('\\x7f')"), 'Should have Backspace key sending \\x7f');
    assert.ok(terminalSource.includes('>⌫<'), 'Should display ⌫ label');
  });

  it('has Tab key button sending tab character', () => {
    assert.ok(terminalSource.includes("sendKey('\\t')"), 'Should have Tab key sending \\t');
  });

  it('has Escape key button sending ESC', () => {
    assert.ok(terminalSource.includes("sendKey('\\x1b')"), 'Should have Escape key sending \\x1b');
  });

  it('has arrow key buttons sending correct escape sequences', () => {
    assert.ok(terminalSource.includes("sendKey('\\x1b[D')"), 'Left arrow should send \\x1b[D');
    assert.ok(terminalSource.includes("sendKey('\\x1b[C')"), 'Right arrow should send \\x1b[C');
    assert.ok(terminalSource.includes("sendKey('\\x1b[A')"), 'Up arrow should send \\x1b[A');
    assert.ok(terminalSource.includes("sendKey('\\x1b[B')"), 'Down arrow should send \\x1b[B');
  });

  it('has Ctrl mode toggle', () => {
    assert.ok(terminalSource.includes('ctrlActive'), 'Should have ctrlActive state');
    assert.ok(terminalSource.includes('setCtrlActive(true)'), 'Should be able to enable Ctrl mode');
    assert.ok(terminalSource.includes('setCtrlActive(false)'), 'Should be able to disable Ctrl mode');
  });

  it('Ctrl mode sends correct control characters', () => {
    assert.ok(terminalSource.includes('ctrlKey'), 'Should have ctrlKey function');
    // Ctrl+C = charCode 3, Ctrl+D = charCode 4, etc.
    assert.match(terminalSource, /charCodeAt\(0\)\s*-\s*64/, 'Should compute control char from letter');
    assert.ok(terminalSource.includes("['c', 'd', 'z', 'l', 'a']"), 'Should have common Ctrl shortcuts');
  });

  it('adjusts terminal height to account for control key row', () => {
    assert.match(terminalSource, /calc\(100%\s*-\s*78px\)/,
      'Terminal height should be calc(100% - 78px) to fit control keys + input bar');
  });

  it('xterm input is enabled on mobile (not gated by fitRows)', () => {
    // The onData handler should not have a fitRows guard
    const onDataMatch = terminalSource.match(/term\.onData\(\(data\)\s*=>\s*\{[\s\S]*?\}\)/);
    assert.ok(onDataMatch, 'Should have term.onData handler');
    assert.ok(!onDataMatch[0].includes('fitRows'), 'onData should NOT be gated by fitRows');
  });
});

describe('Mobile scroll prevention on input focus', () => {
  const terminalSource = readFileSync(resolve(root, 'packages/web/src/components/Terminal.tsx'), 'utf-8');
  const mobileSource = readFileSync(resolve(root, 'packages/web/src/components/MobileLayout.tsx'), 'utf-8');

  it('input onFocus calls window.scrollTo(0, 0)', () => {
    assert.ok(terminalSource.includes('onFocus'), 'Should have onFocus handler on mobile input');
    assert.match(terminalSource, /window\.scrollTo\(0,\s*0\)/,
      'Should scroll to top on input focus to prevent browser auto-scroll');
  });

  it('MobileLayout prevents scroll on visualViewport resize', () => {
    assert.match(mobileSource, /window\.scrollTo\(0,\s*0\)/,
      'Should scroll to top when viewport resizes (keyboard appears)');
    assert.match(mobileSource, /document\.documentElement\.scrollTop\s*=\s*0/,
      'Should also reset scrollTop on document element');
  });

  it('MobileLayout listens to both resize and scroll on visualViewport', () => {
    assert.match(mobileSource, /addEventListener\(['"]resize['"]/, 'Should listen to resize');
    assert.match(mobileSource, /addEventListener\(['"]scroll['"]/, 'Should listen to scroll');
    assert.match(mobileSource, /removeEventListener\(['"]resize['"]/, 'Should clean up resize listener');
    assert.match(mobileSource, /removeEventListener\(['"]scroll['"]/, 'Should clean up scroll listener');
  });
});
