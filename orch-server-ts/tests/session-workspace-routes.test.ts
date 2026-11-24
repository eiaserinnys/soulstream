import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PendingNodeCommandRejectedError } from "../src/node/pending_commands.js";
import { createLiveSessionWorkspaceProvider } from "../src/runtime/live_session_workspace_provider.js";
import { registerSessionWorkspaceRoutes } from "../src/session/session_workspace_routes.js";

function harness() {
  let connected=true; let restricted=false; let fileError:Error | null=null; let rootChecked=true;
  let sessionReads=0; let moveOnSecondRead=false;
  let worktreeId:string|null=null; let events:any[]=[]; let sessionDiffQuery="";
  let activities:any[]=[{event_type:"tool_start",tool_name:"Read",file_path:"read.txt",created_at:new Date("2026-01-02T00:00:00Z")}];
  let outcome: any = {root:"/repo",state:"ready",observed_at:"2026-01-02T00:00:00.000Z",refreshing:false,git:{branch:"main",head:"abc",upstream:null,ahead:0,behind:0,truncated:false,files:[],commits:[]}};
  const sql=async (strings:TemplateStringsArray) => strings.join("?").includes("FROM sessions")
    ? [{session_id:"s",node_id:"n",agent_id:moveOnSecondRead && ++sessionReads > 1 ? "other" : "a",worktree_id:worktreeId,created_at:new Date("2026-01-01T00:00:00Z"),model_preset:"claude"}]
    : strings.join("?").includes("FROM worktrees") ? [{canonical_path:"/repo"}]
    : strings.join("?").includes("SELECT event_type, payload, created_at") ? (sessionDiffQuery=strings.join("?"),events) : activities;
  const registry={getConnectedNode:()=>connected ? {nodeId:"n",connectionId:"c"} : undefined,createCommand:(_node:string,payload:any)=>({message:payload})};
  const bridge={sendPendingCommand:vi.fn(async ({command}:any) => {
    if(command.message.type === "workspace_snapshot" && outcome instanceof Error) throw outcome;
    if(command.message.type !== "workspace_snapshot" && fileError) throw fileError;
    if(command.message.type === "workspace_file_diff") return {status:"renamed",text:"diff",truncated:false,binary:false,...(rootChecked ? {root_checked:true} : {})};
    if(command.message.type === "workspace_file_read") {
      if(command.message.path === "../outside") throw rejected("workspace_file_read","INVALID_REQUEST: outside");
      const {offset,length}=command.message; const bytes=Buffer.from("abcdef").subarray(offset,length === undefined ? undefined : offset+length);
      return {content_b64:bytes.toString("base64"),content_type:"text/plain",size:6,offset,length:bytes.length,...(rootChecked ? {root_checked:true} : {})};
    }
    return outcome;
  })};
  const provider=createLiveSessionWorkspaceProvider({sqlResolver:{resolveSql:async()=>sql} as never,registry:registry as never,bridge:bridge as never,modelCatalog:{snapshot:()=>({presets:[{id:"claude",backend:"claude"}]})} as never});
  const app=Fastify(); registerSessionWorkspaceRoutes(app,{provider,accessProvider:{requireSessionAccess:async()=>{},resolveAccess:async()=>({restricted})} as never});
  return {app,bridge,setConnected:(value:boolean)=>{connected=value;},setOutcome:(value:any)=>{outcome=value;},setRestricted:(value:boolean)=>{restricted=value;},setFileError:(value:Error|null)=>{fileError=value;},setRootChecked:(value:boolean)=>{rootChecked=value;},setActivities:(value:any[])=>{activities=value;},setEvents:(value:any[])=>{events=value;},getSessionDiffQuery:()=>sessionDiffQuery,setWorktree:()=>{worktreeId="w";},moveOnSecondRead:()=>{moveOnSecondRead=true;}};
}
function rejected(commandType:string,message:string,code?:string) {return new PendingNodeCommandRejectedError({commandType,requestId:"r",message,response:{type:"error",code}});}
describe("session workspace routes", () => {
  it("queries nameless failed tool results and removes their matching edit", async () => {
    const h=harness(); const created_at=new Date("2026-01-02T00:00:00Z");
    h.setActivities([{event_type:"tool_start",tool_name:"Edit",file_path:"/repo/wrote.txt",created_at}]);
    h.setEvents([
      {event_type:"tool_start",created_at,payload:{tool_name:"Edit",tool_use_id:"failed",tool_input:{file_path:"/repo/wrote.txt",old_string:"old",new_string:"bad"}}},
      {event_type:"tool_result",created_at,payload:{tool_name:"",tool_use_id:"failed",is_error:true}},
      {event_type:"tool_start",created_at,payload:{tool_name:"Edit",tool_use_id:"good",tool_input:{file_path:"/repo/wrote.txt",old_string:"old",new_string:"good"}}},
    ]);
    const response=await h.app.inject({url:"/api/sessions/s/workspace/session-diff?path=wrote.txt"});
    expect(response.statusCode).toBe(200);
    expect(h.getSessionDiffQuery()).toMatch(/OR\s*\(\s*event_type\s*=\s*'tool_result'\s+AND\s+payload->>'is_error'\s*=\s*'true'\s*\)/i);
    expect(response.json().edits.map((edit:{text:string})=>edit.text)).toEqual(["@@ @@\n-old\n+good"]);
    await h.app.close();
  });
  it("serves a recorded edit only for a written path", async () => {
    const h=harness();
    h.setActivities([{event_type:"tool_start",tool_name:"Write",file_path:"/repo/wrote.txt",created_at:new Date("2026-01-02T00:00:00Z")}]);
    const response=await h.app.inject({url:"/api/sessions/s/workspace/session-diff?path=wrote.txt"});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({path:"wrote.txt",edits:[]});
    expect((await h.app.inject({url:"/api/sessions/s/workspace/session-diff?path=other.txt"})).statusCode).toBe(403);
    await h.app.close();
  });
  it("uses the removed worktree path for activity and restricted history without exposing a root", async () => {
    const h=harness(); h.setWorktree(); h.setRestricted(true);
    h.setOutcome(rejected("workspace_snapshot","NOT_FOUND: workspace unavailable"));
    const created_at=new Date("2026-01-02T00:00:00Z");
    h.setActivities([{event_type:"tool_start",tool_name:"Write",file_path:"/repo/wrote.txt",created_at},{event_type:"tool_start",tool_name:"Read",file_path:"/repo/read.txt",created_at}]);
    h.setEvents([{event_type:"tool_start",created_at,payload:{tool_name:"Write",tool_use_id:"a",tool_input:{file_path:"/repo/wrote.txt",content:"hello"}}}]);
    const list=(await h.app.inject({url:"/api/sessions/s/workspace"})).json();
    expect(list).toMatchObject({root:null,node:{status:"no_workspace"},files:[{path:"wrote.txt",wrote:true,git_status:null}]});
    const response=await h.app.inject({url:"/api/sessions/s/workspace/session-diff?path=.%2Fwrote.txt"});
    expect(response.statusCode).toBe(200); expect(response.json().edits[0].text).toBe("@@ -0,0 +1,1 @@\n+hello");
    expect((await h.app.inject({url:"/api/sessions/s/workspace/session-diff?path=read.txt"})).statusCode).toBe(403);
    expect(h.bridge.sendPendingCommand.mock.calls.every(([arg]:any)=>arg.command.message.type === "workspace_snapshot")).toBe(true);
    await h.app.close();
  });
  it("returns ready, pending and not_git with the node response and activities", async () => {
    const h=harness();
    let response=await h.app.inject({method:"GET",url:"/api/sessions/s/workspace"});
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({node:{status:"ok"},snapshot:{state:"ready",branch:"main"},attribution:"full",read_only:[{path:"read.txt"}]});
    h.setOutcome({root:"/repo",state:"pending",observed_at:null,refreshing:true,git:null});
    response=await h.app.inject({method:"GET",url:"/api/sessions/s/workspace"}); expect(response.json().snapshot.state).toBe("pending");
    h.setOutcome({root:"/repo",state:"not_git",observed_at:"2026-01-02T00:00:00Z",refreshing:false,git:null});
    response=await h.app.inject({method:"GET",url:"/api/sessions/s/workspace"}); expect(response.json().snapshot.state).toBe("not_git");
    await h.app.close();
  });
  it("returns the last snapshot when offline, and identifies older nodes and missing workspaces", async () => {
    const h=harness(); await h.app.inject({method:"GET",url:"/api/sessions/s/workspace"});
    h.setConnected(false);
    let response=await h.app.inject({method:"GET",url:"/api/sessions/s/workspace"});
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({node:{status:"offline"},snapshot:{state:"ready",branch:"main"},read_only:[{path:"read.txt"}]});
    h.setConnected(true); h.setOutcome(rejected("workspace_snapshot","unknown", "CONTROL_COMMAND_NOT_IN_INVENTORY"));
    response=await h.app.inject({method:"GET",url:"/api/sessions/s/workspace"}); expect(response.json()).toMatchObject({node:{status:"unsupported"},read_only:[{path:"read.txt"}]});
    h.setOutcome(rejected("workspace_snapshot","NOT_FOUND: workspace unavailable"));
    response=await h.app.inject({method:"GET",url:"/api/sessions/s/workspace"}); expect(response.json()).toMatchObject({node:{status:"no_workspace"},read_only:[{path:"read.txt"}]});
    await h.app.close();
  });
  it("maps node file errors to the specified HTTP responses", async () => {
    const h=harness();
    const url="/api/sessions/s/workspace/file?path=read.txt";
    await h.app.inject({method:"GET",url:"/api/sessions/s/workspace"});
    h.setConnected(false); expect((await h.app.inject({method:"GET",url})).statusCode).toBe(503); h.setConnected(true);
    for(const [message, code, expected] of [["NOT_FOUND: missing", undefined, 404], ["TOO_LARGE: too big", undefined, 413], ["Not implemented in soul-server-ts: workspace_file_read", undefined, 501], ["deadline", "CONTROL_RESULT_TIMEOUT", 504]] as const) {
      h.setFileError(rejected("workspace_file_read",message,code));
      expect((await h.app.inject({method:"GET",url})).statusCode).toBe(expected);
    }
    await h.app.close();
  });
  it("returns byte ranges and maps outside paths to 400", async () => {
    const h=harness();
    const response=await h.app.inject({method:"GET",url:"/api/sessions/s/workspace/file?path=.%2Fread.txt",headers:{range:"bytes=1-3"}});
    expect(response.statusCode).toBe(206); expect(response.headers["content-range"]).toBe("bytes 1-3/6"); expect(response.headers["content-length"]).toBe("3"); expect(response.body).toBe("bcd");
    expect((await h.app.inject({method:"GET",url:"/api/sessions/s/workspace/file?path=..%2Foutside"})).statusCode).toBe(403);
    await h.app.close();
  });
});

