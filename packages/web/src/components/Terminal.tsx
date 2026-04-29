import { useEffect, useRef, useState } from 'react';
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

const STRIP_ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function Terminal({ surfaceId, cols, rows, fitRows, onInput, onResize }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const colsRef = useRef(cols);
  const isAtBottomRef = useRef(true);
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
    let hasWritten = false;
    let previousText = '';

    const updateTrailingOffset = (text: string) => {
      if (!fitRows || !wrapperRef.current || !containerRef.current || !termRef.current) return;
      const lines = text.split('\n');
      let trailing = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].replace(STRIP_ANSI_RE, '').trim() === '') trailing++;
        else break;
      }
      trailing = Math.min(trailing, lines.length - 1);
      if (trailing > 0) {
        const rowHeight = containerRef.current.offsetHeight / termRef.current.rows;
        wrapperRef.current.style.marginBottom = `-${trailing * rowHeight}px`;
      } else {
        wrapperRef.current.style.marginBottom = '0px';
      }
    };

    const writeOutput = (base64Data: string) => {
      if (!termRef.current) return;
      if (base64Data === lastB64) return;
      lastB64 = base64Data;

      const t = termRef.current;
      const bytes = atob(base64Data);
      const text = new TextDecoder().decode(
        Uint8Array.from(bytes, (c) => c.charCodeAt(0)),
      );

      if (!hasWritten) {
        hasWritten = true;
        previousText = text;
        t.write(text);
        t.scrollToBottom();
        updateTrailingOffset(text);
        return;
      }

      // Push previous screen content into scrollback, then write new content.
      if (previousText) {
        t.write(`\x1b[${t.rows};1H`);
        t.write(previousText + '\n');
        t.write('\x1b[H');
      }
      t.write(text);
      t.write('\x1b[J');
      // Position cursor at last row (where prompt typically is)
      // read_text doesn't provide cursor position, so we default to bottom
      t.write(`\x1b[${t.rows};1H`);
      previousText = text;

      if (isAtBottomRef.current) {
        t.scrollToBottom();
      }
      updateTrailingOffset(text);
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

  const [scrolledUp, setScrolledUp] = useState(false);
  const [scrollPercent, setScrollPercent] = useState(100);
  const [scrollPanelOpen, setScrollPanelOpen] = useState(false);
  const [mobileInput, setMobileInput] = useState('');
  const [ctrlActive, setCtrlActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Custom touch scroll handler for reliable mobile scrolling
  useEffect(() => {
    const container = containerRef.current;
    const t = termRef.current;
    if (!container || !t) return;

    let lastTouchY = 0;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      lastTouchY = e.touches[0].clientY;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const currentY = e.touches[0].clientY;
      const delta = lastTouchY - currentY;
      lastTouchY = currentY;
      if (Math.abs(delta) > 0) {
        t.scrollLines(Math.round(delta / 10) || (delta > 0 ? 1 : -1));
        e.preventDefault();
      }
    };

    const onTouchEnd = () => {};

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
    };
  }, [surfaceId]);

  // Track scroll position for indicator
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    const disp = t.onScroll(() => {
      const buffer = t.buffer.active;
      const maxScroll = buffer.length - t.rows;
      const atBottom = maxScroll <= 0 || buffer.viewportY >= maxScroll - 1;
      isAtBottomRef.current = atBottom;
      setScrolledUp(!atBottom);
      setScrollPercent(maxScroll > 0 ? Math.round((buffer.viewportY / maxScroll) * 100) : 100);
    });
    return () => disp.dispose();
  }, [surfaceId]);

  const scrollUp = () => termRef.current?.scrollLines(-termRef.current.rows);
  const scrollDown = () => {
    const t = termRef.current;
    if (!t) return;
    const maxScroll = t.buffer.active.length - t.rows;
    if (t.buffer.active.viewportY + t.rows >= maxScroll) {
      isAtBottomRef.current = true;
      t.scrollToBottom();
    } else {
      t.scrollLines(t.rows);
    }
  };
  const scrollToTop = () => termRef.current?.scrollToTop();
  const scrollToBottom = () => {
    isAtBottomRef.current = true;
    termRef.current?.scrollToBottom();
    setScrolledUp(false);
  };

  const btnStyle = (size = 32): React.CSSProperties => ({
    width: size,
    height: size,
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(137, 180, 250, 0.75)',
    color: '#1e1e2e',
    fontSize: 15,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
    padding: 0,
  });

  const sendMobileInput = () => {
    if (!mobileInput.trim()) return;
    onInputRef.current(mobileInput);
    setMobileInput('');
  };

  const sendKey = (data: string) => {
    onInputRef.current(data);
  };

  const ctrlKey = (ch: string) => {
    // Ctrl+A=0x01 ... Ctrl+Z=0x1a
    const code = ch.toUpperCase().charCodeAt(0) - 64;
    if (code >= 1 && code <= 26) sendKey(String.fromCharCode(code));
    setCtrlActive(false);
  };

  const ctrlBtnStyle: React.CSSProperties = {
    height: 30,
    minWidth: 36,
    border: 'none',
    borderRadius: 5,
    background: '#313244',
    color: '#cdd6f4',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    padding: '0 4px',
    fontFamily: 'inherit',
    flexShrink: 0,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      <div
        ref={wrapperRef}
        style={fitRows ? { flex: '1 1 0', minHeight: 0, overflow: 'hidden' } : { height: '100%' }}
      >
        <div
          ref={containerRef}
          style={{
            width: cols ? `${cols * 7.8}px` : '100%',
            minWidth: '100%',
            height: '100%',
            backgroundColor: '#1e1e2e',
            overflow: 'hidden',
            touchAction: 'pan-y',
          }}
        />
      </div>
      {/* Mobile input bar for IME support + control keys */}
      {fitRows && (
        <div style={{
          flexShrink: 0,
          background: '#181825',
          borderTop: '1px solid #313244',
        }}>
          {/* Control keys row */}
          {ctrlActive ? (
            <div style={{
              display: 'flex',
              gap: 3,
              padding: '4px 6px',
              justifyContent: 'center',
            }}>
              {['c', 'd', 'z', 'l', 'a'].map(ch => (
                <button key={ch} onClick={() => ctrlKey(ch)} style={ctrlBtnStyle}>
                  C-{ch.toUpperCase()}
                </button>
              ))}
              <button onClick={() => setCtrlActive(false)} style={{ ...ctrlBtnStyle, background: '#f38ba8', color: '#1e1e2e' }}>
                ✕
              </button>
            </div>
          ) : (
            <div style={{
              display: 'flex',
              gap: 3,
              padding: '4px 6px',
              justifyContent: 'center',
            }}>
              <button onClick={() => sendKey('\r')} style={ctrlBtnStyle}>↵</button>
              <button onClick={() => sendKey('\x7f')} style={ctrlBtnStyle}>⌫</button>
              <button onClick={() => sendKey('\t')} style={ctrlBtnStyle}>Tab</button>
              <button onClick={() => sendKey('\x1b')} style={ctrlBtnStyle}>Esc</button>
              <button onClick={() => sendKey('\x1b[D')} style={ctrlBtnStyle}>←</button>
              <button onClick={() => sendKey('\x1b[C')} style={ctrlBtnStyle}>→</button>
              <button onClick={() => sendKey('\x1b[A')} style={ctrlBtnStyle}>↑</button>
              <button onClick={() => sendKey('\x1b[B')} style={ctrlBtnStyle}>↓</button>
              <button onClick={() => setCtrlActive(true)} style={ctrlBtnStyle}>Ctrl</button>
            </div>
          )}
          {/* Text input + send */}
          <div style={{
            display: 'flex',
            gap: 0,
            padding: '0 6px 4px',
            alignItems: 'center',
          }}>
            <input
              ref={inputRef}
              type="text"
              value={mobileInput}
              onChange={(e) => setMobileInput(e.target.value)}
              onFocus={(e) => {
                // Prevent browser scroll-into-view on mobile
                requestAnimationFrame(() => window.scrollTo(0, 0));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  sendMobileInput();
                }
              }}
              placeholder="입력..."
              enterKeyHint="send"
              style={{
                flex: 1,
                height: 32,
                border: '1px solid #313244',
                borderRadius: 6,
                background: '#1e1e2e',
                color: '#cdd6f4',
                fontSize: 14,
                padding: '0 10px',
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
            <button
              onClick={sendMobileInput}
              style={{
                height: 32,
                minWidth: 44,
                marginLeft: 6,
                border: 'none',
                borderRadius: 6,
                background: 'rgba(137, 180, 250, 0.8)',
                color: '#1e1e2e',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                padding: '0 10px',
              }}
            >
              전송
            </button>
          </div>
        </div>
      )}
      {/* Scroll controls - collapsible, mobile only */}
      {fitRows && <div style={{
        position: 'absolute',
        right: 6,
        top: '50%',
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        zIndex: 10,
        alignItems: 'center',
      }}>
        {scrollPanelOpen ? (
          <>
            <button onClick={scrollToTop} style={btnStyle()} aria-label="Scroll to top">⇈</button>
            <button onClick={scrollUp} style={btnStyle()} aria-label="Scroll up">↑</button>
            <div style={{
              width: 4,
              height: 20,
              borderRadius: 2,
              background: 'rgba(137, 180, 250, 0.3)',
              position: 'relative',
              overflow: 'hidden',
            }}>
              <div style={{
                position: 'absolute',
                left: 0,
                right: 0,
                height: `${scrollPercent}%`,
                minHeight: 4,
                background: 'rgba(137, 180, 250, 0.8)',
                borderRadius: 2,
                transition: 'height 0.1s',
              }} />
            </div>
            <button onClick={scrollDown} style={btnStyle()} aria-label="Scroll down">↓</button>
            <button onClick={scrollToBottom} style={btnStyle()} aria-label="Scroll to bottom">⇊</button>
            <button onClick={() => setScrollPanelOpen(false)} style={{ ...btnStyle(), background: 'rgba(69, 71, 90, 0.75)', color: '#cdd6f4' }} aria-label="Close scroll panel">✕</button>
          </>
        ) : (
          <button onClick={() => setScrollPanelOpen(true)} style={btnStyle(28)} aria-label="Open scroll controls">
            ⇅
          </button>
        )}
      </div>}
    </div>
  );
}
