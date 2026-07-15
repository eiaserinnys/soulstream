import type { Browser, LaunchOptions } from "playwright";

export interface BrowserProcessInfo {
  pid: number;
  ppid: number;
  startTime: string;
  command: string;
}

export interface BrowserLike {
  close(): Promise<void>;
}

export interface PlaywrightLifecycleOptions<TBrowser extends BrowserLike = Browser> {
  lockName: string;
  timeoutMs?: number;
  closeTimeoutMs?: number;
  residualTimeoutMs?: number;
  lockRoot?: string;
  launchOptions?: LaunchOptions;
  launchBrowser?: (options: LaunchOptions) => Promise<TBrowser>;
}

export interface PlaywrightLifecycleContext<TBrowser extends BrowserLike = Browser> {
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

export function runPlaywrightLifecycle<T, TBrowser extends BrowserLike = Browser>(
  options: PlaywrightLifecycleOptions<TBrowser>,
  callback: (context: PlaywrightLifecycleContext<TBrowser>) => Promise<T> | T,
): Promise<T>;

export function listBrowserDescendants(rootPid?: number): BrowserProcessInfo[];
