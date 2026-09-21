import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { jsonResult, errorResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { requireMcpMutationActor } from "./caller_session.js";
import { WorktreeServiceError } from "../../worktree/worktree_service.js";

const nodeSchema = z.string().min(1).optional();

export function registerWorktreeTools(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "list_worktrees",
    {
      description: "노드의 Git worktree 발견 목록과 Soulstream 소유 상태를 조회한다. 네트워크 fetch는 하지 않는다.",
      inputSchema: {
        node_id: nodeSchema,
        repo_id: z.string().min(1).optional(),
        worktree_id: z.string().min(1).optional(),
        caller_session_id: z.string().min(1).optional(),
      },
    },
    async ({ node_id, repo_id, worktree_id, caller_session_id }) => {
      try {
        const actor = requireAgentActor(caller_session_id, "list_worktrees");
        const worktrees = await route(runtime, node_id, "list", {
          actorSessionId: actor,
          ...(repo_id ? { repoId: repo_id } : {}),
          ...(worktree_id ? { worktreeId: worktree_id } : {}),
        });
        return jsonResult({ worktrees });
      } catch (error) {
        return worktreeError(error);
      }
    },
  );

  server.registerTool(
    "create_worktree",
    {
      description: "새/기존 branch worktree를 만들거나 발견된 unmanaged worktree를 명시적으로 인계한다.",
      annotations: { destructiveHint: true },
      inputSchema: {
        node_id: nodeSchema,
        repo_id: z.string().min(1),
        branch: z.string().min(1),
        mode: z.enum(["new", "existing", "adopt"]),
        start_point: z.string().min(1).optional(),
        adopt_path: z.string().min(1).optional(),
        expected_head: z.string().min(1).optional(),
        setup: z.enum(["none", "shared_dependencies"]).default("none"),
        require_setup: z.boolean().default(false),
        caller_session_id: z.string().min(1).optional(),
      },
    },
    async ({ node_id, repo_id, branch, mode, start_point, adopt_path, expected_head, setup, require_setup, caller_session_id }) => {
      try {
        const actorSessionId = requireAgentActor(caller_session_id, "create_worktree");
        return jsonResult(await route(runtime, node_id, "create", {
          actorSessionId,
          repoId: repo_id,
          branch,
          mode,
          ...(start_point ? { startPoint: start_point } : {}),
          ...(adopt_path ? { adoptPath: adopt_path } : {}),
          ...(expected_head ? { expectedHead: expected_head } : {}),
          setup,
          requireSetup: require_setup,
        }));
      } catch (error) {
        return worktreeError(error);
      }
    },
  );

  server.registerTool(
    "remove_worktree",
    {
      description: "소유한 clean worktree의 작업 디렉터리만 제거한다. branch와 파일은 강제 삭제하지 않는다.",
      annotations: { destructiveHint: true },
      inputSchema: {
        node_id: nodeSchema,
        worktree_id: z.string().min(1),
        caller_session_id: z.string().min(1).optional(),
      },
    },
    async ({ node_id, worktree_id, caller_session_id }) => {
      try {
        const actorSessionId = requireAgentActor(caller_session_id, "remove_worktree");
        return jsonResult(await route(runtime, node_id, "remove", {
          actorSessionId,
          worktreeId: worktree_id,
        }));
      } catch (error) {
        return worktreeError(error);
      }
    },
  );

  server.registerTool(
    "delete_worktree_branch",
    {
      description: "제거된 worktree의 보존이 입증된 local branch만 expected-SHA transaction으로 삭제한다.",
      annotations: { destructiveHint: true },
      inputSchema: {
        node_id: nodeSchema,
        worktree_id: z.string().min(1),
        caller_session_id: z.string().min(1).optional(),
      },
    },
    async ({ node_id, worktree_id, caller_session_id }) => {
      try {
        const actorSessionId = requireAgentActor(caller_session_id, "delete_worktree_branch");
        return jsonResult(await route(runtime, node_id, "delete-branch", {
          actorSessionId,
          worktreeId: worktree_id,
        }));
      } catch (error) {
        return worktreeError(error);
      }
    },
  );
}

function requireAgentActor(callerSessionId: string | undefined, operation: string): string {
  const actor = requireMcpMutationActor(callerSessionId, operation);
  if (actor.actorKind !== "agent") {
    throw new WorktreeServiceError("AGENT_SESSION_REQUIRED", `${operation} requires an agent session`);
  }
  return actor.actorSessionId;
}

async function route(
  runtime: McpRuntime,
  nodeId: string | undefined,
  operation: "list" | "create" | "remove" | "delete-branch",
  body: Record<string, unknown>,
): Promise<unknown> {
  const targetNodeId = nodeId ?? runtime.nodeId;
  if (targetNodeId === runtime.nodeId) {
    if (!runtime.worktreeService) {
      throw new WorktreeServiceError("WORKTREE_MCP_DISABLED", "Worktree MCP is disabled on this node");
    }
    if (operation === "list") return await runtime.worktreeService.list(body as never);
    if (operation === "create") return await runtime.worktreeService.create(body as never);
    if (operation === "remove") return await runtime.worktreeService.remove(body as never);
    return await runtime.worktreeService.deleteBranch(body as never);
  }
  if (!runtime.orch) throw new WorktreeServiceError("ORCH_UNAVAILABLE", "Orchestrator proxy is unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 130_000);
  try {
    const response = await fetch(
      `${runtime.orch.baseUrl}/api/nodes/${encodeURIComponent(targetNodeId)}/worktrees/${operation}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...runtime.orch.headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    const result = await response.json() as unknown;
    if (!response.ok) {
      const remote = remoteError(result);
      throw new WorktreeServiceError(
        remote?.code ?? "REMOTE_WORKTREE_FAILED",
        remote?.message ?? JSON.stringify(result),
        remote?.details,
      );
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function remoteError(value: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} | undefined {
  if (!value || typeof value !== "object") return undefined;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const { code, message, details } = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  return typeof code === "string" && typeof message === "string"
    ? {
        code,
        message,
        ...(details !== null && typeof details === "object" && !Array.isArray(details)
          ? { details: details as Record<string, unknown> }
          : {}),
      }
    : undefined;
}

function worktreeError(error: unknown) {
  if (error instanceof WorktreeServiceError) {
    return errorResult(JSON.stringify({
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    }));
  }
  const candidate = error as { code?: unknown; message?: unknown };
  return errorResult(JSON.stringify({
    code: typeof candidate?.code === "string" ? candidate.code : "WORKTREE_FAILED",
    message: error instanceof Error ? error.message : String(error),
  }));
}