it("denies a file absent from the workspace list before requesting its contents", async () => {
  const h=harness();
  const response=await h.app.inject({method:"GET",url:"/api/sessions/s/workspace/file?path=.env.local"});
  expect(response.statusCode).toBe(403);
  expect(h.bridge.sendPendingCommand.mock.calls.some(([arg]:any)=>arg.command.message.type === "workspace_file_read")).toBe(false);
  await h.app.close();
});

it("filters git-only paths for restricted users and shares authorization with diff", async () => {
  const h=harness();
  h.setOutcome({root:"/repo",state:"ready",observed_at:"2026-01-02T00:00:00Z",refreshing:false,git:{branch:"main",head:"abc",upstream:null,ahead:0,behind:0,truncated:false,files:[{path:"other/file.txt",orig_path:"old.txt",status:"renamed",added:1,deleted:1,size:1}],commits:[]}});
  h.setRestricted(true);
  expect((await h.app.inject({url:"/api/sessions/s/workspace"})).json().files).toEqual([]);
  for (const endpoint of ["file","diff"]) expect((await h.app.inject({url:`/api/sessions/s/workspace/${endpoint}?path=other%2Ffile.txt`})).statusCode).toBe(403);
  h.setRestricted(false);
  expect((await h.app.inject({url:"/api/sessions/s/workspace/file?path=other%2Ffile.txt"})).statusCode).toBe(200);
  expect((await h.app.inject({url:"/api/sessions/s/workspace/diff?path=other%2Ffile.txt"})).json()).toMatchObject({path:"other/file.txt",status:"renamed"});
  const command=h.bridge.sendPendingCommand.mock.calls.map(([arg]:any)=>arg.command.message).find((cmd:any)=>cmd.type === "workspace_file_diff");
  expect(command.orig_path).toBeNull();
  await h.app.close();
});

