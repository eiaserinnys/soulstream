import type {
  ContextItem as WireContextItem,
  InputMaterialPartV1,
} from "@soulstream/wire-schema";
import {
  createInputMaterialFramingPart,
  createInputMaterialPart,
  scopeInputMaterialParts,
} from "./input_material_parts.js";

const TAG_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_\-]*$/;
const FORMAT_KEY_INVALID_CHARS = /[^a-zA-Z0-9_]/g;

export type ContextItem = Pick<WireContextItem, "key" | "content"> & { label?: string };

function escapeClosingTag(text: string): string {
  return text.replace(/<\//g, "<\\/");
}

/**
 * context_items를 codex가 읽을 XML 블록으로 직렬화 (Python `format_context_items` 정본).
 *
 * Python L72-85 정합:
 *   - key 정규화: 영문/숫자/_ 외 문자 → '_'로 치환 (skip 아님). 빈 결과 → "item".
 *   - string content: `str(content)` — *이스케이프 없음*
 *   - dict/list content: `json.dumps(content, ensure_ascii=False, indent=2)`
 *   - 빈 list 또는 *모든 item이 빈 content* → 빈 문자열 반환 (호출자가 prepend skip).
 */
export function formatContextItems(items: ContextItem[]): string {
  return formatContextItemsWithMaterial(items).text;
}

export function formatContextItemsWithMaterial(
  items: ContextItem[],
  contentPartsByIndex?: readonly (readonly InputMaterialPartV1[] | null | undefined)[],
): { text: string; parts: InputMaterialPartV1[] } {
  const blocks: Array<{ key: string; content: string; index: number }> = [];
  for (const [index, item] of items.entries()) {
    const rawKey = item.key || "item";
    const key = rawKey.replace(FORMAT_KEY_INVALID_CHARS, "_") || "item";
    const content = item.content;
    if (content === undefined || content === null || content === "") continue;
    let serialized: string;
    if (typeof content === "string") {
      serialized = content;  // Python L83 str(content) — 이스케이프 없음
    } else if (typeof content === "object") {
      serialized = JSON.stringify(content, null, 2);  // indent=2 (Python L81)
    } else {
      serialized = String(content);
    }
    blocks.push({ key, content: serialized, index });
  }
  if (blocks.length === 0) return { text: "", parts: [] };

  const location = "context_items";
  let text = "<context>\n";
  const parts: InputMaterialPartV1[] = [
    createInputMaterialFramingPart(location, 0, "<context>\n"),
  ];
  let framingIndex = 1;
  blocks.forEach((block, index) => {
    if (index > 0) {
      text += "\n";
      parts.push(createInputMaterialFramingPart(location, framingIndex++, "\n"));
    }
    const open = `<${block.key}>\n`;
    const close = `\n</${block.key}>`;
    text += open + block.content + close;
    parts.push(createInputMaterialFramingPart(location, framingIndex++, open));
    const supplied = contentPartsByIndex?.[block.index];
    const suppliedChars = supplied?.reduce(
      (sum, part) => sum + (part.raw_chars_utf16 ?? 0),
      0,
    );
    parts.push(...(
      supplied && suppliedChars === block.content.length
        ? scopeInputMaterialParts(supplied, `context/${block.index}/atom`)
        : [createInputMaterialPart(
            "soulstream_injection",
            `context/${block.index}/content`,
            block.content,
          )]
    ));
    parts.push(createInputMaterialFramingPart(location, framingIndex++, close));
  });
  text += "\n</context>";
  parts.push(createInputMaterialFramingPart(location, framingIndex, "\n</context>"));
  return { text, parts };
}

/**
 * prompt와 context를 조합 (Python `assemble_prompt` 정본 L23-71).
 *
 * Python L51-65 정합:
 *   - key 검증: `TAG_NAME_RE` 통과만 — invalid는 *skip* (정규화 안 함)
 *   - content null/undefined/빈 문자열 → skip
 *   - string content: `_escape_closing_tag` 적용 (Python L59)
 *   - dict/list content: `json.dumps(content, ensure_ascii=False)` — *indent 없음* (Python L61)
 *   - 모든 item이 skip되면 prompt 그대로 반환
 *   - 그 외 → "<key>...\n</key>\\n" 합쳐서 "${block}\\n\\n${prompt}" 반환
 *
 * 본 PR 범위에서 TS Task는 StructuredContext wire가 없으므로 (분석 캐시 §C-4 별건 카드),
 * 호출 위치는 `context_builder._assembleContext`의 `assembledPrompt` 빌더에서 context=undefined로
 * 한 곳뿐. 그러나 정본 알고리즘은 별건 카드를 위해 보존.
 */
export function assemblePrompt(
  prompt: string,
  context?: { items?: ContextItem[] },
): string {
  if (!context) return prompt;
  const items = context.items ?? [];
  if (items.length === 0) return prompt;

  const parts: string[] = [];
  for (const item of items) {
    if (!TAG_NAME_RE.test(item.key)) continue;  // invalid → skip (Python L53)
    const content = item.content;
    if (content === undefined || content === null || content === "") continue;
    let serialized: string;
    if (typeof content === "string") {
      serialized = escapeClosingTag(content);  // Python L59
    } else if (typeof content === "object") {
      serialized = JSON.stringify(content);  // indent 없음 (Python L61)
    } else {
      serialized = String(content);
    }
    parts.push(`<${item.key}>\n${serialized}\n</${item.key}>`);
  }
  if (parts.length === 0) return prompt;
  return `${parts.join("\n")}\n\n${prompt}`;
}
