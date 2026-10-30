import type { SqlClient } from "../control_plane/control_plane_types.js";
import type { Binding, ConversationNotice, EnsureRequest, Execution } from "./conversation_types.js";

export class ConversationRepository {
  constructor(private readonly sql: SqlClient) {}
  async byKey(account: string, namespace: string, key: string): Promise<Binding | null> {
    const rows = await this.sql<Binding[]>`SELECT * FROM conversation_bindings WHERE account_id=${account} AND namespace=${namespace} AND external_key=${key}`;
    return rows[0] ?? null;
  }
  async byId(account: string, id: string): Promise<Binding | null> {
    const rows = await this.sql<Binding[]>`SELECT * FROM conversation_bindings WHERE account_id=${account} AND session_id=${id}`;
    return rows[0] ?? null;
  }
  async list(account: string, namespace: string): Promise<Binding[]> {
    return await this.sql<Binding[]>`SELECT * FROM conversation_bindings WHERE account_id=${account} AND namespace=${namespace} ORDER BY external_key`;
  }
  async reserve(account: string, namespace: string, key: string, id: string, model: string, request: EnsureRequest | null, phase: string, notices: string[], firstInputIsInitial = false): Promise<boolean> {
    const entries: ConversationNotice[] = notices.map((text, index) => ({ id: `notice:${index}`, text, at: new Date().toISOString() }));
    const rows = await this.sql<Execution[]>`WITH binding AS (INSERT INTO conversation_bindings
      (account_id, namespace, external_key, session_id, active_session_id, selected_model, creation_request, phase, notices, first_input_is_initial_instruction)
      VALUES (${account}, ${namespace}, ${key}, ${id}, ${id}, ${model}, ${request === null ? null : this.sql.json(request as never)}, ${phase}, ${this.sql.json(entries)}, ${firstInputIsInitial})
      ON CONFLICT DO NOTHING RETURNING session_id)
      INSERT INTO conversation_executions(thread_id,session_id,ordinal,first_input_is_initial_instruction)
      SELECT session_id,session_id,0,${firstInputIsInitial || Boolean(request?.initial_instruction)} FROM binding RETURNING *`;
    return rows.length > 0;
  }
  async phase(id: string, phase: string): Promise<void> { await this.sql`UPDATE conversation_bindings SET phase=${phase} WHERE session_id=${id}`; }
  async instruction(id: string, instructionId: string): Promise<void> { await this.sql`UPDATE conversation_bindings SET instruction_id=${instructionId} WHERE session_id=${id}`; }
  async clearInstruction(id: string): Promise<void> { await this.sql`UPDATE conversation_bindings SET instruction_id=NULL WHERE session_id=${id}`; }
  async model(id: string, model: string): Promise<void> { await this.sql`UPDATE conversation_bindings SET selected_model=${model} WHERE session_id=${id}`; }
  async order(id: string, modelOrder: string[]): Promise<void> {
    await this.sql`UPDATE conversation_bindings
      SET creation_request=jsonb_set(COALESCE(creation_request, '{}'::jsonb), '{model_order}', ${this.sql.json(modelOrder)}::jsonb, true)
      WHERE session_id=${id}`;
  }
  async selection(id: string, model: string, notices: ConversationNotice[]): Promise<void> {
    await this.sql`UPDATE conversation_bindings SET selected_model=${model}, notices=${this.sql.json(notices)} WHERE session_id=${id}`;
  }
  async archive(id: string): Promise<void> { await this.sql`UPDATE conversation_bindings SET archived=true WHERE session_id=${id}`; }
  async remove(id: string): Promise<void> { await this.sql`DELETE FROM conversation_bindings WHERE session_id=${id}`; }
  async executions(id: string): Promise<Execution[]> {
    return this.sql<Execution[]>`SELECT * FROM conversation_executions WHERE thread_id=${id} ORDER BY ordinal`;
  }
  async reserveExecution(thread: string, previous: string, id: string, ordinal: number, request: EnsureRequest, model: string, notices: ConversationNotice[]): Promise<Execution> {
    const [row] = await this.sql<Execution[]>`INSERT INTO conversation_executions
      (thread_id,session_id,predecessor_session_id,ordinal,request,selected_model,phase,first_input_is_initial_instruction,notices)
      VALUES (${thread},${id},${previous},${ordinal},${this.sql.json(request as never)},${model},'reserved',${Boolean(request.initial_instruction)},${this.sql.json(notices)}) RETURNING *`;
    return row!;
  }
  async executionPhase(id: string, phase: string): Promise<void> { await this.sql`UPDATE conversation_executions SET phase=${phase} WHERE session_id=${id}`; }
  async executionSelection(id: string, model: string, notices: ConversationNotice[]): Promise<void> {
    await this.sql`UPDATE conversation_executions SET selected_model=${model},notices=${this.sql.json(notices)} WHERE session_id=${id}`;
  }
  async executionInstruction(id: string, instruction: string): Promise<void> { await this.sql`UPDATE conversation_executions SET instruction_id=${instruction} WHERE session_id=${id}`; }
  async releasePending(id: string, pending: boolean): Promise<void> { await this.sql`UPDATE conversation_executions SET release_pending=${pending} WHERE session_id=${id}`; }
}
