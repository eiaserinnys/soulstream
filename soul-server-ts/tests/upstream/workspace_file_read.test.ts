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

it("rejects a listed symlink to another file inside the workspace", async () => {
  const root=await mkdtemp(path.join(tmpdir(),"workspace-link-")); roots.push(root);
  await writeFile(path.join(root,".env"),"secret");
  await symlink(path.join(root,".env"),path.join(root,"listed"));
  await expect(readWorkspaceFile(root,"listed")).rejects.toThrow("INVALID_REQUEST:");
});

it("keeps root cache entries per worktree and rejects mismatched expected roots", async () => {
  const {WorkspaceService}=await import("../../src/workspace/workspace_service.js");
  const first=await mkdtemp(path.join(tmpdir(),"workspace-first-")); roots.push(first);
  const second=await mkdtemp(path.join(tmpdir(),"workspace-second-")); roots.push(second);
  const service=new WorkspaceService({get:()=>undefined} as never,{resolveExecutionWorkspace:async(id:string)=>id === "first" ? first : second} as never);
  const a={session_id:"s",agent_id:"a",worktree_id:"first"};
  const b={...a,worktree_id:"second"};
  expect(await service.root(a)).toBe(first);
  expect(await service.root(b)).toBe(second);
  await expect(service.read(b,"missing",0,undefined,first)).rejects.toThrow("CONFLICT: workspace root changed");
  await expect(service.diff(b,"missing",null,first)).rejects.toThrow("CONFLICT: workspace root changed");
});

it("rejects an unexpected root before accessing file or git", async () => {
  const {WorkspaceService}=await import("../../src/workspace/workspace_service.js");
  const root=await mkdtemp(path.join(tmpdir(),"workspace-root-")); roots.push(root);
  const service=new WorkspaceService({get:()=>({workspace_dir:root})} as never);
  const target={session_id:"s",agent_id:"a",worktree_id:null};
  await expect(service.read(target,"missing",0,undefined,"/unexpected")).rejects.toThrow("CONFLICT: workspace root changed");
  await expect(service.diff(target,"missing",null,"/unexpected")).rejects.toThrow("CONFLICT: workspace root changed");
});

it("passes expected roots through both workspace commands", async () => {
  const {WorkspaceService}=await import("../../src/workspace/workspace_service.js");
  const {createWorkspaceCommandFamily}=await import("../../src/upstream/workspace_command_family.js");
  const root=await mkdtemp(path.join(tmpdir(),"workspace-command-")); roots.push(root);
  const workspace=new WorkspaceService({get:()=>({workspace_dir:root})} as never);
  const family=createWorkspaceCommandFamily({workspace,send:async()=>{throw new Error("unexpected send");}});
  const target={session_id:"s",agent_id:"a",worktree_id:null,path:"missing",expected_root:"/different"};
  await expect(family.workspace_file_read!({...target,type:"workspace_file_read"})).rejects.toThrow("CONFLICT: workspace root changed");
  const diffCommand={...target,type:"workspace_file_diff",orig_path:null};
  await expect(family.workspace_file_diff!(diffCommand)).rejects.toThrow("CONFLICT: workspace root changed");
});
