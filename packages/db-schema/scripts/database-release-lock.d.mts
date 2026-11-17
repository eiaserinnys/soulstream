export interface DatabaseReleaseLease {
  lockPath: string;
  owner: { pid: number; nonce: string; [key: string]: unknown };
}
export function databaseReleaseJournalLockPath(journalPath: string): string;
export function databaseReleasePhaseLockPath(env: NodeJS.ProcessEnv): string;
export function acquireDatabaseReleaseLease(lockPath: string, options?: { timeoutMs?: number; platform?: NodeJS.Platform; now?: () => Date; onReclaimClaimAcquired?: () => void | Promise<void> }): Promise<DatabaseReleaseLease>;
export function releaseDatabaseReleaseLease(lease: DatabaseReleaseLease): Promise<void>;
export function withDatabaseReleaseLease<T>(lockPath: string, callback: (lease: DatabaseReleaseLease) => T | Promise<T>, options?: { timeoutMs?: number; platform?: NodeJS.Platform; now?: () => Date; onReclaimClaimAcquired?: () => void | Promise<void> }): Promise<T>;
export function assertDatabaseReleaseLease<T extends DatabaseReleaseLease>(lease: T, lockPath: string): T;
