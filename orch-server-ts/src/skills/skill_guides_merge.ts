import type { DomainCatalogEntry, SkillCatalogEntry } from "./skill_catalog.js";
import type { StoredSkillLintReport } from "./skill_lint_report_store.js";

type Json = Record<string, unknown>;
export type GuideFinding = { code: string; level: string; message: string };
export type GuideLink = { kind: string | null; target: string; target_kind: string };

function record(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;
}
function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.flatMap((item) => { const r = record(item); return r ? [r] : []; }) : [];
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function levelOf(code: string): string {
  return code.startsWith("E") ? "error" : code.startsWith("I") ? "info" : "warning";
}

/** 보고의 최상위 findings를 이름별로 모은다. affected가 있으면 거기 든 이름, 없으면 target 하나에 건다. */
function topLevelByName(report: Json): { all: Json[]; byName: Map<string, Json[]> } {
  const all = records(report.findings);
  const byName = new Map<string, Json[]>();
  for (const finding of all) {
    const affected = strings(finding.affected);
    const names = affected.length > 0 ? affected : typeof finding.target === "string" ? [finding.target] : [];
    for (const name of new Set(names)) byName.set(name, [...(byName.get(name) ?? []), finding]);
  }
  return { all, byName };
}

function normalizeFindings(own: unknown, related: Json[]): GuideFinding[] {
  const result: GuideFinding[] = [];
  const seen = new Set<string>();
  const add = (code: string, level: unknown, message: unknown) => {
    const finding = { code, level: typeof level === "string" ? level : levelOf(code), message: typeof message === "string" ? message : "" };
    const key = `${finding.code}\u0000${finding.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(finding);
  };
  const ownItems = Array.isArray(own) ? own : [];
  for (const item of ownItems) {
    if (typeof item === "string") {
      const match = related.find((finding) => finding.code === item);
      add(item, match?.level, match?.message ?? "");
    } else {
      const object = record(item);
      if (object && typeof object.code === "string") add(object.code, object.level, object.message);
    }
  }
  for (const finding of related) if (typeof finding.code === "string") add(finding.code, finding.level, finding.message);
  return result;
}

function linksOf(skill: Json, catalogNames: ReadonlySet<string>): GuideLink[] {
  if (Array.isArray(skill.links)) {
    return records(skill.links).flatMap((link) => typeof link.target === "string" ? [{
      kind: typeof link.kind === "string" ? link.kind : null,
      target: link.target,
      target_kind: typeof link.target_kind === "string" ? link.target_kind : catalogNames.has(link.target) ? "catalog" : "skill",
    }] : []);
  }
  return strings(skill.dependencies).map((target) => ({
    kind: null, target, target_kind: catalogNames.has(target) ? "catalog" : "skill",
  }));
}

export function mergeSkillGuides(
  skills: readonly SkillCatalogEntry[],
  catalogs: readonly DomainCatalogEntry[],
  stored: StoredSkillLintReport | null,
) {
  const report = stored?.report ?? null;
  const reportSkills = new Map(records(report?.skills).flatMap((item) => typeof item.name === "string" ? [[item.name, item] as const] : []));
  const reportCatalogs = new Map(records(report?.catalogs).flatMap((item) => typeof item.name === "string" ? [[item.name, item] as const] : []));
  const catalogNames = new Set<string>([...reportCatalogs.keys(), ...catalogs.map((catalog) => catalog.name)]);
  const top = report ? topLevelByName(report) : { all: [], byName: new Map<string, Json[]>() };

  return {
    skills: skills.map((entry) => {
      const item = reportSkills.get(entry.name);
      return {
        name: entry.name,
        description: entry.description,
        entry_node_id: entry.nodeId ?? null,
        entry_card_id: entry.cardId ?? null,
        body_node_id: entry.bodyNodeId,
        lint: item ? {
          body_chars: typeof item.body_chars === "number" ? item.body_chars : 0,
          links: linksOf(item, catalogNames),
          called_by: strings(item.called_by),
          block_counts: record(item.block_counts) ?? { call: 0, include: 0, pick: 0 },
          agent_count: typeof item.agent_count === "number" ? item.agent_count : 0,
          findings: normalizeFindings(item.findings, top.byName.get(entry.name) ?? []),
        } : null,
      };
    }),
    catalogs: catalogs.map((entry) => {
      const item = reportCatalogs.get(entry.name);
      return {
        name: entry.name,
        description: entry.description,
        node_id: entry.nodeId ?? null,
        card_id: entry.cardId ?? null,
        lint: item ? {
          axis: strings(item.axis),
          composition: typeof item.composition === "string" ? item.composition : "",
          used_by: strings(item.used_by),
          findings: normalizeFindings(item.findings, top.byName.get(entry.name) ?? []),
        } : null,
      };
    }),
    report: stored ? {
      generated_at: typeof report!.generated_at === "string" ? report!.generated_at : null,
      uploaded_at: stored.uploaded_at,
      uploaded_by_session_id: stored.uploaded_by_session_id,
      verify_job_id: stored.verify_job_id,
      findings: top.all,
    } : null,
  };
}
