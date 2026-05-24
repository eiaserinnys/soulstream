/**
 * agents.yaml 도구 — agent profile 정본을 MCP에서 읽고 편집한다.
 *
 * 파일 쓰기 후 같은 AgentRegistry 인스턴스를 reload하여, 새 세션 생성 경로가 즉시
 * 갱신된 profile을 보도록 한다. 이미 실행 중인 세션은 시작 당시 profile을 유지한다.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AgentConfigService } from "../../agent_config_service.js";
import {
  AgentAtomContextSchema,
  AgentProfileSchema,
} from "../../agent_registry.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

export function registerAgentConfigTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  const agentConfig = runtime.agentConfigService ?? new AgentConfigService({
    configPath: runtime.agentsConfigPath,
    agentRegistry: runtime.agentRegistry,
  });

  server.registerTool(
    "get_agents_config",
    {
      description:
        "agents.yaml 설정 조회. include_raw=true면 원본 YAML도 반환한다.",
      inputSchema: {
        include_raw: z.boolean().default(false),
      },
    },
    async ({ include_raw }) => {
      try {
        const { raw, parsed } = agentConfig.readRaw();
        return jsonResult({
          config_path: runtime.agentsConfigPath,
          agents: parsed.agents,
          ...(include_raw ? { raw_yaml: raw } : {}),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "list_agents_config_snapshots",
    {
      description:
        "ConfigStore가 만든 agents.yaml snapshot 목록을 최신순으로 조회한다.",
      inputSchema: {},
    },
    async () => {
      try {
        const snapshots = agentConfig.listSnapshots();
        return jsonResult({
          ok: true,
          config_path: runtime.agentsConfigPath,
          snapshots: snapshots.map((snapshot) => ({
            snapshot_path: snapshot.snapshotPath,
            created_at: snapshot.createdAt,
            mtime: snapshot.mtime,
            size_bytes: snapshot.sizeBytes,
            config_path: snapshot.configPath,
            config_name: snapshot.configName,
            config_hash: snapshot.configHash,
          })),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "plan_agent_profile_update",
    {
      description:
        "agents.yaml 단일 agent profile 교체 계획(diff)을 생성한다. 파일은 쓰지 않는다.",
      inputSchema: {
        profile: AgentProfileSchema,
        create_if_missing: z.boolean().default(false),
      },
    },
    async ({ profile, create_if_missing }) => {
      try {
        const plan = await agentConfig.planProfileUpdate(
          profile,
          create_if_missing ?? false,
        );
        return jsonResult({
          ok: true,
          config_path: runtime.agentsConfigPath,
          changed: plan.changed,
          diff: plan.diff,
          snapshot_root: plan.snapshotRoot,
          comment_preservation: plan.commentPreservation,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "update_agent_profile",
    {
      description:
        "agents.yaml의 단일 agent profile을 교체한다. create_if_missing=true면 새 profile을 추가한다.",
      inputSchema: {
        profile: AgentProfileSchema,
        create_if_missing: z.boolean().default(false),
      },
    },
    async ({ profile, create_if_missing }) => {
      try {
        const updated = await agentConfig.replaceProfile(
          profile,
          create_if_missing ?? false,
        );
        return jsonResult({
          ok: true,
          config_path: runtime.agentsConfigPath,
          changed: updated.changed,
          diff: updated.diff,
          snapshot_path: updated.snapshotPath,
          comment_preservation: updated.commentPreservation,
          agent_count: updated.config.agents.length,
          agent: updated.config.agents.find((p) => p.id === profile.id),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "set_agent_atom_contexts",
    {
      description:
        "agents.yaml의 agent.atom_contexts를 교체한다. 각 항목은 atom node_id, bfs depth, titles_only를 지정한다.",
      inputSchema: {
        agent_id: z.string().min(1),
        atom_contexts: z.array(AgentAtomContextSchema).default([]),
      },
    },
    async ({ agent_id, atom_contexts }) => {
      try {
        const updated = await agentConfig.setAgentAtomContexts(
          agent_id,
          atom_contexts ?? [],
        );
        return jsonResult({
          ok: true,
          config_path: runtime.agentsConfigPath,
          changed: updated.changed,
          diff: updated.diff,
          snapshot_path: updated.snapshotPath,
          comment_preservation: updated.commentPreservation,
          agent: updated.config.agents.find((p) => p.id === agent_id),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "rollback_agents_config",
    {
      description:
        "ConfigStore가 만든 snapshot으로 agents.yaml을 rollback하고 AgentRegistry를 reload한다.",
      inputSchema: {
        snapshot_path: z.string().min(1),
      },
    },
    async ({ snapshot_path }) => {
      try {
        const updated = await agentConfig.rollback(snapshot_path);
        return jsonResult({
          ok: true,
          config_path: runtime.agentsConfigPath,
          changed: updated.changed,
          diff: updated.diff,
          rollback_snapshot_path: updated.snapshotPath,
          comment_preservation: updated.commentPreservation,
          agent_count: updated.config.agents.length,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
