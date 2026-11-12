import type { SessionExecutionChainRow } from "../db/session_db_types.js";
import type { IsolationToolGuard } from "../security/session_isolation_contract.js";
import type { McpRuntime } from "./runtime.js";

/**
 * restricted principal의 guarded/inherit 도구 실행 전 조건(§4 guard 계약).
 *
 * guard는 handler보다 먼저 실행되며, 실패하면 handler는 호출되지 않는다.
 * 관계 판정은 DB의 structural caller_session_id만 쓴다. display/header/인자
 * 주장은 근거가 아니다.
 */

export interface IsolationGuardContext {
  runtime: McpRuntime;
  principal: { tier: "restricted"; sessionId: string };
}

export type IsolationGuardDecision =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string };

export async function runIsolationToolGuard(
  guard: IsolationToolGuard,
  args: Record<string, unknown>,
  context: IsolationGuardContext,
): Promise<IsolationGuardDecision> {
  switch (guard) {
    case "create-local-session":
      return {
        ok: true,
        args: { ...args, caller_session_id: context.principal.sessionId },
      };
    case "draft-card":
      return rejectFlags(args, ["run", "queue"], "draft-card");
    case "card-status":
      return rejectStatuses(args, ["queued", "running"], "card-status");
    case "worktree-create":
      return guardWorktreeCreate(args);
    case "owned-worktree":
      return await guardOwnedWorktree(args, context);
    case "message-recipient":
      return await guardMessageRecipient(args, context);
  }
}

function rejectFlags(
  args: Record<string, unknown>,
  flags: readonly string[],
  guard: string,
): IsolationGuardDecision {
  if (flags.some((flag) => args[flag] === true)) {
    return { ok: false, message: `MCP_POLICY_DENIED: ${guard}` };
  }
  return { ok: true, args };
}

function rejectStatuses(
  args: Record<string, unknown>,
  statuses: readonly string[],
  guard: string,
): IsolationGuardDecision {
  if (statuses.includes(args.status as string)) {
    return { ok: false, message: `MCP_POLICY_DENIED: ${guard}` };
  }
  return { ok: true, args };
}

function guardWorktreeCreate(args: Record<string, unknown>): IsolationGuardDecision {
  if (args.mode === "adopt" || args.adopt_path !== undefined) {
    return { ok: false, message: "MCP_POLICY_DENIED: worktree-create" };
  }
  if (args.setup === "shared_dependencies" || args.require_setup === true) {
    return { ok: false, message: "MCP_POLICY_DENIED: worktree-create" };
  }
  return {
    ok: true,
    args: { ...args, setup: "none", require_setup: false },
  };
}

async function guardOwnedWorktree(
  args: Record<string, unknown>,
  context: IsolationGuardContext,
): Promise<IsolationGuardDecision> {
  const worktreeId = args.worktree_id;
  if (typeof worktreeId !== "string" || worktreeId.length === 0) {
    return { ok: false, message: "MCP_POLICY_DENIED: owned-worktree" };
  }
  const service = context.runtime.worktreeService;
  if (!service) return { ok: false, message: "MCP_POLICY_DENIED: owned-worktree" };
  try {
    const removable = await service.canRemoveWorktree(context.principal.sessionId, worktreeId);
    if (!removable) return { ok: false, message: "MCP_POLICY_DENIED: owned-worktree" };
  } catch {
    return { ok: false, message: "MCP_POLICY_DENIED: owned-worktree" };
  }
  return { ok: true, args };
}

async function guardMessageRecipient(
  args: Record<string, unknown>,
  context: IsolationGuardContext,
): Promise<IsolationGuardDecision> {
  const recipient = args.target_session_id;
  if (typeof recipient !== "string" || recipient.length === 0) {
    return { ok: false, message: "MCP_POLICY_DENIED: message-recipient" };
  }
  const caller = context.principal.sessionId;
  if (recipient === caller) return { ok: true, args };

  const mine = await readCallerChain(context.runtime, caller);
  if (!mine) return { ok: false, message: "MCP_POLICY_DENIED: message-recipient" };
  if (mine.has(recipient)) return { ok: true, args };

  const theirs = await readCallerChain(context.runtime, recipient);
  if (!theirs) return { ok: false, message: "MCP_POLICY_DENIED: message-recipient" };
  if (theirs.has(caller)) return { ok: true, args };
  return { ok: false, message: "MCP_POLICY_DENIED: message-recipient" };
}

/**
 * 세션 자신을 포함한 호출자 사슬 집합. 행 누락·순환·깊이 상한 절단·host 오류는
 * 모두 null(입증 불가)이다.
 */
async function readCallerChain(
  runtime: McpRuntime,
  sessionId: string,
): Promise<Set<string> | null> {
  try {
    const chain = await runtime.db.getSessionCallerChain(sessionId);
    if (!chain.root) return null;
    const seen = new Set<string>([sessionId]);
    let callerId = chain.root.caller_session_id;
    let cursor = 0;
    while (callerId !== null) {
      const row: SessionExecutionChainRow | undefined = chain.ancestors[cursor];
      if (!row || row.session_id !== callerId || seen.has(row.session_id)) return null;
      seen.add(row.session_id);
      callerId = row.caller_session_id;
      cursor += 1;
    }
    if (cursor !== chain.ancestors.length) return null;
    return seen;
  } catch {
    return null;
  }
}
