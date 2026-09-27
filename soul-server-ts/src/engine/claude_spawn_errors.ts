export function isMissingSpawnExecutableError(
  err: unknown,
): err is NodeJS.ErrnoException & { syscall: string } {
  if (!err || typeof err !== "object") return false;
  const candidate = err as NodeJS.ErrnoException;
  return candidate.code === "ENOENT"
    && typeof candidate.syscall === "string"
    && candidate.syscall.startsWith("spawn ");
}
