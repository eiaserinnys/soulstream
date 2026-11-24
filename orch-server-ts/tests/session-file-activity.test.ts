import { describe, expect, it } from "vitest";
import { collectSessionFileActivity } from "../src/session/session_file_activity.js";
import { createLiveSessionWorkspaceProvider } from "../src/runtime/live_session_workspace_provider.js";
const at="2026-01-02T00:00:00.000Z";
describe("session file activity", () => {
  it("attributes Claude, Codex, Antigravity and opencode while excluding outside and shell paths", () => {
    const rows = [
      {event_type:"tool_start",tool_name:"Read",file_path:"/repo/read.txt",created_at:at},
      ...["Edit","Write","MultiEdit"].map(tool_name=>({event_type:"tool_start",tool_name,file_path:`/repo/${tool_name}.txt`,created_at:at})),
      {event_type:"tool_start",tool_name:"NotebookEdit",notebook_path:"/repo/book.ipynb",created_at:at},
      {event_type:"tool_result",tool_name:"file_change",result:'[{"path":"/repo/codex.txt"}]',created_at:at},
      {event_type:"tool_start",tool_name:"view_file",absolute_path:"/repo/agy-read.txt",created_at:at},
      ...["write_file","write_to_file","edit_file","replace_file_content","multi_replace_file_content","notebook_edit"].map(tool_name=>({event_type:"tool_start",tool_name,target_file:`/repo/${tool_name}.txt`,created_at:at})),
      {event_type:"tool_start",tool_name:"read",file_path_camel:"/repo/open-read.txt",created_at:at},
      ...["edit","write"].map(tool_name=>({event_type:"tool_start",tool_name,file_path_camel:`/repo/open-${tool_name}.txt`,created_at:at})),
      {event_type:"tool_start",tool_name:"Bash",file_path:"/repo/ignored",created_at:at},
      {event_type:"tool_start",tool_name:"Read",file_path:"/outside",created_at:at},
    ];
    const files=collectSessionFileActivity("/repo",rows);
    for(const name of ["read.txt","agy-read.txt","open-read.txt"]) expect(files.get(name)).toMatchObject({read:true,wrote:false});
    for(const name of ["Edit.txt","Write.txt","MultiEdit.txt","book.ipynb","codex.txt","write_file.txt","write_to_file.txt","edit_file.txt","replace_file_content.txt","multi_replace_file_content.txt","notebook_edit.txt","open-edit.txt","open-write.txt"]) expect(files.get(name)).toMatchObject({read:false,wrote:true});
    expect(files.has("ignored")).toBe(false); expect(files.has("../outside")).toBe(false);
  });
  it("skips malformed Codex results and attributes paths from object arrays", async () => {
    const sql=async (parts:TemplateStringsArray)=>{
      const query=parts.join("?");
      if(query.includes("FROM sessions")) return [{session_id:"s",node_id:"n",agent_id:"a",worktree_id:null,created_at:new Date("2026-01-01T00:00:00Z"),model_preset:null}];
      if(query.includes("SELECT event_type, payload, created_at")) return [];
      expect(query).toContain("payload->>'result'");
      expect(query).toContain("MAX(created_at)");
      expect(query).toMatch(/ORDER BY MAX\(created_at\) DESC/i);
      expect(query).not.toMatch(/LIMIT\s+5000/i);
      expect(query).not.toContain("jsonb_path_query_array");
      return [
        {event_type:"tool_result",tool_name:"file_change",result:"not json",created_at:at},
        {event_type:"tool_result",tool_name:"file_change",result:'[{"path":"/repo/valid.ts","kind":"update"}]',created_at:at},
        {event_type:"tool_start",tool_name:"Read",file_path:"/repo/read.txt",created_at:at},
      ];
    };
    const snapshot={root:"/repo",state:"ready",observed_at:at,refreshing:false,git:{branch:"main",head:"a",upstream:null,ahead:0,behind:0,truncated:false,files:[],commits:[]}};
    const provider=createLiveSessionWorkspaceProvider({sqlResolver:{resolveSql:async()=>sql} as never,registry:{getConnectedNode:()=>({nodeId:"n",connectionId:"c"}),createCommand:()=>({})} as never,bridge:{sendPendingCommand:async()=>snapshot} as never,modelCatalog:{snapshot:()=>({presets:[]})} as never});
    const response=await provider.readWorkspace("s");
    expect(response.files).toEqual([expect.objectContaining({path:"valid.ts",wrote:true})]);
    expect(response.read_only).toEqual([expect.objectContaining({path:"read.txt"})]);
  });
  it("marks committed only for files both written by this session and committed since it began", async () => {
    const sql=async (parts:TemplateStringsArray)=>parts.join("?").includes("FROM sessions")
      ? [{session_id:"s",node_id:"n",agent_id:"a",worktree_id:null,created_at:new Date("2026-01-01T00:00:00Z"),model_preset:null}]
      : [{event_type:"tool_start",tool_name:"Edit",file_path:"/repo/written.txt",created_at:at},{event_type:"tool_start",tool_name:"Edit",file_path:"/repo/not-committed.txt",created_at:at},{event_type:"tool_start",tool_name:"Edit",file_path:"/repo/old-commit.txt",created_at:at}];
    const snapshot={root:"/repo",state:"ready",observed_at:at,refreshing:false,git:{branch:"main",head:"a",upstream:null,ahead:0,behind:0,truncated:false,files:[{path:"only-git.txt",status:"modified",orig_path:null,added:1,deleted:0,size:1}],commits:[{sha:"a",subject:"c",committed_at:at,files:["written.txt","only-git.txt"]},{sha:"old",subject:"old",committed_at:"2025-01-01T00:00:00.000Z",files:["old-commit.txt"]}]}};
    const provider=createLiveSessionWorkspaceProvider({sqlResolver:{resolveSql:async()=>sql} as never,registry:{getConnectedNode:()=>({nodeId:"n",connectionId:"c"}),createCommand:()=>({})} as never,bridge:{sendPendingCommand:async()=>snapshot} as never,modelCatalog:{snapshot:()=>({presets:[]})} as never});
    const response=await provider.readWorkspace("s");
    expect(response.files).toEqual(expect.arrayContaining([expect.objectContaining({path:"written.txt",wrote:true,committed:true}),expect.objectContaining({path:"only-git.txt",wrote:false,committed:false}),expect.objectContaining({path:"not-committed.txt",wrote:true,committed:false}),expect.objectContaining({path:"old-commit.txt",wrote:true,committed:false})]));
  });
});

