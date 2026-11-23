import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
