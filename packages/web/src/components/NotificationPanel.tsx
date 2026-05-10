import type { CmuxNotification } from '@cmux-relay/shared';

interface NotificationPanelProps {
  notifications: CmuxNotification[];
  onNavigate: (n: CmuxNotification) => void;
  onClose: () => void;
}

export function NotificationPanel({
  notifications,
  onNavigate,
  onClose,
}: NotificationPanelProps) {
  return (
    <div className="notif-panel">
      <div className="notif-panel-header">
        <span>Notifications</span>
        {notifications.length > 0 && (
          <button className="notif-clear-btn" onClick={onClose}>Clear</button>
        )}
      </div>
      {notifications.length === 0 ? (
        <div className="notif-empty">No notifications</div>
      ) : (
        <div className="notif-list">
          {notifications.map((n) => (
            <button
              key={n.id}
              className={`notif-item ${n.isRead ? 'read' : 'unread'}`}
              onClick={() => onNavigate(n)}
            >
              <div className="notif-item-title">{n.title}</div>
              {n.subtitle && <div className="notif-item-sub">{n.subtitle}</div>}
              {n.body && <div className="notif-item-body">{n.body}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
