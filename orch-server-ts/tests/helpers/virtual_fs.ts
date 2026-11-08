import type * as NodeFs from "node:fs";

// Overlay only the absolute paths a Darwin resolver inspects (Homebrew
// prefixes) so the suite can exercise them without writing outside the
// workspace. Every other path and function keeps the real node:fs behavior.
export interface VirtualFsEntry {
  readonly isFile: boolean;
  readonly executable: boolean;
}

const entries = new Map<string, VirtualFsEntry>();

export function resetVirtualFs(): void {
  entries.clear();
}

export function addVirtualFile(path: string, executable = true): void {
  entries.set(path, { isFile: true, executable });
}

export function virtualFs(actual: typeof NodeFs): typeof NodeFs {
  const statSync = ((path: Parameters<typeof NodeFs.statSync>[0], ...args: unknown[]) => {
    const entry = entries.get(String(path));
    if (entry === undefined) {
      return (actual.statSync as (...rest: unknown[]) => unknown)(path, ...args);
    }
    return {
      isFile: () => entry.isFile,
      isDirectory: () => !entry.isFile,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
    };
  }) as unknown as typeof NodeFs.statSync;

  const accessSync = ((path: Parameters<typeof NodeFs.accessSync>[0], ...args: unknown[]) => {
    const entry = entries.get(String(path));
    if (entry === undefined) {
      return (actual.accessSync as (...rest: unknown[]) => void)(path, ...args);
    }
    if (!entry.executable) {
      throw Object.assign(
        new Error(`EACCES: permission denied, access '${String(path)}'`),
        { code: "EACCES" },
      );
    }
    return undefined;
  }) as unknown as typeof NodeFs.accessSync;

  return { ...actual, statSync, accessSync };
}
