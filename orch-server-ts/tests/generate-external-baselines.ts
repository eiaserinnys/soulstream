import { mkdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpToolDefinitions } from "@soulstream/mcp-contract";
import { ExternalEventsService, credentialOwner } from "../../soul-server-ts/src/external_events/service.js";

const old = JSON.parse(await readFile(new URL("../../soul-server-ts/tests/mcp/fixtures/tool_inventory.external.json", import.meta.url), "utf8"));
const names = new Set(mcpToolDefinitions.filter(d => d.audience === "all").map(d => d.name));
const inventory = old.filter((t: { name: string }) => names.has(t.name));
if (inventory.length !== 63 || names.size !== 63) throw new Error("inventory count mismatch");
const fixtures = new URL("./fixtures/", import.meta.url);
await mkdir(fixtures, { recursive: true });
await writeFile(new URL("mcp_external_tool_inventory.json", fixtures), JSON.stringify(inventory, null, 2) + "\n");
console.log("63 entries equal to the old same-name entries; old JSON key order preserved");
const dir = await mkdtemp(join(tmpdir(), "worker-external-baseline-"));
try {
  const owner = credentialOwner("/dot", "test-credential");
  const path = join(dir, "state.json");
  const service = await ExternalEventsService.open({ path, owner, now: () => Date.parse("2026-10-03T00:00:00Z"),
    post: async (_url, body) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }) });
  await service.subscribe({ name: "soulstream.message.created", arguments: { recipient_label: "test-dot" },
    delivery: { mode: "webhook", url: "https://receiver.example/events", secret: `whsec_${Buffer.alloc(32, 8).toString("base64")}` } });
  await writeFile(new URL("worker_external_events_state.json", fixtures), await readFile(path));
  console.log("worker-written subscription and credentialOwner captured using test-only inputs");
} finally { await rm(dir, { recursive: true, force: true }); }
