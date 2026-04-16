import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

// Global registry: surfaceId → writeOutput function
const terminalRegistry = new Map<string, (data: string) => void>();

export function writeToTerminal(surfaceId: string, data: string) {
  const write = terminalRegistry.get(surfaceId);
  write?.(data);
}

interface TerminalProps {
  surfaceId: string;
  cols?: number;
  rows?: number;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

export function Terminal({ surfaceId, cols, rows, onInput, onResize }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);

  onInputRef.current = onInput;
  onResizeRef.current = onResize;

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 10000,
      convertEol: true,
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
      },
    });

    term.open(containerRef.current);

    if (cols && rows) {
      term.resize(cols, rows);
      onResizeRef.current(cols, rows);
    }

    term.onData((data) => {
      onInputRef.current(data);
    });

    termRef.current = term;

    let lastB64 = '';

    const writeOutput = (base64Data: string) => {
      if (!termRef.current) return;
      if (base64Data === lastB64) return;
      lastB64 = base64Data;

      const t = termRef.current;
      const bytes = atob(base64Data);
      const text = new TextDecoder().decode(
        Uint8Array.from(bytes, (c) => c.charCodeAt(0)),
      );
      const lines = text.split('\n');

      if (lines.length > t.rows * 2) {
        // Scrollback data (>2x visible): reset and write full history
        t.reset();
        t.write(text);
        t.scrollToBottom();
      } else {
        // Screen snapshot: overwrite visible rows only.
        // This preserves scrollback buffer from the initial load.
        let output = '\x1b[H'; // cursor to top-left of visible area
        for (let i = 0; i < lines.length; i++) {
          if (i > 0) output += `\x1b[${i + 1};1H`;
          output += lines[i];
        }
        if (lines.length < t.rows) {
          output += `\x1b[${lines.length + 1};1H\x1b[J`;
        }
        t.write(output);
        t.scrollToBottom();
      }
    };
    terminalRegistry.set(surfaceId, writeOutput);

    return () => {
      terminalRegistry.delete(surfaceId);
      term.dispose();
    };
  }, [surfaceId]);

  useEffect(() => {
    if (termRef.current && cols && rows) {
      termRef.current.resize(cols, rows);
    }
  }, [cols, rows]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: '#1e1e2e',
        overflow: 'hidden',
      }}
    />
  );
}
