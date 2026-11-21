import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { jsonResult } from "@soulstream/mcp-contract";
import { getCurrentMcpPrincipal } from "../request_context.js";
import type { McpRuntime } from "../runtime.js";
import { requireMcpMutationActor } from "./caller_session.js";
import { WorktreeServiceError } from "../../worktree/worktree_service.js";

type WorktreeOperation = "list" | "create" | "remove" | "delete-branch";

export function registerWorktreeTools(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "list_worktrees",
    {
      description: "노드의 Git worktree 발견 목록과 Soulstream 소유 상태를 조회한다. 네트워크 fetch는 하지 않는다. 기본은 제거된(removed) 기록을 빼고 20건씩 돌려주며 nextCursor로 다음 쪽을 잇는다. total은 거른 뒤 전체 건수다. repo_id로 한 리포만 보고, worktree_id로 한 건(제거된 기록 포함)을 보며 전체 ID가 필요하다. include_removed=true면 제거된 기록도 넣는다.",
      inputSchema: {
        repo_id: z.string().min(1).optional(),
        worktree_id: z.string().min(1).optional(),
        include_removed: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().min(1).optional(),
        caller_session_id: z.string().min(1).optional(),
      },
    },
    async ({ repo_id, worktree_id, include_removed, limit, cursor, caller_session_id }) => {
      try {
        const actor = requireAgentActor(caller_session_id, "list_worktrees");
        return jsonResult(await route(runtime, "list", {
          actorSessionId: actor,
          ...(repo_id ? { repoId: repo_id } : {}),
          ...(worktree_id ? { worktreeId: worktree_id } : {}),
          ...(include_removed !== undefined ? { includeRemoved: include_removed } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        }));
      } catch (error) {
        return worktreeError(error);
      }
    },
  );

  server.registerTool(
    "create_worktree",
    {
      description: "새/기존 branch worktree를 만들거나 발견된 unmanaged worktree를 명시적으로 인계한다. pnpm 저장소는 setup 생략 시 shared_dependencies와 필수 준비를 사용한다. 필수 shared 준비가 실패하면 WORKTREE_SETUP_REQUIRED로 보존된 worktree ID와 경로를 반환한다. 복구 시 그 경로의 필요한 변경을 보존하고 점유 세션을 종료한 뒤 remove_worktree로 제거하고, 같은 브랜치를 mode=existing, setup=none으로 새 worktree에 만든 다음 반환 경로 안에서 독립 설치한다. 보존된 같은 ID/브랜치에 setup=none으로 재호출하면 WORKTREE_SETUP_CONTRACT_MISMATCH이며, 실패한 worktree에서 독립 설치만 해도 shared 계약과 실행 차단은 유지된다. shared ready는 연결된 의존성과 직접 선언된 package-local Vitest/Jest 실행 파일의 존재와 실행 가능 여부만 확인한다. soul-app Jest는 별도 npm 준비가 필요하고 workspace import 및 의존성 버전 호환은 별도로 검증한다. 오래된 base나 의존성 변경이 있는 작업은 처음부터 setup=none으로 만들고 반환 경로 안에서 독립 설치한다. setup=none은 의존성 링크를 만들지 않는다. 격리 세션(예: 구현원 roselin)에 붙일 워크트리는 setup=\"none\"으로 만들고 그 안에서 독립 설치한다. shared_dependencies 워크트리를 붙이면 세션이 시작하자마자 ISOLATION_SHARED_DEPENDENCY_INODE로 끝난다. 독립 pnpm 설치는 반환된 경로 안에서 `corepack pnpm@10.32.1 install --frozen-lockfile`을 사용한다. soul-app은 별도 npm 프로젝트이므로 setup=none으로 만들고 `NODE_ENV=development npm --prefix soul-app ci --include=dev`를 실행한다.",
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
          restricted: getCurrentMcpPrincipal().tier === "restricted",
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
      description: "소유한 clean worktree의 작업 디렉터리만 제거한다. branch와 파일은 강제 삭제하지 않는다. worktree_id는 list_worktrees가 돌려준 전체 ID다(짧은 ID나 앞부분은 받지 않는다).",
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
      description: "제거된 worktree의 보존이 입증된 local branch만 expected-SHA transaction으로 삭제한다. worktree_id는 list_worktrees가 돌려준 전체 ID다(짧은 ID나 앞부분은 받지 않는다).",
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
  const candidate = error as { code?: unknown; details?: unknown };
  const code = error instanceof WorktreeServiceError
    ? error.code
    : typeof candidate?.code === "string"
      ? candidate.code
      : "WORKTREE_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof WorktreeServiceError
    ? error.details
    : candidate?.details && typeof candidate.details === "object" && !Array.isArray(candidate.details)
      ? candidate.details as Record<string, unknown>
      : undefined;
  // 에이전트 런타임은 content 글만 모델에 보여 준다. code와 details도 여기에 싣는다.
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: details === undefined
        ? `${code}: ${message}`
        : `${code}: ${message}\ndetails: ${JSON.stringify(details)}`,
    }],
    structuredContent: {
      error: message,
      code,
      ...(details ? { details } : {}),
    },
  };
}
