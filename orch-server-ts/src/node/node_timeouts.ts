export const DEFAULT_NODE_HTTP_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_NODE_COMMAND_TIMEOUT_MS = 30_000;
export const DEFAULT_SESSION_CREATE_RECONCILE_TIMEOUT_MS = 5_000;
// The first inventory request after a soul-server restart waits for the
// runner start scan and the live inventory, answering 30.7~50.2s after the
// request in production. Keep it above that window (card #1273).
export const RUNNER_INVENTORY_COMMAND_TIMEOUT_MS = 90_000;
