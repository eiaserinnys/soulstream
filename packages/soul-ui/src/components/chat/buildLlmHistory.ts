/**
 * LLM 대화 히스토리 빌더.
 *
 * 활성 세션의 트리에서 user 메시지와 assistant 메시지를
 * 시간 순서로 평탄화해 LLM API 요청 형식의 messages 배열을 만든다.
 *
 * 순수 함수 — 네트워크 호출 없음, React 훅에 의존하지 않음.
 */

import { flattenTree } from "../../lib/flatten-tree";
import type { ChatMessage } from "../../lib/flatten-tree";
import type { EventTreeNode } from "@shared/types";

export interface LlmHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * 트리에서 user / assistant 메시지를 시간순으로 뽑아 LLM history 포맷으로 변환한다.
 *
 * - user 메시지: 그대로 포함한다.
 * - assistant 메시지: `treeNodeType === "assistant_message"` 인 것만 포함한다
 *   (tool 호출, 시스템 메시지 등은 제외).
 */
export function buildLlmHistory(
  tree: EventTreeNode | null | undefined,
): LlmHistoryMessage[] {
  if (!tree) return [];
  const flat: ChatMessage[] = flattenTree(tree);
  const msgs: LlmHistoryMessage[] = [];
  for (const m of flat) {
    if (m.role === "user") {
      msgs.push({ role: "user", content: m.content });
    } else if (m.role === "assistant" && m.treeNodeType === "assistant_message") {
      msgs.push({ role: "assistant", content: m.content });
    }
  }
  return msgs;
}
