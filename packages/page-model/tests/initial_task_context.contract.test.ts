import { describe, expect, it } from "vitest";

import {
  parseInitialTaskContextWire,
  serializeInitialTaskContext,
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
      }],
      sessionDefaults: {
        agentId: "roselin_codex",
        nodeId: "eiaserinnys",
      },
    };
    const wire = serializeInitialTaskContext(context);

    expect(wire).toEqual({
      guidance: "직접 지침",
      atom_references: [{
        instance: "atom",
        node_id: "node-a",
        node_title: "soulstream",
        depth: 5,
        titles_only: true,
      }],
      session_defaults: {
        agent_id: "roselin_codex",
        node_id: "eiaserinnys",
      },
    });
    expect(parseInitialTaskContextWire(wire)).toEqual({
      ok: true,
      value: { ...context, guidance: "직접 지침" },
    });
  });

  it("rejects invalid depth and missing node title at the shared boundary", () => {
    expect(parseInitialTaskContextWire({
      atom_references: [{
        instance: "atom",
        node_id: "node-a",
        node_title: "",
        depth: 6,
        titles_only: false,
      }],
    })).toMatchObject({ ok: false });
  });

  it("accepts session defaults as the only initial context", () => {
    expect(parseInitialTaskContextWire({
      session_defaults: {
        agent_id: " roselin_codex ",
        node_id: " eiaserinnys ",
      },
    })).toEqual({
      ok: true,
      value: {
        guidance: "",
        atomReferences: [],
        sessionDefaults: {
          agentId: "roselin_codex",
          nodeId: "eiaserinnys",
        },
      },
    });
  });

  it.each([
    ["non-object", "invalid"],
    ["missing agent", { node_id: "eiaserinnys" }],
    ["missing node", { agent_id: "roselin_codex" }],
    ["blank agent", { agent_id: " ", node_id: "eiaserinnys" }],
    ["blank node", { agent_id: "roselin_codex", node_id: " " }],
  ])("rejects %s session defaults", (_label, sessionDefaults) => {
    expect(parseInitialTaskContextWire({ session_defaults: sessionDefaults })).toMatchObject({
      ok: false,
    });
  });
});
