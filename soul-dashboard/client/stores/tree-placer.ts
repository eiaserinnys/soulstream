/**
 * Tree Placer — 노드를 트리에 배치하고 Map에 등록
 *
 * placeInTree: 생성된 노드를 이벤트 필드 기반으로 트리에 삽입
 * resolveParent: parent_tool_use_id로 부모 노드를 결정
 *
 * Phase 2: 현재 코드의 행위를 100% 보존. 일부 이벤트 타입별 분기가 남아 있으나
 * Phase 5에서 parent_event_id 통합 후 필드 기반으로 단순화될 예정.
 */

import type {
  EventTreeNode,
  SoulSSEEvent,
  SubagentStartEvent,
  TextStartEvent,
  ThinkingEvent,
  ToolStartEvent,
  ResultEvent,
} from "@shared/types";
import type { ProcessingContext } from "./processing-context";
import { makeNode, registerNode, insertOrphanError } from "./processing-context";

/**
 * parent_tool_use_id로 부모 노드를 결정합니다.
 * - null/undefined → 현재 턴 루트 (없으면 session root)
 * - "toolu_X" → toolUseMap에서 tool 노드 → 그 자식 subagent 반환
 */
export function resolveParent(
  parentToolUseId: string | null | undefined,
  ctx: ProcessingContext,
  root: EventTreeNode,
): EventTreeNode {
  if (!parentToolUseId) {
    // 루트 레벨 → 현재 턴 루트
    if (ctx.currentTurnNodeId) {
      const turn = ctx.nodeMap.get(ctx.currentTurnNodeId);
      if (turn) return turn;
    }
    return root;
  }

  // parent_tool_use_id → toolUseMap에서 해당 tool 노드 찾기
  const toolNode = ctx.toolUseMap.get(parentToolUseId);
  if (!toolNode) {
    insertOrphanError(root, ctx, "resolveParent", `resolve-${parentToolUseId}`,
      `parent_tool_use_id="${parentToolUseId}" toolUseMap 매칭 실패`);
    return root;
  }

  // tool 노드의 subagent 자식 찾기 (1단계 탐색, 최대 1개)
  const subagent = toolNode.children.find(c => c.type === "subagent");
  if (subagent) return subagent;

  // subagent_start가 아직 안 왔을 수 있음 → tool 노드 자체에 임시 배치.
  // subagent_start 도착 시 reparent 로직이 이 자식들을 subagent 아래로 이동시킨다.
  return toolNode;
}

/**
 * 생성된 노드를 트리에 배치하고 필요한 Map에 등록합니다.
 *
 * 이벤트 타입별 분기를 최소화하되, 현재 코드의 행위를 100% 보존합니다.
 * - 턴 루트(user_message, intervention): root.children에 추가, currentTurnNodeId 갱신
 * - thinking: resolveParent로 부모 결정, lastThinkingByParent 등록
 * - subagent_start: 복잡한 reparent 로직 포함
 * - tool_start: resolveParent로 부모 결정, toolUseMap 등록
 * - complete/error: 턴 루트 또는 root에 추가
 * - result: resolveParent로 부모 결정
 */
