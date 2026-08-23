import { defineHarnessBoundary } from "./fault-harness-boundary.mjs";

export const THROWAWAY_MARKER_TABLE = "lab_harness_throwaway_marker";
export const THROWAWAY_MARKER_TOKEN = "disposable-harness-database";

export const assertThrowawayTarget = defineHarnessBoundary({
  name: "mutation_gate_requires_throwaway_marker",
  what: "the database mutation gate refuses every target without the disposable marker",
  async implementation(query, databaseName = process.env.PGDATABASE) {
    let marker;
    try {
      marker = await query(`
        SELECT json_build_object('token', (
          SELECT token FROM ${THROWAWAY_MARKER_TABLE} LIMIT 1
        ))
      `);
    } catch {
      marker = null;
    }
    if (marker?.token === THROWAWAY_MARKER_TOKEN) return;
    throw new Error(
      `refusing to run: ${databaseName ?? "<no PGDATABASE>"} did not present a`
      + ` throwaway marker. This gate plants rows and must only ever touch a database`
      + ` created for it. Prove the target is disposable with:\n`
      + `  CREATE TABLE ${THROWAWAY_MARKER_TABLE} (token text);\n`
      + `  INSERT INTO ${THROWAWAY_MARKER_TABLE} VALUES ('${THROWAWAY_MARKER_TOKEN}');\n`
      + `To exercise the judges against the live lab instead, run`
      + ` fault-harness.sh mutation, which reverts everything it plants.`,
    );
  },
  async contract(assertTarget) {
    let refused = false;
    try {
      await assertTarget(async () => ({ token: null }), "not-disposable");
    } catch {
      refused = true;
    }
    boundaryAssert(refused, "the mutation gate accepted a target without the marker");
    await assertTarget(
      async () => ({ token: THROWAWAY_MARKER_TOKEN }),
      "disposable",
    );
  },
});

function boundaryAssert(condition, message) {
  if (!condition) throw new Error(message);
}