it("excludes Windows absolute paths when the workspace root is unknown", () => {
  const rows = ["D:\\repo\\a.txt", "D:/repo/b.txt", "\\\\server\\share\\c.txt"].map(file_path => ({event_type:"tool_start",tool_name:"Read",file_path,created_at:at}));
  expect([...collectSessionFileActivity(null, rows).keys()]).toEqual([]);
});

it("keeps the oldest activity past 5000 events and records the distinct-path limit", () => {
  const rows = Array.from({length:6000}, (_,i)=>({event_type:"tool_start",tool_name:"Read",file_path:i === 0 ? "/repo/oldest.txt" : "/repo/repeated.txt",created_at:at}));
  const activity=collectSessionFileActivity("/repo",rows);
  expect(activity.has("oldest.txt")).toBe(true);
  expect(activity.truncated).toBe(false);
  const many=collectSessionFileActivity("/repo",Array.from({length:5001},(_,i)=>({event_type:"tool_start",tool_name:"Read",file_path:`/repo/${i}.txt`,created_at:at})));
  expect(many.size).toBe(5000); expect(many.truncated).toBe(true);
});

it("keeps the newest 5000 distinct paths from timestamp-ordered activity", () => {
  const rows=Array.from({length:5001},(_,i)=>({event_type:"tool_start",tool_name:"Read",file_path:`/repo/file-${i}.txt`,created_at:new Date(Date.UTC(2026,0,1,0,0,5000-i))}));
  const activity=collectSessionFileActivity("/repo",rows);
  expect(activity.size).toBe(5000);
  expect(activity.has("file-0.txt")).toBe(true);
  expect(activity.has("file-5000.txt")).toBe(false);
  expect(activity.truncated).toBe(true);
});

it("normalizes a trailing slash when the workspace root is unknown", () => {
  const activity=collectSessionFileActivity(null,[{event_type:"tool_start",tool_name:"Read",file_path:"dir/file/",created_at:at}]);
  expect([...activity.keys()]).toEqual(["dir/file"]);
});
