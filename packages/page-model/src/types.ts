export const PAGE_BLOCK_TYPES = [
  "paragraph",
  "session_ref",
  "atom_ref",
  "guidance",
  "checklist",
  "custom_view",
  "image",
] as const;

export type KnownPageBlockType = (typeof PAGE_BLOCK_TYPES)[number];
export type PageBlockType = KnownPageBlockType | (string & {});

export interface SessionRefBlockProperties {
  sessionId: string;
  primary: boolean;
  [key: string]: unknown;
}

export interface AtomRefBlockProperties {
  instance: "atom" | "atom-nl";
  nodeId: string;
  [key: string]: unknown;
}

export interface GuidanceBlockProperties {
  enabled: boolean;
  scope: string;
  [key: string]: unknown;
}

export interface ChecklistBlockProperties {
  checked: boolean;
  [key: string]: unknown;
}

export interface CustomViewBlockProperties {
  customViewId: string;
  [key: string]: unknown;
}

export interface ImageBlockProperties {
  assetId: string;
  alt: string;
  [key: string]: unknown;
}

export interface PageBlockPropertiesByType {
  paragraph: Record<string, unknown>;
  session_ref: SessionRefBlockProperties;
  atom_ref: AtomRefBlockProperties;
  guidance: GuidanceBlockProperties;
  checklist: ChecklistBlockProperties;
  custom_view: CustomViewBlockProperties;
  image: ImageBlockProperties;
}

export type PageBlockProperties<T extends PageBlockType = PageBlockType> =
  T extends keyof PageBlockPropertiesByType
    ? PageBlockPropertiesByType[T]
    : Record<string, unknown>;

export type PageActorKind = "agent" | "user" | "system";
export type PageLinkKind = "mount" | "inline_page" | "block_ref";

export type PageOperationType =
  | "create_page"
  | "rename_page"
  | "archive_page"
  | "unarchive_page"
  | "create_block"
  | "update_block_text"
  | "update_block_type_and_properties"
  | "move_block"
  | "delete_block_subtree"
  | "set_check_state"
  | "replace_page_markdown"
  | "batch_operations";

export interface PageDto {
  id: string;
  title: string;
  daily_date: string | null;
  version: number;
  archived: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BlockDto<T extends PageBlockType = PageBlockType> {
  id: string;
  page_id: string;
  parent_id: string | null;
  position_key: string;
  block_type: T;
  text: string;
  properties: PageBlockProperties<T>;
  collapsed: boolean;
}

export interface BlockOperationDto {
  id: string;
  page_id: string;
  target_block_id: string | null;
  operation_type: PageOperationType;
  actor_kind: PageActorKind;
  actor_session_id: string | null;
  actor_user_id: string | null;
  expected_version: number;
  result_version: number;
  idempotent?: boolean;
}

export interface BacklinkDto {
  id: string;
  source_page_id: string;
  source_block_id: string;
  link_kind: PageLinkKind;
  target_page_id: string | null;
  target_block_id: string | null;
  source_start: number;
  source_end: number;
}
