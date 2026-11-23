import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBoundedProcess } from "../../src/worktree/worktree_process.js";

vi.mock("node:os", async importOriginal => {
  const original = await importOriginal<typeof import("node:os")>();
  return {...original, devNull: "\\\\.\\nul"};
});
vi.mock("../../src/worktree/worktree_process.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../src/worktree/worktree_process.js")>();
  return {...original, runBoundedProcess: vi.fn(original.runBoundedProcess)};
});
import { diffWorkspaceFile } from "../../src/workspace/workspace_file_diff.js";

const roots:string[]=[];
afterEach(async()=>{ await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true}))); roots.length=0; });
async function repo() {
  const root=await mkdtemp(path.join(tmpdir(),"workspace-diff-")); roots.push(root);
  const git=(...args:string[])=>execFileSync("git",args,{cwd:root,encoding:"utf8"});
  git("init","-q"); git("config","user.email","test@example.com"); git("config","user.name","Test");
  for (const name of ["modified.txt","deleted.txt","old.txt","same.txt","binary.bin"]) await writeFile(path.join(root,name), name === "binary.bin" ? Buffer.from([0,1,2]) : "before\n");
  git("add","."); git("commit","-qm","initial"); return {root,git};
}
describe("workspace file diff",()=>{
  it("returns changes relative to HEAD, untracked, deleted, rename, binary and unchanged",async()=>{
    const {root,git}=await repo();
    await writeFile(path.join(root,"modified.txt"),"staged\n"); git("add","modified.txt");
    await writeFile(path.join(root,"modified.txt"),"staged\nunstaged\n");
    await writeFile(path.join(root,"new.txt"),"new file\n"); await unlink(path.join(root,"deleted.txt"));
    await rename(path.join(root,"old.txt"),path.join(root,"renamed.txt")); git("add","old.txt","renamed.txt");
    await writeFile(path.join(root,"binary.bin"),Buffer.from([0,3,4]));
    expect(await diffWorkspaceFile(root,"modified.txt",null)).toMatchObject({status:"modified",text:expect.stringContaining("+unstaged"),binary:false});
    expect(await diffWorkspaceFile(root,"new.txt",null)).toMatchObject({status:"untracked",text:expect.stringContaining("+new file"),binary:false});
    expect(await diffWorkspaceFile(root,"deleted.txt",null)).toMatchObject({status:"deleted",text:expect.stringContaining("-before")});
    expect(await diffWorkspaceFile(root,"renamed.txt","old.txt")).toMatchObject({status:"renamed",text:expect.stringContaining("rename from")});
    expect(await diffWorkspaceFile(root,"binary.bin",null)).toMatchObject({status:"modified",text:"",binary:true});
    expect(await diffWorkspaceFile(root,"same.txt",null)).toMatchObject({status:"unchanged",text:"",binary:false});
    await writeFile(path.join(root,"large.txt"),"x".repeat(600*1024));
    const large=await diffWorkspaceFile(root,"large.txt",null); expect(large.truncated).toBe(true); expect(Buffer.byteLength(large.text)).toBeLessThanOrEqual(512*1024);
  },60000);
  it("rejects a non-git workspace",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"workspace-nogit-")); roots.push(root);
    await writeFile(path.join(root,"file"),"hello");
    await expect(diffWorkspaceFile(root,"file",null)).rejects.toThrow("NOT_GIT:");
  });
});

it("uses relative paths in an untracked diff header", async () => {
  const {root}=await repo();
  await writeFile(path.join(root,"new.txt"),"new file\n");
  const diff=await diffWorkspaceFile(root,"new.txt",null);
  expect(diff.text).toContain("diff --git a/new.txt b/new.txt");
  expect(diff.text).toContain("+++ b/new.txt");
  expect(diff.text).not.toContain(root);
});

