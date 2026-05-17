/**
 * Prompt Assembler — Python `service/prompt_assembler.py` + `context_builder.format_context_items`
 * 정본 그대로 이식.
 *
 * 구조화된 컨텍스트 항목(soulstream_session, atom_context 등)을 XML 태그로 변환하여 codex
 * prompt 앞에 prepend한다. codex SDK가 systemPrompt를 turn-level로 지원하지 않으므로
 * (분석 캐시 `20260517-2338-codex-ts-context-builder-B-6.md` §B), 본 helper가 claude의
 * `system_prompt + context_items + assembled_prompt` 흐름을 단일 prompt 문자열로 합성한다.
 */

const TAG_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_\-]*$/;

export interface ContextItem {
  key: string;
  label?: string;
  content: unknown;
}

/**
 * 문자열 content 내부에서 닫힘 태그 패턴을 이스케이프 (Python `_escape_closing_tag` 정본).
 *
 * `</key>` 패턴이 content 안에 있으면 태그가 조기 종료되어 프롬프트 구조가 파손된다.
 * `</`를 `<\/`로 치환하여 방어.
 */
function escapeClosingTag(text: string): string {
  return text.replace(/<\//g, "<\\/");
}

/**
 * 단일 context item을 XML 블록으로 직렬화 (Python `format_context_items` 안의 per-item 로직).
 *
 * key가 유효한 태그명 형식이 아니면 빈 문자열 반환 (호출자가 skip).
 */
function serializeItem(item: ContextItem): string | null {
  if (!TAG_NAME_RE.test(item.key)) return null;
  const content = item.content;
  if (content === undefined || content === null || content === "") return null;
  let serialized: string;
  if (typeof content === "string") {
    serialized = escapeClosingTag(content);
  } else if (typeof content === "object") {
    // JSON으로 직렬화 — 꺾쇠 미포함 (Python json.dumps ensure_ascii=False 등가)
    serialized = JSON.stringify(content, null, 2);
  } else {
    serialized = String(content);
  }
  return `<${item.key}>\n${serialized}\n</${item.key}>`;
}

/**
 * context_items를 codex가 읽을 XML 블록으로 직렬화 (Python `format_context_items` 정본).
 *
 * Python L72-85: `<context>\n${items}\n</context>` 래퍼로 감싼다.
 * 빈 list 또는 모든 item이 invalid면 빈 문자열 반환.
 */
export function formatContextItems(items: ContextItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    const block = serializeItem(item);
    if (block) parts.push(block);
  }
  if (parts.length === 0) return "";
  return `<context>\n${parts.join("\n")}\n</context>`;
}

/**
 * prompt와 context를 조합 (Python `assemble_prompt` 정본).
 *
 * Python은 `context: Optional[dict]` (StructuredContext.model_dump 결과)를 받지만 본 PR
 * 범위에서 TS Task는 그 wire가 없으므로 (분석 캐시 §C-4 별건 카드), assemblePrompt 자체는
 * 정본 알고리즘만 보존하고 호출자는 context=undefined로 호출한다.
 *
 * 빈 context → prompt 그대로 반환. items 있으면 XML 블록 + "\n\n" + prompt.
 */
export function assemblePrompt(
  prompt: string,
  context?: { items?: ContextItem[] },
): string {
  if (!context) return prompt;
  const items = context.items ?? [];
  if (items.length === 0) return prompt;
  const block = formatContextItems(items);
  if (!block) return prompt;
  return `${block}\n\n${prompt}`;
}
