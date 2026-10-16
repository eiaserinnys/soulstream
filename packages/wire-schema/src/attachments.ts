export type AttachmentScope =
  | { type: "session"; id: string }
  | { type: "card"; id: string }
  | { type: "page"; id: string }
  | { type: "board_item"; id: string };

export type AttachmentRegistrationScope =
  | AttachmentScope
  | { type: "folder"; id: string };

export type AttachmentReadContext = { type: "owner" } | AttachmentScope;

export interface AttachmentDescriptor {
  attachment_id: string;
  name: string;
  mime_type: string;
  byte_size: number;
  checksum_sha256: string | null;
  width: number | null;
  height: number | null;
  preview_kind: "image" | "text" | "info";
  preview_mime_type: string | null;
}

export interface AttachmentRef {
  attachment_id: string;
}

export type AttachmentPathBinding = {
  attachment_id: string;
  node_id: string;
  path: string;
};

export type AttachmentInputFields = {
  attachmentIds?: readonly string[];
  attachmentPaths?: readonly string[];
  attachmentBindings?: readonly AttachmentPathBinding[];
};

export type AttachmentProjection =
  | {
      kind: "asset";
      descriptor: AttachmentDescriptor;
      read_context: AttachmentReadContext;
    }
  | {
      kind: "legacy";
      node_id: string;
      path: string;
      name: string;
      mime_type: string | null;
      byte_size: number | null;
      availability: "unresolved" | "missing";
    };
