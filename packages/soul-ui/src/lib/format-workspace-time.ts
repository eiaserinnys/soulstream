function parseTimeMs(value: string | undefined | null): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function formatWorkspaceTime(value: string | undefined | null): string {
  const ms = parseTimeMs(value);
  if (!ms) return "...";
  return new Date(ms).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
