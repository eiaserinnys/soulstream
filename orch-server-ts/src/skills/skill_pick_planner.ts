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
  preExcluded: Array<{
    name: string;
    reason: "top" | "below_floor" | "bundle_axis" | "no_intent";
    jev_score?: number;
  }>;
  pinned: DomainCatalogEntry[];
  includedBefore: DomainCatalogEntry[];
  needsJev: boolean;
  jevCandidates: DomainCatalogEntry[];
  unresolvedCode?: "unresolved_pick" | "jev_failed";
  noIntent?: boolean;
  coveredBy?: string;
  allBelowFloor?: boolean;
  selections: Array<{
    catalog: DomainCatalogEntry;
    reason: "above" | "pinned" | "only" | "jev";
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

function occupyBundleAxes(catalog: DomainCatalogEntry, occupied: Map<string, string>): void {
  if (catalog.composition !== "bundle") return;
  for (const axis of catalog.axis) {
    if (!occupied.has(axis)) occupied.set(axis, catalog.name);
  }
}

function addExcluded(
  plan: PickPlan,
  name: string,
  reason: PickPlan["preExcluded"][number]["reason"],
  jevScore?: number,
): void {
  const existing = plan.preExcluded.find((item) => item.name === name && item.reason === reason);
  if (existing) {
    if (jevScore !== undefined) existing.jev_score = jevScore;
    return;
  }
  plan.preExcluded.push({ name, reason, ...(jevScore === undefined ? {} : { jev_score: jevScore }) });
}

type PickFields = LinkFields & { axis: string[]; top: number; optional: boolean };

function pickFields(block: LinkBlock): PickFields {
  return block.fields as PickFields;
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
  const pinNames = input.pins ?? [];
  const hasIntent = Boolean(input.intent?.trim());
  let allCatalogs: DomainCatalogEntry[] = [];

  if (mainPicks.length > 0) {
    allCatalogs = await loadCatalogList();
    for (const block of mainPicks) {
      const fields = pickFields(block);
      const candidates = allCatalogs.filter((catalog) => containsAxis(catalog, fields.axis));
      const includedBefore = mainIncludes
        .filter((include) => include.endOffset <= block.startOffset)
        .flatMap((include) => {
          const target = includeTargets.get(include.startOffset);
          return target?.catalog && !target.ambiguous ? [target.catalog] : [];
        });
      const pinned: DomainCatalogEntry[] = [];
      const pinnedNames = new Set<string>();
      for (const pinName of pinNames) {
        const catalog = candidates.find((candidate) => normalizedName(candidate.name) === normalizedName(pinName));
        if (!catalog || pinnedNames.has(normalizedName(catalog.name))) continue;
        pinnedNames.add(normalizedName(catalog.name));
        pinned.push(catalog);
      }
      pickPlans.set(block.startOffset, {
        block,
        candidates,
        preExcluded: [],
        pinned,
        includedBefore,
        needsJev: false,
        jevCandidates: [],
        selections: [],
      });
    }
  }

  const distinctPins = [...new Map(pinNames.map((name) => [normalizedName(name), name])).values()];
  const usedPinNames = new Set([...pickPlans.values()].flatMap((plan) => plan.pinned.map(({ name }) => normalizedName(name))));
  const unusedPins = distinctPins.filter((name) => !usedPinNames.has(normalizedName(name)));
  if (unusedPins.length > 0) {
    warnings.push(warning("pin_unused", `어느 pick 후보에도 없는 pin: ${unusedPins.join(", ")}`));
  }

  // Simulate only choices that are already deterministic. It collects all Jev candidates
  // for one request; the final pass applies those scores against the real prior selections.
  const simulatedExpandedNames = new Set<string>();
  const simulatedBundleAxes = new Map<string, string>();
  let selectionUncertain = false;
  for (const plan of pickPlans.values()) {
    const fields = pickFields(plan.block);
    for (const catalog of plan.includedBefore) {
      simulatedExpandedNames.add(catalog.name);
      occupyBundleAxes(catalog, simulatedBundleAxes);
    }

    const bundleAxesAtBlockStart = new Map(simulatedBundleAxes);
    const alreadyExpanded = plan.candidates.filter((catalog) => simulatedExpandedNames.has(catalog.name));
    const currentPins = plan.pinned.filter((catalog) => !simulatedExpandedNames.has(catalog.name));
    for (const catalog of currentPins) {
      simulatedExpandedNames.add(catalog.name);
      occupyBundleAxes(catalog, simulatedBundleAxes);
    }

    const slots = Math.max(0, fields.top - alreadyExpanded.length - currentPins.length);
    const remainingCandidates = plan.candidates.filter((catalog) => {
      if (simulatedExpandedNames.has(catalog.name)) return false;
      if (bundleConflict(catalog, bundleAxesAtBlockStart)) {
        addExcluded(plan, catalog.name, "bundle_axis");
        return false;
      }
      return true;
    });
    const selectableCandidates = remainingCandidates.filter((catalog) => !bundleConflict(catalog, simulatedBundleAxes));
    for (const catalog of remainingCandidates) {
      if (bundleConflict(catalog, simulatedBundleAxes)) addExcluded(plan, catalog.name, "top");
    }

    plan.needsJev = slots > 0 && (fields.optional || selectableCandidates.length > slots);
    plan.jevCandidates = selectableCandidates;
    if (plan.needsJev && hasIntent && selectableCandidates.length > 0) selectionUncertain = true;

    if (plan.needsJev || selectionUncertain) continue;
    let selectedCount = alreadyExpanded.length + currentPins.length;
    for (const catalog of selectableCandidates) {
      if (selectedCount >= fields.top || bundleConflict(catalog, simulatedBundleAxes)) continue;
      simulatedExpandedNames.add(catalog.name);
      selectedCount += 1;
      occupyBundleAxes(catalog, simulatedBundleAxes);
    }
  }

  const needsJevPlans = [...pickPlans.values()].filter((plan) => plan.needsJev);
  const jevCandidateNames = [...new Set(needsJevPlans.flatMap((plan) => plan.jevCandidates.map(({ name }) => name)))];
  let jevScoreByName = new Map<string, number>();
  let jevFailed = false;
  if (hasIntent && jevCandidateNames.length > 0) {
    try {
      ensureTime();
      const scores = await input.score({
        query: input.intent!,
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

  let missingIntentNeeded = false;
  for (const plan of pickPlans.values()) {
    const fields = pickFields(plan.block);
    for (const catalog of plan.includedBefore) {
      expandedCatalogNames.add(catalog.name);
      occupyBundleAxes(catalog, occupiedBundleAxes);
    }

    const bundleAxesAtBlockStart = new Map(occupiedBundleAxes);
    const coveredBundles = [...new Set(fields.axis
      .map((axis) => occupiedBundleAxes.get(axis))
      .filter((name): name is string => name !== undefined))];
    const alreadyExpanded = plan.candidates.filter((catalog) => expandedCatalogNames.has(catalog.name));
    plan.selections = alreadyExpanded.map((catalog) => ({ catalog, reason: "above" as const }));
    const currentPins = plan.pinned.filter((catalog) => !expandedCatalogNames.has(catalog.name));
    for (const catalog of currentPins) {
      plan.selections.push({ catalog, reason: "pinned" });
      expandedCatalogNames.add(catalog.name);
      occupyBundleAxes(catalog, occupiedBundleAxes);
    }

    if (fields.axis.length > 0 && fields.axis.every((axis) => bundleAxesAtBlockStart.has(axis))) {
      plan.coveredBy = coveredBundles[0];
    }

    const slots = Math.max(0, fields.top - plan.selections.length);
    const selectedNames = new Set(plan.selections.map(({ catalog }) => catalog.name));
    const remainingCandidates = plan.candidates.filter((catalog) => {
      if (selectedNames.has(catalog.name) || expandedCatalogNames.has(catalog.name)) return false;
      if (bundleConflict(catalog, bundleAxesAtBlockStart)) {
        addExcluded(plan, catalog.name, "bundle_axis");
        return false;
      }
      return true;
    });
    const selectableCandidates = remainingCandidates.filter((catalog) => !bundleConflict(catalog, occupiedBundleAxes));
    for (const catalog of remainingCandidates) {
      if (bundleConflict(catalog, occupiedBundleAxes)) addExcluded(plan, catalog.name, "top");
    }

    const useOnly = slots > 0 && !fields.optional && selectableCandidates.length <= slots;
    let queue: Array<{ catalog: DomainCatalogEntry; reason: "only" | "jev"; score?: number }> = [];

    if (slots > 0 && !hasIntent) {
      if (fields.optional) {
        plan.noIntent = true;
        missingIntentNeeded = true;
        for (const catalog of selectableCandidates) addExcluded(plan, catalog.name, "no_intent");
      } else if (useOnly) {
        queue = selectableCandidates.map((catalog) => ({ catalog, reason: "only" }));
      } else {
        plan.unresolvedCode = "unresolved_pick";
        missingIntentNeeded = true;
      }
    } else if (useOnly) {
      queue = selectableCandidates.map((catalog) => ({ catalog, reason: "only" }));
    } else if (slots > 0) {
      if (jevFailed && plan.needsJev) {
        plan.unresolvedCode = "jev_failed";
      } else if (plan.needsJev) {
        queue = selectableCandidates.map((catalog, order) => ({
          catalog,
          reason: "jev" as const,
          score: jevScoreByName.get(catalog.name),
          order,
        })).sort((left, right) => (right.score ?? -1) - (left.score ?? -1) || left.order - right.order)
          .map(({ catalog, reason, score }) => ({ catalog, reason, score }));
      } else {
        plan.unresolvedCode = "unresolved_pick";
      }
    }

    for (const candidate of queue) {
      if (plan.selections.length >= fields.top) {
        addExcluded(plan, candidate.catalog.name, "top");
        continue;
      }
      if (bundleConflict(candidate.catalog, bundleAxesAtBlockStart)) {
        addExcluded(plan, candidate.catalog.name, "bundle_axis");
        continue;
      }
      if (bundleConflict(candidate.catalog, occupiedBundleAxes)) {
        addExcluded(plan, candidate.catalog.name, "top");
        continue;
      }
      if (candidate.reason === "jev" && candidate.score === undefined) continue;
      if (fields.optional && candidate.reason === "jev" && candidate.score! < DEFAULT_MIN_JEV_SCORE) {
        addExcluded(plan, candidate.catalog.name, "below_floor", candidate.score);
        continue;
      }
      plan.selections.push({
        catalog: candidate.catalog,
        reason: candidate.reason,
        ...(candidate.score === undefined ? {} : { jevScore: candidate.score }),
      });
      expandedCatalogNames.add(candidate.catalog.name);
      occupyBundleAxes(candidate.catalog, occupiedBundleAxes);
    }

    const belowFloorNames = new Set(
      plan.preExcluded.filter(({ reason }) => reason === "below_floor").map(({ name }) => name),
    );
    plan.allBelowFloor = fields.optional && hasIntent && slots > 0 &&
      !plan.unresolvedCode && !jevFailed && plan.needsJev && plan.selections.length === 0 &&
      selectableCandidates.length > 0 && selectableCandidates.every((catalog) => {
        const score = jevScoreByName.get(catalog.name);
        return belowFloorNames.has(catalog.name) && score !== undefined && score < DEFAULT_MIN_JEV_SCORE;
      });

    if (slots > 0 && plan.candidates.length === 0 && !plan.noIntent) {
      plan.unresolvedCode ??= "unresolved_pick";
    }
    if (plan.unresolvedCode) {
      const code = plan.unresolvedCode;
      warnings.push(warning(code, code === "jev_failed"
        ? "Jev 평가에 실패했습니다. 후보를 확인하고 필요한 카탈로그를 직접 읽으세요."
        : "선택을 결정하지 못했습니다. 작업에 맞는 후보를 직접 읽으세요.", plan.block.line));
    }
  }

  if (!hasIntent && pinNames.length === 0 && missingIntentNeeded) {
    warnings.push(warning("no_intent", "intent와 pins가 없어 Jev가 필요한 pick을 결정하지 못했습니다."));
  }

  const pinnedBundles = [...new Map([...pickPlans.values()]
    .flatMap((plan) => plan.pinned.filter(({ composition }) => composition === "bundle"))
    .map((catalog) => [normalizedName(catalog.name), catalog])).values()];
  const pinConflictPairs: string[] = [];
  for (let left = 0; left < pinnedBundles.length; left += 1) {
    for (let right = left + 1; right < pinnedBundles.length; right += 1) {
      const a = pinnedBundles[left]!;
      const b = pinnedBundles[right]!;
      if (a.axis.some((axis) => b.axis.includes(axis))) pinConflictPairs.push(`${a.name}/${b.name}`);
    }
  }
  if (pinConflictPairs.length > 0) {
    warnings.push(warning("pin_conflict", `같은 축의 bundle pin을 모두 선택했습니다: ${pinConflictPairs.join(", ")}`));
  }

  const includedCatalogs = [...includeTargets.values()].flatMap((target) => target.catalog && !target.ambiguous ? [target.catalog] : []);
  const pickedCatalogs = [...pickPlans.values()].flatMap((plan) => plan.selections.map(({ catalog }) => catalog));
  const selectedCatalogs = [...new Map([...includedCatalogs, ...pickedCatalogs].map((catalog) => [catalog.name, catalog])).values()];
  return { pickPlans, warnings, selectedCatalogs };
}
