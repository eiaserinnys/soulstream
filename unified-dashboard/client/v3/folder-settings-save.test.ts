import { describe, expect, it, vi } from "vitest";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { saveProjectFormContext } from "./project-form-actions";
import { projectFormValueFromDetails, type ProjectFormValue } from "./project-form-model";
import { parseProjectPageDetails } from "./project-page-details";

interface FakeBlock {
  id: string;
  page_id: string;
  parent_id: string | null;
  block_type: string;
  text: string;
  properties: Record<string, unknown>;
}

function block(id: string, block_type: string, text: string, properties: Record<string, unknown>): FakeBlock {
  return { id, page_id: "p", parent_id: null, block_type, text, properties };
}

function fakePage(initial: FakeBlock[]) {
  const blocks = [...initial];
  const operations: Array<Record<string, unknown>> = [];
  const getPage = vi.fn(async () => ({
    page: { id: "p", title: "대시보드", version: 1 }, blocks: blocks.map((item) => ({ ...item })), state_vector: "",
  }));
  const applyOperations = vi.fn(async (_pageId: string, input: { operations: Array<Record<string, any>> }) => {
    for (const op of input.operations) {
      operations.push(op);
      if (op.op === "create_block") blocks.push(block(op.temp_id, op.block_type, op.text, op.properties));
      if (op.op === "update_block_text") blocks.find((item) => item.id === op.block_id)!.text = op.text;
      if (op.op === "update_block_type_and_properties") {
        const target = blocks.find((item) => item.id === op.block_id)!;
        target.block_type = op.block_type;
        target.properties = op.properties;
      }
      if (op.op === "delete_block_subtree") blocks.splice(blocks.findIndex((item) => item.id === op.block_id), 1);
    }
    return { page: { id: "p", version: 2 }, blocks: blocks.map((item) => ({ ...item })), temp_id_mapping: {}, operation: { id: "op" } };
  });
  const api = { getPage, applyOperations } as unknown as PageApiClient;
  return { api, blocks, operations, applyOperations };
}

const guidanceBlocks = () => [
  block("g1", "guidance", "첫 지침", { enabled: true, scope: "folder" }),
  block("g2", "guidance", "둘째 지침", { enabled: true, scope: "project" }),
];

function loaded(blocks: FakeBlock[]): ProjectFormValue {
  return projectFormValueFromDetails("대시보드", "", parseProjectPageDetails(blocks as never));
}

async function save(page: ReturnType<typeof fakePage>, initial: FakeBlock[], value: ProjectFormValue) {
  await saveProjectFormContext(page.api, "p", parseProjectPageDetails(initial as never), value, {});
}

describe("folder settings guidance", () => {
  it("shows every guidance block of the folder in one text box, joined by a blank line", () => {
    expect(loaded(guidanceBlocks()).guidance).toEqual({ source: "own", text: "첫 지침\n\n둘째 지침" });
    expect(loaded([]).guidance).toEqual({ source: "inherit", text: "" });
  });

  it("saves the text box as a single project-scoped guidance block and removes the rest", async () => {
    const initial = guidanceBlocks();
    const page = fakePage(initial);
    const value = loaded(initial);
    await save(page, initial, { ...value, guidance: { source: "own", text: "합친 지침" } });
    const guidance = page.blocks.filter((item) => item.block_type === "guidance");
    expect(guidance).toHaveLength(1);
    expect(guidance[0]).toMatchObject({ text: "합친 지침", properties: { enabled: true, scope: "project" } });
    expect(page.applyOperations).toHaveBeenCalledTimes(1);
  });

  it("removes every guidance block of the folder when saved as inherited", async () => {
    const initial = [...guidanceBlocks(), block("g3", "guidance", "꺼진 지침", { enabled: false, scope: "project" })];
    const page = fakePage(initial);
    await save(page, initial, { ...loaded(initial), guidance: { source: "inherit", text: "첫 지침" } });
    expect(page.blocks.filter((item) => item.block_type === "guidance")).toEqual([]);
  });
});

