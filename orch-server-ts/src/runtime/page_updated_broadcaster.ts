import type {
  PageUpdatedNotification,
  PageUpdatedObserver,
} from "../page/page_update_notifications.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";

export function createPageUpdatedEmitter(
  broadcaster: Pick<InMemorySseReplayBroadcaster<SessionStreamEvent>, "append">,
): PageUpdatedObserver {
  return ({ pageId, version }: PageUpdatedNotification) => {
    broadcaster.append({
      type: "page_updated",
      page_id: pageId,
      version,
    });
  };
}
