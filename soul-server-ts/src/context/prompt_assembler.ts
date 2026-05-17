/**
 * Prompt Assembler — Python 두 정본을 *각자 분리하여* 이식 (code-reviewer P1-1·2·3 정합).
 *
 *   - `formatContextItems` ↔ Python `service/context_builder.py:72-85 format_context_items`
 *     · 키 정규화: `re.sub(r'[^a-zA-Z0-9_]', '_', key) or "item"` — *치환* (skip 아님)
 *     · string content: 이스케이프 *없음* (Python L83 `str(content)`)
 *     · dict/list content: `json.dumps(content, ensure_ascii=False, indent=2)`
 *
 *   - `assemblePrompt` ↔ Python `service/prompt_assembler.py:23-71 assemble_prompt`
 *     · key 검증: `TAG_NAME_RE`(`^[a-zA-Z_][a-zA-Z0-9_\\-]*$`) 통과만 — invalid는 *skip*
 *     · string content: 이스케이프 *적용* (`_escape_closing_tag`)
 *     · dict/list content: `json.dumps(content, ensure_ascii=False)` — *indent 없음*
 *
 * 두 정본의 *직렬화 정책 차이*는 의도된 것이다 (Python에 그대로 존재). TS는 두 함수를
 * *분리 유지*하여 정본 둘을 동시에 보존한다. 호출자는 의도에 맞게 선택:
 *   - context_items → XML 블록 prepend: `formatContextItems`
 *   - 클라이언트 StructuredContext → prompt prepend: `assemblePrompt`
 *
 * codex SDK가 turn-level systemPrompt를 지원하지 않으므로 (분석 캐시
 * `20260517-2338-codex-ts-context-builder-B-6.md` §B) `composeFirstTurnPrompt`가 둘을
 * 합쳐 단일 prompt 문자열로 만든다.
 */

const TAG_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_\-]*$/;
const FORMAT_KEY_INVALID_CHARS = /[^a-zA-Z0-9_]/g;

export interface ContextItem {
  key: string;
  label?: string;
  content: unknown;
}

/**
 * 문자열 content 내부 닫힘 태그 패턴 이스케이프 (Python `_escape_closing_tag` 정본).
 * `assemblePrompt`에서만 사용 — `formatContextItems`는 Python 정합으로 이스케이프 *없음*.
 */
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
  const parts: string[] = [];
  for (const item of items) {
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
    parts.push(`<${key}>\n${serialized}\n</${key}>`);
  }
  if (parts.length === 0) return "";
  return `<context>\n${parts.join("\n")}\n</context>`;
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