describe("folder settings execution defaults", () => {
  const defaultsBlocks = () => [
    block("d1", "session_defaults", "", { agentId: "utonium", nodeId: "eiaserinnys", scope: "project" }),
    block("d2", "session_defaults", "", { agentId: "roselin", nodeId: "silent", scope: "session" }),
  ];

  it("saves the defaults as one session-scoped block", async () => {
    const initial = defaultsBlocks();
    const page = fakePage(initial);
    await save(page, initial, {
      ...loaded(initial),
      sessionDefaults: { source: "own", nodeId: "eiaserinnys", agentId: "roselin", modelPreset: "sol" },
    });
    const defaults = page.blocks.filter((item) => item.block_type === "session_defaults");
    expect(defaults).toHaveLength(1);
    expect(defaults[0].properties).toEqual({ agentId: "roselin", nodeId: "eiaserinnys", modelPreset: "sol", scope: "session" });
  });

  it("creates a session-scoped block for a folder that had none", async () => {
    const page = fakePage([]);
    await save(page, [], { ...loaded([]), sessionDefaults: { source: "own", nodeId: "eiaserinnys", agentId: "roselin", modelPreset: "" } });
    expect(page.blocks).toEqual([expect.objectContaining({
      block_type: "session_defaults", properties: { agentId: "roselin", nodeId: "eiaserinnys", scope: "session" },
    })]);
  });

  it("removes every defaults block when saved as inherited", async () => {
    const initial = defaultsBlocks();
    const page = fakePage(initial);
    await save(page, initial, { ...loaded(initial), sessionDefaults: { source: "inherit", nodeId: "", agentId: "", modelPreset: "" } });
    expect(page.blocks.filter((item) => item.block_type === "session_defaults")).toEqual([]);
  });
});

describe("folder settings references", () => {
  const atom = () => block("a1", "atom_ref", "", {
    instance: "atom", nodeId: "node-a", nodeTitle: "프론트엔드 아키텍처", depth: 2, titlesOnly: true, limit: 15, mode: "index",
  });

  it("adds a reference as an atom_ref block", async () => {
    const page = fakePage([]);
    const value = loaded([]);
    await save(page, [], { ...value, atomReferences: [{ blockId: null, draftId: "x", instance: "atom", nodeId: "node-b", nodeTitle: "세션", depth: 1, titlesOnly: false }] });
    expect(page.blocks).toEqual([expect.objectContaining({
      block_type: "atom_ref", properties: { instance: "atom", nodeId: "node-b", nodeTitle: "세션", depth: 1, titlesOnly: false },
    })]);
  });

  it("removes a reference by deleting its atom_ref block", async () => {
    const initial = [atom()];
    const page = fakePage(initial);
    await save(page, initial, { ...loaded(initial), atomReferences: [] });
    expect(page.blocks).toEqual([]);
    expect(page.operations).toEqual([{ op: "delete_block_subtree", block_id: "a1" }]);
  });

  it("keeps the hidden limit and render mode when a reference is edited", async () => {
    const initial = [atom()];
    const page = fakePage(initial);
    const value = loaded(initial);
    await save(page, initial, { ...value, atomReferences: [{ ...value.atomReferences[0], depth: 4, titlesOnly: false }] });
    expect(page.blocks[0].properties).toEqual({
      instance: "atom", nodeId: "node-a", nodeTitle: "프론트엔드 아키텍처", depth: 4, titlesOnly: false, limit: 15, mode: "index",
    });
  });

  it("writes nothing when the loaded folder is saved unchanged", async () => {
    const initial = [atom(), block("g", "guidance", "지침", { enabled: true, scope: "project" }),
      block("d", "session_defaults", "", { agentId: "roselin", nodeId: "eiaserinnys", scope: "session" })];
    const page = fakePage(initial);
    await save(page, initial, loaded(initial));
    expect(page.applyOperations).not.toHaveBeenCalled();
  });
});
