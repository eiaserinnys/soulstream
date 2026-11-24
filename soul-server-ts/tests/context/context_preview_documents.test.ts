import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compileContexts } from "../../src/context/compiler/index.js";
import { extractContextDocuments } from "../../src/context/compiler/context_documents.js";
import type { AtomContextSpec } from "../../src/context/atom_context.js";

const ROOT = "11111111-2222-3333-4444-555555555555";
const ROOT_CARD = "aaaaaaaa-0000-4000-8000-000000000001";
const CHILD = "22222222-2222-3333-4444-555555555555";
const CHILD_CARD = "aaaaaaaa-0000-4000-8000-000000000002";
const GRAND = "33333333-2222-3333-4444-555555555555";
const GRAND_CARD = "aaaaaaaa-0000-4000-8000-000000000003";
const NO_CARD = "44444444-2222-3333-4444-555555555555";

const atom = { enabled: true, serverUrl: "https://atom.test", apiKey: "key" };
const logger = { warn: vi.fn() };

/** heading 컴파일: 머리 주석에 chars가 없다. */
const headingTree = (depthLimit: number): string => [
  `# 뿌리 <!-- node:${ROOT} card:${ROOT_CARD} depth:0 created:2026-11-11 -->`,
  "뿌리 본문",
  `## 자식 <!-- node:${CHILD} card:${CHILD_CARD} depth:1 created:2026-11-11 -->`,
  "자식 본문 글",
  ...(depthLimit >= 2 ? [
    `### 손자 <!-- node:${GRAND} card:${GRAND_CARD} depth:2 -->`,
    "손자 본문",
  ] : []),
].join("\n");

/** titles_only 컴파일: 머리 주석에 chars가 있다. */
const titleTree = (depthLimit: number): string => [
  `뿌리 <!-- node:${ROOT} card:${ROOT_CARD} depth:0 chars:10 -->`,
  `  ├── 자식 <!-- node:${CHILD} card:${CHILD_CARD} depth:1 chars:20 -->`,
  ...(depthLimit >= 2 ? [`  │   └── 손자 <!-- node:${GRAND} card:${GRAND_CARD} depth:2 chars:30 -->`] : []),
  ...(depthLimit >= 1 ? [`  └── 카드 없음 <!-- node:${NO_CARD} depth:1 chars:5 -->`] : []),
].join("\n");

function serveAtom(): void {
  globalThis.fetch = vi.fn(async (input) => {
    const url = new URL(String(input));
    const depth = Number(url.searchParams.get("depth"));
    const titlesOnly = url.searchParams.has("titles_only");
    const markdown = titlesOnly
      ? titleTree(depth)
      : depth === 0 ? headingTree(0).split("\n").slice(0, 2).join("\n") : headingTree(depth);
    return new Response(JSON.stringify({ markdown }), { status: 200 });
  }) as typeof fetch;
}

function spec(overrides: Partial<AtomContextSpec>): AtomContextSpec {
  return { nodeId: ROOT, depth: 1, titlesOnly: false, ...overrides };
}

async function documentsOf(
  source: AtomContextSpec,
  parameters: Record<string, string> = {},
  options: { ignoreConditions?: boolean } = {},
) {
  const result = await compileContexts(atom, [source], logger, parameters, options);
  return { documents: result.sections[0]!.documents, status: result.sections[0]!.status };
}

describe("context preview documents", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    logger.warn.mockClear();
    serveAtom();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("full 모드는 요청 깊이까지의 문서를 머리 주석에서 뽑고 본문 글자 수를 센다", async () => {
    const { documents } = await documentsOf(spec({ mode: "full", depth: 1 }));
    expect(documents).toEqual([
      { node_id: ROOT, card_id: ROOT_CARD, title: "뿌리", depth: 0, chars: "뿌리 본문".length },
      { node_id: CHILD, card_id: CHILD_CARD, title: "자식", depth: 1, chars: "자식 본문 글".length },
    ]);
  });

  it("모드 없는 소스는 컴파일 원문에 실린 문서를 모두 싣는다", async () => {
    const { documents } = await documentsOf(spec({ depth: 2 }));
    expect(documents?.map((doc) => [doc.node_id, doc.depth])).toEqual([[ROOT, 0], [CHILD, 1], [GRAND, 2]]);
  });

  it("index 모드는 뿌리와 자식 제목 표의 문서를 싣고 깊은 문서는 싣지 않는다", async () => {
    const { documents } = await documentsOf(spec({ mode: "index" }));
    expect(documents?.map((doc) => [doc.node_id, doc.depth, doc.chars])).toEqual([
      [ROOT, 0, 10], [CHILD, 1, 20], [NO_CARD, 1, 5],
    ]);
  });

  it("titles 모드는 제목 트리에 보이는 깊이까지만 싣는다", async () => {
    const shallow = await documentsOf(spec({ mode: "titles", depth: 1 }));
    expect(shallow.documents?.map((doc) => doc.depth)).toEqual([0, 1, 1]);
    const rootOnly = await documentsOf(spec({ mode: "titles", depth: 0 }));
    expect(rootOnly.documents?.map((doc) => doc.node_id)).toEqual([ROOT]);
  });

  it("카드 ID가 없는 줄은 card_id가 null이다", async () => {
    const { documents } = await documentsOf(spec({ mode: "titles", depth: 1 }));
    expect(documents?.find((doc) => doc.node_id === NO_CARD)).toEqual({
      node_id: NO_CARD, card_id: null, title: "카드 없음", depth: 1, chars: 5,
    });
  });

  it("조건으로 빠진 소스는 문서가 비고, ignore_conditions면 같은 소스가 읽힌다", async () => {
    const conditioned = spec({ mode: "titles", depth: 1, appliesWhen: { source: ["agent"] } });
    const filtered = await documentsOf(conditioned, { source: "browser" });
    expect(filtered).toEqual({ status: "filtered", documents: [] });
    const ignored = await documentsOf(conditioned, { source: "browser" }, { ignoreConditions: true });
    expect(ignored.status).toBe("ok");
    expect(ignored.documents?.map((doc) => doc.node_id)).toEqual([ROOT, CHILD, NO_CARD]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("가져오지 못한 소스는 문서가 비어 있다", async () => {
    globalThis.fetch = vi.fn(async () => new Response("failure", { status: 500 })) as typeof fetch;
    for (const mode of [undefined, "full", "index", "titles"]) {
      const { documents, status } = await documentsOf(spec(mode ? { mode } : {}));
      expect(status).toBe("error");
      expect(documents).toEqual([]);
    }
  });

  it("머리 주석이 없는 마크다운과 잘림 표시는 문서로 세지 않는다", () => {
    expect(extractContextDocuments(null)).toEqual([]);
    expect(extractContextDocuments("# 제목만\n본문")).toEqual([]);
    const [doc] = extractContextDocuments(
      `# 뿌리 <!-- node:${ROOT} depth:0 -->\n본문\n<!-- truncated: 99 chars omitted -->`,
    );
    expect(doc).toMatchObject({ card_id: null, chars: 2 });
  });
});
