import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
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
  fitRows?: boolean;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

export function Terminal({ surfaceId, cols, rows, fitRows, onInput, onResize }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const colsRef = useRef(cols);
  colsRef.current = cols;

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
        selectionBackground: '#585b70',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#f5c2e7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    term.open(containerRef.current);

    const doFitRows = () => {
      if (!fitAddonRef.current || !containerRef.current) return;
      if (containerRef.current.offsetHeight === 0) return;
      try {
        const dims = fitAddonRef.current.proposeDimensions();
        if (!dims) return;
        const fixedCols = colsRef.current || dims.cols;
        term.resize(fixedCols, dims.rows);
        onResizeRef.current(fixedCols, dims.rows);
      } catch {}
    };

    if (fitRows) {
      doFitRows();
    } else if (cols && rows) {
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

      if (lines.length > (t.rows || 24) * 2) {
        t.reset();
        t.write(text);
        t.scrollToBottom();
      } else {
        t.write('\x1b[H\x1b[2J');
        t.write(text);
      }
    };
    terminalRegistry.set(surfaceId, writeOutput);

    return () => {
      terminalRegistry.delete(surfaceId);
      term.dispose();
    };
  }, [surfaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit rows on container resize
  useEffect(() => {
    if (!fitRows || !containerRef.current) return;

    const observer = new ResizeObserver(() => {
      if (!fitAddonRef.current || !containerRef.current) return;
      if (containerRef.current.offsetHeight === 0) return;
      try {
        const dims = fitAddonRef.current.proposeDimensions();
        if (!dims || !termRef.current) return;
        const fixedCols = colsRef.current || dims.cols;
        termRef.current.resize(fixedCols, dims.rows);
        onResizeRef.current(fixedCols, dims.rows);
      } catch {}
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [fitRows]);

  useEffect(() => {
    if (fitRows || !termRef.current || !cols || !rows) return;
    termRef.current.resize(cols, rows);
  }, [cols, rows, fitRows]);

  return (
    <div
      ref={containerRef}
      style={{
        width: cols ? `${cols * 7.8}px` : '100%',
        minWidth: '100%',
        height: '100%',
        backgroundColor: '#1e1e2e',
        overflow: 'hidden',
      }}
    />
  );
}
