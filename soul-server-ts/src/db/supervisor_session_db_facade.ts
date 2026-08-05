import type { SupervisorHostClient } from "../control_plane/persistence_host_clients.js";
import type {
  AppendSupervisorEventParams,
  SqlClient,
  SupervisorAppendResult,
  SupervisorEventRow,
  SupervisorRegistryRow,
  SupervisorRegistryUpsertParams,
  SupervisorSourceCursorRow,
  SupervisorWakeDispatchStateParams,
} from "./session_db_types.js";

/** Supervisor 저장소 API를 SessionDB의 기존 공개 표면으로 제공한다. */
export class SupervisorSessionDbFacade {
  private supervisorHost?: SupervisorHostClient;

  constructor(_sql: SqlClient) {}

  configureSupervisorHost(host: SupervisorHostClient): void {
    this.supervisorHost = host;
  }

  async appendSupervisorEvent(params: AppendSupervisorEventParams): Promise<SupervisorAppendResult> {
    return await this.host().appendSupervisorEvent(params);
  }
  async readSupervisorEventsAfter(afterOffset = 0, limit = 100): Promise<SupervisorEventRow[]> {
    return await this.host().readSupervisorEventsAfter(afterOffset, limit);
  }
  async getSupervisorEventHeadOffset(): Promise<number> {
    return await this.host().getSupervisorEventHeadOffset();
  }
  async getSupervisorSourceCursor(sourceNode: string, sourceSessionId: string): Promise<SupervisorSourceCursorRow | null> {
    return await this.host().getSupervisorSourceCursor(sourceNode, sourceSessionId);
  }
  async setSupervisorSourceCursor(params: {
    sourceNode: string;
    sourceSessionId: string;
    contiguousUpto: number;
    highestSeenEventId: number;
    gapStart?: number | null;
    gapEnd?: number | null;
  }): Promise<SupervisorSourceCursorRow> {
    return await this.host().setSupervisorSourceCursor(params);
  }
  async getSupervisorConsumerCursor(supervisorId: string): Promise<number> {
    return await this.host().getSupervisorConsumerCursor(supervisorId);
  }
  async setSupervisorConsumerCursor(supervisorId: string, cursorOffset: number): Promise<number> {
    return await this.host().setSupervisorConsumerCursor(supervisorId, cursorOffset);
  }
  async setSupervisorWakeDispatchState(params: SupervisorWakeDispatchStateParams): Promise<SupervisorRegistryRow> {
    return await this.host().setSupervisorWakeDispatchState(params);
  }
  async upsertSupervisorRegistry(params: SupervisorRegistryUpsertParams): Promise<SupervisorRegistryRow> {
    return await this.host().upsertSupervisorRegistry(params);
  }
  async getSupervisorRegistry(role: string): Promise<SupervisorRegistryRow | null> {
    return await this.host().getSupervisorRegistry(role);
  }
  async listSupervisorRegistries(): Promise<SupervisorRegistryRow[]> {
    return await this.host().listSupervisorRegistries();
  }
  async touchSupervisorRegistry(role: string, lastSeenAt: Date): Promise<SupervisorRegistryRow | null> {
    return await this.host().touchSupervisorRegistry(role, lastSeenAt);
  }
  async recordSupervisorUsageDelta(params: {
    role: string;
    tokenDelta: number;
    compactionDelta?: number;
    lastSeenAt?: Date | null;
  }): Promise<SupervisorRegistryRow> {
    return await this.host().recordSupervisorUsageDelta(params);
  }
  async deleteSupervisorRegistry(role: string): Promise<boolean> {
    return await this.host().deleteSupervisorRegistry(role);
  }

  private host(): SupervisorHostClient {
    if (!this.supervisorHost) throw new Error("supervisor host is not configured");
    return this.supervisorHost;
  }
}
