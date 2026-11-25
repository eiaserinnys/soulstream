// 견본 설정 창(/dialogues?sample=settings)의 지침과 스킬 보기 가짜 응답.
// 미리보기는 ?assemblyState=legacy일 때만 실린 문서 칸이 없는 옛 꼴이다.
// ?guidesState=normal(기본) | loading | failure | empty | noreport | nolint | verifying | conflict | bodyfail | overviewslow | overviewfail | noprofiles | verifyfail
import { assemblyPreview } from "./agent-profile-assembly-fixture";
import { buildOverview, guideCatalogs, guideReport, guideSkills } from "./guides-fixture";
import type { OverviewDocument } from "../lib/skill-guides";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** 응답을 끝내지 않고 취소를 기다린다. 로딩 캡처용이다. */
const never = (signal?: AbortSignal | null) => new Promise<Response>((_resolve, reject) => {
  const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
});

const BODY_LINES = [
  "## 언제 쓰는가\n\n가상의 작업을 시작하기 전에 읽는다. 이 문단은 견본이다.",
  "## 순서\n\n1. 입력을 읽는다.\n2. 빠진 항목을 표로 모은다.\n3. 결과를 한 장으로 정리한다.",
  "## 하지 않는 것\n\n- 원본을 고치지 않는다.\n- 추측으로 빈칸을 채우지 않는다.",
];
const bodyFor = (name: string) => `# ${name}\n\n${BODY_LINES.join("\n\n")}\n\n${"견본 문장을 되풀이해 본문을 길게 만든다. ".repeat(60)}`;

let verifyAsked = false;

export function resetGuidesSample(): void { verifyAsked = false; }

export async function guidesSampleRoute(path: string, method: string, init: RequestInit | undefined, state: string): Promise<Response | null> {
  const isGuides = path === "/api/skill-guides" || path.startsWith("/api/skill-guides/");
  const overview = /^\/api\/nodes\/([^/]+)\/agents\/context-overview$/.exec(path);
  if (!isGuides && !overview) return null;
  if (state === "loading" && (path === "/api/skill-guides" || overview)) return never(init?.signal);
  if (state === "failure" && (path === "/api/skill-guides" || overview)) return json({ detail: "견본 응답 실패" }, 503);
  if (overview) {
    if (state === "overviewslow") return never(init?.signal);
    if (state === "overviewfail") return json({ detail: "견본 응답 실패" }, 503);
    return json(buildOverview(decodeURIComponent(overview[1]!), { empty: state === "noprofiles" }));
  }
  if (path === "/api/skill-guides/verify" && method === "POST") {
    if (state === "conflict") return json({ error: "no_verify_job" }, 409);
    if (state === "verifyfail") return json({ detail: { error: { code: "RECURRING_JOB_FAILED", message: "견본 응답 실패" } } }, 500);
    verifyAsked = true;
    return json({ job_id: "견본-작업" }, 202);
  }
  const body = /^\/api\/skill-guides\/([^/]+)\/body$/.exec(path);
  if (body) {
    const name = decodeURIComponent(body[1]!);
    const skill = guideSkills.find(item => item.name === name);
    if (!skill) return json({ error: "not_found" }, 404);
    if (state === "bodyfail") return json({ detail: "견본 응답 실패" }, 503);
    return json({ name, body_node_id: skill.body_node_id, markdown: bodyFor(name) });
  }
  if (path === "/api/skill-guides") {
    if (state === "empty") return json({ skills: [], catalogs: [], report: guideReport });
    if (state === "noreport") return json({ skills: guideSkills.map(skill => ({ ...skill, lint: null })), catalogs: guideCatalogs.map(catalog => ({ ...catalog, lint: null })), report: null });
    if (state === "nolint") return json({ skills: guideSkills.map(skill => ({ ...skill, lint: null })), catalogs: guideCatalogs, report: guideReport });
    // 다시 검증을 누른 뒤 normal은 새 보고가 올라온 것처럼, verifying은 그대로 답한다.
    const report = verifyAsked && state !== "verifying" ? { ...guideReport, uploaded_at: "2026-11-25T06:10:00.000Z", generated_at: "2026-11-25T06:08:00.000Z" } : guideReport;
    return json({ skills: guideSkills, catalogs: guideCatalogs, report });
  }
  return json({ error: "not_found" }, 404);
}

/**
 * 실서버 꼴의 미리보기 응답: 제목, 부모 제목, 실린 문서는 manifest.sources[i]에 싣고 sections[i]에는 spec_index, title, markdown만 둔다.
 * 스킬 목록 소스에는 견본 스킬이 본문까지 실린다.
 */
export function assemblyPreviewDocuments(body: Parameters<typeof assemblyPreview>[0]) {
  // 스킬 정의 원문: 깊이 0으로 스킬 본문 노드 하나만 불러 온다.
  const only = body.atom_contexts?.length === 1 ? body.atom_contexts[0]! : null;
  const original = only && only.depth === 0 ? guideSkills.find(item => item.body_node_id === only.node_id) : undefined;
  if (original) {
    const markdown = `# ${original.name}\n\n가상의 스킬 정의 원문입니다.`;
    return { manifest: { sources: [{ ...only, status: "ok", chars: markdown.length, token_estimate: Math.ceil(markdown.length / 4), title: original.name, parent_title: "skills", documents: [] }], total_chars: markdown.length, total_token_estimate: Math.ceil(markdown.length / 4) }, sections: [{ spec_index: 0, title: original.name, markdown }], assembled: markdown, atom_base_url: "https://atom.example.invalid" };
  }
  const preview = assemblyPreview(body);
  const skillDocs: OverviewDocument[] = guideSkills.slice(1, 9).flatMap((skill, index) => !skill.entry_node_id ? [] : [
    { node_id: skill.entry_node_id, card_id: skill.entry_card_id, title: skill.name, depth: 1, chars: 280 + index * 21 },
    { node_id: skill.body_node_id, card_id: `${(skill.entry_card_id ?? skill.name).slice(0, 8)}-body-${index}`, title: `${skill.name} 본문`, depth: 2, chars: skill.lint?.body_chars ?? 2400 },
  ]);
  const sources = preview.manifest.sources.map((source, index) => {
    const section = preview.sections[index]!;
    const isSkillList = section.title === "스킬 목록";
    const documents: OverviewDocument[] = source.status !== "ok" ? [] : isSkillList
      ? [{ node_id: source.node_id, card_id: `${source.node_id.slice(0, 8)}-card`, title: "스킬 목록", depth: 0, chars: 0 }, ...skillDocs]
      : [
        { node_id: source.node_id, card_id: `${source.node_id.slice(0, 8)}-card`, title: section.title ?? "문서", depth: 0, chars: Math.min(source.chars, 900) },
        ...Array.from({ length: 4 }, (_, child) => ({ node_id: `${source.node_id.slice(0, 30)}${child}0`, card_id: `${source.node_id.slice(0, 30)}${child}1`, title: `절 ${child + 1}`, depth: 1 + (child === 3 ? 1 : 0), chars: 600 + child * 130 })),
      ];
    return { ...source, title: section.title, parent_title: "공통", documents };
  });
  return { ...preview, manifest: { ...preview.manifest, sources } };
}