export function placeInTree(
  node: EventTreeNode,
  event: SoulSSEEvent,
  eventId: number,
  ctx: ProcessingContext,
  root: EventTreeNode,
): void {
  // nodeMap 등록 (모든 노드 공통)
  registerNode(ctx, node);

  switch (event.type) {
    case "user_message":
    case "intervention_sent": {
      // 턴 루트: session root의 직접 자식
      root.children.push(node);
      ctx.currentTurnNodeId = node.id;
      break;
    }

    case "thinking": {
      const e = event as ThinkingEvent;
      const parent = resolveParent(e.parent_tool_use_id, ctx, root);
      // 같은 parent 레벨의 후속 text_start와 매칭하기 위해 등록
      // "" = root 레벨 (서브에이전트 밖), 그 외 = 해당 서브에이전트의 parent_tool_use_id
      const parentKey = e.parent_tool_use_id || "";
      ctx.lastThinkingByParent.set(parentKey, node);
      parent.children.push(node);
      break;
    }

    case "subagent_start": {
      const e = event as SubagentStartEvent;
      ctx.subagentMap.set(e.agent_id, node);

      // 부모 노드 결정
      // SDK 한계: PreToolUse는 toolu_* ID를, SubagentStart는 crypto.randomUUID()를 전달하며
      // Task 도구가 isConcurrencySafe=true라 병렬 실행 시 매핑 불가.
      // → parent_tool_use_id가 비어 있으면 턴 루트에 연결한다.
      const parentToolUseId = e.parent_tool_use_id;
      const parentTool = parentToolUseId ? ctx.toolUseMap.get(parentToolUseId) : null;

      if (parentTool) {
        // NOTE: 현재 서버는 빈 parent_tool_use_id를 전달하므로 이 분기는 도달 불가.
        // SDK 한계가 해소되어 parent 매핑이 복원되면 활성화된다.
        // parent_tool_use_id로 매칭 성공 → reparent 로직
        const toReparent: EventTreeNode[] = [];
        const toKeep: EventTreeNode[] = [];
        for (const child of parentTool.children) {
          if (child.parentToolUseId === parentToolUseId) {
            toReparent.push(child);
          } else {
            toKeep.push(child);
          }
        }
        parentTool.children.length = 0;
        parentTool.children.push(...toKeep, node);
        node.children.push(...toReparent);
      } else if (!parentToolUseId) {
        // parent_tool_use_id 없음 (SDK 한계) → 현재 턴 루트에 연결
        const turnNode = ctx.currentTurnNodeId ? ctx.nodeMap.get(ctx.currentTurnNodeId) : null;
        (turnNode ?? root).children.push(node);
      } else {
        // parent_tool_use_id가 있으나 매칭 실패 → 에러 노드
        insertOrphanError(root, ctx, "subagent_start", eventId,
          `parent_tool_use_id="${parentToolUseId}" toolUseMap 매칭 실패`);
        root.children.push(node);
      }
      break;
    }

    case "tool_start": {
      const e = event as ToolStartEvent;
      if (e.tool_use_id) {
        ctx.toolUseMap.set(e.tool_use_id, node);
      }
      const parent = resolveParent(e.parent_tool_use_id, ctx, root);
      parent.children.push(node);
      break;
    }

    case "complete":
    case "error": {
      const turnNode = ctx.currentTurnNodeId ? ctx.nodeMap.get(ctx.currentTurnNodeId) : null;
      if (turnNode) {
        turnNode.children.push(node);
      } else {
        root.children.push(node);
      }
      break;
    }

    case "result": {
      const e = event as ResultEvent;
      const parent = resolveParent(e.parent_tool_use_id, ctx, root);
      parent.children.push(node);
      break;
    }

    default: {
      // 예상 외의 생성 이벤트 — 턴 루트 또는 root에 배치
      const turnNode = ctx.currentTurnNodeId ? ctx.nodeMap.get(ctx.currentTurnNodeId) : null;
      (turnNode ?? root).children.push(node);
      break;
    }
  }
}

/**
 * text_start 이벤트를 처리합니다.
 *
 * - thinking 매칭: 같은 parent 레벨에 thinking 노드가 존재하면 텍스트를 thinking에 병합
 * - 독립 text 노드: thinking 없이 text만 온 경우 독립 text 노드를 생성하여 트리에 배치
 *
 * node-factory의 applyUpdate와 분리된 이유:
 * text_start는 조건에 따라 노드 생성 + 트리 삽입을 수행하므로
 * tree-placer의 책임에 해당합니다.
 */
export function handleTextStart(
  event: TextStartEvent,
  eventId: number,
  ctx: ProcessingContext,
  root: EventTreeNode,
): boolean {
  const parentKey = event.parent_tool_use_id || "";
  const thinkingNode = ctx.lastThinkingByParent.get(parentKey);

  if (thinkingNode) {
    // 같은 parent 레벨에 thinking 노드 존재 → 텍스트를 thinking에 병합
    ctx.lastThinkingByParent.delete(parentKey); // 1:1 매칭 후 해제
    ctx.activeTextTarget = thinkingNode;
  } else {
    // thinking 없이 text만 온 경우 → 독립 text 노드 생성
    const textParent = resolveParent(event.parent_tool_use_id, ctx, root);
    const textNode = makeNode(`text-${eventId}`, "text", "");
    registerNode(ctx, textNode);
    textParent.children.push(textNode);
    ctx.activeTextTarget = textNode;
  }
  return true;
}
