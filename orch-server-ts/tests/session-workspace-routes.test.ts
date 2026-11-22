import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { PendingNodeCommandRejectedError } from "../src/node/pending_commands.js";
import { createLiveSessionWorkspaceProvider } from "../src/runtime/live_session_workspace_provider.js";
import { registerSessionWorkspaceRoutes } from "../src/session/session_workspace_routes.js";

function harness() {
  let connected=true;
  let outcome: any = {root:"/repo",state:"ready",observed_at:"2026-01-02T00:00:00.000Z",refreshing:false,git:{branch:"main",head:"abc",upstream:null,ahead:0,behind:0,truncated:false,files:[],commits:[]}};
  const sql=async (strings:TemplateStringsArray) => strings.join("?").includes("FROM sessions")
    ? [{session_id:"s",node_id:"n",agent_id:"a",worktree_id:null,created_at:new Date("2026-01-01T00:00:00Z"),model_preset:"claude"}]
    : [{event_type:"tool_start",tool_name:"Read",file_path:"read.txt",created_at:new Date("2026-01-02T00:00:00Z")}];
  const registry={getConnectedNode:()=>connected ? {nodeId:"n",connectionId:"c"} : undefined,createCommand:(_node:string,payload:any)=>({message:payload})};
  const bridge={sendPendingCommand:vi.fn(async ({command}:any) => {
    if(outcome instanceof Error) throw outcome;
    if(command.message.type === "workspace_file_read") {
      if(command.message.path === "../outside") throw rejected("workspace_file_read","INVALID_REQUEST: outside");
      const {offset,length}=command.message; const bytes=Buffer.from("abcdef").subarray(offset,length === undefined ? undefined : offset+length);
      return {content_b64:bytes.toString("base64"),content_type:"text/plain",size:6,offset,length:bytes.length};
    }
    return outcome;
  })};
  const provider=createLiveSessionWorkspaceProvider({sqlResolver:{resolveSql:async()=>sql} as never,registry:registry as never,bridge:bridge as never,modelCatalog:{snapshot:()=>({presets:[{id:"claude",backend:"claude"}]})} as never});
  const app=Fastify(); registerSessionWorkspaceRoutes(app,{provider,accessProvider:{requireSessionAccess:async()=>({restricted:false})} as never});
  return {app,bridge,setConnected:(value:boolean)=>{connected=value;},setOutcome:(value:any)=>{outcome=value;}};
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
    const url="/api/sessions/s/workspace/file?path=a.txt";
    h.setConnected(false); expect((await h.app.inject({method:"GET",url})).statusCode).toBe(503); h.setConnected(true);
    for(const [message, code, expected] of [["NOT_FOUND: missing", undefined, 404], ["TOO_LARGE: too big", undefined, 413], ["Not implemented in soul-server-ts: workspace_file_read", undefined, 501], ["deadline", "CONTROL_RESULT_TIMEOUT", 504]] as const) {
      h.setOutcome(rejected("workspace_file_read",message,code));
      expect((await h.app.inject({method:"GET",url})).statusCode).toBe(expected);
    }
    await h.app.close();
  });
  it("returns byte ranges and maps outside paths to 400", async () => {
    const h=harness();
    const response=await h.app.inject({method:"GET",url:"/api/sessions/s/workspace/file?path=a.txt",headers:{range:"bytes=1-3"}});
    expect(response.statusCode).toBe(206); expect(response.headers["content-range"]).toBe("bytes 1-3/6"); expect(response.headers["content-length"]).toBe("3"); expect(response.body).toBe("bcd");
    expect((await h.app.inject({method:"GET",url:"/api/sessions/s/workspace/file?path=..%2Foutside"})).statusCode).toBe(400);
    await h.app.close();
  });
});
