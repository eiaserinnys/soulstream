export interface PageUpdatedNotification {
  pageId: string;
  version: number;
}

export type PageUpdatedObserver = (event: PageUpdatedNotification) => void;

interface PageMutationNotificationSource {
  page: { id: string; version: number };
  idempotent?: boolean;
}

interface PageUpdateNotificationLogger {
  error(
    context: { err: unknown; pageId: string; version: number },
    message: string,
  ): void;
}

export function notifyPageUpdates(
  results: readonly PageMutationNotificationSource[],
  observer?: PageUpdatedObserver,
  logger?: PageUpdateNotificationLogger,
): void {
  if (!observer) return;
  const notifications = new Map<string, PageUpdatedNotification>();
  for (const result of results) {
    if (result.idempotent === true) continue;
    notifications.set(result.page.id, {
      pageId: result.page.id,
      version: result.page.version,
    });
  }
  for (const notification of notifications.values()) {
    try {
      observer(notification);
    } catch (error) {
      logger?.error(
        { err: error, pageId: notification.pageId, version: notification.version },
        "Page update notification failed after commit",
      );
    }
  }
}
