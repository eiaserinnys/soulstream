import { readPersistentReport } from "@soulstream/wire-schema/persistent-report";
import type { ContextItem } from "./prompt_assembler.js";

export function buildPersistentReportContext(metadata: unknown): ContextItem {
  const entries = readPersistentReport(metadata);
  return { key:"persistent_report", label:"지금의 보고", content:`지금의 보고 (${entries.length}장)\n${JSON.stringify(entries)}` };
}
