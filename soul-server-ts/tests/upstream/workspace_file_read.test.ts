import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceFile } from "../../src/workspace/workspace_file_read.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); roots.length = 0; });
describe("workspace file read", () => {
  it("reads a byte range and rejects paths outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-read-")); roots.push(root);
    await writeFile(path.join(root, "a.txt"), "abcdef");
    expect(await readWorkspaceFile(root, "a.txt", 1, 3)).toMatchObject({ content_b64: Buffer.from("bcd").toString("base64"), size: 6, offset: 1, length: 3, content_type: "text/plain" });
    await expect(readWorkspaceFile(root, "../outside")).rejects.toThrow("INVALID_REQUEST:");
  });
});
