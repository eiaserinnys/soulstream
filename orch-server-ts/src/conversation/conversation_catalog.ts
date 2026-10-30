import type { ModelPresetAvailability } from "../model/model_preset_availability.js";

export type ConversationModelGroup = { id: string; label: string };
export type ConversationModel = {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  group?: ConversationModelGroup;
  reason_code?: string;
  resets_at?: string;
};
export type ConversationModelReply = { models: ConversationModel[] };
export type ConversationProfile = { id: string; label: string; available: boolean; reason?: string };
export type ConversationProfilesReply = { profiles: ConversationProfile[] };
export type ConversationCatalogNode = { nodeId: string; connected: boolean };
export type ConversationModelReference = { nodeId: string; presetId: string };

type AgentProfile = { name?: unknown };
type ConversationCatalogOptions = {
  defaultNodeId: string;
  listNodes(): readonly ConversationCatalogNode[];
  listKnownForNode(nodeId: string): ModelPresetAvailability[] | undefined;
  listAgentProfiles(nodeId: string): Promise<Record<string, AgentProfile> | undefined>;
};

export class ConversationCatalog {
  constructor(private readonly options: ConversationCatalogOptions) {}

  async models(profile?: string): Promise<ConversationModelReply> {
    const nodes = this.orderedNodes();
    const profileSets = profile === undefined
      ? undefined
      : new Map(await Promise.all(nodes.map(async node => [
          node.nodeId,
          node.connected ? await this.options.listAgentProfiles(node.nodeId) : undefined,
        ] as const)));
    const models: ConversationModel[] = [];
    for (const node of nodes) {
      const presets = this.options.listKnownForNode(node.nodeId);
      if (!presets) continue;
      for (const preset of presets) {
        const group = { id: node.nodeId, label: node.nodeId };
        if (!node.connected) {
          models.push({ id: this.idFor(node.nodeId, preset.id), label: preset.label, available: false,
            reason: "노드 연결 끊김", group, reason_code: "offline" });
          continue;
        }
        if (profile !== undefined && !(profile in (profileSets?.get(node.nodeId) ?? {}))) {
          models.push({ id: this.idFor(node.nodeId, preset.id), label: preset.label, available: false,
            reason: "이 노드에 프로필 없음", group, reason_code: "profile_unavailable" });
          continue;
        }
        models.push({
          id: this.idFor(node.nodeId, preset.id),
          label: preset.label,
          available: preset.available,
          ...(preset.reason_label ? { reason: preset.reason_label } : {}),
          group,
          ...(preset.reason ? { reason_code: preset.reason } : {}),
          ...(preset.resets_at ? { resets_at: preset.resets_at } : {}),
        });
      }
    }
    return { models };
  }

  async profiles(): Promise<ConversationProfilesReply> {
    const nodes = this.orderedNodes().filter(node => node.connected);
    const collected = await Promise.all(nodes.map(async node => ({
      nodeId: node.nodeId,
      profiles: await this.options.listAgentProfiles(node.nodeId),
    })));
    const labels = new Map<string, string>();
    for (const { profiles } of collected) {
      for (const [id, profile] of Object.entries(profiles ?? {})) {
        if (!labels.has(id)) labels.set(id, typeof profile.name === "string" && profile.name.length > 0 ? profile.name : id);
      }
    }
    const defaultProfiles = collected.find(item => item.nodeId === this.options.defaultNodeId)?.profiles ?? {};
    const defaultIds = Object.keys(defaultProfiles);
    const rest = [...labels.keys()].filter(id => !defaultIds.includes(id)).sort((a, b) => a.localeCompare(b));
    const orderedIds = [...defaultIds.filter(id => labels.has(id)), ...rest];
    return { profiles: orderedIds.map(id => ({ id, label: labels.get(id)!, available: true })) };
  }

  resolve(id: string): ConversationModelReference | undefined {
    if (!id.startsWith("n1:")) return { nodeId: this.options.defaultNodeId, presetId: id };
    const rest = id.slice(3);
    const separator = rest.indexOf(":");
    if (separator < 0) return undefined;
    try {
      const nodeId = decodeURIComponent(rest.slice(0, separator));
      const presetId = decodeURIComponent(rest.slice(separator + 1));
      return nodeId && presetId ? { nodeId, presetId } : undefined;
    } catch {
      return undefined;
    }
  }

  idFor(nodeId: string, presetId: string): string {
    return nodeId === this.options.defaultNodeId
      ? presetId
      : `n1:${encodeURIComponent(nodeId)}:${encodeURIComponent(presetId)}`;
  }

  async model(id: string): Promise<ConversationModel | undefined> {
    const reference = this.resolve(id);
    if (!reference) return undefined;
    const preset = this.options.listKnownForNode(reference.nodeId)?.find(item => item.id === reference.presetId);
    const node = this.options.listNodes().find(item => item.nodeId === reference.nodeId);
    return {
      id,
      label: preset?.label ?? id,
      available: node?.connected === true && preset?.available === true,
      group: { id: reference.nodeId, label: reference.nodeId },
      ...(node && !node.connected ? { reason: "노드 연결 끊김", reason_code: "offline" } : {}),
      ...(node?.connected && preset?.reason_label ? { reason: preset.reason_label } : {}),
      ...(node?.connected && preset?.reason ? { reason_code: preset.reason } : {}),
      ...(node?.connected && preset?.resets_at ? { resets_at: preset.resets_at } : {}),
    };
  }

  private orderedNodes(): ConversationCatalogNode[] {
    return [...this.options.listNodes()].sort((a, b) => {
      if (a.nodeId === this.options.defaultNodeId) return b.nodeId === this.options.defaultNodeId ? 0 : -1;
      if (b.nodeId === this.options.defaultNodeId) return 1;
      return a.nodeId.localeCompare(b.nodeId);
    });
  }
}