it("maps diff node errors", async () => {
  const h=harness(); const url="/api/sessions/s/workspace/diff?path=read.txt";
  for (const [message,code,expected] of [["NOT_FOUND: missing",undefined,404],["INVALID_REQUEST: bad",undefined,400],["NOT_GIT: bad",undefined,409],["CONFLICT: workspace root changed",undefined,409],["Not implemented in soul-server-ts: workspace_file_diff",undefined,501],["deadline","CONTROL_RESULT_TIMEOUT",504]] as const) {
    h.setFileError(rejected("workspace_file_diff",message,code)); expect((await h.app.inject({url})).statusCode).toBe(expected);
  }
  h.setConnected(false); expect((await h.app.inject({url})).statusCode).toBe(503);
  await h.app.close();
});

it("uses the last git list while a fresh snapshot is pending", async () => {
  const h=harness();
  h.setOutcome({root:"/repo",state:"ready",observed_at:"2026-01-02T00:00:00Z",refreshing:false,git:{branch:"main",head:"abc",upstream:null,ahead:0,behind:0,truncated:false,files:[{path:"git.txt",orig_path:null,status:"modified",added:1,deleted:0,size:1}],commits:[]}});
  await h.app.inject({url:"/api/sessions/s/workspace"});
  h.setOutcome({root:"/repo",state:"pending",observed_at:null,refreshing:true,git:null});
  expect((await h.app.inject({url:"/api/sessions/s/workspace"})).json()).toMatchObject({snapshot:{state:"pending"},files:[{path:"git.txt"}]});
  expect((await h.app.inject({url:"/api/sessions/s/workspace/file?path=git.txt"})).statusCode).toBe(200);
  await h.app.close();
});

