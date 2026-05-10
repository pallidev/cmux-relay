import type { CmuxNotification } from '@cmux-relay/shared';
import { getToastType } from '../lib/helpers';

interface ToastContainerProps {
  toasts: CmuxNotification[];
  onDismiss: (index: number) => void;
  onClick?: (n: CmuxNotification, index: number) => void;
}

export function ToastContainer({ toasts, onDismiss, onClick }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((n, i) => {
        const toastType = getToastType(n);
        return (
          <div
            key={`${n.id}-${i}`}
            className={`toast toast-${toastType}`}
            onClick={() => onClick?.(n, i)}
          >
            <span className="toast-icon">
              {n.title.toLowerCase().includes('claude') ? '🤖' : '🔔'}
            </span>
            <div className="toast-content">
              <div className="toast-title">{n.title}</div>
              {n.subtitle && <div className="toast-sub">{n.subtitle}</div>}
              {n.body && <div className="toast-body">{n.body}</div>}
            </div>
            <button
              className="toast-close"
              onClick={(e) => { e.stopPropagation(); onDismiss(i); }}
              aria-label="Dismiss"
            >
              &times;
            </button>
            <div className="toast-progress" />
          </div>
        );
      })}
    </div>
  );
}
