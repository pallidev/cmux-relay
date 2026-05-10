/**
 * Notification toast management hook.
 *
 * Centralises the duplicated toast + browser notification logic from
 * Layout.tsx, MobileLayout.tsx, and RelaySessionLayout.tsx.
 *
 * Pure helper functions are exported separately for unit testing without
 * React.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { CmuxNotification } from '@cmux-relay/shared';

// ─── Pure helpers (testable without React) ───

const TOAST_DURATION_MS = 5000;

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
}

export interface UseNotificationToastsResult {
  toasts: CmuxNotification[];
  dismissToast: (i: number) => void;
}

/**
 * Manages in-app toast notifications that appear when new cmux
 * notifications arrive and auto-dismiss after 5 seconds.
 */
export function useNotificationToasts(opts: UseNotificationToastsOpts): UseNotificationToastsResult {
  const { notifications } = opts;
  const [toasts, setToasts] = useState<CmuxNotification[]>([]);
  const prevNotifCount = useRef(0);

  useEffect(() => {
    const { newNotifs, newPrevCount } = detectNewNotifications(notifications, prevNotifCount.current);
    prevNotifCount.current = newPrevCount;

    if (newNotifs.length === 0) return;

    setToasts(prev => [...prev, ...newNotifs]);
    const timer = scheduleToastDismissal(newNotifs.length, setToasts);
    return () => clearTimeout(timer);
  }, [notifications]);

  const dismissToast = useCallback((i: number) => {
    setToasts(prev => prev.filter((_, idx) => idx !== i));
  }, []);

  return { toasts, dismissToast };
}
