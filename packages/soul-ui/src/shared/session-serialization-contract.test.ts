import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { toSessionSummary } from "./mappers";

const CONTRACT_PATH = fileURLToPath(
  new URL(
    "../../../../packages/wire-schema/fixtures/session_serialization_contract.json",
    import.meta.url,
  ),
);

function loadCase(): Record<string, any> {
  const data = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
  return data.cases[0];
}

function jsonShape(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function pickCanonicalSummaryFields(value: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(loadCase().expectedCanonicalSummary);
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

describe("session serialization contract fixture", () => {
  it("maps orch REST response to the shared SessionSummary contract", () => {
    const fixture = loadCase();

    expect(jsonShape(toSessionSummary(fixture.expectedOrchResponse))).toEqual(
      fixture.expectedSoulUiSummaryFromOrch,
    );
  });

  it("normalizes orch and node session wire to the same canonical summary meaning", () => {
    const fixture = loadCase();
    const orchSummary = jsonShape(toSessionSummary(fixture.expectedOrchResponse));
    const nodeSummary = jsonShape(toSessionSummary(fixture.expectedNodeSessionInfo));

    expect(pickCanonicalSummaryFields(orchSummary as Record<string, unknown>)).toEqual(
      fixture.expectedCanonicalSummary,
    );
    expect(pickCanonicalSummaryFields(nodeSummary as Record<string, unknown>)).toEqual(
      fixture.expectedCanonicalSummary,
    );
  });
});
