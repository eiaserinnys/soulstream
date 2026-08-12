import pino from "pino";

import {
  PersistenceHostTransport,
  SessionDeliveryNotificationHostClient,
} from "../src/control_plane/persistence_host_clients.js";
import { buildOrchProxyConfig } from "../src/mcp/orch_proxy.js";

export function createNotificationDlqClient(
  env: NodeJS.ProcessEnv = process.env,
): SessionDeliveryNotificationHostClient {
  const upstreamUrl = requiredEnvironmentVariable(env, "SOULSTREAM_UPSTREAM_URL");
  const authBearerToken = requiredEnvironmentVariable(env, "AUTH_BEARER_TOKEN");
  const orch = buildOrchProxyConfig({
    SOULSTREAM_UPSTREAM_URL: upstreamUrl,
    AUTH_BEARER_TOKEN: authBearerToken,
  });
  return new SessionDeliveryNotificationHostClient(
    new PersistenceHostTransport({ orch, logger: pino({ level: "silent" }) }),
  );
}

export function readArgument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function requiredEnvironmentVariable(
  env: NodeJS.ProcessEnv,
  name: "SOULSTREAM_UPSTREAM_URL" | "AUTH_BEARER_TOKEN",
): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
