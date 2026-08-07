import { readAgentsConfig } from "../src/agent_registry.js";
import {
  buildAgentProfileImportPlan,
  assertAgentProfileImportApproval,
  projectAgentProfileImportDryRun,
  type AgentProfileImportPlan,
} from "../src/agent_profile_import.js";

type CliOptions = {
  agentsConfigPath: string;
  orchUrl: string;
  token: string | undefined;
  apply: boolean;
  approvedFingerprint: string | undefined;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const current = await requestJson(`${options.orchUrl}/api/agent-profiles/runtime`, options);
  const profiles = current && typeof current === "object" && Array.isArray((current as { profiles?: unknown }).profiles)
    ? (current as { profiles: unknown[] }).profiles
    : [];
  const plan = await buildAgentProfileImportPlan(
    readAgentsConfig(options.agentsConfigPath).agents,
    profiles,
  );
  process.stdout.write(`${JSON.stringify(projectAgentProfileImportDryRun(plan), null, 2)}\n`);
  if (!options.apply) return;
  assertAgentProfileImportApproval(plan, options.approvedFingerprint);
  await applyPlan(plan, options);
}

async function applyPlan(plan: AgentProfileImportPlan, options: CliOptions): Promise<void> {
  for (const entry of plan.entries) {
    if (entry.action === "unchanged") continue;
    const profile = await requestJson(
      `${options.orchUrl}/api/agent-profiles/${encodeURIComponent(entry.agentId)}`,
      options,
      "PUT",
      { ...entry.desired, expected_version: entry.expectedVersion },
    ) as { version: number };
    if (entry.portraitAction === "put" && entry.portrait) {
      await requestJson(
        `${options.orchUrl}/api/agent-profiles/${encodeURIComponent(entry.agentId)}/portrait`,
        options,
        "PUT",
        {
          data_base64: entry.portrait.dataBase64,
          mime: entry.portrait.mime,
          sha256: entry.portrait.sha256,
          expected_version: profile.version,
        },
      );
    } else if (entry.portraitAction === "delete") {
      await requestJson(
        `${options.orchUrl}/api/agent-profiles/${encodeURIComponent(entry.agentId)}/portrait`,
        options,
        "DELETE",
        { expected_version: profile.version },
      );
    }
  }
}

async function requestJson(
  url: string,
  options: CliOptions,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${url} returned HTTP ${response.status}: ${await response.text()}`);
  return response.status === 204 ? {} : response.json();
}

function parseArgs(args: string[]): CliOptions {
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const agentsConfigPath = value("--agents-config");
  const orchUrl = value("--orch-url")?.replace(/\/$/, "");
  if (!agentsConfigPath || !orchUrl) {
    throw new Error("Usage: --agents-config <path> --orch-url <http-url> [--token <token>] [--apply --approved-fingerprint <sha256>]");
  }
  return {
    agentsConfigPath,
    orchUrl,
    token: value("--token"),
    apply: args.includes("--apply"),
    approvedFingerprint: value("--approved-fingerprint"),
  };
}

await main();
