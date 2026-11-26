import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readDecisionCredential } from "../../src/card-orchestration/runtime_composition.js";

describe("card decision Codex credential", () => {
  it("reads auth.json from the Codex home it is given", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "decision-codex-home-"));
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "agent-access", account_id: "acct-1" } }));

      await expect(readDecisionCredential("codex", undefined, codexHome))
        .resolves.toEqual({ backend: "codex", oauthToken: "agent-access", accountId: "acct-1" });
      await expect(readDecisionCredential("codex", undefined, join(codexHome, "missing"))).resolves.toBeUndefined();
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
