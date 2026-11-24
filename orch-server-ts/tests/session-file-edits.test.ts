import { describe, expect, it } from "vitest";
import { collectSessionFileEdits, countSessionFileEdits } from "../src/session/session_file_edits.js";

const at = new Date("2026-01-01T00:00:00Z");
const start = (tool_name: string, tool_input: object, tool_use_id = tool_name) => ({event_type:"tool_start",created_at:at,payload:{tool_name,tool_input,tool_use_id}});
const result = (payload: object) => ({event_type:"tool_result",created_at:at,payload});
const edit = (old_string: string,new_string: string) => ({file_path:"/repo/a.txt",old_string,new_string});
describe("session file edits", () => {
  it("builds Claude edits, ignores failed tools and keeps incomplete ones", () => {
    const events=[start("Edit",{...edit("same\nold\nend","same\nnew\nend"),replace_all:true},"good"),start("Edit",edit("x","y"),"bad"),result({tool_use_id:"bad",is_error:true}),start("Write",{file_path:"/repo/a.txt",content:"one\ntwo\n"}),start("MultiEdit",{file_path:"/repo/a.txt",edits:[edit("a","b"),edit("c","d")]})];
    const value=collectSessionFileEdits("/repo","a.txt",events);
    expect(value.edits).toHaveLength(3);
    expect(value.edits[0]).toMatchObject({text:"@@ @@\n same\n-old\n+new\n end",replace_all:true,line_numbers:false});
    expect(value.edits[1]).toMatchObject({kind:"write",text:"@@ -0,0 +1,2 @@\n+one\n+two",line_numbers:true});
    expect(value.edits[2]!.text).toBe("@@ @@\n-a\n+b\n@@ @@\n-c\n+d");
  });
  it("selects codex changes by absolute path and counts content-free edits", () => {
    const changes=[{path:"/repo/a.txt",kind:{type:"update"},diff:"@@ -1 +1 @@\n-a\n+b"},{path:"/repo/b.txt",kind:{type:"add"},diff:"wrong"},{path:"/repo/a.txt",kind:{type:"add"},diff:"new"},{path:"/repo/a.txt",kind:{type:"delete"},diff:"old"}];
    const events=[result({tool_name:"file_change",result:JSON.stringify(changes)}),result({tool_name:"file_change",result:"{"}),start("edit_file",{Path:"/repo/a.txt"}),start("NotebookEdit",{notebook_path:"/repo/a.txt"})];
    const value=collectSessionFileEdits("/repo","a.txt",events);
    expect(value.edits.map(x=>x.text)).toEqual([changes[0]!.diff,"@@ -0,0 +1,1 @@\n+new","@@ -1,1 +0,0 @@\n-old"]);
    expect(value.unrecorded).toBe(2);
  });
  it("drops old edits above the limit and reports truncated events", () => {
    const events=[start("Write",{file_path:"/repo/a.txt",content:"x".repeat(400000)},"a"),start("Write",{file_path:"/repo/a.txt",content:"y".repeat(200000)},"b")];
    const value=collectSessionFileEdits("/repo","a.txt",events);
    expect(value.truncated).toBe(true); expect(value.edits).toHaveLength(1); expect(value.edits[0]!.text).toContain("yyy");
    expect(collectSessionFileEdits("/repo","a.txt",[{...events[0]!,payload:{...events[0]!.payload,truncation:{}}}]).truncated).toBe(true);
  });
  describe("countSessionFileEdits", () => {
    const count=(events:any[],paths=["a.txt"])=>countSessionFileEdits("/repo",new Set(paths),events);
    it("counts only the - and + lines of an Edit and the whole content of a Write", () => {
      const value=count([start("Edit",{...edit("same\nold\nend","same\nnew\nmore\nend")},"e"),start("Write",{file_path:"/repo/a.txt",content:"1\n2\n3\n"},"w")]);
      expect(value.get("a.txt")).toEqual({added:2+3,deleted:1});
    });
    it("counts codex diff lines for update and whole text for add and delete, skipping hunk headers and failed edits", () => {
      const changes=[{path:"/repo/a.txt",kind:{type:"update"},diff:"@@ -1,2 +1,2 @@\n ctx\n-a\n+b\n+c\n\\ No newline"},{path:"/repo/a.txt",kind:{type:"add"},diff:"x\ny"},{path:"/repo/a.txt",kind:{type:"delete"},diff:"z"},{path:"/repo/b.txt",kind:{type:"add"},diff:"other"}];
      const value=count([result({tool_name:"file_change",result:JSON.stringify(changes)}),result({tool_name:"file_change",result:"{"}),start("Edit",edit("x","y"),"bad"),result({tool_use_id:"bad",is_error:true})]);
      expect(value.get("a.txt")).toEqual({added:2+2,deleted:1+1}); expect(value.has("b.txt")).toBe(false);
    });
    it("omits paths without recorded content and counts past the 512KiB display limit", () => {
      expect(count([start("NotebookEdit",{notebook_path:"/repo/a.txt"}),start("edit_file",{Path:"/repo/a.txt"})]).size).toBe(0);
      const big=Array.from({length:3},(_,i)=>start("Write",{file_path:"/repo/a.txt",content:`${"x".repeat(300000)}\nsecond`},`w${i}`));
      expect(count(big).get("a.txt")).toEqual({added:6,deleted:0});
      expect(collectSessionFileEdits("/repo","a.txt",big).edits.length).toBeLessThan(3);
    });
  });
});
