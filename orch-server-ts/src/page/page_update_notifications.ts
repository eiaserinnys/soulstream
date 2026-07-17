export interface PageUpdatedNotification {
  pageId: string;
  version: number;
}

export type PageUpdatedObserver = (event: PageUpdatedNotification) => void;

interface PageMutationNotificationSource {
  page: { id: string; version: number };
  idempotent?: boolean;
}

interface PageCommitNotificationSource {
  pageId: string;
  pageCommit?: {
    operation: { result_version: number };
    idempotent: boolean;
  };
  idempotent?: boolean;
}

type PageUpdateNotificationSource =
  | PageMutationNotificationSource
  | PageCommitNotificationSource;

interface PageUpdateNotificationLogger {
  error(
    context: { err: unknown; pageId: string; version: number },
    message: string,
  ): void;
}

export function notifyPageUpdates(
  results: readonly PageUpdateNotificationSource[],
  observer?: PageUpdatedObserver,
  logger?: PageUpdateNotificationLogger,
): void {
  if (!observer) return;
  const notifications = new Map<string, PageUpdatedNotification>();
  for (const result of results) {
    const notification = toNotification(result);
    if (notification) notifications.set(notification.pageId, notification);
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

function toNotification(
  result: PageUpdateNotificationSource,
): PageUpdatedNotification | null {
  if (result.idempotent === true) return null;
  if ("page" in result) {
    return { pageId: result.page.id, version: result.page.version };
  }
  if (!result.pageCommit || result.pageCommit.idempotent) return null;
  return {
    pageId: result.pageId,
    version: result.pageCommit.operation.result_version,
  };
}
