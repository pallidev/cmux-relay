import { useState, useEffect, useRef, useCallback } from 'react';
import type { CmuxNotification } from '@cmux-relay/shared';

// ─── Pure helpers (testable without React) ───

const TOAST_DURATION_MS = 5000;
const SETTLE_MS = 2000;

/**
 * Detect new notifications by comparing current vs previous count.
 * Returns the new notifications (empty array if none).
 */
export function detectNewNotifications(
  currentNotifications: CmuxNotification[],
  prevCount: number,
): { newNotifs: CmuxNotification[]; newPrevCount: number } {
  if (currentNotifications.length <= prevCount) {
    return { newNotifs: [], newPrevCount: currentNotifications.length };
  }
  const newNotifs = currentNotifications.slice(0, currentNotifications.length - prevCount);
  return { newNotifs, newPrevCount: currentNotifications.length };
}

/**
 * Schedule auto-dismissal of toast notifications.
 * Returns a cleanup function to clear the timeout.
 */
export function scheduleToastDismissal(
  count: number,
  setToasts: React.Dispatch<React.SetStateAction<CmuxNotification[]>>,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    setToasts(prev => prev.length > count ? prev.slice(count) : []);
  }, TOAST_DURATION_MS);
}

// ─── React hook ───

export interface UseNotificationToastsOpts {
  notifications: CmuxNotification[];
  /** Timestamp (Date.now()) when the connection became 'connected'. undefined = not connected yet. */
  connectedAt?: number;
}

export interface UseNotificationToastsResult {
  toasts: CmuxNotification[];
  dismissToast: (i: number) => void;
}

/**
 * Manages in-app toast notifications that appear when new cmux
 * notifications arrive and auto-dismiss after 5 seconds.
 *
 * Suppresses toasts for notifications received within SETTLE_MS of
 * connecting to prevent duplicate toasts on page refresh / reconnect.
 * Notifications are still stored in state (visible in the notification panel).
 */
export function useNotificationToasts(opts: UseNotificationToastsOpts): UseNotificationToastsResult {
  const { notifications, connectedAt } = opts;
  const [toasts, setToasts] = useState<CmuxNotification[]>([]);
  const prevNotifCount = useRef(0);

  useEffect(() => {
    const { newNotifs, newPrevCount } = detectNewNotifications(notifications, prevNotifCount.current);
    prevNotifCount.current = newPrevCount;

    if (newNotifs.length === 0) return;

    // Suppress toasts within the settle window after connecting
    const settled = connectedAt != null && (Date.now() - connectedAt > SETTLE_MS);
    if (!settled) return;

    setToasts(prev => [...prev, ...newNotifs]);
    const timer = scheduleToastDismissal(newNotifs.length, setToasts);
    return () => clearTimeout(timer);
  }, [notifications, connectedAt]);

  const dismissToast = useCallback((i: number) => {
    setToasts(prev => prev.filter((_, idx) => idx !== i));
  }, []);

  return { toasts, dismissToast };
}
