import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;
const dnsResolve: Resolver = hostname => lookup(hostname, { all: true });
export type WebhookPost = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;
export class WebhookError extends Error {
  constructor(readonly reason: string, readonly transient = false) { super(reason); }
}
export async function resolvePublicCallback(url: string, resolve: Resolver = dnsResolve) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password || target.hash) throw new WebhookError("unsafe_callback");
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname);
  if (!addresses.length || addresses.some(({ address }) => !ipaddr.isValid(address) || ipaddr.process(address).range() !== "unicast")) {
    throw new WebhookError("unsafe_callback");
  }
  return { target, hostname, address: addresses[0]!.address, family: addresses[0]!.family };
}
/** Resolve for every attempt; lookup is replaced with the validated IP, preserving TLS hostname. */
export async function postWebhook(url: string, body: string, headers: Record<string, string>, deps: {
  resolve?: Resolver; request?: typeof httpsRequest;
} = {}) {
  const deadline = AbortSignal.timeout(10_000);
  let endpoint: Awaited<ReturnType<typeof resolvePublicCallback>>;
  try {
    endpoint = await Promise.race([
      resolvePublicCallback(url, deps.resolve),
      new Promise<never>((_resolve, reject) => deadline.addEventListener("abort", () => reject(new WebhookError("timeout", true)), { once: true })),
    ]);
  } catch (error) {
    if (error instanceof WebhookError) throw error;
    throw new WebhookError("dns_failed", true);
  }
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = (deps.request ?? httpsRequest)(endpoint.target, {
      method: "POST", agent: false, signal: deadline,
      servername: isIP(endpoint.hostname) ? undefined : endpoint.hostname,
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
      lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options.all) callback(null, [{ address: endpoint.address, family: endpoint.family }]);
        else callback(null, endpoint.address, endpoint.family);
      }) as NonNullable<Parameters<typeof httpsRequest>[1]>["lookup"],
    }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) { response.resume?.(); reject(new WebhookError("redirect_forbidden")); return; }
      let bytes = 0; const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16_384) { response.destroy(); reject(new WebhookError("response_too_large")); }
        else chunks.push(chunk);
      });
      response.on("error", () => reject(new WebhookError("network_error", true)));
      response.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", () => reject(new WebhookError(deadline.aborted ? "timeout" : "network_error", true)));
    req.end(body);
  });
}
