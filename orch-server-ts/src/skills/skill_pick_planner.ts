import {
  catalogEvaluationText,
  DEFAULT_MIN_JEV_SCORE,
  type DomainCatalogEntry,
  type SkillCatalogEntry,
} from "./skill_catalog.js";
import type { LinkBlock, LinkFields } from "./link_blocks.js";
import type { CompileSkillInput, SkillCompileWarning } from "./skill_compile.js";

export interface ResolvedIncludeTarget {
  skill?: SkillCatalogEntry;
  catalog?: DomainCatalogEntry;
  ambiguous: boolean;
}

export interface PickPlan {
  block: LinkBlock;
  candidates: DomainCatalogEntry[];
  preExcluded: Array<{ name: string; reason: "top" | "below_floor" | "bundle_axis" | "already_expanded" }>;
  pinned: DomainCatalogEntry[];
  includedBefore: DomainCatalogEntry[];
  needsJev: boolean;
  jevCandidates: DomainCatalogEntry[];
  unresolvedCode?: "unresolved_pick" | "jev_failed";
  coveredBy?: string;
  selections: Array<{
    catalog: DomainCatalogEntry;
    reason: "pinned" | "only" | "jev";
    jevScore?: number;
  }>;
}

export interface PickPlanningResult {
  pickPlans: Map<number, PickPlan>;
  warnings: SkillCompileWarning[];
  selectedCatalogs: DomainCatalogEntry[];
}