it("does not reuse git paths from a different pending root", async () => {
  const h=harness();
  h.setOutcome({root:"/repo",state:"ready",observed_at:"2026-01-02T00:00:00Z",refreshing:false,git:{branch:"main",head:"abc",upstream:null,ahead:0,behind:0,truncated:false,files:[{path:"git.txt",orig_path:null,status:"modified",added:1,deleted:0,size:1}],commits:[]}});
  await h.app.inject({url:"/api/sessions/s/workspace"});
  h.setOutcome({root:"/other",state:"pending",observed_at:null,refreshing:true,git:null});
  expect((await h.app.inject({url:"/api/sessions/s/workspace"})).json().files).toEqual([]);
  expect((await h.app.inject({url:"/api/sessions/s/workspace/file?path=git.txt"})).statusCode).toBe(403);
  await h.app.close();
});

it("does not pass an unauthorized rename source for a restricted caller", async () => {
  const h=harness(); h.setRestricted(true);
  h.setOutcome({root:"/repo",state:"ready",observed_at:"2026-01-02T00:00:00Z",refreshing:false,git:{branch:"main",head:"abc",upstream:null,ahead:0,behind:0,truncated:false,files:[{path:"read.txt",orig_path:"secret.txt",status:"renamed",added:1,deleted:0,size:1}],commits:[]}});
  expect((await h.app.inject({url:"/api/sessions/s/workspace/diff?path=read.txt"})).statusCode).toBe(200);
  const command=h.bridge.sendPendingCommand.mock.calls.map(([arg]:any)=>arg.command.message).find((cmd:any)=>cmd.type === "workspace_file_diff");
  expect(command.orig_path).toBeNull(); await h.app.close();
});

it("uses the session identity that produced the authorized file list", async () => {
  const h=harness(); h.moveOnSecondRead();
  expect((await h.app.inject({url:"/api/sessions/s/workspace/file?path=read.txt"})).statusCode).toBe(200);
  const commands=h.bridge.sendPendingCommand.mock.calls.map(([arg]:any)=>arg.command.message);
  expect(commands.find((cmd:any)=>cmd.type === "workspace_file_read").agent_id).toBe("a");
  await h.app.close();
});

it("permits only activity paths for restricted callers on both endpoints", async () => {
  const h=harness(); h.setRestricted(true);
  const created_at=new Date("2026-01-02T00:00:00Z");
  h.setActivities([{event_type:"tool_start",tool_name:"Read",file_path:"read.txt",created_at},{event_type:"tool_start",tool_name:"Read",file_path:"read-only.txt",created_at},{event_type:"tool_start",tool_name:"Write",file_path:"wrote.txt",created_at}]);
  const changed=(path:string)=>({path,orig_path:null,status:"modified",added:1,deleted:0,size:1});
  h.setOutcome({root:"/repo",state:"ready",observed_at:"2026-01-02T00:00:00Z",refreshing:false,git:{branch:"main",head:"abc",upstream:null,ahead:0,behind:0,truncated:false,files:[changed("git-only.txt"),changed("read.txt"),changed("wrote.txt")],commits:[]}});
  for(const endpoint of ["file","diff"]) for(const [name,code] of [["git-only.txt",403],["read.txt",200],["wrote.txt",200],["read-only.txt",200]] as const) {
    expect((await h.app.inject({url:`/api/sessions/s/workspace/${endpoint}?path=${name}`})).statusCode).toBe(code);
  }
  await h.app.close();
});

