import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: execute }));

describe("folder storage release entrypoint", () => {
  beforeEach(() => { execute.mockReset(); });

  it("applies SQL before the journaled document conversion", async () => {
    const { applyFolderStorage } = await import("../scripts/apply-folder-storage.mjs");
    applyFolderStorage();
    expect(execute.mock.calls.map((call) => call[1][1])).toEqual(["apply", "run-subphase"]);
    expect(execute.mock.calls[1]![1]).toContain("folder_storage_documents");
    expect(execute.mock.calls[1]![1]).toContain("--documents");
  });

  it("does not start document conversion when SQL fails", async () => {
    const { applyFolderStorage } = await import("../scripts/apply-folder-storage.mjs");
    execute.mockImplementation(() => { throw new Error("SQL failed"); });
    expect(() => applyFolderStorage()).toThrow("SQL failed");
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
