import pino from "pino";
import { describe, expect, it } from "vitest";
import { AgentBackendSchema } from "@soulstream/model-catalog";
import { ModelCatalog, nodeEffortCapabilities } from "../../../src/model_catalog.js";
import { createEngineFactory } from "../../../src/runtime/engine_factory.js";
import { createRunnerChildEngine } from "../../../src/runner/runner_child_engine_factory.js";
import { parseRunnerChildConfig } from "../../../src/runner/runner_child_config.js";
import { requiresBackendSessionId } from "../../../src/runner/runner_child_runtime_helpers.js";
import { runnerProcessPaths } from "../../../src/runner/runner_process_paths.js";
import { McpConfigService } from "../../../src/mcp_config_service.js";
import { RunnerEventFrameSchema } from "../../../src/runner/frame_protocol.js";
import { join } from "node:path";
import { makeTempDirSync } from "../../helpers/temp_dir.js";

it("uses the shared backend schema at catalog, frame and child-config boundaries", () => {
  expect(AgentBackendSchema.parse("antigravity")).toBe("antigravity");
  expect(requiresBackendSessionId("antigravity")).toBe(true);
  for (const kind of ["run_state_snapshot", "session_items_snapshot"]) {
    expect(RunnerEventFrameSchema.safeParse({ protocolVersion: 1, channel: "event", kind, snapshot: { backendId: "antigravity", serialized: null, items: [] } }).success).toBe(true);
  }
});
it("advertises two base-model presets, bounded efforts and null usage provider until PR B", () => {
  const catalog=new ModelCatalog(join(process.cwd(),"config/model-catalog.yaml.example"));
  for(const [id,effort] of [["gemini-3.8-flash","low"],["gemini-4-argon","high"]]) {
    expect(catalog.list().find(x=>x.id===id)).toMatchObject({backend:"antigravity",model:id,default_effort:effort,supported_efforts:["low","medium","high"]});
    expect(catalog.advertise().find(x=>x.id===id)?.usage_provider).toBeNull();
  }
  expect(nodeEffortCapabilities("sdk").antigravity).toEqual(["low","medium","high"]);
});
it("creates Antigravity through both factories without checking or spawning an installed CLI", () => {
  const workspaceDir=makeTempDirSync("agy-factories-");
  const stateDirectory=join(workspaceDir,"state");
  const agent={ id:"test",name:"시험",backend:"claude" as const,workspace_dir:workspaceDir };
  const logger=pino({level:"silent"});
  const factory=createEngineFactory({env:{CODEX_ADAPTER_MODE:"sdk",CODEX_APP_SERVER_REQUEST_TIMEOUT_MS:30000,CODEX_APP_SERVER_STARTUP_TIMEOUT_MS:120000,CODEX_DETACHED_RESULT_RETENTION_MS:1800000,CLAUDE_SESSION_RUNTIME_V2_ENABLED:false,MCP_INTERNAL_PORT:4206,MCP_PATH:"/mcp",SOUL_RUNNER_STATE_DIR:stateDirectory},logger,codexProcessEnv:{},antigravityProcessEnv:{},buildClaudeProcessEnv:()=>({}),claudeSessionStore:{async append(){},async load(){return null;}},mcpConfigService:new McpConfigService({agentsConfigPath:join(workspaceDir,"agents.yaml")})});
  expect(factory(agent,"antigravity").backendId).toBe("antigravity");
  const config=parseRunnerChildConfig({schemaVersion:1,sessionId:"test",backend:"antigravity",agent,paths:runnerProcessPaths(stateDirectory,"test"),codeSha:"test",snapshotPath:workspaceDir,codexAdapterMode:"sdk",antigravityCliPath:"/test/agy",claudeRuntimeV2Enabled:false,claudeRuntimeIdleTtlMs:60000,claudeRuntimeMaxEntries:1,claudeRuntimeTurnTimeoutMs:60000,internalMcpUrl:"http://127.0.0.1:4206/mcp",codexHome:null,rolloutRoot:null});
  expect(config.antigravityCliPath).toBe("/test/agy");
  expect(createRunnerChildEngine(config,{} as never,logger).backendId).toBe("antigravity");
  expect(()=>createRunnerChildEngine({...config,backend:"unknown" as never},{} as never,logger)).toThrow(/Unsupported backend/);
});
