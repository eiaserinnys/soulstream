/**
 * Executes every verdict-critical boundary contract registered in this folder.
 *
 * The old implementation copied three names into a hand-written array and
 * copied them once more into a test. A fourth wiring was then added and, as
 * expected, neither list changed. This loader has no boundary names. It finds
 * every module that constructs a boundary, imports it, and asks the registry
 * produced by those constructors for the contracts to run.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { registeredBoundaryContracts } from "./fault-harness-boundary.mjs";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const BOUNDARY_CONSTRUCTOR = "defineHarnessBoundary(";
const DISCOVERY_EXCLUSIONS = new Set([
  "fault-harness-boundary.mjs",
  "fault-harness-contracts.mjs",
]);

let definitionsLoaded = false;

export async function boundaryContractInventory() {
  await loadBoundaryDefinitions();
  return registeredBoundaryContracts();
}

export async function runBoundaryContracts() {
  const results = [];
  for (const contract of await boundaryContractInventory()) {
    try {
      await contract.check();
      results.push({ name: contract.name, what: contract.what, outcome: "held" });
    } catch (error) {
      results.push({
        name: contract.name,
        what: contract.what,
        outcome: "BROKEN",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export function reportBoundaryContracts(results) {
  for (const result of results) {
    process.stdout.write(
      `${result.outcome.padEnd(14)} ${result.name.padEnd(42)} ${result.what}\n`
      + (result.detail ? `               ${result.detail}\n` : ""),
    );
  }
  const broken = results.filter((result) => result.outcome !== "held");
  process.stdout.write(
    `\n${results.length} boundary contract(s): `
    + `${results.length - broken.length} held, ${broken.length} broken.\n`,
  );
  return broken.length === 0;
}

async function loadBoundaryDefinitions() {
  if (definitionsLoaded) return;
  const entries = await readdir(DIRECTORY, { withFileTypes: true });
  const modules = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
    if (entry.name.endsWith(".test.mjs") || DISCOVERY_EXCLUSIONS.has(entry.name)) continue;
    const path = join(DIRECTORY, entry.name);
    const source = await readFile(path, "utf8");
    if (source.includes(BOUNDARY_CONSTRUCTOR)) modules.push(path);
  }
  for (const path of modules.sort()) await import(pathToFileURL(path).href);
  definitionsLoaded = true;
}
