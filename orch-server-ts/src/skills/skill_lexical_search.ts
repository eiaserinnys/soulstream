import type { SkillCatalogEntry } from "./skill_catalog.js";

function grams(text: string): Set<string> {
  const result = new Set<string>();
  for (const token of text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const characters = Array.from(token);
    if (characters.length === 1) result.add(characters[0]!);
    for (let i = 0; i < characters.length - 1; i++) {
      result.add(characters[i]! + characters[i + 1]!);
    }
  }
  return result;
}

export function rankSkillsLexically(
  query: string,
  catalog: readonly SkillCatalogEntry[],
  limit: number,
): Array<{ entry: SkillCatalogEntry; score: number }> {
  const queryGrams = grams(query);
  if (queryGrams.size === 0) return [];

  return catalog.map((entry) => {
    const entryGrams = grams(`${entry.name} ${entry.description}`);
    let matches = 0;
    for (const gram of queryGrams) if (entryGrams.has(gram)) matches++;
    return { entry, score: matches / queryGrams.size };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
