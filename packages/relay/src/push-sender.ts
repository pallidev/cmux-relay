import webpush from 'web-push';
import type Database from 'better-sqlite3';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPushSubscriptionsForUser } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface PushNotificationPayload {
  title: string;
  body: string;
  workspaceId?: string;
  surfaceId?: string;
}

export function initVapidKeys(): { publicKey: string; privateKey: string; subject: string } {
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@cmux-relay.dev';

  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(subject, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, subject };
  }

  const keyPath = resolve(__dirname, '../.vapid-keys.json');
  if (existsSync(keyPath)) {
    const keys = JSON.parse(readFileSync(keyPath, 'utf-8')) as { publicKey: string; privateKey: string };
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    return { ...keys, subject };
  }

  const vapidKeys = webpush.generateVAPIDKeys();
  writeFileSync(keyPath, JSON.stringify(vapidKeys, null, 2));
  webpush.setVapidDetails(subject, vapidKeys.publicKey, vapidKeys.privateKey);
  console.log('[relay] Generated new VAPID keys, saved to', keyPath);
  return { ...vapidKeys, subject };
}

export function sendPushToUser(
  db: Database.Database,
  userId: string,
  payload: PushNotificationPayload,
): void {
  const subscriptions = getPushSubscriptionsForUser(db, userId);
  const data = JSON.stringify(payload);

  for (const sub of subscriptions) {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth_key },
    };

    webpush.sendNotification(pushSubscription, data, {
      TTL: 86400,
      urgency: 'high',
    }).catch((err: Error & { statusCode?: number }) => {
      if (err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
        console.log(`[relay] Removed expired push subscription: ${sub.endpoint.slice(0, 60)}...`);
      } else {
        console.error('[relay] Push send error:', err.message);
      }
    });
  }
}
