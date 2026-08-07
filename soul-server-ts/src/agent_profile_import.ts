import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AgentProfile } from "./agent_registry.js";
import { RemoteAgentProfileSchema, type RemoteAgentProfile } from "./agent_profile_source.js";

export type ImportPortrait = {
  readonly path: string;
  readonly mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  readonly size: number;
  readonly sha256: string;
  readonly dataBase64: string;
};

export type ImportPlanEntry = {
  readonly agentId: string;
  readonly action: "create" | "update" | "unchanged";
  readonly expectedVersion: number | null;
  readonly changedFields: readonly string[];
  readonly desired: {
    readonly name: string;
    readonly atom_contexts: AgentProfile["atom_contexts"];
    readonly default_preset: string | null;
    readonly aliases: AgentProfile["aliases"];
  };
  readonly portrait: ImportPortrait | null;
  readonly portraitAction: "put" | "delete" | "unchanged";
};

export type AgentProfileImportPlan = {
  readonly schemaVersion: 1;
  readonly entries: readonly ImportPlanEntry[];
  readonly fingerprint: string;
};

export async function buildAgentProfileImportPlan(
  profiles: readonly AgentProfile[],
  currentInput: readonly unknown[],
): Promise<AgentProfileImportPlan> {
  const current = new Map(
    currentInput.map((profile) => RemoteAgentProfileSchema.parse(profile))
      .map((profile) => [profile.agent_id, profile]),
  );
  const entries = await Promise.all(
    [...profiles].sort((left, right) => left.id.localeCompare(right.id)).map(async (profile) =>
      buildEntry(profile, current.get(profile.id))),
  );
  const fingerprint = sha256(stableJson(entries.map(projectFingerprintEntry)));
  return { schemaVersion: 1, entries, fingerprint };
}

export function projectAgentProfileImportDryRun(plan: AgentProfileImportPlan) {
  return {
    mode: "dry-run",
    fingerprint: plan.fingerprint,
    summary: {
      create: plan.entries.filter((entry) => entry.action === "create").length,
      update: plan.entries.filter((entry) => entry.action === "update").length,
      unchanged: plan.entries.filter((entry) => entry.action === "unchanged").length,
    },
    profiles: plan.entries.map((entry) => ({
      agent_id: entry.agentId,
      action: entry.action,
      expected_version: entry.expectedVersion,
      changed_fields: entry.changedFields,
      portrait: entry.portrait
        ? { mime: entry.portrait.mime, size: entry.portrait.size, sha256: entry.portrait.sha256, action: entry.portraitAction }
        : { action: entry.portraitAction },
    })),
  };
}

export function assertAgentProfileImportApproval(
  plan: AgentProfileImportPlan,
  approvedFingerprint: string | undefined,
): void {
  if (approvedFingerprint !== plan.fingerprint) {
    throw new Error("approved fingerprint does not match the current dry-run plan");
  }
}

async function buildEntry(
  profile: AgentProfile,
  current: RemoteAgentProfile | undefined,
): Promise<ImportPlanEntry> {
  const desired = {
    name: profile.name,
    atom_contexts: profile.atom_contexts ?? [],
    default_preset: profile.default_preset ?? null,
    aliases: profile.aliases ?? [],
  };
  const portrait = profile.portrait_path ? await loadPortrait(profile.portrait_path) : null;
  const changedFields = current ? changedProfileFields(desired, current) : Object.keys(desired);
  const portraitAction = portrait
    ? current?.portrait?.sha256 === portrait.sha256 ? "unchanged" : "put"
    : current?.has_portrait ? "delete" : "unchanged";
  const action = !current
    ? "create"
    : changedFields.length > 0 || portraitAction !== "unchanged"
      ? "update"
      : "unchanged";
  return {
    agentId: profile.id,
    action,
    expectedVersion: current?.version ?? null,
    changedFields,
    desired,
    portrait,
    portraitAction,
  };
}

function changedProfileFields(
  desired: ImportPlanEntry["desired"],
  current: RemoteAgentProfile,
): string[] {
  const existing = {
    name: current.name,
    atom_contexts: current.atom_contexts,
    default_preset: current.default_preset,
    aliases: current.aliases,
  };
  return Object.keys(desired).filter((key) =>
    stableJson(desired[key as keyof typeof desired])
      !== stableJson(existing[key as keyof typeof existing]));
}

async function loadPortrait(path: string): Promise<ImportPortrait> {
  const absolutePath = resolve(path);
  const body = await readFile(absolutePath);
  const mime = portraitMime(body);
  if (!mime) throw new Error(`Unsupported portrait bytes: ${path}`);
  return {
    path: absolutePath,
    mime,
    size: body.length,
    sha256: sha256(body),
    dataBase64: body.toString("base64"),
  };
}

function portraitMime(body: Buffer): ImportPortrait["mime"] | null {
  if (body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (body.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) return "image/jpeg";
  if (body.subarray(0, 4).toString() === "RIFF" && body.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (body.subarray(0, 4).toString() === "GIF8") return "image/gif";
  return null;
}

function projectFingerprintEntry(entry: ImportPlanEntry) {
  return {
    agentId: entry.agentId,
    action: entry.action,
    expectedVersion: entry.expectedVersion,
    desired: entry.desired,
    portrait: entry.portrait
      ? { mime: entry.portrait.mime, size: entry.portrait.size, sha256: entry.portrait.sha256 }
      : null,
    portraitAction: entry.portraitAction,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
