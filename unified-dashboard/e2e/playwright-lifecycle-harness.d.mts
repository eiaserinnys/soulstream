export interface BrowserProcessInfo {
  pid: number;
  ppid: number;
  startTime: string;
  command: string;
}

export interface BrowserLike {
  close(): Promise<void>;
}

export interface PlaywrightLifecycleOptions<TBrowser extends BrowserLike = BrowserLike> {
  lockName: string;
  timeoutMs?: number;
  closeTimeoutMs?: number;
  residualTimeoutMs?: number;
  lockRoot?: string;
  launchOptions?: Record<string, unknown>;
  launchBrowser?: (options: Record<string, unknown>) => Promise<TBrowser>;
}

export interface PlaywrightLifecycleContext<TBrowser extends BrowserLike = BrowserLike> {
  browser: TBrowser;
  signal: AbortSignal;
}

export class HarnessAlreadyRunningError extends Error {
  readonly code: "PLAYWRIGHT_HARNESS_ALREADY_RUNNING";
  readonly owner: { pid?: number; lockName?: string; startedAt?: string } | null;
}

export class HarnessTimeoutError extends Error {
  readonly code: "PLAYWRIGHT_HARNESS_TIMEOUT";
  readonly timeoutMs: number;
}

export class HarnessSignalError extends Error {
  readonly code: "PLAYWRIGHT_HARNESS_SIGNAL";
  readonly signal: NodeJS.Signals;
}

export class HarnessResidualProcessError extends Error {
  readonly code: "PLAYWRIGHT_HARNESS_RESIDUAL_PROCESS";
  readonly processes: BrowserProcessInfo[];
}

export function runPlaywrightLifecycle<T, TBrowser extends BrowserLike = BrowserLike>(
  options: PlaywrightLifecycleOptions<TBrowser>,
  callback: (context: PlaywrightLifecycleContext<TBrowser>) => Promise<T> | T,
): Promise<T>;

export function listBrowserDescendants(rootPid?: number): BrowserProcessInfo[];
