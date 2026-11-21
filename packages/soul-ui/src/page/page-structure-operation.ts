export type PageStructureOperation =
  | { op: "rename_page"; title: string }
  | { op: "set_page_archived"; archived: boolean }
  | {
    op: "create_block";
    temp_id: string;
    parent_id: string | null;
    parent_temp_id?: string | null;
    after_block_id: string | null;
    after_temp_id?: string | null;
    block_type: string;
    text: string;
    properties: Record<string, unknown>;
    collapsed?: boolean;
  }
  | { op: "update_block_text"; block_id: string; text: string }
  | {
    op: "update_block_type_and_properties";
    block_id: string;
    block_type: string;
    properties: Record<string, unknown>;
  }
  | {
    op: "move_block";
    block_id: string;
    parent_id: string | null;
    parent_temp_id?: string | null;
    after_block_id: string | null;
    after_temp_id?: string | null;
  }
  | { op: "delete_block_subtree"; block_id: string }
  | { op: "set_check_state"; block_id: string; checked: boolean };