it("uses Git's null path on Windows and disables text conversion for both diff modes", async () => {
  const {root}=await repo();
  await writeFile(path.join(root,"new.txt"),"new file\n");
  await writeFile(path.join(root,"modified.txt"),"changed\n");
  vi.mocked(runBoundedProcess).mockClear();
  await diffWorkspaceFile(root,"new.txt",null);
  await diffWorkspaceFile(root,"modified.txt",null);
  const calls=vi.mocked(runBoundedProcess).mock.calls.map(([input])=>input.args).filter(args=>args.includes("diff"));
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("--no-textconv");
  expect(calls[0]?.slice(-3)).toEqual(["--", "/dev/null", "new.txt"]);
  expect(calls[1]).toContain("--no-textconv");
});

it("treats pathspec characters as literal file names", async () => {
  if (process.platform === "win32") return;
  const {root,git}=await repo();
  await writeFile(path.join(root,"*.txt"),"before\n"); git("add","*.txt"); git("commit","-qm","literal");
  await writeFile(path.join(root,"*.txt"),"literal-only\n");
  await writeFile(path.join(root,"modified.txt"),"not-allowed\n");
  const result=await diffWorkspaceFile(root,"*.txt",null);
  expect(result.text).toContain("+literal-only");
  expect(result.text).not.toContain("not-allowed");
});

it("diffs a staged file before the first commit", async () => {
  const root=await mkdtemp(path.join(tmpdir(),"workspace-initial-")); roots.push(root);
  execFileSync("git",["init","-q"],{cwd:root});
  await writeFile(path.join(root,"initial.txt"),"first\n");
  execFileSync("git",["add","initial.txt"],{cwd:root});
  expect(await diffWorkspaceFile(root,"initial.txt",null)).toMatchObject({status:"added",text:expect.stringContaining("+first")});
});

it("selects the requested status and ignores a stale rename source", async () => {
  const {root,git}=await repo();
  await writeFile(path.join(root,"modified.txt"),"requested change\n");
  await writeFile(path.join(root,"old.txt"),"other change\n");
  const result=await diffWorkspaceFile(root,"modified.txt","old.txt");
  expect(result.status).toBe("modified");
  expect(result.text).toContain("+requested change");
  expect(result.text).not.toContain("other change");
  git("add","old.txt");
  const other=await diffWorkspaceFile(root,"modified.txt","old.txt");
  expect(other.status).toBe("modified");
  expect(other.text).not.toContain("other change");
});

it("settles as truncated when the output limit and timeout overlap", async () => {
  const script="process.on('SIGTERM',()=>{}); setTimeout(()=>process.stdout.write('x'.repeat(4096)),900); setInterval(()=>{},1000)";
  const result=await runBoundedProcess({command:process.execPath,args:["-e",script],cwd:tmpdir(),timeoutMs:1000,maxStdoutBytes:64});
  expect(result.truncated).toBe(true); expect(result.stdout).toHaveLength(64);
},60000);

it("treats a no-index exit of one with stderr as an error", async () => {
  const {root}=await repo(); await writeFile(path.join(root,"new.txt"),"new\n");
  vi.mocked(runBoundedProcess)
    .mockResolvedValueOnce({stdout:root,stderr:"",exitCode:0})
    .mockResolvedValueOnce({stdout:"?? new.txt\0",stderr:"",exitCode:0})
    .mockResolvedValueOnce({stdout:"",stderr:"git failed",exitCode:1});
  await expect(diffWorkspaceFile(root,"new.txt",null)).rejects.toThrow("git failed");
});

it("uses the requested file's status when both supplied paths have changes", async () => {
  const {root}=await repo();
  await unlink(path.join(root,"modified.txt"));
  await writeFile(path.join(root,"old.txt"),"requested only\n");
  const result=await diffWorkspaceFile(root,"old.txt","modified.txt");
  expect(result.status).toBe("modified");
  expect(result.text).toContain("+requested only");
  expect(result.text).not.toContain("modified.txt");
});
