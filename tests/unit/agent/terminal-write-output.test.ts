/**
 * Tests for the terminal writeOutput scrollback preservation logic.
 *
 * The writeOutput function must:
 *   - Use base64 dedup to skip unchanged content
 *   - On first write, just write text and scrollToBottom (always)
 *   - On subsequent writes, push previous screen content into scrollback
 *     (not blank lines) via ANSI escapes
 *   - Only call scrollToBottom when isAtBottom is true (sticky bottom)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Extract writeOutput logic for testing ───

function createWriteOutputCapture() {
  const written: string[] = [];
  const calls = { scrollToBottom: 0 };

  const state = {
    lastB64: '',
    hasWritten: false,
    previousText: '',
    rows: 24,
    isAtBottom: true,
  };

  // Mirrors production writeOutput from Terminal.tsx
  function writeOutput(base64Data: string) {
    if (base64Data === state.lastB64) return;
    state.lastB64 = base64Data;

    const bytes = Buffer.from(base64Data, 'base64').toString();

    if (!state.hasWritten) {
      state.hasWritten = true;
      state.previousText = bytes;
      written.push(bytes);
      calls.scrollToBottom++;
      return;
    }

    // Push previous screen content into scrollback, then write new content
    if (state.previousText) {
      written.push(`\x1b[${state.rows};1H`);
      written.push(state.previousText + '\n');
      written.push('\x1b[H');
    }
    written.push(bytes);
    written.push('\x1b[J');
    state.previousText = bytes;

    if (state.isAtBottom) {
      calls.scrollToBottom++;
    }
  }

  return { written, calls, state, writeOutput };
}

// ─── Tests ───

describe('writeOutput scrollback logic', () => {
  it('first write outputs text directly without ANSI escape hacks', () => {
    const { written, writeOutput } = createWriteOutputCapture();
    const text = 'Hello terminal\n$ ';
    writeOutput(Buffer.from(text).toString('base64'));

    assert.equal(written.length, 1);
    assert.equal(written[0], text);
    assert.ok(!written[0].includes('\x1b['), 'First write should not contain ANSI escapes');
  });

  it('second write uses scrollback-preserving ANSI sequences with previous content', () => {
    const { written, writeOutput } = createWriteOutputCapture();

    writeOutput(Buffer.from('content v1').toString('base64'));
    writeOutput(Buffer.from('content v2').toString('base64'));

    assert.equal(written.length, 6, 'Two writes should produce 1 + 5 = 6 entries');
    assert.equal(written[1], '\x1b[24;1H', 'Move cursor to last row');
    assert.equal(written[2], 'content v1\n', 'Push previous content + separator into scrollback');
    assert.equal(written[4], 'content v2', 'New content');
    assert.equal(written[5], '\x1b[J', 'Clear from cursor to end');
  });

  it('dedup: unchanged content is completely skipped', () => {
    const { written, writeOutput } = createWriteOutputCapture();
    const b64 = Buffer.from('same content').toString('base64');

    writeOutput(b64);
    const lenAfterFirst = written.length;
    writeOutput(b64); // Same content
    writeOutput(b64); // Again

    assert.equal(written.length, lenAfterFirst, 'Dedup should skip all unchanged writes');
  });

  it('different content after dedup break writes normally', () => {
    const { written, writeOutput } = createWriteOutputCapture();

    writeOutput(Buffer.from('aaa').toString('base64'));
    writeOutput(Buffer.from('bbb').toString('base64')); // Different, goes through
    writeOutput(Buffer.from('bbb').toString('base64')); // Dedup'd
    writeOutput(Buffer.from('ccc').toString('base64')); // Different, goes through

    // v1: 1 write, v2: 5 writes, v3: 5 writes = 11
    assert.equal(written.length, 11, 'Total: 1 + 5 + 5 = 11 write entries');
  });

  it('scrollToBottom is called when isAtBottom is true', () => {
    const { calls, writeOutput } = createWriteOutputCapture();

    writeOutput(Buffer.from('v1').toString('base64'));
    writeOutput(Buffer.from('v2').toString('base64'));
    writeOutput(Buffer.from('v2').toString('base64')); // dedup'd
    writeOutput(Buffer.from('v3').toString('base64'));

    assert.equal(calls.scrollToBottom, 3, 'scrollToBottom called 3 times (not for dedup\'d write)');
  });

  it('scrollToBottom is NOT called when user is scrolled up (isAtBottom=false)', () => {
    const { calls, state, writeOutput } = createWriteOutputCapture();

    writeOutput(Buffer.from('v1').toString('base64'));
    assert.equal(calls.scrollToBottom, 1, 'First write always scrolls to bottom');

    state.isAtBottom = false; // User scrolled up

    writeOutput(Buffer.from('v2').toString('base64'));
    writeOutput(Buffer.from('v3').toString('base64'));

    assert.equal(calls.scrollToBottom, 1, 'scrollToBottom NOT called when user is scrolled up');
  });

  it('scrollToBottom resumes when user scrolls back to bottom', () => {
    const { calls, state, writeOutput } = createWriteOutputCapture();

    writeOutput(Buffer.from('v1').toString('base64'));
    assert.equal(calls.scrollToBottom, 1);

    state.isAtBottom = false;
    writeOutput(Buffer.from('v2').toString('base64'));
    assert.equal(calls.scrollToBottom, 1, 'No scrollToBottom while scrolled up');

    state.isAtBottom = true;
    writeOutput(Buffer.from('v3').toString('base64'));
    assert.equal(calls.scrollToBottom, 2, 'scrollToBottom resumes when back at bottom');
  });

  it('never uses \\x1b[2J which destroys scrollback', () => {
    const { written, writeOutput } = createWriteOutputCapture();

    for (let i = 0; i < 10; i++) {
      writeOutput(Buffer.from(`version ${i}`).toString('base64'));
    }

    for (const w of written) {
      assert.ok(!w.includes('\x1b[2J'), 'Should never use clear-screen escape that destroys scrollback');
    }
  });

  it('respects rows setting for scrollback push', () => {
    const capture = createWriteOutputCapture();
    capture.state.rows = 40;

    capture.writeOutput(Buffer.from('v1').toString('base64'));
    capture.writeOutput(Buffer.from('v2').toString('base64'));

    assert.equal(capture.written[1], '\x1b[40;1H', 'Move to row 40');
    assert.equal(capture.written[2], 'v1\n', 'Push previous content with separator');
  });
});
