export class ClaudeAccountNotFoundError extends Error {
  readonly code = "ACCOUNT_NOT_FOUND";
  readonly accountId: string;

  constructor(accountId: string) {
    super(`Claude account not found: ${accountId}`);
    this.name = "ClaudeAccountNotFoundError";
    this.accountId = accountId;
  }
}
