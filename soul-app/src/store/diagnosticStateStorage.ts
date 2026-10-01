import {
  DIAGNOSTIC_STORAGE_OPERATION,
  measureDiagnosticOperation,
} from "../lib/session-diagnostics-api";
import type { DiagnosticSource } from "../lib/session-diagnostics-core";

export interface DiagnosticStateStorage {
  getItem(name: string): Promise<string | null>;
  setItem(name: string, value: string): Promise<void>;
  removeItem(name: string): Promise<void>;
}

export function withDiagnosticStateStorage(
  storage: DiagnosticStateStorage,
  source: Extract<DiagnosticSource, "auth" | "search" | "settings" | "ui">,
): DiagnosticStateStorage {
  return {
    getItem: (name) =>
      measureDiagnosticOperation(
        source,
        DIAGNOSTIC_STORAGE_OPERATION.read,
        () => storage.getItem(name),
      ),
    setItem: (name, value) =>
      measureDiagnosticOperation(
        source,
        DIAGNOSTIC_STORAGE_OPERATION.write,
        () => storage.setItem(name, value),
      ),
    removeItem: (name) =>
      measureDiagnosticOperation(
        source,
        DIAGNOSTIC_STORAGE_OPERATION.remove,
        () => storage.removeItem(name),
      ),
  };
}
