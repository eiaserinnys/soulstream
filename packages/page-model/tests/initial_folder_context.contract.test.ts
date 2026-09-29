import { describe, expect, it } from "vitest";

import {
  parseInitialFolderContextWire,
  serializeInitialFolderContext,
} from "../src/index.js";

describe("initial task context wire", () => {
  it("round-trips guidance, atom references, and session defaults", () => {
    const context = {
      guidance: "  직접 지침  ",
      atomReferences: [{
        instance: "atom" as const,
        nodeId: "node-a",
        nodeTitle: "soulstream",
        depth: 5,
        titlesOnly: true,
        mode: "index" as const,
        limit: 3,
      }],
      sessionDefaults: {
        agentId: "roselin_codex",
        nodeId: "eiaserinnys",
        modelPreset: "codex-5.6-sol",
      },
    };
    const wire = serializeInitialFolderContext(context);

    expect(wire).toEqual({
      guidance: "직접 지침",
      atom_references: [{
        instance: "atom",
        node_id: "node-a",
        node_title: "soulstream",
        depth: 5,
        titles_only: true,
        mode: "index",
        limit: 3,
      }],
      session_defaults: {
        agent_id: "roselin_codex",
        node_id: "eiaserinnys",
        model_preset: "codex-5.6-sol",
      },
    });
    expect(parseInitialFolderContextWire(wire)).toEqual({
      ok: true,
      value: { ...context, guidance: "직접 지침" },
    });
  });

  it("rejects invalid depth and missing node title at the shared boundary", () => {
    expect(parseInitialFolderContextWire({
      atom_references: [{
        instance: "atom",
        node_id: "node-a",
        node_title: "",
        depth: 6,
        titles_only: false,
      }],
    })).toMatchObject({ ok: false });
  });

  it("keeps an omitted limit omitted and rejects non-positive limits", () => {
    const context = {
      guidance: "",
      atomReferences: [{
        instance: "atom" as const,
        nodeId: "node-a",
        nodeTitle: "soulstream",
        depth: 3,
        titlesOnly: false,
      }],
    };

    expect(serializeInitialFolderContext(context)?.atom_references?.[0]).not.toHaveProperty("limit");
    expect(parseInitialFolderContextWire(serializeInitialFolderContext(context))).toEqual({
      ok: true,
      value: context,
    });
    expect(parseInitialFolderContextWire({
      atom_references: [{
        instance: "atom",
        node_id: "node-a",
        node_title: "soulstream",
        depth: 3,
        titles_only: false,
        limit: 0,
      }],
    })).toEqual({
      ok: false,
      error: "initial_context.atom_references[0].limit must be a positive integer",
    });
  });

  it("keeps legacy mode omitted and rejects unknown explicit modes", () => {
    const legacy = {
      guidance: "",
      atomReferences: [{
        instance: "atom" as const,
        nodeId: "node-a",
        nodeTitle: "soulstream",
        depth: 3,
        titlesOnly: false,
      }],
    };
    expect(serializeInitialFolderContext(legacy)?.atom_references?.[0]).not.toHaveProperty("mode");
    expect(parseInitialFolderContextWire({
      atom_references: [{
        instance: "atom",
        node_id: "node-a",
        node_title: "soulstream",
        depth: 3,
        titles_only: false,
        mode: "future-mode",
      }],
    })).toEqual({
      ok: false,
      error: "initial_context.atom_references[0].mode invalid",
    });
  });

  it("accepts session defaults as the only initial context", () => {
    expect(parseInitialFolderContextWire({
      session_defaults: {
        agent_id: " roselin_codex ",
        node_id: " eiaserinnys ",
        model_preset: " codex-5.6-sol ",
      },
    })).toEqual({
      ok: true,
      value: {
        guidance: "",
        atomReferences: [],
        sessionDefaults: {
          agentId: "roselin_codex",
          nodeId: "eiaserinnys",
          modelPreset: "codex-5.6-sol",
        },
      },
    });
  });

  it("rejects a blank model preset when it is present", () => {
    expect(parseInitialFolderContextWire({
      session_defaults: {
        agent_id: "roselin_codex",
        node_id: "eiaserinnys",
        model_preset: " ",
      },
    })).toMatchObject({ ok: false });
  });

  it.each([
    ["non-object", "invalid"],
    ["missing agent", { node_id: "eiaserinnys" }],
    ["missing node", { agent_id: "roselin_codex" }],
    ["blank agent", { agent_id: " ", node_id: "eiaserinnys" }],
    ["blank node", { agent_id: "roselin_codex", node_id: " " }],
  ])("rejects %s session defaults", (_label, sessionDefaults) => {
    expect(parseInitialFolderContextWire({ session_defaults: sessionDefaults })).toMatchObject({
      ok: false,
    });
  });
});
