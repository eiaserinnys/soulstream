import type {
  EventTreeNode,
  InputRequestEvent,
  InputRequestExpiredEvent,
  InputRequestNodeDef,
  InputRequestRespondedEvent,
  SessionEvent,
  SessionNode,
  SoulSSEEvent,
  ToolApprovalNodeDef,
  ToolApprovalRequestedEvent,
  ToolApprovalResolvedEvent,
  ToolNode,
  ToolResultEvent,
} from "@shared/types";
import type { ProcessingContext } from "./processing-context";

export const TRUNCATE_THRESHOLD = 2000;

/** 기존 노드를 수정하는 업데이트 이벤트를 처리한다. */
export function applyUpdate(
  event: SoulSSEEvent,
  eventId: number,
  ctx: ProcessingContext,
  root: EventTreeNode | null,
): boolean {
  switch (event.type) {
    case "session": {
      if (!root || root.type !== "session") return false;
      const e = event as SessionEvent;
      const sessionRoot = root as SessionNode;
      sessionRoot.sessionId = e.session_id;
      sessionRoot.pid = e.pid;
      root.content = e.session_id;
      return true;
    }

    case "text_delta": {
      if (ctx.activeTextTarget) {
        ctx.activeTextTarget.content += event.text;
        return true;
      }
      return false;
    }

    case "text_end": {
      if (ctx.activeTextTarget) {
        ctx.activeTextTarget.textCompleted = true;
        ctx.activeTextTarget.completed = true;
        ctx.activeTextTarget = null;
        return true;
      }
      return false;
    }

    case "tool_result": {
      const e = event as ToolResultEvent;
      const found = e.tool_use_id
        ? ctx.nodeMap.get(e.tool_use_id)
        : undefined;

      if (found && (found.type === "tool" || found.type === "tool_use")) {
        const toolNode = found as ToolNode;
        const result = e.result;
        if (result && result.length > TRUNCATE_THRESHOLD) {
          toolNode.toolResult = result.slice(0, TRUNCATE_THRESHOLD);
          toolNode.isTruncated = true;
          toolNode.fullContentEventId = eventId;
        } else {
          toolNode.toolResult = result;
        }
        toolNode.isError = e.is_error;
        if (e.timeline_id) toolNode.toolTraceId = e.timeline_id;
        toolNode.completed = true;
        if (toolNode.timestamp && e.timestamp) {
          toolNode.durationMs = Math.round(
            (e.timestamp - toolNode.timestamp) * 1000,
          );
        }
        return true;
      }
      return false;
    }

    case "input_request_expired": {
      const e = event as InputRequestExpiredEvent;
      const node = ctx.nodeMap.get(e.request_id);
      if (node && node.type === "input_request") {
        // 라이브 만료는 기존 2초 종료 표시를 유지한다.
        (node as InputRequestNodeDef).serverExpiredAt = Date.now();
        return true;
      }
      rememberPendingResolution(ctx, `input:${e.request_id}`, event, eventId);
      return false;
    }

    case "input_request_responded": {
      const e = event as InputRequestRespondedEvent;
      const node = ctx.nodeMap.get(e.request_id);
      if (node && node.type === "input_request") {
        (node as InputRequestNodeDef).responded = true;
        (node as InputRequestNodeDef).completed = true;
        return true;
      }
      rememberPendingResolution(ctx, `input:${e.request_id}`, event, eventId);
      return false;
    }

    case "tool_approval_resolved": {
      const e = event as ToolApprovalResolvedEvent;
      const node = ctx.nodeMap.get(e.approval_id);
      if (node && node.type === "tool_approval") {
        const approvalNode = node as ToolApprovalNodeDef;
        approvalNode.resolved = true;
        approvalNode.completed = true;
        approvalNode.approved = e.approved;
        approvalNode.rejected = e.rejected;
        approvalNode.message = e.message;
        return true;
      }
      rememberPendingResolution(ctx, `approval:${e.approval_id}`, event, eventId);
      return false;
    }

    case "subagent_stop":
    case "claude_runtime_session_state":
    case "claude_runtime_task_started":
    case "claude_runtime_task_created":
    case "claude_runtime_task_updated":
    case "claude_runtime_task_progress":
    case "claude_runtime_task_completed":
    case "claude_runtime_task_notification":
    case "claude_runtime_notification":
    case "claude_runtime_remote_trigger":
    case "claude_runtime_transcript_mirror_error":
    case "claude_runtime_hook_event":
    case "claude_runtime_mode_state":
    case "claude_runtime_schedule_updated":
    case "claude_runtime_schedule_deleted":
    case "task_updated":
    case "custom_view_updated":
      return false;

    default:
      return false;
  }
}

/** 원본 생성 이벤트가 뒤늦게 놓인 직후 보관한 최신 resolution을 소급한다. */
export function applyPendingResolution(
  originalEvent: SoulSSEEvent,
  ctx: ProcessingContext,
  root: EventTreeNode | null,
): boolean {
  const key = originalEvent.type === "input_request"
    ? `input:${(originalEvent as InputRequestEvent).request_id}`
    : originalEvent.type === "tool_approval_requested"
      ? `approval:${(originalEvent as ToolApprovalRequestedEvent).approval_id}`
      : null;
  if (key === null) return false;

  const pending = ctx.pendingResolutions.get(key);
  if (pending === undefined) return false;
  ctx.pendingResolutions.delete(key);

  if (pending.event.type === "input_request_expired") {
    const node = ctx.nodeMap.get((pending.event as InputRequestExpiredEvent).request_id);
    if (!node || node.type !== "input_request") return false;
    const inputNode = node as InputRequestNodeDef;
    // 이력 역순 복원은 이미 만료된 과거 상태이므로 라이브 2초 애니메이션을 재생하지 않는다.
    inputNode.expired = true;
    inputNode.completed = true;
    return true;
  }
  return applyUpdate(pending.event, pending.eventId, ctx, root);
}

function rememberPendingResolution(
  ctx: ProcessingContext,
  key: string,
  event: SoulSSEEvent,
  eventId: number,
): void {
  const current = ctx.pendingResolutions.get(key);
  if (current === undefined || eventId > current.eventId) {
    ctx.pendingResolutions.set(key, { event, eventId });
  }
}
