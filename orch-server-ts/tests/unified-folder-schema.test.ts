import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const schema = readFileSync(fileURLToPath(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url)), "utf8");

describe("canonical folder schema", () => {
  it("has one folder identity and one audit stream", () => {
    for (const table of ["folders", "cards", "card_reports", "card_questions", "folder_operations", "planner_starred_page_order"]) {
      expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    }
    expect(schema).not.toMatch(/CREATE (?:TABLE|OR REPLACE VIEW)(?: IF NOT EXISTS)? (?:tasks|task_sections|task_items|task_operations|runbooks|folder_project_operations|checklist_task_projection_outbox)\b/);
  });

  it("has a single board owner and uses the session card link", () => {
    const board = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS board_items ("), schema.indexOf("CREATE TABLE IF NOT EXISTS board_yjs_documents ("));
    expect(board).not.toContain("source_checklist_item_id");
    expect(schema).toContain("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS card_id TEXT REFERENCES cards(id) ON DELETE SET NULL");
    expect(board).not.toMatch(/container_kind|container_id|board_items_fill_container_defaults/);
    expect(schema).toContain("owner_folder_id");
  });
});
