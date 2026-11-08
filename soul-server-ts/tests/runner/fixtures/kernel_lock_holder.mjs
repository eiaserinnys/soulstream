import { createServer } from "node:net";

const endpoint = Buffer.from(process.argv[2] ?? "", "base64").toString("utf8");
const platform = process.argv[3] ?? "net";
const darwinLockFilePath = process.argv[4] ?? "";

if (platform === "darwin") {
  if (!darwinLockFilePath) throw new Error("darwin kernel lock holder requires a lock file path");
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(darwinLockFilePath);
  database.exec("PRAGMA busy_timeout=0");
  database.exec("PRAGMA journal_mode=DELETE");
  database.exec("BEGIN EXCLUSIVE");
  process.stdout.write("ready\n");
  setInterval(() => {}, 1_000);
} else {
  if (!endpoint) throw new Error("kernel lock holder requires a base64 endpoint");
  const server = createServer((socket) => socket.destroy());
  server.on("error", (error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
  server.listen(endpoint, () => process.stdout.write("ready\n"));
}
