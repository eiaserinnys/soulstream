import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import type { HostSessionRow } from "../control_plane/repositories/session_read_repository.js";
import type { PersistentSessionSettingsService } from "../session/persistent_session_settings_service.js";
import type { SessionResourceAccessProvider } from "../session/session_resource_access.js";
import { ConversationCatalog, type ConversationModel } from "./conversation_catalog.js";
import { ConversationRepository } from "./conversation_repository.js";
import { ConversationError, type Binding, type EnsureRequest, type Execution, type ExecutionRequest } from "./conversation_types.js";

type Deps = {
  sql: SqlClient; repo: ConversationRepository; catalog: ConversationCatalog;
  access: Pick<SessionResourceAccessProvider, "requireFolderAccess" | "requireSessionAccess">;
  persistent: Pick<PersistentSessionSettingsService, "update">;
  row(id: string): Promise<HostSessionRow>;
  candidates(body: EnsureRequest): Promise<ConversationModel[]>;
  notice(preferred: ConversationModel, selected: ConversationModel, reason: string): string;
  initialize(request: FastifyRequest, binding: Binding, execution: Execution): Promise<void>;
};

export class ConversationExecutions {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly watchers = new Map<string, Set<() => void>>();
  constructor(private readonly deps: Deps) {}

  async locked<T>(thread: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(thread) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(thread, tail);
    await previous;
    try { return await action(); }
    finally { release(); if (this.locks.get(thread) === tail) this.locks.delete(thread); }
  }
  watch(thread: string, close: () => void): () => void {
    let set = this.watchers.get(thread);
    if (!set) { set = new Set(); this.watchers.set(thread, set); }
    set.add(close);
    return () => { set!.delete(close); if (!set!.size) this.watchers.delete(thread); };
  }
  async retryReleases(request: FastifyRequest, binding: Binding): Promise<void> {
    for (const execution of await this.deps.repo.executions(binding.session_id)) {
      if (!execution.release_pending) continue;
      await this.deps.access.requireSessionAccess({ request, sessionId: execution.session_id });
      try { await this.release(request, execution.session_id); }
      catch (error) { if (!nodeUnavailable(error)) request.log.warn({err:error}, "conversation release retry failed"); }
    }
  }
  async switch(request: FastifyRequest, binding: Binding, input: ExecutionRequest): Promise<void> {
    const { expected_execution_id: expected, ...body } = input;
    await this.deps.access.requireFolderAccess({ request, folderId: body.collection });
    const executions = await this.deps.repo.executions(binding.session_id);
    const active = binding.active_session_id ?? binding.session_id;
    const matching = executions.find(x => x.predecessor_session_id === expected && sameRequest(x.request, body));
    if (active !== expected) {
      if (matching?.phase === "complete") return;
      throw new ConversationError(409, "conflict", "Execution has changed");
    }
    const pending = executions.find(x => x.phase !== "complete");
    if (pending && (!matching || pending.session_id !== matching.session_id)) throw new ConversationError(409, "conflict", "Another execution is pending");
    if (pending) return this.finish(request, binding, pending);
    const row = await this.deps.row(active);
    const [last] = await this.deps.sql<Array<{ event_type: string }>>`SELECT event_type FROM events WHERE session_id=${active}
      AND event_type IN ('user_message','intervention_sent','tool_start','tool_result','complete','error','assistant_error') ORDER BY id DESC LIMIT 1`;
    if (row.status !== "error" && last && ["user_message","intervention_sent","tool_start","tool_result"].includes(last.event_type)) {
      throw new ConversationError(409, "conflict", "답변이 끝난 뒤 바꿀 수 있습니다");
    }
    const candidates = await this.deps.candidates(body);
    const selected = candidates.find(x => x.available);
    if (!selected) throw new ConversationError(422, "model_unavailable", "No requested model is available");
    const preferred = candidates.find(x => x.id === body.selected_model) ?? {id:body.selected_model,label:body.selected_model,available:false};
    const notices = selected.id === body.selected_model ? [] : [{id:"notice:0",at:new Date().toISOString(),
      text:this.deps.notice(preferred,selected,preferred.reason ?? "사용할 수 없습니다")}];
    const execution = await this.deps.repo.reserveExecution(binding.session_id, active, randomUUID(), executions.length, body, selected.id, notices);
    await this.finish(request, binding, execution);
  }
  async resume(request: FastifyRequest, binding: Binding): Promise<void> {
    const pending = (await this.deps.repo.executions(binding.session_id)).find(x => x.phase !== "complete");
    if (pending) await this.finish(request, binding, pending);
    await this.retryReleases(request, binding);
  }
  private async finish(request: FastifyRequest, binding: Binding, execution: Execution): Promise<void> {
    const previous = execution.predecessor_session_id!;
    await this.deps.access.requireFolderAccess({request,folderId:execution.request!.collection});
    if (execution.phase !== "initialized") await this.deps.initialize(request, binding, execution);
    const updated = (await this.deps.repo.executions(binding.session_id)).find(x => x.session_id === execution.session_id)!;
    try { await this.release(request, previous); }
    catch (error) {
      if (!nodeUnavailable(error)) throw new ConversationError(504, "pending", "Execution change is pending", binding.session_id);
      await this.deps.repo.releasePending(previous, true);
    }
    const oldRow = await this.deps.row(previous);
    const newRow = await this.deps.row(execution.session_id);
    const body = updated.request!;
    const model = await this.deps.catalog.model(updated.selected_model!);
    const profile = await this.deps.catalog.profileLabel(String(newRow.node_id), body.profile);
    const notice = oldRow.agent_id !== body.profile
      ? `프로필을 ${profile}(으)로 바꿔 새 세션으로 이었습니다.`
      : `${model?.group?.label ?? newRow.node_id}의 ${model?.label ?? updated.selected_model}로 옮겨 새 세션으로 이었습니다.`;
    await this.deps.sql.begin(async tx => {
      for (const [index, fallback] of updated.notices.entries()) {
        await tx`SELECT event_append(${execution.session_id}, 'notification', ${JSON.stringify({_conversation_notice:fallback.text})}, NULL, now(), ${`conversation-fallback:${execution.session_id}:${index}`})`;
      }
      await tx`SELECT event_append(${execution.session_id}, 'notification', ${JSON.stringify({_conversation_notice:notice})}, NULL, now(), ${`conversation-execution:${execution.session_id}`})`;
      await tx`UPDATE conversation_executions SET phase='complete',notice=${notice} WHERE session_id=${execution.session_id}`;
      await tx`UPDATE conversation_bindings SET active_session_id=${execution.session_id},selected_model=${updated.selected_model},
        creation_request=${tx.json(body as never)},instruction_id=${updated.instruction_id} WHERE session_id=${binding.session_id}`;
    });
    for (const close of this.watchers.get(binding.session_id) ?? []) close();
  }
  async release(request: FastifyRequest, session: string): Promise<void> {
    await this.deps.sql`UPDATE soulstream_schedules SET status='cancelled',claim_token=NULL,claimed_until=NULL,updated_at=now()
      WHERE session_id=${session} AND source_tool='ResumeAfterLimit' AND status IN ('active','dispatching','failed','orphaned')`;
    const [firing] = await this.deps.sql<Array<{ schedule_id: string }>>`SELECT schedule_id FROM soulstream_schedules WHERE session_id=${session} AND source_tool='ResumeAfterLimit' AND status='firing' LIMIT 1`;
    if (firing) throw new Error("Resume schedule is firing");
    await this.deps.persistent.update(request, session, { enabled:false });
    await this.deps.repo.releasePending(session, false);
  }
}
function nodeUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "NODE_UNAVAILABLE";
}
function sameRequest(a: EnsureRequest | null, b: EnsureRequest): boolean {
  return a !== null && a.title === b.title && a.selected_model === b.selected_model && a.profile === b.profile
    && a.collection === b.collection && a.initial_instruction === b.initial_instruction && a.instructions === b.instructions
    && JSON.stringify(a.model_order) === JSON.stringify(b.model_order);
}
