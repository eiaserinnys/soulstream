/**
 * atom 컨텍스트 취득 — Python `service/atom_context.py` 정본 그대로 이식.
 *
 * atom API에서 subtree를 compile하여 codex 세션에 주입할 컨텍스트 마크다운을 생성하는
 * 독립 함수들. 호출 실패 시 null 반환 (graceful) — turn 시작 차단하지 않는다.
 */

import type { Logger } from "pino";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * atom HTML metadata 주석 매칭 정규식 (Python `_ATOM_HTML_PATTERN` 정본).
 *   group(1) node_id  — 필수
 *   group(2) card_id  — 옵션 (구 단일 ID 입력 폴백)
 *   group(3) chars    — 옵션 (heading 모드는 chars 없음)
 */
const ATOM_HTML_PATTERN = new RegExp(
  `<!--\\s*node:(${UUID})(?:\\s+card:(${UUID}))?(?:\\s+[^>]*?chars:(\\d+))?[^>]*?-->`,
  "g",
);

const ATOM_CONTEXT_HEADER =
  "# atom 트리 | 드릴다운: " +
  "mcp__atom__list_children(parent_node_id) · " +
  "compile_subtree(node_id)\n";

export interface AtomContextSpec {
  nodeId: string;
  depth: number;
  titlesOnly: boolean;
}

/**
 * atom HTML metadata 주석을 짧은 ID 라벨로 변환 (Python `format_atom_context` 정본).
 *
 * 출력 라벨 형식 (atom PR #10 정합):
 *   - 두 ID 보존:  `[node:X card:Y] [(N chars)]`
 *   - 구 단일 ID:  `[X] [(N chars)]`
 *
 * HTML 주석 없는 라인(짧은 라벨, *(cycle)*, plain text)은 정규식 미매칭으로 자동 통과
 * — 후처리 idempotent.
 */
export function formatAtomContext(markdown: string): string {
  return `${ATOM_CONTEXT_HEADER}${formatAtomMarkdown(markdown)}`;
}

function formatAtomMarkdown(markdown: string): string {
  const lines = markdown.split("\n").map((line) =>
    line.replace(ATOM_HTML_PATTERN, (_match, nodeId, cardId, chars) => {
      const label = cardId ? `[node:${nodeId} card:${cardId}]` : `[${nodeId}]`;
      return chars !== undefined ? `${label} (${chars} chars)` : label;
    }),
  );
  return lines.join("\n");
}

export interface AtomFetchConfig {
  serverUrl: string;
  apiKey: string;
  enabled: boolean;
}

/**
 * atom API에서 subtree를 compile하여 마크다운을 반환 (Python `fetch_atom_context` 정본).
 *
 * 실패 시 null 반환 — turn 진행 차단하지 않는다. 5초 timeout (Python httpx.AsyncClient
 * timeout 5.0 정합).
 */
export async function fetchAtomContext(
  config: AtomFetchConfig,
  nodeId: string,
  depth: number,
  titlesOnly: boolean,
  logger: Logger,
): Promise<string | null> {
  const markdown = await fetchAtomMarkdown(
    config,
    { nodeId, depth, titlesOnly },
    logger,
  );
  return markdown === null ? null : formatAtomContext(markdown);
}

export async function fetchAtomContexts(
  config: AtomFetchConfig,
  specs: AtomContextSpec[],
  logger: Logger,
): Promise<string | null> {
  if (specs.length === 0) return null;
  const sections: string[] = [];
  for (const spec of specs) {
    const markdown = await fetchAtomMarkdown(config, spec, logger);
    if (!markdown) continue;
    sections.push(
      [
        `## atom node: ${spec.nodeId}`,
        `depth=${spec.depth}, titles_only=${spec.titlesOnly}`,
        "",
        formatAtomMarkdown(markdown),
      ].join("\n"),
    );
  }
  if (sections.length === 0) return null;
  return `${ATOM_CONTEXT_HEADER}\n${sections.join("\n\n")}`;
}

async function fetchAtomMarkdown(
  config: AtomFetchConfig,
  spec: AtomContextSpec,
  logger: Logger,
): Promise<string | null> {
  if (!config.enabled || !config.serverUrl) return null;
  const url = new URL(
    `${config.serverUrl.replace(/\/$/, "")}/api/tree/${spec.nodeId}/compile`,
  );
  url.searchParams.set("depth", String(spec.depth));
  url.searchParams.set("max_chars", "50000");
  url.searchParams.set("include_ids", "true");
  if (spec.titlesOnly) url.searchParams.set("titles_only", "true");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(url.toString(), {
      headers: { "x-api-key": config.apiKey },
      signal: controller.signal,
    });
    if (resp.status !== 200) {
      logger.warn(
        { status: resp.status, nodeId: spec.nodeId },
        "[atom] compile failed",
      );
      return null;
    }
    const data = (await resp.json()) as { markdown?: string };
    if (!data.markdown) return null;
    return data.markdown;
  } catch (err) {
    logger.warn({ err, nodeId: spec.nodeId }, "[atom] compile error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}
