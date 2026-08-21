import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { WebSocketServer } from "ws";

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function parseCliOptions(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("usage: test_install_release_activation_orch.mjs --host HOST --port PORT");
    }
    values.set(key.slice(2), value);
  }
  const host = requiredString(values.get("host"), "host");
  const port = Number(values.get("port"));
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return { host, port };
}

function registrationIdentity(message) {
  const nodeId = requiredString(message.node_id, "node_id");
  const manifestId = requiredString(
    message.release_manifest?.manifest_id,
    "release_manifest.manifest_id",
  );
  const activationManifestId = requiredString(
    message.release_activation?.manifest_id,
    "release_activation.manifest_id",
  );
  if (manifestId !== activationManifestId) {
    throw new Error("manifest identity mismatch");
  }
  const registrationKey = requiredString(
    message.release_activation?.registration_idempotency_key,
    "release_activation.registration_idempotency_key",
  );
  return { nodeId, manifestId, registrationKey };
}

export async function startReleaseActivationOrchStub({ host, port, now = () => new Date() }) {
  const server = new WebSocketServer({ host, port });
  const receipts = new Map();
  let nextGeneration = 1;

  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type !== "node_register") return;

        const { nodeId, manifestId, registrationKey } = registrationIdentity(message);
        const receiptKey = `${nodeId}\u0000${registrationKey}`;
        const existing = receipts.get(receiptKey);
        if (existing && existing.manifest_id !== manifestId) {
          throw new Error("registration key reused for another manifest");
        }
        const receipt = existing ?? {
          manifest_id: manifestId,
          activation_generation: nextGeneration++,
          activated_at: now().toISOString(),
          registration_idempotency_key: registrationKey,
        };
        receipts.set(receiptKey, receipt);
        socket.send(JSON.stringify({
          type: "node_register_ack",
          node_id: nodeId,
          release_activation_receipt: receipt,
        }));
      } catch (error) {
        socket.close(1008, error instanceof Error ? error.message : "invalid registration");
      }
    });
  });

  await new Promise((resolveListening, rejectListening) => {
    server.once("listening", resolveListening);
    server.once("error", rejectListening);
  });
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("activation orch stub did not bind a TCP address");
  }
  return {
    port: address.port,
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  const options = parseCliOptions(process.argv.slice(2));
  const stub = await startReleaseActivationOrchStub(options);
  console.log(JSON.stringify({ status: "ready", host: options.host, port: stub.port }));
  const shutdown = async () => {
    await stub.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
