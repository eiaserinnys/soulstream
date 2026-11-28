import type { CatalogFolder } from "@seosoyoung/soul-ui";

import type { ProjectPageDetails } from "./project-page-details";

export type ContextSource = "inherit" | "own";

export interface ProjectFormAtomReference {
  blockId: string | null;
  draftId?: string;
  instance: "atom" | "atom-nl";
  nodeId: string;
  nodeTitle: string;
  depth: number;
  titlesOnly: boolean;
  limit?: number | null;
  mode?: "full" | "index" | "titles";
}

export interface ProjectFormGuidance {
  source: ContextSource;
  text: string;
}

export interface ProjectFormSessionDefaults {
  source: ContextSource;
  nodeId: string;
  agentId: string;
  modelPreset: string;
}

export interface ProjectFormValue {
  title: string;
  description: string;
  guidance: ProjectFormGuidance;
  atomReferences: ProjectFormAtomReference[];
  sessionDefaults: ProjectFormSessionDefaults;
}

export function emptyProjectFormValue(title = ""): ProjectFormValue {
  return {
    title,
    description: "",
    guidance: { source: "inherit", text: "" },
    atomReferences: [],
    sessionDefaults: { source: "inherit", nodeId: "", agentId: "", modelPreset: "" },
  };
}

export function projectFormValueFromDetails(
  title: string,
  description: string,
  details: ProjectPageDetails,
): ProjectFormValue {
  const defaults = details.sessionDefaults[0];
  return {
    title,
    description,
    guidance: details.guidance.length > 0
      ? { source: "own", text: details.guidance.map((item) => item.text).join("\n\n") }
      : { source: "inherit", text: "" },
    atomReferences: details.atomReferences.map((item) => ({
      blockId: item.blockId,
      instance: item.instance,
      nodeId: item.nodeId,
      nodeTitle: item.nodeTitle,
      depth: item.depth ?? 3,
      titlesOnly: item.titlesOnly ?? false,
      limit: item.limit ?? null,
      ...(item.mode !== undefined ? { mode: item.mode } : {}),
    })),
    sessionDefaults: defaults
      ? { source: "own", nodeId: defaults.nodeId ?? "", agentId: defaults.agentId ?? "", modelPreset: defaults.modelPreset ?? "" }
      : { source: "inherit", nodeId: "", agentId: "", modelPreset: "" },
  };
}

export function isProjectFormValid(value: ProjectFormValue): boolean {
  return value.title.trim().length > 0
    && (value.guidance.source === "inherit" || value.guidance.text.trim().length > 0)
    && (value.sessionDefaults.source === "inherit"
      || (value.sessionDefaults.nodeId.length > 0 && value.sessionDefaults.agentId.length > 0));
}

export function projectHasContents(
  folderId: string,
  input: {
    folders: readonly CatalogFolder[];
    sessions: Readonly<Record<string, { folderId?: string | null }>>;
    hasCards: boolean;
    hasDocuments: boolean;
    hasResources?: boolean;
  },
): boolean {
  return input.folders.some((folder) => folder.parentFolderId === folderId)
    || Object.values(input.sessions).some((assignment) => assignment.folderId === folderId)
    || input.hasCards
    || input.hasDocuments
    || (input.hasResources ?? false);
}
