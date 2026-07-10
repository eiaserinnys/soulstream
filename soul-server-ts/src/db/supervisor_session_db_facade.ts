import { SupervisorRepository } from "./repositories/supervisor_repository.js";
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
  private readonly supervisorRepository: SupervisorRepository;

  constructor(sql: SqlClient) {
    this.supervisorRepository = new SupervisorRepository(sql);
  }

  async appendSupervisorEvent(
    params: AppendSupervisorEventParams,
  ): Promise<SupervisorAppendResult> {
    return await this.supervisorRepository.appendSupervisorEvent(params);
  }

  async readSupervisorEventsAfter(
    afterOffset = 0,
    limit = 100,
  ): Promise<SupervisorEventRow[]> {
    return await this.supervisorRepository.readSupervisorEventsAfter(afterOffset, limit);
  }

  async getSupervisorEventHeadOffset(): Promise<number> {
    return await this.supervisorRepository.getSupervisorEventHeadOffset();
  }

  async getSupervisorSourceCursor(
    sourceNode: string,
    sourceSessionId: string,
  ): Promise<SupervisorSourceCursorRow | null> {
    return await this.supervisorRepository.getSupervisorSourceCursor(sourceNode, sourceSessionId);
  }

  async setSupervisorSourceCursor(params: {
    sourceNode: string;
    sourceSessionId: string;
    contiguousUpto: number;
    highestSeenEventId: number;
    gapStart?: number | null;
    gapEnd?: number | null;
  }): Promise<SupervisorSourceCursorRow> {
    return await this.supervisorRepository.setSupervisorSourceCursor(params);
  }

  async getSupervisorConsumerCursor(supervisorId: string): Promise<number> {
    return await this.supervisorRepository.getSupervisorConsumerCursor(supervisorId);
  }

  async setSupervisorConsumerCursor(
    supervisorId: string,
    cursorOffset: number,
  ): Promise<number> {
    return await this.supervisorRepository.setSupervisorConsumerCursor(supervisorId, cursorOffset);
  }

  async setSupervisorWakeDispatchState(
    params: SupervisorWakeDispatchStateParams,
  ): Promise<SupervisorRegistryRow> {
    return await this.supervisorRepository.setSupervisorWakeDispatchState(params);
  }

  async upsertSupervisorRegistry(
    params: SupervisorRegistryUpsertParams,
  ): Promise<SupervisorRegistryRow> {
    return await this.supervisorRepository.upsertSupervisorRegistry(params);
  }

  async getSupervisorRegistry(role: string): Promise<SupervisorRegistryRow | null> {
    return await this.supervisorRepository.getSupervisorRegistry(role);
  }

  async listSupervisorRegistries(): Promise<SupervisorRegistryRow[]> {
    return await this.supervisorRepository.listSupervisorRegistries();
  }

  async touchSupervisorRegistry(
    role: string,
    lastSeenAt: Date,
  ): Promise<SupervisorRegistryRow | null> {
    return await this.supervisorRepository.touchSupervisorRegistry(role, lastSeenAt);
  }

  async recordSupervisorUsageDelta(params: {
    role: string;
    tokenDelta: number;
    compactionDelta?: number;
    lastSeenAt?: Date | null;
  }): Promise<SupervisorRegistryRow> {
    return await this.supervisorRepository.recordSupervisorUsageDelta(params);
  }

  async deleteSupervisorRegistry(role: string): Promise<boolean> {
    return await this.supervisorRepository.deleteSupervisorRegistry(role);
  }
}
