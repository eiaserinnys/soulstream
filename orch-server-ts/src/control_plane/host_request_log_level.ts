const SLOW_HOST_REQUEST_MS = 1_000;

export function hostRequestLogLevel(
  statusCode: number,
  durationMs: number,
): "info" | "debug" {
  return statusCode < 400 && durationMs < SLOW_HOST_REQUEST_MS ? "debug" : "info";
}

export function isHostRequestPath(path: string): boolean {
  return path.includes("/host/");
}
