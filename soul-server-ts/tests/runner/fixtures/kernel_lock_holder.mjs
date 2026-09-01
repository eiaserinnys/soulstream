import { createServer } from "node:net";

const endpoint = Buffer.from(process.argv[2] ?? "", "base64").toString("utf8");
if (!endpoint) throw new Error("kernel lock holder requires a base64 endpoint");

const server = createServer((socket) => socket.destroy());
server.on("error", (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
server.listen(endpoint, () => process.stdout.write("ready\n"));
