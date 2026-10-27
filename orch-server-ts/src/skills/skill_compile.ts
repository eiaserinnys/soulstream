import { createHash } from "node:crypto";

import { findSection, parseLinkBlocks, type LinkBlock, type LinkFields } from "./link_blocks.js";
import {
  computeActiveBindings,
  DEFAULT_MIN_JEV_SCORE,
  type ActiveDomainCatalogBinding,
  type DomainCatalogEntry,
  type LoadedAtomBody,
  type SkillCatalogEntry,
} from "./skill_catalog.js";
import { planPickSelections, type ResolvedIncludeTarget } from "./skill_pick_planner.js";

const COMPILE_DEADLINE_MS = 170_000;
const LARGE_CATALOG_CHARS = 8_000;

export interface LinkSource {
  node_id: string;
  version: number;
  sha256: string;
  chars: number;
}

export interface CompiledLinkSelection {
  name: string;
  reason: "include" | "above" | "pinned" | "only" | "jev";
  jev_score?: number;
  source?: LinkSource;
}

export interface CompiledLink {
  kind: "call" | "include" | "pick";
  line: number;
  axis?: string[];
  optional?: boolean;
  candidates: string[];
  selected: CompiledLinkSelection[];
  excluded: Array<{
    name: string;
    reason: "top" | "below_floor" | "bundle_axis" | "no_intent";
    jev_score?: number;
  }>;
  note?: string;
  when?: string;
}

export interface SkillCompileWarning {
  code: string;
  line?: number;
  message: string;
}

export interface CompileSkillResult {
  name: string;
  entry_version: number;
  body_version: number;
  compiled_markdown: string;
  links: CompiledLink[];
  active_bindings: ActiveDomainCatalogBinding[];
  pins: string[];
  warnings: SkillCompileWarning[];
  total_chars: number;
  policy: { version: 1; min_jev_score: number };
}

export interface SkillScoreInput {
  query: string;
  items: Array<{ key: string; text: string }>;
  context: Record<string, string>;
  timeoutMs: number;
}

export interface CompileSkillInput {
  skill: SkillCatalogEntry;
  entryVersion: number;
  body: LoadedAtomBody;
  skills: SkillCatalogEntry[];
  readBody: (nodeId: string) => Promise<LoadedAtomBody>;
  loadCatalogs: () => Promise<DomainCatalogEntry[]>;
  score: (input: SkillScoreInput) => Promise<Array<{ key: string; score: number }>>;
  intent?: string;
  pins?: string[];
  deadlineAt?: number;
}

export interface BrokenInclude {
  line: number;
  target: string;
  section?: string;
  cause: string;
}

export class IncludeResolutionError extends Error {
  readonly broken: BrokenInclude[];

  constructor(broken: BrokenInclude[]) {
    const details = broken.map(({ line, target, section, cause }) =>
      `- line ${line}: ${target}${section ? ` / ${section}` : ""}: ${cause}`,
    ).join("\n");
    super(`필수 include를 해결하지 못했습니다.\n${details}\n원문은 compile_subtree로 읽고 블록을 직접 따르라.`);
    this.name = "IncludeResolutionError";
    this.broken = broken;
  }
}

function charCount(value: string): number {
  return Array.from(value).length;
}

