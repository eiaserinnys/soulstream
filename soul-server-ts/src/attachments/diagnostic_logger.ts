import { readdir, stat } from "node:fs/promises";

export interface AttachmentDiagnosticsLogger {
  info(payload: Record<string, unknown>, message?: string): void;
}

export interface AttachmentPathStat {
  exists: boolean;
  size?: number;
  isFile?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface AttachmentDirectoryEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
}

export interface AttachmentDirectoryListing {
  ok: boolean;
  entries?: AttachmentDirectoryEntry[];
  errorCode?: string;
  errorMessage?: string;
}

const NOOP_LOGGER: AttachmentDiagnosticsLogger = {
  info: () => undefined,
};

export class AttachmentDiagnostics {
  constructor(private readonly logger: AttachmentDiagnosticsLogger = NOOP_LOGGER) {}

  info(event: string, payload: Record<string, unknown>): void {
    try {
      this.logger.info(
        {
          component: "FileAttachmentStore",
          event,
          ...payload,
        },
        "attachment diagnostic",
      );
    } catch {
      // Diagnostics must never alter attachment behavior.
    }
  }

  async statPath(targetPath: string): Promise<AttachmentPathStat> {
    try {
      const pathStat = await stat(targetPath);
      return {
        exists: true,
        size: pathStat.size,
        isFile: pathStat.isFile(),
      };
    } catch (err) {
      const fsErr = err as NodeJS.ErrnoException;
      return {
        exists: false,
        errorCode: fsErr.code,
        errorMessage: fsErr.message,
      };
    }
  }

  async listDirectory(dirPath: string): Promise<AttachmentDirectoryListing> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      return {
        ok: true,
        entries: entries.map((entry) => ({
          name: entry.name,
          kind: entry.isFile()
            ? "file"
            : entry.isDirectory()
              ? "directory"
              : entry.isSymbolicLink()
                ? "symlink"
                : "other",
        })),
      };
    } catch (err) {
      const fsErr = err as NodeJS.ErrnoException;
      return {
        ok: false,
        errorCode: fsErr.code,
        errorMessage: fsErr.message,
      };
    }
  }

  callerStack(): string[] | undefined {
    return new Error().stack?.split("\n").slice(0, 5);
  }
}
