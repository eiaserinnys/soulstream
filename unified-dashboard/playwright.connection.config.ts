import { defineConfig } from "@playwright/test";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";
async function freePort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return String(port);
}
for (const name of [
  "CONNECTION_QA_SERVER_PORT",
  "CONNECTION_QA_CONTROL_PORT",
  "CONNECTION_QA_NGINX_PORT",
]) {
  process.env[name] ??= await freePort();
}
process.env.CONNECTION_QA_BASE_URL = `http://127.0.0.1:${process.env.CONNECTION_QA_NGINX_PORT}`;
process.env.CONNECTION_QA_CONTROL_URL = `http://127.0.0.1:${process.env.CONNECTION_QA_CONTROL_PORT}`;
export default defineConfig({
  testDir: "./e2e",
  testMatch: "connection-recovery.e2e.ts",
  workers: 1,
  retries: 0,
  timeout: 60000,
  reporter: [["list"]],
  outputDir: "../.local/connection-recovery/results",
  use: {
    baseURL: process.env.CONNECTION_QA_BASE_URL,
    actionTimeout: 10000,
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node --import "${realpathSync("../orch-server-ts/node_modules/tsx/dist/loader.mjs")}" e2e/connection-harness.ts`,
    url: `${process.env.CONNECTION_QA_CONTROL_URL}/ready`,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      NODE_ENV: "development",
      CONNECTION_QA_SERVER_PORT: process.env.CONNECTION_QA_SERVER_PORT!,
      CONNECTION_QA_CONTROL_PORT: process.env.CONNECTION_QA_CONTROL_PORT!,
      CONNECTION_QA_NGINX_PORT: process.env.CONNECTION_QA_NGINX_PORT!,
    },
  },
});
