import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { PendingNodeCommandRejectedError } from "../src/node/pending_commands.js";
import { createLiveSessionWorkspaceProvider } from "../src/runtime/live_session_workspace_provider.js";
import { registerSessionWorkspaceRoutes } from "../src/session/session_workspace_routes.js";

function harness() {
  let connected=true; let restricted=false; let fileError:Error | null=null;
  let outcome: any = {root:"/repo",state:"ready",observed_at:"2026-01-02T00:00:00.000Z",refreshing:false,git:{branch:"main",head:"abc",upstream:null,ahead:0,behind:0,truncated:false,files:[],commits:[]}};
  const sql=async (strings:TemplateStringsArray) => strings.join("?").includes("FROM sessions")
    ? [{session_id:"s",node_id:"n",agent_id:"a",worktree_id:null,created_at:new Date("2026-01-01T00:00:00Z"),model_preset:"claude"}]
    : [{event_type:"tool_start",tool_name:"Read",file_path:"read.txt",created_at:new Date("2026-01-02T00:00:00Z")}];
  const registry={getConnectedNode:()=>connected ? {nodeId:"n",connectionId:"c"} : undefined,createCommand:(_node:string,payload:any)=>({message:payload})};
  const bridge={sendPendingCommand:vi.fn(async ({command}:any) => {
    if(command.message.type === "workspace_snapshot" && outcome instanceof Error) throw outcome;
    if(command.message.type !== "workspace_snapshot" && fileError) throw fileError;
    if(command.message.type === "workspace_file_diff") return {status:"renamed",text:"diff",truncated:false,binary:false};
    if(command.message.type === "workspace_file_read") {
      if(command.message.path === "../outside") throw rejected("workspace_file_read","INVALID_REQUEST: outside");
      const {offset,length}=command.message; const bytes=Buffer.from("abcdef").subarray(offset,length === undefined ? undefined : offset+length);
      return {content_b64:bytes.toString("base64"),content_type:"text/plain",size:6,offset,length:bytes.length};
    }
    return outcome;
  })};
  const provider=createLiveSessionWorkspaceProvider({sqlResolver:{resolveSql:async()=>sql} as never,registry:registry as never,bridge:bridge as never,modelCatalog:{snapshot:()=>({presets:[{id:"claude",backend:"claude"}]})} as never});
  const app=Fastify(); registerSessionWorkspaceRoutes(app,{provider,accessProvider:{requireSessionAccess:async()=>{},resolveAccess:async()=>({restricted})} as never});
  return {app,bridge,setConnected:(value:boolean)=>{connected=value;},setOutcome:(value:any)=>{outcome=value;},setRestricted:(value:boolean)=>{restricted=value;},setFileError:(value:Error|null)=>{fileError=value;}};
}
function rejected(commandType:string,message:string,code?:string) {return new PendingNodeCommandRejectedError({commandType,requestId:"r",message,response:{type:"error",code}});}
describe("session workspace routes", () => {
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
  expect((await h.app.inject({url:"/api/sessions/s/workspace/file?path=other%5Cfile.txt"})).statusCode).toBe(200);
  expect((await h.app.inject({url:"/api/sessions/s/workspace/diff?path=other%2Ffile.txt"})).json()).toMatchObject({path:"other/file.txt",status:"renamed"});
  const command=h.bridge.sendPendingCommand.mock.calls.map(([arg]:any)=>arg.command.message).find((cmd:any)=>cmd.type === "workspace_file_diff");
  expect(command.orig_path).toBe("old.txt");
  await h.app.close();
});

it("maps diff node errors", async () => {
  const h=harness(); const url="/api/sessions/s/workspace/diff?path=read.txt";
  for (const [message,code,expected] of [["NOT_FOUND: missing",undefined,404],["INVALID_REQUEST: bad",undefined,400],["NOT_GIT: bad",undefined,409],["Not implemented in soul-server-ts: workspace_file_diff",undefined,501],["deadline","CONTROL_RESULT_TIMEOUT",504]] as const) {
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
