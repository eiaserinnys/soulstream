// 구성 보기(AgentContextAssemblyView)의 자료와 순수 계산. 미리보기 응답을 줄로 바꾸고, 줄의 글을 만든다.
import { conditionSummary, type AgentAtomContext } from "./AgentAtomContextFields";
import { loadedHow, skillForCard, type LoadedHow, type SkillGuide } from "../lib/skill-guides";

/** 소스에 실린 문서 하나. depth는 소스 뿌리에서의 깊이다. */
export interface PreviewDocument { node_id: string; card_id: string | null; title: string; depth: number; chars: number }

/** 서버는 제목, 부모 제목, 실린 문서를 manifest.sources[i]에 싣는다. 문서 칸이 없는 옛 응답은 documents가 비어 있다. */
export interface ManifestSource {
  node_id: string;
  mode?: string;
  depth?: number;
  applies_when?: Record<string, unknown>;
  title?: string | null;
  parent_title?: string | null;
  documents?: PreviewDocument[];
  status: "ok" | "empty" | "error" | "filtered";
  chars: number;
  token_estimate: number;
}

/** sections[i]는 spec_index, title, markdown만 가진다. */
export interface PreviewSection { spec_index: number; title: string | null; markdown: string | null }

export interface PreviewResponse {
  manifest: { sources: ManifestSource[]; total_chars?: number; total_token_estimate?: number };
  assembled: string | null;
  sections: PreviewSection[];
  atom_base_url: string | null;
}

export type RowStatus = ManifestSource["status"] | "duplicate";

export interface Row {
  key: string;
  nodeId: string;
  context: AgentAtomContext;
  origin: string | null;
  title: string | null;
  parentTitle: string | null;
  /** 서버가 실린 문서를 주지 않은 옛 응답이면 null. 줄을 펼치지 않고 본문으로 바로 들어간다. */
  documents: PreviewDocument[] | null;
  status: RowStatus | null;
  tokens: number | null;
  chars: number | null;
  markdown: string | null;
}

type Specs = Array<{ context: AgentAtomContext; source: string }>;

export function buildRows(specs: Specs | null, data: PreviewResponse | null): Row[] {
  const sections = data?.sections ?? [];
  const sources = data?.manifest.sources ?? [];
  if (specs) {
    return specs.map(({ context, source }, index) => {
      const at = sections.findIndex((section) => section.spec_index === index);
      const manifest = at >= 0 ? sources[at] : null;
      return {
        key: `${index}`,
        nodeId: context.node_id,
        context,
        origin: source,
        title: at >= 0 ? manifest?.title ?? sections[at]!.title : null,
        parentTitle: manifest?.parent_title ?? null,
        documents: manifest?.documents ?? null,
        status: data ? (manifest?.status ?? "duplicate") : null,
        tokens: manifest?.token_estimate ?? null,
        chars: manifest?.chars ?? null,
        markdown: at >= 0 ? sections[at]!.markdown : null,
      };
    });
  }
  return sections.map((section, index) => {
    const manifest = sources[index]!;
    return {
      key: `${section.spec_index}`,
      nodeId: manifest.node_id,
      context: { node_id: manifest.node_id, depth: manifest.depth, mode: manifest.mode as AgentAtomContext["mode"], applies_when: manifest.applies_when },
      origin: "노드 설정",
      title: manifest.title ?? section.title,
      parentTitle: manifest.parent_title ?? null,
      documents: manifest.documents ?? null,
      status: manifest.status,
      tokens: manifest.token_estimate,
      chars: manifest.chars,
      markdown: section.markdown,
    };
  });
}

export function rowTitle(row: Row): string {
  return row.title ?? row.nodeId.slice(0, 8);
}

export function contextShape(context: AgentAtomContext): string {
  const mode = context.mode === "index" ? "색인 · " : context.mode === "titles" ? "제목만 · " : "전체 · ";
  return `${mode}깊이 ${context.depth ?? 3}`;
}

export function rowMeta(row: Row): string {
  return [row.origin, contextShape(row.context), conditionSummary(row.context.applies_when) || null].filter(Boolean).join(" · ");
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

export interface ListedSkill { skill: SkillGuide; rowKey: string; how: LoadedHow }

/** 상시 목록의 스킬: 실린 문서 가운데 스킬 엔트리 카드인 것. 주입 순서대로, 이름마다 한 번만. */
export function collectListedSkills(rows: readonly Row[], skillsByCard: ReadonlyMap<string, SkillGuide>): ListedSkill[] {
  const seen = new Map<string, ListedSkill>();
  for (const row of rows) {
    const documents = row.documents ?? [];
    const nodeIds = new Set(documents.map(document => document.node_id));
    for (const document of documents) {
      const skill = skillForCard(skillsByCard, document.card_id);
      const how = skill ? loadedHow(row.context, document, skillsByCard, nodeIds) : null;
      if (skill && how && !seen.has(skill.name)) seen.set(skill.name, { skill, rowKey: row.key, how });
    }
  }
  return Array.from(seen.values());
}

/** 한 소스에 실린 스킬의 정의 원문 후보(본문 노드). */
export function skillChoices(row: Row, skillsByCard: ReadonlyMap<string, SkillGuide>): Array<{ name: string; nodeId: string }> {
  return (row.documents ?? []).flatMap((document) => {
    const skill = skillForCard(skillsByCard, document.card_id);
    return skill ? [{ name: skill.name, nodeId: skill.body_node_id }] : [];
  });
}
