/**
 * Executes every verdict-critical boundary contract registered in this folder.
 *
 * The old implementation copied three names into a hand-written array and
 * copied them once more into a test. A fourth wiring was then added and, as
 * expected, neither list changed. Runtime entry modules now register when
 * imported. Execution is separately fail-closed in `invokeHarnessBoundary`,
 * so this inventory is a proof runner rather than the security boundary.
 */
import { registeredBoundaryContracts } from "./fault-harness-boundary.mjs";
import "./fault-harness-evidence.mjs";
import "./fault-harness-rejudge.mjs";
import "./fault-harness-throwaway-boundary.mjs";
import "./fault-traffic-cycles.mjs";

export async function boundaryContractInventory() {
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
