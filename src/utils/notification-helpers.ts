import type { AgentNotification } from '../types.js';

/**
 * Adds a timestamp to a notification's _meta field if it doesn't already have one.
 * Follows ACP extensibility guidelines by using _meta for custom fields.
 *
 * @see https://agentclientprotocol.com/extensibility#the-_meta-field
 */
export function ensureTimestamp<T extends AgentNotification>(
  notification: T
): T {
  const now = Date.now();

  // PostHog notifications already have timestamp in params
  if ('params' in notification && notification.params && 'timestamp' in notification.params) {
    return notification;
  }

  // For SessionNotifications and others, add timestamp to _meta
  if (!notification._meta) {
    (notification as any)._meta = { timestamp: now };
  } else if (!notification._meta.timestamp) {
    notification._meta.timestamp = now;
  }

  return notification;
}

/**
 * Gets the timestamp from a notification, checking both params.timestamp (PostHog)
 * and _meta.timestamp (ACP extension).
 */
export function getNotificationTimestamp(notification: AgentNotification): number | undefined {
  // Check PostHog notification format
  if ('params' in notification && notification.params && 'timestamp' in notification.params) {
    return notification.params.timestamp as number;
  }

  // Check ACP _meta extension
  if (notification._meta?.timestamp) {
    return notification._meta.timestamp as number;
  }

  return undefined;
}