function sourceFor(body: LoadedAtomBody): LinkSource {
  return {
    node_id: body.nodeId,
    version: body.version,
    sha256: createHash("sha256").update(body.markdown, "utf8").digest("hex"),
    chars: charCount(body.markdown),
  };
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function axesText(axes: string[]): string {
  return `[${axes.join(", ")}]`;
}

function warning(code: string, message: string, line?: number): SkillCompileWarning {
  return { code, message, ...(line === undefined ? {} : { line }) };
}

async function compileWithinDeadline(input: CompileSkillInput, deadlineAt: number): Promise<CompileSkillResult> {
  const warnings: SkillCompileWarning[] = [];
  const links: CompiledLink[] = [];
  const brokenIncludes: BrokenInclude[] = [];
  const expandedCatalogSources = new Map<string, LinkSource>();
  let catalogs: DomainCatalogEntry[] | undefined;

  const remainingMs = () => deadlineAt - Date.now();
  const ensureTime = () => {
    if (remainingMs() <= 0) throw new Error("load_skill exceeded its 170 second deadline");
  };
  const loadCatalogList = async (): Promise<DomainCatalogEntry[]> => {
    ensureTime();
    catalogs ??= await input.loadCatalogs();
    ensureTime();
    return catalogs;
  };
  if (input.body.childCount > 0) {
    warnings.push(warning("body_has_children", `본문 노드 자식 ${input.body.childCount}개는 읽지 않았습니다.`));
  }

  const parsedMain = parseLinkBlocks(input.body.markdown);
  const mainPicks = parsedMain.blocks.filter(({ kind }) => kind === "pick");
  const mainIncludes = parsedMain.blocks.filter(({ kind }) => kind === "include");
  const skillByName = new Map(input.skills.map((skill) => [normalizedName(skill.name), skill]));
  const includeTargets = new Map<number, ResolvedIncludeTarget>();
  if (mainIncludes.length > 0) {
    const allCatalogs = await loadCatalogList();
    for (const block of mainIncludes) {
      const name = normalizedName(block.fields.include!);
      const targetSkill = skillByName.get(name);
      const targetCatalogs = allCatalogs.filter((catalog) => normalizedName(catalog.name) === name);
      includeTargets.set(block.startOffset, {
        ...(targetSkill ? { skill: targetSkill } : {}),
        ...(targetCatalogs[0] ? { catalog: targetCatalogs[0] } : {}),
        ambiguous: (targetSkill !== undefined && targetCatalogs.length > 0) || targetCatalogs.length > 1,
      });
    }
  }

  const planned = await planPickSelections({
    input,
    mainPicks,
    mainIncludes,
    includeTargets,
    loadCatalogList,
    ensureTime,
    remainingMs,
  });
  const pickPlans = planned.pickPlans;
  warnings.push(...planned.warnings);
  const activeBindings = computeActiveBindings(planned.selectedCatalogs);
  const bindingsBySource = new Map<string, ActiveDomainCatalogBinding[]>();
  for (const binding of activeBindings) {
    const values = bindingsBySource.get(binding.source_catalog) ?? [];
    values.push(binding);
    bindingsBySource.set(binding.source_catalog, values);
  }
  const renderLinkText = async (
    markdown: string,
    blocks: LinkBlock[],
    allowIncludeAndPick: boolean,
    nested: boolean,
  ): Promise<string> => {
    let output = "";
    let cursor = 0;
    for (const block of blocks) {
      output += markdown.slice(cursor, block.startOffset);
      cursor = block.endOffset;
      const fields = block.fields;
      if (block.kind === "call") {
        const target = skillByName.get(normalizedName(fields.call!));
        const link: CompiledLink = {
          kind: "call",
          line: block.line,
          candidates: [fields.call!],
          selected: [],
          excluded: [],
          ...(fields.note ? { note: fields.note } : {}),
          ...(fields.when ? { when: fields.when } : {}),
        };
        links.push(link);
        if (!target) {
          warnings.push(warning("missing_call", `call 대상 ${fields.call}을 찾지 못했습니다.`, block.line));
          output += `> 링크 오류: call ${fields.call} 대상을 찾을 수 없습니다.\n`;
        } else {
          output += `> 링크: call ${target.name}${fields.when ? ` (${fields.when})` : ""}\n`;
          output += `${target.description.trim().split(/\r?\n/u).map((line) => `> ${line}`).join("\n")}\n> 그때 load_skill로 부른다\n`;
        }
        continue;
      }

      if (nested || !allowIncludeAndPick) {
        warnings.push(warning("nested_link_unresolved", `펼친 글 안의 ${block.kind} 블록은 직접 해석하지 않았습니다.`, block.line));
        output += markdown.slice(block.startOffset, block.endOffset);
        continue;
      }

      if (block.kind === "include") {
        const targetName = fields.include!;
        const includeTarget = includeTargets.get(block.startOffset);
        const targetSkill = includeTarget?.skill;
        const targetCatalog = includeTarget?.catalog;
        if (includeTarget?.ambiguous) {
          brokenIncludes.push({ line: block.line, target: targetName, ...(fields.section ? { section: fields.section } : {}), cause: "이름 공간에서 대상이 모호함" });
          output += markdown.slice(block.startOffset, block.endOffset);
          continue;
        }
        if (!targetSkill && !targetCatalog) {
          brokenIncludes.push({ line: block.line, target: targetName, ...(fields.section ? { section: fields.section } : {}), cause: "대상 문서 없음" });
          output += markdown.slice(block.startOffset, block.endOffset);
          continue;
        }
        const bodyNodeId = targetSkill?.bodyNodeId ?? targetCatalog!.bodyNodeId;
        let targetBody: LoadedAtomBody;
        try {
          ensureTime();
          targetBody = await input.readBody(bodyNodeId);
          ensureTime();
        } catch {
          brokenIncludes.push({ line: block.line, target: targetName, ...(fields.section ? { section: fields.section } : {}), cause: "본문 조회 실패" });
          output += markdown.slice(block.startOffset, block.endOffset);
          continue;
        }
        let text = targetBody.markdown;
        if (fields.section) {
          const section = findSection(text, fields.section);
          if (!section.found) {
            brokenIncludes.push({
              line: block.line,
              target: targetName,
              section: fields.section,
              cause: section.code === "missing" ? "절 없음" : "절 모호",
            });
            output += markdown.slice(block.startOffset, block.endOffset);
            continue;
          }
          text = section.text;
        } else if (targetCatalog?.shards?.length) {
          text = `${text}\n\n${renderShardTable(targetCatalog)}`;
        }
        const source = sourceFor(targetBody);
        if (targetCatalog) expandedCatalogSources.set(normalizedName(targetCatalog.name), source);
        const link: CompiledLink = {
          kind: "include",
          line: block.line,
          candidates: [targetName],
          selected: [{ name: targetName, reason: "include", source }],
          excluded: [],
          ...(fields.note ? { note: fields.note } : {}),
        };
        links.push(link);
        output += `> 링크: include ${targetName}${fields.section ? ` 「${fields.section}」` : ""} (v${targetBody.version})\n`;
        const includeBindings = targetCatalog ? bindingsBySource.get(targetCatalog.name) ?? [] : [];
        if (includeBindings.length > 0) output += includeBindings.map(bindingLine).join("\n") + "\n";
        const nestedResult = await renderExpandedText(text, false, true);
        output += nestedResult;
        if (!nestedResult.endsWith("\n")) output += "\n";
        continue;
      }

      const plan = pickPlans.get(block.startOffset);
      if (!plan) {
        output += markdown.slice(block.startOffset, block.endOffset);
        continue;
      }
      const fieldsPick = block.fields as LinkFields & { axis: string[]; top: number; optional: boolean };
      const link: CompiledLink = {
        kind: "pick",
        line: block.line,
        axis: fieldsPick.axis,
        optional: fieldsPick.optional,
        candidates: plan.candidates.map(({ name }) => name),
        selected: [],
        excluded: plan.unresolvedCode ? [] : [...plan.preExcluded],
        ...(fieldsPick.note ? { note: fieldsPick.note } : {}),
      };
      links.push(link);
      const coveredBy = plan.coveredBy;
      if (coveredBy) {
        output += `> 링크: pick ${axesText(fieldsPick.axis)} → (bundle ${coveredBy}이 담당)\n`;
      }
      const alreadyExpanded = plan.selections.filter(({ reason }) => reason === "above").map(({ catalog }) => catalog.name);
      if (alreadyExpanded.length > 0) {
        output += `> 링크: pick ${axesText(fieldsPick.axis)} → ${alreadyExpanded.join(", ")} (위에서 펼침)\n`;
      }
      if (plan.allBelowFloor) {
        output += `> 링크: pick ${axesText(fieldsPick.axis)} → 없음 (모든 후보가 Jev 하한 ${DEFAULT_MIN_JEV_SCORE.toFixed(2)} 미만)\n`;
      }
      if (plan.noIntent) {
        output += `> 링크: pick ${axesText(fieldsPick.axis)} → 없음 (intent 없음)\n`;
      }
      for (const selection of plan.selections) {
        if (selection.reason === "above") {
          const source = expandedCatalogSources.get(normalizedName(selection.catalog.name));
          if (!source) {
            if (brokenIncludes.length === 0) {
              throw new Error(`No source metadata for previously expanded catalog ${selection.catalog.name}`);
            }
            continue;
          }
          link.selected.push({ name: selection.catalog.name, reason: "above", source });
          continue;
        }
        ensureTime();
        const selectedBody = await input.readBody(selection.catalog.bodyNodeId);
        ensureTime();
        const source = sourceFor(selectedBody);
        expandedCatalogSources.set(normalizedName(selection.catalog.name), source);
        link.selected.push({
          name: selection.catalog.name,
          reason: selection.reason,
          ...(selection.jevScore === undefined ? {} : { jev_score: selection.jevScore }),
          source,
        });
        const selectionLabel = selection.reason === "jev"
          ? ` (Jev ${selection.jevScore!.toFixed(2)})`
          : selection.reason === "pinned" ? " (pins)" : " (only)";
        output += `> 링크: pick ${axesText(fieldsPick.axis)} → ${selection.catalog.name}${selectionLabel}\n`;
        const bindings = bindingsBySource.get(selection.catalog.name) ?? [];
        if (bindings.length > 0) output += bindings.map(bindingLine).join("\n") + "\n";
        if (!selection.catalog.shards?.length && charCount(selectedBody.markdown) > LARGE_CATALOG_CHARS) {
          warnings.push(warning("large_catalog", `${selection.catalog.name} 본문이 ${LARGE_CATALOG_CHARS}자를 넘습니다.`, block.line));
        }
        const selectedText = selection.catalog.shards?.length
          ? `${selectedBody.markdown}\n\n${renderShardTable(selection.catalog)}`
          : selectedBody.markdown;
        const nestedResult = await renderExpandedText(selectedText, false, true);
        output += nestedResult;
        if (!nestedResult.endsWith("\n")) output += "\n";
      }
      if (!plan.unresolvedCode) {
        const selectedNames = new Set(plan.selections.map(({ catalog }) => catalog.name));
        for (const candidate of plan.candidates) {
          if (!selectedNames.has(candidate.name) && !plan.preExcluded.some(({ name }) => name === candidate.name)) {
            link.excluded.push({ name: candidate.name, reason: "top" });
          }
        }
      }
      if (plan.unresolvedCode) {
        const candidateText = plan.candidates.map(({ name, description, axis }) => `${name}: ${description} (${axis.join(", ")})`).join("; ") || "후보 없음";
        output += `> 링크: pick ${axesText(fieldsPick.axis)} 후보 ${candidateText}\n> 작업에 맞는 것을 골라 읽는다\n`;
      }
    }
    output += markdown.slice(cursor);
    return output;
  };

  async function renderExpandedText(text: string, allowIncludeAndPick: boolean, nested: boolean): Promise<string> {
    const parsed = parseLinkBlocks(text);
    for (const error of parsed.errors) warnings.push(warning("invalid_link_block", error.message, error.line));
    return renderLinkText(text, parsed.blocks, allowIncludeAndPick, nested);
  }

  const compiledMarkdown = await renderExpandedText(input.body.markdown, true, false);
  if (brokenIncludes.length > 0) throw new IncludeResolutionError(brokenIncludes);
  const totalChars = charCount(compiledMarkdown);
  const uniquePins = [...new Set([...pickPlans.values()].flatMap((plan) => plan.selections.map(({ catalog }) => catalog.name)))];
  return {
    name: input.skill.name,
    entry_version: input.entryVersion,
    body_version: input.body.version,
    compiled_markdown: compiledMarkdown,
    links,
    active_bindings: activeBindings,
    pins: uniquePins,
    warnings,
    total_chars: totalChars,
    policy: { version: 1, min_jev_score: DEFAULT_MIN_JEV_SCORE },
  };
}

function renderShardTable(catalog: DomainCatalogEntry): string {
  const rows = (catalog.shards ?? []).map((shard) =>
    `| ${escapeTable(shard.name)} | ${escapeTable(shard.nodeId)} | ${escapeTable((shard.cues ?? []).join(", "))} |`,
  );
  return ["| name | node_id | cues |", "| --- | --- | --- |", ...rows].join("\n");
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s*\n\s*/g, " ");
}

function bindingLine(binding: ActiveDomainCatalogBinding): string {
  return `> 바인딩: ${binding.source_catalog} → ${binding.target_catalog} (${binding.sheet_template})`;
}

export function compileSkill(input: CompileSkillInput): Promise<CompileSkillResult> {
  const deadlineAt = input.deadlineAt ?? Date.now() + COMPILE_DEADLINE_MS;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(new Error("load_skill exceeded its 170 second deadline"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("load_skill exceeded its 170 second deadline")), remaining);
  });
  return Promise.race([compileWithinDeadline(input, deadlineAt), deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
