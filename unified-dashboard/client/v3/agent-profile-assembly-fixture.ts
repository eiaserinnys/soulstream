import type { AgentAtomContext } from "../components/AgentAtomContextFields";

// Invented text and identifiers; these fixtures have the shape and lengths of real assemblies.
const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003", "10000000-0000-4000-8000-000000000004", "10000000-0000-4000-8000-000000000005"];
const skillId = "20000000-0000-4000-8000-000000000001";
export const assemblyBundles = [
  { bundle_id: "공통 지침과 긴 이름을 가진 검수용 번들", description: "견본", atom_contexts: [{ node_id: ids[0], depth: 5 }, { node_id: ids[1], depth: 1 }], version: 1, created_at: "", updated_at: "" },
  { bundle_id: "실행 조건", description: "견본", atom_contexts: [{ node_id: ids[2], depth: 2, applies_when: { backend: ["codex"], card_role: ["assignee"] } }, { node_id: ids[3], depth: 1 }], version: 1, created_at: "", updated_at: "" },
];
export const assemblyContexts: AgentAtomContext[] = [{ node_id: ids[4]!, depth: 3 }];
export const assemblyAgents = [
  { id: "roselin", name: "검수 프로필", backend: "claude", source: "db" },
  { id: "node-sample", name: "노드 전용 검수 프로필", backend: "codex", source: "yaml" },
];

const titles: Record<string, string> = {
  [ids[0]!]: "공통 지침과 아주 긴 제목이 화면에서 잘리지 않고 안전하게 표시되는지 확인하는 검수용 소스",
  [ids[1]!]: "스킬 목록", [ids[2]!]: "조건부 지침", [ids[3]!]: "실패 소스", [ids[4]!]: "프로필 지침", [skillId]: "검수 스킬",
};
const contents: Record<string, string> = {
  [ids[0]!]: "# 공통 지침\n\n" + "이 문장은 긴 본문의 선택과 스크롤을 확인하는 가상의 검수 데이터입니다.\n".repeat(1400),
  [ids[1]!]: `# 스킬 목록\n\n## ~ 검수 스킬\ndescription: 검수에 쓰는 가상의 스킬\nbody_node_id: ${skillId}\n`,
  [ids[2]!]: "# 조건부 지침\n\ncodex 담당 조건에서 포함됩니다.",
  [ids[4]!]: "# 프로필 지침\n\n화면에서 조립된 내용을 확인합니다.\n".repeat(40),
  [skillId]: "# 검수 스킬\n\n가상의 스킬 정의 원문입니다.",
};

export function assemblyPreview(body: { atom_contexts?: AgentAtomContext[]; agent_id?: string; session?: { backend?: string; card_role?: string } }) {
  const specs = body.atom_contexts ?? (body.agent_id ? [...assemblyBundles.flatMap((bundle) => bundle.atom_contexts), ...assemblyContexts] : []);
  const seen = new Set<string>();
  const entries = specs.flatMap((spec, spec_index) => {
    const key = JSON.stringify(spec);
    if (seen.has(key)) return [];
    seen.add(key);
    const condition = spec.applies_when as { backend?: string[]; card_role?: string[] } | undefined;
    const filtered = Boolean((condition?.backend && !condition.backend.includes(body.session?.backend ?? "")) || (condition?.card_role && !condition.card_role.includes(body.session?.card_role ?? "")));
    const status = filtered ? "filtered" : spec.node_id === ids[3] ? "error" : contents[spec.node_id] ? "ok" : "empty";
    const markdown = status === "ok" ? contents[spec.node_id]! : null;
    return [{ source: { ...spec, status, chars: markdown?.length ?? 0, token_estimate: Math.ceil((markdown?.length ?? 0) / 4) }, section: { spec_index, title: titles[spec.node_id] ?? null, markdown } }];
  });
  const assembled = entries.map((entry) => entry.section.markdown).filter(Boolean).join("\n\n");
  return { manifest: { sources: entries.map((entry) => entry.source), total_chars: assembled.length, total_token_estimate: Math.ceil(assembled.length / 4) }, sections: entries.map((entry) => entry.section), assembled, atom_base_url: "https://atom.example.invalid" };
}