function warning(code: string, message: string, line?: number): SkillCompileWarning {
  return { code, message, ...(line === undefined ? {} : { line }) };
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function containsAxis(catalog: DomainCatalogEntry, axes: string[]): boolean {
  return catalog.axis.some((axis) => axes.includes(axis));
}

function bundleConflict(catalog: DomainCatalogEntry, occupied: Map<string, string>): string | undefined {
  return catalog.axis.map((axis) => occupied.get(axis)).find((name) => name !== undefined);
}

export async function planPickSelections({
  input,
  mainPicks,
  mainIncludes,
  includeTargets,
  loadCatalogList,
  ensureTime,
  remainingMs,
}: {
  input: CompileSkillInput;
  mainPicks: LinkBlock[];
  mainIncludes: LinkBlock[];
  includeTargets: Map<number, ResolvedIncludeTarget>;
  loadCatalogList: () => Promise<DomainCatalogEntry[]>;
  ensureTime: () => void;
  remainingMs: () => number;
}): Promise<PickPlanningResult> {
  const warnings: SkillCompileWarning[] = [];
  const expandedCatalogNames = new Set<string>();
  const occupiedBundleAxes = new Map<string, string>();
  const pickPlans = new Map<number, PickPlan>();
  let allCatalogs: DomainCatalogEntry[] = [];

  if (mainPicks.length > 0) {
    allCatalogs = await loadCatalogList();
    for (const block of mainPicks) {
      const fields = block.fields as LinkFields & { axis: string[]; top: number; optional: boolean };
      const matching = allCatalogs.filter((catalog) => containsAxis(catalog, fields.axis));
      const preExcluded: PickPlan["preExcluded"] = [];
      const includedBefore = mainIncludes
        .filter((include) => include.endOffset <= block.startOffset)
        .flatMap((include) => {
          const target = includeTargets.get(include.startOffset);
          return target?.catalog && !target.ambiguous ? [target.catalog] : [];
        });
      const includedNames = new Set(includedBefore.map(({ name }) => normalizedName(name)));
      const candidates = matching.filter((catalog) => {
        if (includedNames.has(normalizedName(catalog.name))) {
          preExcluded.push({ name: catalog.name, reason: "already_expanded" });
          return false;
        }
        return true;
      });
      const pinnedAlready = new Set<string>();
      const pinnedCandidates = (input.pins ?? []).flatMap((name) => {
        const catalog = candidates.find((candidate) => normalizedName(candidate.name) === normalizedName(name));
        if (!catalog || pinnedAlready.has(catalog.name) || pinnedAlready.size >= fields.top) return [];
        pinnedAlready.add(catalog.name);
        return [catalog];
      });
      pickPlans.set(block.startOffset, {
        block,
        candidates,
        preExcluded,
        pinned: pinnedCandidates,
        includedBefore,
        needsJev: false,
        jevCandidates: [],
        selections: pinnedCandidates.map((catalog) => ({ catalog, reason: "pinned" as const })),
      });
    }
  }

  const simulatedExpandedNames = new Set<string>();
  const simulatedBundleAxes = new Map<string, string>();
  let selectionUncertain = false;
  for (const plan of pickPlans.values()) {
    const fields = plan.block.fields as LinkFields & { axis: string[]; top: number; optional: boolean };
    for (const catalog of plan.includedBefore) {
      simulatedExpandedNames.add(catalog.name);
      if (catalog.composition === "bundle") {
        for (const axis of catalog.axis) {
          if (!simulatedBundleAxes.has(axis)) simulatedBundleAxes.set(axis, catalog.name);
        }
      }
    }
    if (fields.axis.every((axis) => simulatedBundleAxes.has(axis))) continue;

    const simulatedPins: DomainCatalogEntry[] = [];
    for (const catalog of plan.pinned) {
      if (simulatedExpandedNames.has(catalog.name) || bundleConflict(catalog, simulatedBundleAxes)) continue;
      simulatedPins.push(catalog);
      if (!selectionUncertain) {
        simulatedExpandedNames.add(catalog.name);
        if (catalog.composition === "bundle") {
          for (const axis of catalog.axis) simulatedBundleAxes.set(axis, catalog.name);
        }
      }
    }

    const slotCount = Math.max(0, fields.top - simulatedPins.length);
    const candidatePool = plan.candidates.filter((catalog) =>
      !plan.pinned.some(({ name }) => name === catalog.name) &&
      !simulatedExpandedNames.has(catalog.name) &&
      !bundleConflict(catalog, simulatedBundleAxes),
    );
    plan.needsJev = slotCount > 0 && (fields.optional || candidatePool.length > slotCount);
    if (plan.needsJev) {
      plan.jevCandidates = candidatePool;
      if (input.intent?.trim() && candidatePool.length > 0) selectionUncertain = true;
      continue;
    }

    if (selectionUncertain) continue;
    let selectedCount = simulatedPins.length;
    for (const catalog of candidatePool) {
      if (selectedCount >= fields.top || bundleConflict(catalog, simulatedBundleAxes)) continue;
      simulatedExpandedNames.add(catalog.name);
      selectedCount += 1;
      if (catalog.composition === "bundle") {
        for (const axis of catalog.axis) simulatedBundleAxes.set(axis, catalog.name);
      }
    }
  }

  const needsJevPlans = [...pickPlans.values()].filter((plan) => plan.needsJev);
  let jevScoreByName = new Map<string, number>();
  let jevFailed = false;
  const jevCandidateNames = [...new Set(needsJevPlans.flatMap((plan) => plan.jevCandidates.map(({ name }) => name)))];
  if (needsJevPlans.length > 0 && input.intent?.trim() && jevCandidateNames.length > 0) {
    try {
      ensureTime();
      const scores = await input.score({
        query: input.intent,
        items: jevCandidateNames.map((name) => {
          const catalog = allCatalogs.find((entry) => entry.name === name)!;
          return { key: name, text: catalogEvaluationText(catalog) };
        }),
        context: { skill_name: input.skill.name, skill_description: input.skill.description },
        timeoutMs: Math.max(1, remainingMs()),
      });
      if (scores.length !== jevCandidateNames.length || scores.some(({ key, score }) =>
        !jevCandidateNames.includes(key) || typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1,
      ) || jevCandidateNames.some((name) => !scores.some(({ key }) => key === name))) {
        throw new Error("Jev returned incomplete or invalid scores");
      }
      jevScoreByName = new Map(scores.map(({ key, score }) => [key, score]));
    } catch {
      jevFailed = true;
    }
  }

  for (const plan of pickPlans.values()) {
    const fields = plan.block.fields as LinkFields & { axis: string[]; top: number; optional: boolean };
    for (const catalog of plan.includedBefore) {
      expandedCatalogNames.add(catalog.name);
      if (catalog.composition === "bundle") {
        for (const axis of catalog.axis) {
          if (!occupiedBundleAxes.has(axis)) occupiedBundleAxes.set(axis, catalog.name);
        }
      }
    }
    const coveredBundles = [...new Set(fields.axis.map((axis) => occupiedBundleAxes.get(axis)).filter((name): name is string => name !== undefined))];
    const isCovered = fields.axis.length > 0 && fields.axis.every((axis) => occupiedBundleAxes.has(axis));
    if (isCovered) {
      for (const catalog of plan.candidates) {
        if (catalog.axis.some((axis) => occupiedBundleAxes.has(axis))) plan.preExcluded.push({ name: catalog.name, reason: "bundle_axis" });
      }
      plan.selections = [];
      plan.coveredBy = coveredBundles[0];
      continue;
    }

    for (const catalog of plan.candidates) {
      if (expandedCatalogNames.has(catalog.name) && !plan.preExcluded.some((entry) => entry.name === catalog.name)) {
        plan.preExcluded.push({ name: catalog.name, reason: "already_expanded" });
      }
    }

    const validPinned: PickPlan["selections"] = [];
    for (const selection of plan.selections) {
      if (expandedCatalogNames.has(selection.catalog.name)) {
        if (!plan.preExcluded.some(({ name, reason }) => name === selection.catalog.name && reason === "already_expanded")) {
          plan.preExcluded.push({ name: selection.catalog.name, reason: "already_expanded" });
        }
        continue;
      }
      if (bundleConflict(selection.catalog, occupiedBundleAxes)) {
        plan.preExcluded.push({ name: selection.catalog.name, reason: "bundle_axis" });
        continue;
      }
      validPinned.push(selection);
      expandedCatalogNames.add(selection.catalog.name);
      if (selection.catalog.composition === "bundle") {
        for (const axis of selection.catalog.axis) occupiedBundleAxes.set(axis, selection.catalog.name);
      }
    }
    plan.selections = validPinned;

    let slotCount = Math.max(0, fields.top - plan.selections.length);
    const remainingCandidates = plan.candidates.filter((catalog) => {
      if (plan.pinned.some(({ name }) => name === catalog.name) || expandedCatalogNames.has(catalog.name)) return false;
      if (!bundleConflict(catalog, occupiedBundleAxes)) return true;
      if (!plan.preExcluded.some(({ name, reason }) => name === catalog.name && reason === "bundle_axis")) {
        plan.preExcluded.push({ name: catalog.name, reason: "bundle_axis" });
      }
      return false;
    });
    const useOnly = slotCount > 0 && !fields.optional && remainingCandidates.length <= slotCount;
    if (!useOnly && slotCount > 0 && plan.needsJev) {
      if (!input.intent?.trim()) plan.unresolvedCode = "unresolved_pick";
      else if (jevFailed) plan.unresolvedCode = "jev_failed";
    }
    const ranked = remainingCandidates.map((catalog, index) => ({
      catalog,
      score: jevScoreByName.get(catalog.name),
      order: index,
    })).sort((left, right) => (right.score ?? -1) - (left.score ?? -1) || left.order - right.order);

    const queue = useOnly
      ? remainingCandidates.map((catalog) => ({ catalog, reason: "only" as const, score: undefined }))
      : plan.unresolvedCode
        ? []
        : ranked.map(({ catalog, score }) => ({ catalog, reason: "jev" as const, score }));
    for (const candidate of queue) {
      if (plan.selections.length >= fields.top) {
        plan.preExcluded.push({ name: candidate.catalog.name, reason: "top" });
        continue;
      }
      if (bundleConflict(candidate.catalog, occupiedBundleAxes)) {
        plan.preExcluded.push({ name: candidate.catalog.name, reason: "bundle_axis" });
        continue;
      }
      if (candidate.reason === "jev" && candidate.score === undefined) continue;
      if (fields.optional && candidate.reason === "jev" && candidate.score! < DEFAULT_MIN_JEV_SCORE) {
        plan.preExcluded.push({ name: candidate.catalog.name, reason: "below_floor" });
        continue;
      }
      plan.selections.push({
        catalog: candidate.catalog,
        reason: candidate.reason,
        ...(candidate.score === undefined ? {} : { jevScore: candidate.score }),
      });
      expandedCatalogNames.add(candidate.catalog.name);
      if (candidate.catalog.composition === "bundle") {
        for (const axis of candidate.catalog.axis) occupiedBundleAxes.set(axis, candidate.catalog.name);
      }
    }
    slotCount = Math.max(0, fields.top - plan.selections.length);
    const alreadyExpandedOnly = remainingCandidates.length === 0 && plan.preExcluded.some(({ reason }) => reason === "already_expanded");
    if (slotCount > 0 && plan.candidates.length === 0 && !alreadyExpandedOnly) plan.unresolvedCode ??= "unresolved_pick";
    if (slotCount > 0 && !plan.unresolvedCode && !alreadyExpandedOnly && !useOnly && plan.needsJev) {
      plan.unresolvedCode = "unresolved_pick";
    }
    if (plan.unresolvedCode) {
      const code = plan.unresolvedCode;
      warnings.push(warning(code, code === "jev_failed"
        ? "Jev 평가에 실패했습니다. 후보를 확인하고 필요한 카탈로그를 직접 읽으세요."
        : "선택을 결정하지 못했습니다. 작업에 맞는 후보를 직접 읽으세요.", plan.block.line));
    }
  }

  const includedCatalogs = [...includeTargets.values()].flatMap((target) => target.catalog && !target.ambiguous ? [target.catalog] : []);
  const pickedCatalogs = [...pickPlans.values()].flatMap((plan) => plan.selections.map(({ catalog }) => catalog));
  const selectedCatalogs = [...new Map([...includedCatalogs, ...pickedCatalogs].map((catalog) => [catalog.name, catalog])).values()];
  return { pickPlans, warnings, selectedCatalogs };
}