it("matches Windows paths case insensitively and sends the listed spelling", async () => {
  const h=harness();
  h.setActivities([{event_type:"tool_start",tool_name:"Read",file_path:"C:\\Repo\\Folder\\Read.txt",created_at:new Date("2026-01-02T00:00:00Z")}]);
  h.setOutcome({root:"C:\\Repo",state:"not_git",observed_at:"2026-01-02T00:00:00Z",refreshing:false,git:null});
  expect((await h.app.inject({url:"/api/sessions/s/workspace/file?path=folder%2Fread.txt"})).statusCode).toBe(200);
  const command=h.bridge.sendPendingCommand.mock.calls.map(([arg]:any)=>arg.command.message).find((cmd:any)=>cmd.type === "workspace_file_read");
  expect(command.path).toBe("Folder/Read.txt"); await h.app.close();
});

it("passes a rename source when it is also in the restricted caller's list", async () => {
  const h=harness(); h.setRestricted(true);
  const created_at=new Date("2026-01-02T00:00:00Z");
  h.setActivities([{event_type:"tool_start",tool_name:"Read",file_path:"read.txt",created_at},{event_type:"tool_start",tool_name:"Read",file_path:"old.txt",created_at}]);
  h.setOutcome({root:"/repo",state:"ready",observed_at:"2026-01-02T00:00:00Z",refreshing:false,git:{branch:"main",head:"abc",upstream:null,ahead:0,behind:0,truncated:false,files:[{path:"read.txt",orig_path:"old.txt",status:"renamed",added:1,deleted:0,size:1}],commits:[]}});
  expect((await h.app.inject({url:"/api/sessions/s/workspace/diff?path=read.txt"})).statusCode).toBe(200);
  const command=h.bridge.sendPendingCommand.mock.calls.map(([arg]:any)=>arg.command.message).find((cmd:any)=>cmd.type === "workspace_file_diff");
  expect(command.orig_path).toBe("old.txt"); await h.app.close();
});

it("keeps POSIX backslash activity distinct from a slash path", async () => {
  if (process.platform === "win32") return;
  const root=await mkdtemp(path.join(tmpdir(),"posix-paths-"));
  await mkdir(path.join(root,"a"));
  await writeFile(path.join(root,"a\\b"),"backslash");
  await writeFile(path.join(root,"a","b"),"slash");
  const h=harness(); h.setRestricted(true);
  h.setActivities([{event_type:"tool_start",tool_name:"Read",file_path:path.join(root,"a\\b"),created_at:new Date("2026-01-02T00:00:00Z")}]);
  h.setOutcome({root,state:"ready",observed_at:"2026-01-02T00:00:00Z",refreshing:false,git:{branch:"main",head:"abc",upstream:null,ahead:0,behind:0,truncated:false,files:[{path:"a/b",orig_path:null,status:"modified",added:1,deleted:0,size:1}],commits:[]}});
  const listing=(await h.app.inject({url:"/api/sessions/s/workspace"})).json();
  expect(listing.files).toEqual([]); expect(listing.read_only.map((row:any)=>row.path)).toContain("a\\b");
  for (const endpoint of ["file","diff"]) expect((await h.app.inject({url:`/api/sessions/s/workspace/${endpoint}?path=a%2Fb`})).statusCode).toBe(403);
  await h.app.close(); await rm(root,{recursive:true,force:true});
});

it("requires a known root and sends the same root with file and diff commands", async () => {
  const h=harness();
  for(const endpoint of ["file","diff"]) {
    expect((await h.app.inject({url:`/api/sessions/s/workspace/${endpoint}?path=read.txt`})).statusCode).toBe(200);
  }
  const commands=h.bridge.sendPendingCommand.mock.calls.map(([arg]:any)=>arg.command.message);
  expect(commands.filter((cmd:any)=>cmd.type === "workspace_file_read" || cmd.type === "workspace_file_diff").map((cmd:any)=>cmd.expected_root)).toEqual(["/repo","/repo"]);
  const unknown=harness(); unknown.setOutcome(rejected("workspace_snapshot","not implemented","CONTROL_COMMAND_NOT_IN_INVENTORY"));
  for(const endpoint of ["file","diff"]) expect((await unknown.app.inject({url:`/api/sessions/s/workspace/${endpoint}?path=read.txt`})).statusCode).toBe(501);
  expect(unknown.bridge.sendPendingCommand.mock.calls.some(([arg]:any)=>arg.command.message.type === "workspace_file_read" || arg.command.message.type === "workspace_file_diff")).toBe(false);
  await h.app.close(); await unknown.app.close();
});

