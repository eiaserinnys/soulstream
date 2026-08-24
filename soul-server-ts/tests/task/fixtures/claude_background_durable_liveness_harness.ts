import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

import type {
  ClaudeBackgroundTaskRow,
  ObserveClaudeBackgroundTaskParams,
  TerminalizeClaudeBackgroundTaskParams,
} from "../../../src/control_plane/persistence_host_clients.js";
import { readProcessStartIdentity } from "../../../src/runner/runner_process_lock.js";

export interface DurableProcessEvidence {
  processPid: number;
  processStartIdentity: string;
}

export type DurableBackgroundTaskRow = ClaudeBackgroundTaskRow & {
  process_pid: number | null;
  process_start_identity: string | null;
};

export interface Terminalization {
  taskId: string;
  status: string;
  closeReason: string;
}

export interface RecoverySnapshot {
  rows: Array<{ taskId: string; status: string }>;
  terminalizations: number;
  deliveries: number;
  spawns: number;
}

export class DurableRepository {
  private readonly rows = new Map<string, DurableBackgroundTaskRow>();
  private readonly terminalizations: Terminalization[] = [];
  private recoverySnapshots: DurableBackgroundTaskRow[][] = [];
  private deliveryCount = 0;

  constructor(private readonly dropEvidence = false) {}

  async observe(params: ObserveClaudeBackgroundTaskParams): Promise<DurableBackgroundTaskRow> {
    const extended = params as ObserveClaudeBackgroundTaskParams & Partial<DurableProcessEvidence>;
    const current = this.rows.get(params.taskId);
    const row: DurableBackgroundTaskRow = {
      source_node: params.sourceNode,
      session_id: params.sessionId,
      task_id: params.taskId,
      sdk_session_id: params.sdkSessionId ?? current?.sdk_session_id ?? null,
      status: params.status ?? "running",
      close_reason: null,
      description: params.description ?? current?.description ?? null,
      summary: params.summary ?? current?.summary ?? null,
      output_file: params.outputFile ?? current?.output_file ?? null,
      tool_use_id: params.toolUseId ?? current?.tool_use_id ?? null,
      terminal_revision: null,
      notification_delivery_id: null,
      process_pid: this.dropEvidence ? null : extended.processPid ?? current?.process_pid ?? null,
      process_start_identity: this.dropEvidence
        ? null
        : extended.processStartIdentity ?? current?.process_start_identity ?? null,
      created_at: current?.created_at ?? new Date("2026-08-25T00:00:00.000Z"),
      updated_at: params.observedAt ?? new Date("2026-08-25T00:00:00.000Z"),
      terminal_at: null,
    };
    this.rows.set(row.task_id, row);
    return structuredClone(row);
  }

  async terminalize(params: TerminalizeClaudeBackgroundTaskParams) {
    const current = this.rows.get(params.taskId);
    if (!current) throw new Error(`background row disappeared: ${params.taskId}`);
    if (current.status !== "pending" && current.status !== "running") {
      return { accepted: false, row: structuredClone(current) };
    }
    this.deliveryCount += 1;
    const row: DurableBackgroundTaskRow = {
      ...current,
      status: params.status,
      close_reason: params.closeReason,
      terminal_revision: params.terminalRevision,
      notification_delivery_id: `delivery:${params.taskId}:${this.deliveryCount}`,
      updated_at: params.observedAt ?? new Date("2026-08-25T00:00:00.000Z"),
      terminal_at: params.observedAt ?? new Date("2026-08-25T00:00:00.000Z"),
    };
    this.rows.set(row.task_id, row);
    this.terminalizations.push({
      taskId: params.taskId,
      status: params.status,
      closeReason: params.closeReason,
    });
    return {
      accepted: true,
      row: structuredClone(row),
      delivery: {
        delivery_id: row.notification_delivery_id,
        completion_id: `completion:${params.taskId}:${params.terminalRevision}`,
        relation_key: `claude_runtime:${params.sessionId}:${params.taskId}`,
        producer_terminal_revision: params.terminalRevision,
      },
    } as never;
  }

  beginRecoveryScan(): void {
    this.recoverySnapshots.push(this.rowsSnapshot().filter((row) =>
      row.status === "pending" || row.status === "running"
    ));
    this.recoverySnapshots.push([]);
  }

  async activeForNode(): Promise<DurableBackgroundTaskRow[]> {
    return structuredClone(this.recoverySnapshots.shift() ?? []);
  }

  rowsSnapshot(): DurableBackgroundTaskRow[] {
    return [...this.rows.values()]
      .map((row) => structuredClone(row))
      .sort((left, right) => left.task_id.localeCompare(right.task_id));
  }

  terminalizationsSnapshot(): Terminalization[] {
    return structuredClone(this.terminalizations);
  }

  snapshot(spawns: number): RecoverySnapshot {
    return {
      rows: this.rowsSnapshot().map((row) => ({ taskId: row.task_id, status: row.status })),
      terminalizations: this.terminalizations.length,
      deliveries: this.deliveryCount,
      spawns,
    };
  }
}

export class MarkerProcess {
  readonly spawnCount = 1;
  readonly pid: number;
  private readonly lines: AsyncIterator<string>;
  private exited = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly reader: ReadLineInterface,
  ) {
    if (!child.pid) throw new Error("marker process omitted pid");
    this.pid = child.pid;
    this.lines = reader[Symbol.asyncIterator]();
    child.once("exit", () => { this.exited = true; });
  }

  static async start(): Promise<MarkerProcess> {
    const source = [
      "import { createInterface } from 'node:readline';",
      "let step = 0;",
      "process.stdout.write('ready\\n');",
      "const lines = createInterface({ input: process.stdin });",
      "lines.on('line', (line) => {",
      "  if (line === 'step') { step += 1; process.stdout.write('step:' + step + '\\n'); }",
      "  if (line === 'terminal') { process.stdout.write('terminal\\n'); process.exit(0); }",
      "});",
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const reader = createInterface({ input: child.stdout });
    const markerProcess = new MarkerProcess(child, reader);
    child.stderr.resume();
    return markerProcess;
  }

  async identity(): Promise<DurableProcessEvidence> {
    const processStartIdentity = await readProcessStartIdentity(this.pid);
    if (!processStartIdentity) throw new Error(`marker process ${this.pid} omitted start identity`);
    return { processPid: this.pid, processStartIdentity };
  }

  send(command: "step" | "terminal"): void {
    this.child.stdin.write(`${command}\n`);
  }

  async nextLine(): Promise<string> {
    const next = await this.lines.next();
    if (next.done) throw new Error(`marker process ${this.pid} closed before evidence`);
    return next.value;
  }

  async kill(): Promise<void> {
    if (this.exited) return;
    this.child.kill("SIGKILL");
    await this.waitForExit();
  }

  async waitForExit(): Promise<void> {
    if (this.exited) return;
    await once(this.child, "exit");
  }

  isAlive(): boolean {
    if (this.exited) return false;
    try {
      process.kill(this.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  async close(): Promise<void> {
    if (this.isAlive()) await this.kill();
    this.reader.close();
  }
}
