/**
 * 소스 하나가 싣는 문서 목록 풀이 (카드 #1854 V1).
 *
 * 이미 컴파일한 atom 마크다운의 노드 머리 주석(`<!-- node:… card:… depth:N [chars:N] -->`)에서만
 * 뽑는다. 문서 본문을 더 읽지 않는다. 머리 주석은 formatAtomMarkdown과 렌더 모드가 지우기 전의
 * 원문에서 읽어야 한다.
 */
import { ATOM_HTML_PATTERN } from "../atom_context.js";

export interface ContextDocument {
  node_id: string;
  card_id: string | null;
  title: string;
  /** 소스 뿌리 기준 깊이. 뿌리가 0이다. */
  depth: number;
  chars: number;
}

const TRUNCATION_MARKER = /<!--\s*truncated:\s*\d+\s+chars omitted\s*-->/;

interface ParsedHeaderLine {
  nodeId: string;
  cardId: string | null;
  depth: number;
  title: string;
  chars: number | undefined;
}

function parseHeaderLine(line: string): ParsedHeaderLine | undefined {
  const match = [...line.matchAll(ATOM_HTML_PATTERN)][0];
  if (!match) return undefined;
  const depthMatch = /\sdepth:(\d+)/.exec(match[0]);
  if (!depthMatch) return undefined;
  const title = line.replace(ATOM_HTML_PATTERN, "").trimEnd()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\s*(?:[│ ]*[├└]──\s*)?/, "")
    .trim();
  return {
    nodeId: match[1]!,
    cardId: match[2] ?? null,
    depth: Number(depthMatch[1]),
    title,
    chars: match[3] === undefined ? undefined : Number(match[3]),
  };
}

/**
 * 컴파일 원문에서 문서 목록을 뽑는다.
 *
 * - `chars`는 머리 주석에 있으면 그 값(titles_only 컴파일), 없으면(제목 줄만 있는 heading 컴파일)
 *   그 노드 줄 밑에서 다음 노드 줄 전까지의 본문 글자 수다.
 * - `maxDepth`가 있으면 그 깊이까지만 싣는다(full 모드는 한 단계 더 가져와 잘린 것을 빼야 한다).
 */
export function extractContextDocuments(
  markdown: string | null | undefined,
  options: { maxDepth?: number } = {},
): ContextDocument[] {
  if (!markdown) return [];
  const documents: ContextDocument[] = [];
  let current: { header: ParsedHeaderLine; body: string[] } | undefined;
  const flush = (): void => {
    if (!current) return;
    const { header, body } = current;
    if (options.maxDepth === undefined || header.depth <= options.maxDepth) {
      documents.push({
        node_id: header.nodeId,
        card_id: header.cardId,
        title: header.title,
        depth: header.depth,
        chars: header.chars ?? body.join("\n").trim().length,
      });
    }
    current = undefined;
  };
  for (const line of markdown.split("\n")) {
    const header = parseHeaderLine(line);
    if (header) {
      flush();
      current = { header, body: [] };
      continue;
    }
    if (current && !TRUNCATION_MARKER.test(line)) current.body.push(line);
  }
  flush();
  return documents;
}