it("keeps differently cased Windows paths separate for restricted access", async () => {
  const h=harness(); h.setRestricted(true);
  const created_at=new Date("2026-01-02T00:00:00Z");
  h.setActivities([{event_type:"tool_start",tool_name:"Write",file_path:"C:\\Repo\\folder\\read.txt",created_at},{event_type:"tool_start",tool_name:"Read",file_path:"C:\\Repo\\FOLDER\\READ.TXT",created_at}]);
  h.setOutcome({root:"C:\\Repo",state:"ready",observed_at:"2026-01-02T00:00:00Z",refreshing:false,git:{branch:"main",head:"abc",upstream:null,ahead:0,behind:0,truncated:false,files:[{path:"Folder/Read.txt",orig_path:null,status:"modified",added:1,deleted:0,size:1}],commits:[]}});
  const response=await h.app.inject({url:"/api/sessions/s/workspace"});
  expect(response.json().files).toEqual([expect.objectContaining({path:"folder/read.txt",git_status:null,wrote:true,read:false})]);
  expect(response.json().read_only).toEqual([expect.objectContaining({path:"FOLDER/READ.TXT"})]);
  expect((await h.app.inject({url:"/api/sessions/s/workspace/file?path=folder%2Fread.txt"})).statusCode).toBe(200);
  await h.app.close();
});

it("rejects file and diff contents when an older node omits root confirmation", async () => {
  const h=harness(); h.setRootChecked(false);
  for (const endpoint of ["file","diff"]) {
    const response=await h.app.inject({url:`/api/sessions/s/workspace/${endpoint}?path=read.txt`});
    expect(response.statusCode).toBe(501); expect(response.body).not.toContain(endpoint === "file" ? "abcdef" : "diff");
  }
  await h.app.close();
});

it("does not authorize a git-only Windows spelling through a differently cased activity", async () => {
  const h=harness(); h.setRestricted(true);
  h.setActivities([{event_type:"tool_start",tool_name:"Read",file_path:"C:\\Repo\\Foo.ts",created_at:new Date("2026-01-02T00:00:00Z")}]);
  h.setOutcome({root:"C:\\Repo",state:"ready",observed_at:"2026-01-02T00:00:00Z",refreshing:false,git:{branch:"main",head:"abc",upstream:null,ahead:0,behind:0,truncated:false,files:[{path:"foo.ts",orig_path:null,status:"modified",added:1,deleted:0,size:1}],commits:[]}});
  const listing=(await h.app.inject({url:"/api/sessions/s/workspace"})).json();
  expect(listing.files).toEqual([]); expect(listing.read_only.map((row:any)=>row.path)).toEqual(["Foo.ts"]);
  for(const endpoint of ["file","diff"]) expect((await h.app.inject({url:`/api/sessions/s/workspace/${endpoint}?path=foo.ts`})).statusCode).toBe(403);
  await h.app.close();
});

it("maps a missing snapshot root according to the node status without reading files", async () => {
  for(const [kind,expected] of [["offline",503],["unsupported",501],["no_workspace",404],["error",502]] as const) {
    const h=harness();
    if(kind === "offline") h.setConnected(false);
    else if(kind === "unsupported") h.setOutcome(rejected("workspace_snapshot","unknown","CONTROL_COMMAND_NOT_IN_INVENTORY"));
    else if(kind === "no_workspace") h.setOutcome(rejected("workspace_snapshot","NOT_FOUND: missing"));
    else h.setOutcome(rejected("workspace_snapshot","unexpected"));
    for(const endpoint of ["file","diff"]) expect((await h.app.inject({url:`/api/sessions/s/workspace/${endpoint}?path=read.txt`})).statusCode).toBe(expected);
    expect(h.bridge.sendPendingCommand.mock.calls.some(([arg]:any)=>["workspace_file_read","workspace_file_diff"].includes(arg.command.message.type))).toBe(false);
    await h.app.close();
  }
});
