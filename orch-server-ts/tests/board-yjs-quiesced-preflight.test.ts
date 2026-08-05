import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { assertBoardYjsQuiescedApplyPreflight } from
  "../src/board-yjs/board_yjs_quiesced_preflight.js";

describe("Board Y.Doc quiesced apply preflight", () => {
  it("does not require host state for a read-only dry run", async () => {
    const fetchImpl = vi.fn();
    await expect(assertBoardYjsQuiescedApplyPreflight({
      apply: false,
      quiescedAcknowledged: false,
      orchHealthUrl: null,
      fetchImpl,
    })).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires an explicit quiesced acknowledgement and loopback health endpoint", async () => {
    await expect(assertBoardYjsQuiescedApplyPreflight({
      apply: true,
      quiescedAcknowledged: false,
      orchHealthUrl: "http://127.0.0.1:5200/api/health",
      fetchImpl: vi.fn(),
    })).rejects.toThrow("--quiesced");
    await expect(assertBoardYjsQuiescedApplyPreflight({
      apply: true,
      quiescedAcknowledged: true,
      orchHealthUrl: "https://orch.example.com/api/health",
      fetchImpl: vi.fn(),
    })).rejects.toThrow("exact loopback endpoint");
  });

  it("rejects apply when the orchestrator returns any HTTP response", async () => {
    await expect(assertBoardYjsQuiescedApplyPreflight({
      apply: true,
      quiescedAcknowledged: true,
      orchHealthUrl: "http://127.0.0.1:5200/api/health",
      fetchImpl: vi.fn().mockResolvedValue(new Response("maintenance", { status: 503 })),
    })).rejects.toThrow("still responding");
  });

  it("accepts only a local connection refusal as proof that the host is stopped", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    await expect(assertBoardYjsQuiescedApplyPreflight({
      apply: true,
      quiescedAcknowledged: true,
      orchHealthUrl: "http://127.0.0.1:5200/api/health",
      fetchImpl: vi.fn().mockRejectedValue(refused),
    })).resolves.toBeUndefined();

    await expect(assertBoardYjsQuiescedApplyPreflight({
      apply: true,
      quiescedAcknowledged: true,
      orchHealthUrl: "http://127.0.0.1:5200/api/health",
      fetchImpl: vi.fn().mockRejectedValue(new Error("network unknown")),
    })).rejects.toThrow("could not prove");
  });

  it("keeps apply offline instead of routing through the live host API", async () => {
    const source = await readFile(
      new URL("../scripts/migrate-board-yjs-runbook-residue.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("executeQuiescedBoardYjsRunbookMigration");
    expect(source).not.toContain("/api/board-yjs/host/migrate-runbook-residue");
    expect(source).not.toContain("AUTH_BEARER_TOKEN");
    expect(source.indexOf("await assertBoardYjsQuiescedApplyPreflight"))
      .toBeLessThan(source.indexOf('requiredEnv("DATABASE_URL")'));
  });
});
