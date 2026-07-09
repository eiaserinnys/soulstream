import {
  buildTaskChangedStreamEvent,
  type InMemorySseReplayBroadcaster,
  type TaskStreamEvent,
} from "../sse/replay_broadcaster.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";

export const TASK_TREE_CHANGED_CHANNEL = "task_tree_changed";

export type LiveTaskChangeListener = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly isRunning: () => boolean;
};

export type CreateLiveTaskChangeListenerOptions = {
  readonly sqlResolver: LiveDbSqlResolver;
  readonly broadcaster: InMemorySseReplayBroadcaster<TaskStreamEvent>;
  readonly channel?: string;
};

export function createLiveTaskChangeListener(
  options: CreateLiveTaskChangeListenerOptions,
): LiveTaskChangeListener {
  let subscription: { readonly unlisten: () => Promise<void> } | null = null;
  const channel = options.channel ?? TASK_TREE_CHANGED_CHANNEL;

  return {
    async start() {
      if (subscription !== null) return;
      const sql = await options.sqlResolver.resolveSql();
      if (sql.listen === undefined) {
        throw new Error("Live Postgres SQL connection does not support LISTEN");
      }
      subscription = await sql.listen(channel, (payload) => {
        options.broadcaster.append(buildTaskChangedStreamEvent(parseChange(payload)));
      });
    },
    async stop() {
      const current = subscription;
      subscription = null;
      await current?.unlisten();
    },
    isRunning() {
      return subscription !== null;
    },
  };
}

function parseChange(payload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Preserve malformed notifications as observable task stream events.
  }
  return { raw: payload };
}
