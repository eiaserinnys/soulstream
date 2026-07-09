import type {
  TaskMutationResponse,
  TaskMutationRouteProvider,
} from "../tasks/task_mutation_routes.js";
import {
  buildTaskChangedStreamEvent,
  type InMemorySseReplayBroadcaster,
  type TaskStreamEvent,
} from "../sse/replay_broadcaster.js";

export function withTaskMutationBroadcasts(
  provider: TaskMutationRouteProvider,
  broadcaster: InMemorySseReplayBroadcaster<TaskStreamEvent>,
): TaskMutationRouteProvider {
  return {
    async createTask(payload) {
      return broadcastResult(await provider.createTask(payload), broadcaster);
    },
    async setTaskStatus(taskId, payload) {
      return broadcastResult(await provider.setTaskStatus(taskId, payload), broadcaster);
    },
    async updateTask(taskId, payload) {
      return broadcastResult(await provider.updateTask(taskId, payload), broadcaster);
    },
    async moveTask(taskId, payload) {
      return broadcastResult(await provider.moveTask(taskId, payload), broadcaster);
    },
    async linkTask(taskId, payload) {
      return broadcastResult(await provider.linkTask(taskId, payload), broadcaster);
    },
    async holdTask(taskId, payload) {
      return broadcastResult(await provider.holdTask(taskId, payload), broadcaster);
    },
    async archiveTask(taskId, payload) {
      return broadcastResult(await provider.archiveTask(taskId, payload), broadcaster);
    },
    async pinTask(taskId, payload) {
      return broadcastResult(await provider.pinTask(taskId, payload), broadcaster);
    },
    listTaskOperations: provider.listTaskOperations,
  };
}

function broadcastResult(
  result: TaskMutationResponse,
  broadcaster: InMemorySseReplayBroadcaster<TaskStreamEvent>,
): TaskMutationResponse {
  if (result.idempotent === true) return result;
  broadcaster.append(buildTaskChangedStreamEvent({
    table: "task_operations",
    action: "UPDATE",
    task_id: result.operation.taskId ?? result.task?.id,
    operation_id: result.operation.id,
    operation_type: result.operation.operationType,
    actor_event_id: result.operation.actorEventId,
  }));
  return result;
}
