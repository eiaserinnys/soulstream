import type { SqlClient } from "../control_plane/control_plane_types.js";
import type { Binding, ConversationNotice, EnsureRequest } from "./conversation_types.js";

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
    const rows = await this.sql<Binding[]>`INSERT INTO conversation_bindings
      (account_id, namespace, external_key, session_id, selected_model, creation_request, phase, notices, first_input_is_initial_instruction)
      VALUES (${account}, ${namespace}, ${key}, ${id}, ${model}, ${request === null ? null : this.sql.json(request as never)}, ${phase}, ${this.sql.json(entries)}, ${firstInputIsInitial})
      ON CONFLICT DO NOTHING RETURNING *`;
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
}
