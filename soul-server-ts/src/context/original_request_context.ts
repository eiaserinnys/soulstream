/**
 * 일반 세션의 모델 대체 세대 첫 입력에 "이어갈 원래 요청"을 다시 넣는다.
 *
 * 세대 시작 시점의 `task.prompt`/`task.contextItems`는 재개 메시지로 덮여
 * 있어 원래 요청이 아니다. 영속 원본(세션 행 prompt와 최초 user_message
 * 이벤트)에서 복원한다. 다시 실행하라는 뜻이 아님을 문구로 못박는다.
 */

import type { Logger } from "pino";

import type { ContextItem } from "./prompt_assembler.js";
import { formatContextItems } from "./prompt_assembler.js";

interface OriginalRequestSource {
  readEvents(
    sessionId: string,
    afterId: number,
    limit: number,
    eventTypes?: string[],
  ): Promise<Array<{ event_type: string; payload: unknown }>>;
}

export const ORIGINAL_REQUEST_ITEM_KEY = "original_request";

/** 최초 user_message 이벤트의 text와 context를 읽는다. 실패는 빈 값. */
async function readEarliestUserMessage(
  db: OriginalRequestSource,
  logger: Pick<Logger, "warn">,
  sessionId: string,
): Promise<{ text: string | null; contextItems: ContextItem[] }> {
  try {
    const events = await db.readEvents(sessionId, 0, 20, ["user_message"]);
    const first = events.find((event) =>
      event.event_type === "user_message"
      && isRecord(event.payload)
      && typeof event.payload.text === "string"
      && event.payload.text.trim() !== "",
    );
    if (!first || !isRecord(first.payload)) return { text: null, contextItems: [] };
    const context = first.payload.context;
    return {
      text: first.payload.text as string,
      contextItems: Array.isArray(context) ? context.filter(isContextItem) : [],
    };
  } catch (err) {
    logger.warn({ err, sessionId }, "original request event read failed");
    return { text: null, contextItems: [] };
  }
}

/**
 * 세대 첫 입력에 넣을 원래 요청 항목. 원문이 전혀 없으면 null.
 */
export async function buildOriginalRequestContextItem(
  db: OriginalRequestSource,
  logger: Pick<Logger, "warn">,
  sessionId: string,
  fallbackPrompt: string | null | undefined,
): Promise<ContextItem | null> {
  const earliest = await readEarliestUserMessage(db, logger, sessionId);
  const text = (earliest.text ?? fallbackPrompt ?? "").trim();
  const contextText = formatContextItems(
    earliest.contextItems.filter((item) => item.key !== ORIGINAL_REQUEST_ITEM_KEY),
  ).trim();
  if (text === "" && contextText === "") return null;

  const sections = [
    "## 이어갈 원래 요청",
    "이 세션의 원래 요청입니다. 처음부터 다시 실행하라는 뜻이 아니며, 미완료 부분을 이어갈 때 참고하세요.",
  ];
  if (text !== "") sections.push("### 원래 요청", text);
  if (contextText !== "") sections.push("### 원래 요청에 함께 전달된 맥락", contextText);
  return {
    key: ORIGINAL_REQUEST_ITEM_KEY,
    label: "이어갈 원래 요청",
    content: sections.join("\n\n"),
  };
}

function isContextItem(value: unknown): value is ContextItem {
  return isRecord(value) && typeof value.key === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
