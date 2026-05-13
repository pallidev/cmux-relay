import type { ConnectionPhase } from '../hooks/useRelay';

type TransportType = 'relay' | 'p2p';

interface ConnectionOverlayProps {
  phase: ConnectionPhase;
  highestPhase: ConnectionPhase | null;
  reconnectAttempt: number;
  reconnectDelay: number;
  errorMessage: string | null;
  transport: TransportType;
  onRetry?: () => void;
}

const STEPS = [
  { key: 'connecting', label: 'WebSocket 연결' },
  { key: 'waiting-agent', label: 'Agent 연결 대기' },
] as const;

const STEP_KEYS = STEPS.map(s => s.key);

function stepIndex(phase: ConnectionPhase): number {
  return STEP_KEYS.indexOf(phase as typeof STEP_KEYS[number]);
}

function progressPercent(phase: ConnectionPhase): number {
  const idx = stepIndex(phase);
  if (idx < 0) return 0;
  return Math.round(((idx + 1) / STEPS.length) * 100);
}

export function ConnectionOverlay({
  phase,
  highestPhase,
  reconnectAttempt,
  reconnectDelay,
  errorMessage,
  onRetry,
}: ConnectionOverlayProps) {
  if (phase === 'connected' || phase === 'idle') return null;

  const isReconnecting = phase === 'reconnecting';
  const isError = phase === 'error';
  const isPermanentError = isError && (errorMessage?.includes('세션을 찾을 수') || errorMessage?.includes('연결할 수 없') || errorMessage?.includes('응답하지 않'));
  const accent = isReconnecting ? 'var(--yellow)' : isError ? 'var(--red)' : 'var(--blue)';
  const gradient = isReconnecting
    ? 'linear-gradient(90deg, var(--yellow), var(--peach))'
    : isError
    ? 'linear-gradient(90deg, var(--red), var(--peach))'
    : 'linear-gradient(90deg, var(--blue), var(--mauve))';

  const title = isReconnecting ? '재연결 중' : isError ? '연결 실패' : '터미널 연결 중';
  const detail = isReconnecting
    ? reconnectDelay > 0 ? `${Math.ceil(reconnectDelay / 1000)}초 후 재시도...` : '연결 시도 중...'
    : isError
    ? errorMessage || '연결할 수 없습니다'
    : phase === 'connecting' ? 'WebSocket 연결 중...'
    : 'Agent 응답 대기...';

  const highestIdx = highestPhase ? stepIndex(highestPhase) : -1;

  return (
    <div className="connection-overlay">
      <div className="connection-overlay-content">
        <div className="connection-spinner" style={{ '--spinner-color': accent } as React.CSSProperties}>
          <svg width="48" height="48" viewBox="0 0 48 48">
            <circle cx="24" cy="24" r="20" fill="none" stroke="var(--bg-surface1)" strokeWidth="4"/>
            <circle cx="24" cy="24" r="20" fill="none" stroke="var(--spinner-color)" strokeWidth="4"
              strokeDasharray="80 45" strokeLinecap="round"/>
          </svg>
        </div>

        <h3 className="connection-title" style={{ color: accent }}>{title}</h3>
        <p className="connection-detail">{detail}</p>

        <div className="connection-progress-track">
          <div className="connection-progress-bar"
            style={{
              background: gradient,
              width: isReconnecting ? '100%' : `${progressPercent(phase)}%`,
            }}
          />
        </div>

        <div className="connection-steps">
          {STEPS.map((step) => {
            const idx = STEP_KEYS.indexOf(step.key);
            const currentIdx = isReconnecting ? -1 : stepIndex(phase);
            const isComplete = isReconnecting ? idx <= highestIdx : idx < currentIdx;
            const isCurrent = isReconnecting ? false : idx === currentIdx;

            return (
              <div key={step.key}
                className={`connection-step ${isComplete ? 'complete' : isCurrent ? 'current' : 'pending'}`}>
                {isComplete ? '✓' : isCurrent ? '●' : '○'} {step.label}
              </div>
            );
          })}
        </div>

        {isReconnecting && reconnectAttempt > 0 && (
          <p className="connection-attempt">시도 {reconnectAttempt}</p>
        )}

        {isPermanentError && (
          <button className="connection-retry-btn" onClick={() => onRetry?.() ?? window.location.reload()} style={{
            marginTop: '12px',
            padding: '8px 20px',
            background: accent,
            color: 'var(--bg-base)',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 600,
          }}>
            다시 시도
          </button>
        )}
      </div>
    </div>
  );
}
