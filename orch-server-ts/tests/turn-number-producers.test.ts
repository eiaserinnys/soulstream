import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// A turn number is the label a stored narrative's `[Tn]` marker cites, so every
// query that produces one has to agree on how it is assigned. When one producer
// drifted, the same turn reported two different numbers depending on which read
// path the caller happened to hit, and stored markers started resolving to the
// wrong turn. This pins all of them to the one definition.
const PRODUCERS = [
  "src/turn-summary/session_story_repository.ts",
  "src/control_plane/repositories/session_story_read_repository.ts",
  "src/runtime/live_session_conversation_context.ts",
] as const;

const DEFINITION = "ROW_NUMBER() OVER (ORDER BY id ASC)::integer AS turn_number";

describe("turn_number producers", () => {
  it("assigns turn numbers by append order everywhere", () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    let total = 0;
    for (const file of PRODUCERS) {
      const source = readFileSync(
        fileURLToPath(new URL(`../${file}`, import.meta.url)),
        "utf8",
      );
      for (const [index, line] of source.split("\n").entries()) {
        if (!line.includes("AS turn_number")) continue;
        total += 1;
        if (!line.includes(DEFINITION)) {
          offenders.push({ file, line: index + 1, text: line.trim() });
        }
      }
    }
    expect(offenders).toEqual([]);
    // Guards against a producer being deleted or moved out of the list without
    // the contract being reconsidered.
    expect(total).toBe(7);
  });
});
