import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { writeFileAtomically } from "../atomic_file_rename.js";
import { recordSchema, type SubscriptionRecord } from "./contracts.js";

const stateSchema = z.object({ version: z.literal(1), subscriptions: z.array(recordSchema) });
/** One local writer owns this file. Every mutation awaits its serialized atomic save. */
export class SubscriptionStore {
  private records = new Map<string, SubscriptionRecord>();
  private pending: Promise<void> = Promise.resolve();
  private constructor(private readonly path: string) {}
  static async open(path: string): Promise<SubscriptionStore> {
    if (!isAbsolute(path)) throw new Error("MCP_EXTERNAL_EVENTS_STATE_FILE must be absolute");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    const store = new SubscriptionStore(path);
    let raw: string;
    try { raw = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return store; throw error; }
    let state: z.infer<typeof stateSchema>;
    try { state = stateSchema.parse(JSON.parse(raw)); }
    catch { throw new Error("Invalid external Events state file"); }
    await chmod(path, 0o600);
    store.records = new Map(state.subscriptions.map(record => [record.id, record]));
    return store;
  }
  get(id: string) { return this.records.get(id); }
  values() { return [...this.records.values()]; }
  update(id: string, change: (current: SubscriptionRecord | undefined) => SubscriptionRecord | undefined): Promise<void> {
    const save = this.pending.then(async () => {
      const next = new Map(this.records);
      const record = change(next.get(id));
      if (record) next.set(id, record); else next.delete(id);
      await writeFileAtomically(this.path, JSON.stringify({ version: 1, subscriptions: [...next.values()] }), 0o600);
      this.records = next;
    });
    this.pending = save.catch(() => {});
    return save;
  }
}
