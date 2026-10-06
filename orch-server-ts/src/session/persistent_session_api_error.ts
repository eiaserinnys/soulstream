/** Failure with the HTTP status and public error code the route should answer with. */
export class PersistentSessionApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PersistentSessionApiError";
  }
}
