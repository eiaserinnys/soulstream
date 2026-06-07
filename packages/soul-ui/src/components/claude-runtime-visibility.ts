export function shouldShowClaudeRuntimePanels(backend?: string | null): boolean {
  return backend === "claude";
}
