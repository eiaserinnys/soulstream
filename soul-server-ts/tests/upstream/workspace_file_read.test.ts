import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceFile } from "../../src/workspace/workspace_file_read.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); roots.length = 0; });
describe("workspace file read", () => {
  it("reads a byte range and rejects outside paths, symlinks, and oversized ranges", async () => {
    const parent=await mkdtemp(path.join(tmpdir(), "workspace-read-")); roots.push(parent);
    const root=path.join(parent,"root"); await import("node:fs/promises").then(fs=>fs.mkdir(root));
    await writeFile(path.join(root, "a.txt"), "abcdef"); await writeFile(path.join(parent,"outside.txt"),"outside");
    await symlink(path.join(parent,"outside.txt"),path.join(root,"link.txt"));
    expect(await readWorkspaceFile(root, "a.txt", 1, 3)).toMatchObject({ content_b64: Buffer.from("bcd").toString("base64"), size: 6, offset: 1, length: 3, content_type: "text/plain" });
    await expect(readWorkspaceFile(root, "../outside.txt")).rejects.toThrow("INVALID_REQUEST:");
    await expect(readWorkspaceFile(root, "link.txt")).rejects.toThrow("INVALID_REQUEST:");
    await expect(readWorkspaceFile(root, "a.txt", 0, 25*1024*1024+1)).rejects.toThrow("TOO_LARGE:");
  });
});
