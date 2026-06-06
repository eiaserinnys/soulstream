export class MarkdownDocumentVersionConflictError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion?: number,
  ) {
    super(
      actualVersion === undefined
        ? `markdown document version conflict: ${documentId} expected version ${expectedVersion}`
        : `markdown document version conflict: ${documentId} expected version ${expectedVersion}, actual version ${actualVersion}`,
    );
    this.name = "MarkdownDocumentVersionConflictError";
  }
}

export function normalizeMarkdownVersion(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.trunc(parsed);
  }
  return 1;
}
