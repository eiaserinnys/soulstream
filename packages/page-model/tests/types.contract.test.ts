import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PAGE_BLOCK_TYPES,
  type BacklinkDto,
  type BlockDto,
  type ChecklistBlockProperties,
  type PageBlockProperties,
  type PageBlockType,
} from "../src/types.js";

describe("page model DTO contract", () => {
  it("keeps the v1 registry explicit while allowing open-set block types", () => {
    expect(PAGE_BLOCK_TYPES).toEqual([
      "paragraph",
      "session_ref",
      "atom_ref",
      "guidance",
      "checklist",
      "custom_view",
      "image",
    ]);

    const customType: PageBlockType = "plugin/chart";
    const dto: BlockDto = {
      id: "block-1",
      page_id: "page-1",
      parent_id: null,
      position_key: "V",
      block_type: customType,
      text: "chart",
      properties: { renderer: "bar" },
      collapsed: false,
    };

    expect(dto.block_type).toBe("plugin/chart");
  });

  it("maps known block types to their minimum property contracts", () => {
    expectTypeOf<PageBlockProperties<"checklist">>().toEqualTypeOf<ChecklistBlockProperties>();
    expectTypeOf<PageBlockProperties<"plugin/chart">>().toEqualTypeOf<
      Record<string, unknown>
    >();

    const boundChecklist: ChecklistBlockProperties = {
      runbookId: "page-runbook:page-1",
      itemId: "checklist:block-1",
    };
    expect(boundChecklist).not.toHaveProperty("checked");
  });

  it("exposes backlink DTOs with the canonical link kinds", () => {
    const backlink: BacklinkDto = {
      id: "block-link:block-1:0",
      source_page_id: "page-1",
      source_block_id: "block-1",
      link_kind: "inline_page",
      target_page_id: null,
      target_block_id: null,
      source_start: 0,
      source_end: 8,
    };

    expect(backlink.link_kind).toBe("inline_page");
  });
});
