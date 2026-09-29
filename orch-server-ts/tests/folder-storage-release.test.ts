import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute, gate } = vi.hoisted(() => ({ execute: vi.fn(), gate: vi.fn() }));
vi.mock("../../packages/db-schema/scripts/release-executor.mjs", () => ({ runDatabaseRelease: execute }));
vi.mock("../../packages/db-schema/scripts/database-release-subphase.mjs", () => ({
  assertDatabaseReleaseSubphaseGate: gate,
}));

describe("folder storage release entrypoint", () => {
  beforeEach(() => { execute.mockReset(); gate.mockReset(); });

  it("rejects conversion without current release handover evidence", async () => {
    const { convertFolderStorage } = await import("../scripts/apply-folder-storage.mjs");
    gate.mockRejectedValue(new Error("JOURNAL_GATE_FAILED"));
    await expect(convertFolderStorage()).rejects.toThrow("JOURNAL_GATE_FAILED");
    expect(gate).toHaveBeenCalledWith({ subphase: "folder_storage_documents" });
  });

  it("applies SQL before the journaled document conversion", async () => {
    const { applyFolderStorage } = await import("../scripts/apply-folder-storage.mjs");
    const options = { env: { HANIEL_REQUEST_ID: "release-1" } };
    const result = { ok: true, status: "applied" };
    execute.mockResolvedValueOnce({ status: "sql_applied" }).mockResolvedValueOnce(result);
    await expect(applyFolderStorage(options)).resolves.toBe(result);
    expect(execute.mock.calls.map((call) => call[0])).toEqual(["apply", "run-subphase"]);
    expect(execute.mock.calls[0]![1]).toBe(options);
    expect(execute.mock.calls[1]![1]).toMatchObject({
      ...options, subphase: "folder_storage_documents",
    });
    expect(execute.mock.calls[1]![1].childCommand).toContain("--documents");
  });

  it("does not start document conversion when SQL fails", async () => {
    const { applyFolderStorage } = await import("../scripts/apply-folder-storage.mjs");
    execute.mockImplementation(() => { throw new Error("SQL failed"); });
    await expect(applyFolderStorage()).rejects.toThrow("SQL failed");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("connects the real central deployment manifest to the conversion subphase", () => {
    const read = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
    const manifest = read("../../deploy/release-manifest.json");
    const contract = read("../../deploy/database-release-central.json");
    expect(manifest.migration.apply.command).toBe("node orch-server-ts/scripts/apply-folder-storage.mjs");
    expect(contract.required_subphases).toEqual(["folder_storage_documents"]);
    expect(JSON.stringify(manifest)).not.toMatch(/runbook/);
  });
});
