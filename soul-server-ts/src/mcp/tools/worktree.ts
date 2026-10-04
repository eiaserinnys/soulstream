import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { jsonResult, errorResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { requireMcpMutationActor } from "./caller_session.js";
import { WorktreeServiceError } from "../../worktree/worktree_service.js";

type WorktreeOperation = "list" | "create" | "remove" | "delete-branch";

export function registerWorktreeTools(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "list_worktrees",
    {
      description: "노드의 Git worktree 발견 목록과 Soulstream 소유 상태를 조회한다. 네트워크 fetch는 하지 않는다.",
      inputSchema: {
        repo_id: z.string().min(1).optional(),
        worktree_id: z.string().min(1).optional(),
        caller_session_id: z.string().min(1).optional(),
      },
    },
    async ({ repo_id, worktree_id, caller_session_id }) => {
      try {
        const actor = requireAgentActor(caller_session_id, "list_worktrees");
        const worktrees = await route(runtime, "list", {
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
      description: "새/기존 branch worktree를 만들거나 발견된 unmanaged worktree를 명시적으로 인계한다. pnpm 저장소는 생략 시 shared_dependencies와 필수 준비를 사용하고, package-local Vitest/Jest 실행 파일이 없으면 WORKTREE_SETUP_REQUIRED로 보존된 워크트리 ID와 경로를 반환한다. setup=none은 의존성 링크를 만들지 않는다. 독립 설치는 반환된 경로 안에서 `corepack pnpm@10.32.1 install --frozen-lockfile`을 사용한다. soul-app은 별도 npm 프로젝트이므로 setup=none으로 만들고 `NODE_ENV=development npm --prefix soul-app ci --include=dev`를 실행한다.",
      annotations: { destructiveHint: true },
      inputSchema: {
        repo_id: z.string().min(1),
        branch: z.string().min(1),
        mode: z.enum(["new", "existing", "adopt"]),
        start_point: z.string().min(1).optional(),
        adopt_path: z.string().min(1).optional(),
        expected_head: z.string().min(1).optional(),
        setup: z.enum(["none", "shared_dependencies"]).optional(),
        require_setup: z.boolean().optional(),
        caller_session_id: z.string().min(1).optional(),
      },
    },
    async ({ repo_id, branch, mode, start_point, adopt_path, expected_head, setup, require_setup, caller_session_id }) => {
      try {
        const actorSessionId = requireAgentActor(caller_session_id, "create_worktree");
        return jsonResult(await route(runtime, "create", {
          actorSessionId,
          repoId: repo_id,
          branch,
          mode,
          ...(start_point ? { startPoint: start_point } : {}),
          ...(adopt_path ? { adoptPath: adopt_path } : {}),
          ...(expected_head ? { expectedHead: expected_head } : {}),
          ...(setup !== undefined ? { setup } : {}),
          ...(require_setup !== undefined ? { requireSetup: require_setup } : {}),
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
        worktree_id: z.string().min(1),
        caller_session_id: z.string().min(1).optional(),
      },
    },
    async ({ worktree_id, caller_session_id }) => {
      try {
        const actorSessionId = requireAgentActor(caller_session_id, "remove_worktree");
        return jsonResult(await route(runtime, "remove", {
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
        worktree_id: z.string().min(1),
        caller_session_id: z.string().min(1).optional(),
      },
    },
    async ({ worktree_id, caller_session_id }) => {
      try {
        const actorSessionId = requireAgentActor(caller_session_id, "delete_worktree_branch");
        return jsonResult(await route(runtime, "delete-branch", {
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
  operation: WorktreeOperation,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (!runtime.worktreeService) {
    throw new WorktreeServiceError("WORKTREE_MCP_DISABLED", "Worktree MCP is disabled on this node");
  }
  if (operation === "list") return await runtime.worktreeService.list(body as never);
  if (operation === "create") return await runtime.worktreeService.create(body as never);
  if (operation === "remove") return await runtime.worktreeService.remove(body as never);
  return await runtime.worktreeService.deleteBranch(body as never);
}

function worktreeError(error: unknown) {
  if (error instanceof WorktreeServiceError) {
    return errorResult(error.message, {
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  const candidate = error as { code?: unknown; details?: unknown };
  return errorResult(error instanceof Error ? error.message : String(error), {
    code: typeof candidate?.code === "string" ? candidate.code : "WORKTREE_FAILED",
    ...(candidate?.details && typeof candidate.details === "object" && !Array.isArray(candidate.details)
      ? { details: candidate.details as Record<string, unknown> }
      : {}),
  });
}
