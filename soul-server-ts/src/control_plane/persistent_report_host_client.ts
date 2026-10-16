import type { PersistentReportResult } from "@soulstream/wire-schema/persistent-report";
import { PersistenceHostTransport, type HostClientConfig } from "./persistence_host_transport.js";

export class PersistentReportHostClient {
  private readonly transport: PersistenceHostTransport;
  constructor(config: HostClientConfig) { this.transport = new PersistenceHostTransport(config); }
  put(sessionId: string, entry: unknown): Promise<PersistentReportResult> {
    return this.transport.request("session-data","put_report_entry",[sessionId,entry],{opaqueArgumentIndexes:[1]});
  }
  remove(sessionId: string, key: string): Promise<PersistentReportResult> {
    return this.transport.request("session-data","remove_report_entry",[sessionId,key]);
  }
}
