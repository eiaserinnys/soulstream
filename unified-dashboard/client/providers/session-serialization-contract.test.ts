import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestratorSessionProvider } from "./OrchestratorSessionProvider";

const CONTRACT_PATH = fileURLToPath(
  new URL(
    "../../../packages/wire-schema/fixtures/session_serialization_contract.json",
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

describe("OrchestratorSessionProvider session serialization contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the soul-ui session mapper while preserving the provider summary shape", async () => {
    const fixture = loadCase();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          sessions: [fixture.expectedOrchResponse],
          total: 1,
        }),
      }),
    );

    const result = await new OrchestratorSessionProvider().fetchSessions();

    expect(jsonShape(result.sessions[0])).toEqual(
      fixture.expectedUnifiedDashboardSession,
    );
    expect(result).toMatchObject({ total: 1, hasMore: false });
  });
});
