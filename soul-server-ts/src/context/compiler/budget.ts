export type ContextBudgetCategory = "guidance" | "atom_ref" | "session_defaults";

export interface ContextBudgetLimits {
  categories: Record<ContextBudgetCategory, number>;
  total: number;
}

export interface ContextBudgetEntry {
  id: string;
  category: ContextBudgetCategory;
  content: string | null;
  priority: number;
  neverTruncate: boolean;
  fallback?: string;
  fallbackAnchorCount?: number;
  baseAnchorCount?: number;
  countTowardTotal?: boolean;
}

export interface ContextBudgetedEntry extends ContextBudgetEntry {
  content: string | null;
  truncated: boolean;
  anchorCount: number;
}

export interface ContextBudgetUsage {
  categories: Record<ContextBudgetCategory, {
    limit: number;
    used: number;
    omitted: number;
  }>;
  total: { limit: number; used: number; omitted: number };
}

export interface ContextBudgetResult {
  entries: ContextBudgetedEntry[];
  usage: ContextBudgetUsage;
}

export function allocateContextBudget(input: {
  limits: ContextBudgetLimits;
  entries: readonly ContextBudgetEntry[];
}): ContextBudgetResult {
  const usage: ContextBudgetUsage = {
    categories: {
      guidance: usageRow(input.limits.categories.guidance),
      atom_ref: usageRow(input.limits.categories.atom_ref),
      session_defaults: usageRow(input.limits.categories.session_defaults),
    },
    total: usageRow(input.limits.total),
  };
  const results = new Map<string, ContextBudgetedEntry>();
  const ordered = input.entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.priority - a.entry.priority || a.index - b.index);

  for (const { entry } of ordered) {
    const category = usage.categories[entry.category];
    const countTowardTotal = entry.countTowardTotal ?? true;
    if (entry.content === null) {
      category.omitted += 1;
      if (countTowardTotal) usage.total.omitted += 1;
      results.set(entry.id, budgeted(entry, null, false, entry.baseAnchorCount ?? 0));
      continue;
    }

    if (entry.neverTruncate) {
      consume(usage, entry.category, entry.content.length, countTowardTotal);
      results.set(
        entry.id,
        budgeted(entry, entry.content, false, entry.baseAnchorCount ?? 0),
      );
      continue;
    }

    const categoryRemaining = Math.max(0, category.limit - category.used);
    const totalRemaining = countTowardTotal
      ? Math.max(0, usage.total.limit - usage.total.used)
      : Number.POSITIVE_INFINITY;
    const available = Math.min(categoryRemaining, totalRemaining);
    if (entry.content.length <= available) {
      consume(usage, entry.category, entry.content.length, countTowardTotal);
      results.set(
        entry.id,
        budgeted(entry, entry.content, false, entry.baseAnchorCount ?? 0),
      );
      continue;
    }

    const replacement = entry.fallback ?? (available > 0
      ? entry.content.slice(0, available)
      : null);
    const used = replacement?.length ?? 0;
    consume(usage, entry.category, used, countTowardTotal);
    category.omitted += 1;
    if (countTowardTotal) usage.total.omitted += 1;
    results.set(
      entry.id,
      budgeted(
        entry,
        replacement,
        true,
        entry.fallback !== undefined
          ? entry.fallbackAnchorCount ?? 0
          : entry.baseAnchorCount ?? 0,
      ),
    );
  }

  return {
    entries: input.entries.map((entry) => results.get(entry.id)!),
    usage,
  };
}

function budgeted(
  entry: ContextBudgetEntry,
  content: string | null,
  truncated: boolean,
  anchorCount: number,
): ContextBudgetedEntry {
  return { ...entry, content, truncated, anchorCount };
}

function usageRow(limit: number): { limit: number; used: number; omitted: number } {
  return { limit, used: 0, omitted: 0 };
}

function consume(
  usage: ContextBudgetUsage,
  category: ContextBudgetCategory,
  chars: number,
  countTowardTotal: boolean,
): void {
  usage.categories[category].used += chars;
  if (countTowardTotal) usage.total.used += chars;
}
