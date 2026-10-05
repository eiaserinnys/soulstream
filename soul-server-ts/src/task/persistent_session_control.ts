import type { EventPersistence } from "../db/event_persistence.js";
import type { Task } from "./task_models.js";
import { buildPersistentSessionMetadataEntry } from "./task_metadata.js";

export interface PersistentSessionControlDeps {
  getTask(sessionId: string): Task | undefined;
  loadEvictedTask(sessionId: string): Promise<Task | null>;
  rememberTask(task: Task): void;
  persistence?: EventPersistence;
}

export interface SetSessionPersistentResult {
  sessionId: string;
  persistent: boolean;
  generation: number;
}

export class PersistentSessionControl {
  constructor(private readonly deps: PersistentSessionControlDeps) {}

  async setSessionPersistent(
    sessionId: string,
    enabled: boolean,
  ): Promise<SetSessionPersistentResult> {
    let task = this.deps.getTask(sessionId);
    if (!task) {
      task = await this.deps.loadEvictedTask(sessionId) ?? undefined;
      if (!task) throw new Error(`Session not found: ${sessionId}`);
      this.deps.rememberTask(task);
    }

    if (task.sessionType === "llm") {
      throw new Error(`LLM sessions cannot be persistent: ${sessionId}`);
    }
    if (!this.deps.persistence) {
      throw new Error("Persistent session metadata persistence unavailable");
    }

    const entry = buildPersistentSessionMetadataEntry(enabled);
    await this.deps.persistence.enqueueMetadataEffect(sessionId, entry, {
      replaceExistingType: "persistent_session",
      waitForAck: true,
    });
    task.metadata = [
      ...(task.metadata ?? []).filter((item) => item.type !== "persistent_session"),
      entry,
    ];
    task.persistent = enabled;

    return { sessionId, persistent: enabled, generation: 1 };
  }
}
