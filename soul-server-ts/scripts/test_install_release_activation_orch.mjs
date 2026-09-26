import { createServer } from "node:http";
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
  const connectedNodes = new Map();
  const receipts = new Map();
  let nextGeneration = 1;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
    if (request.method === "GET" && pathname === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "GET" && pathname === "/api/nodes") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        nodes: [...connectedNodes.keys()].map((nodeId) => ({
          nodeId,
          connected: true,
          status: "connected",
        })),
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const webSocketServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
    if (pathname !== "/ws/node") {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });

  webSocketServer.on("connection", (socket) => {
    let registeredNodeId;
    socket.on("close", () => {
      if (registeredNodeId && connectedNodes.get(registeredNodeId) === socket) {
        connectedNodes.delete(registeredNodeId);
      }
    });
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type !== "node_register") return;

        const { nodeId, manifestId, registrationKey } = registrationIdentity(message);
        registeredNodeId = nodeId;
        connectedNodes.set(nodeId, socket);
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
    server.listen(port, host);
  });
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("activation orch stub did not bind a TCP address");
  }
  return {
    port: address.port,
    close: async () => {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise((resolveClose, rejectClose) => {
        webSocketServer.close((error) => error ? rejectClose(error) : resolveClose());
      });
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
