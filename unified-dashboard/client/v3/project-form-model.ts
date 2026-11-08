import type { CatalogFolder } from "@seosoyoung/soul-ui";

import type { ProjectPageDetails } from "./project-page-details";

export interface ProjectFormGuidance {
  blockId: string | null;
  draftId?: string;
  text: string;
}

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

export interface ProjectFormSessionDefaults {
  blockId: string | null;
  draftId?: string;
  agentId: string;
  nodeId: string;
  modelPreset: string;
}

export interface ProjectFormValue {
  title: string;
  guidance: ProjectFormGuidance[];
  atomReferences: ProjectFormAtomReference[];
  sessionDefaults: ProjectFormSessionDefaults | null;
}

export function emptyProjectFormValue(title = ""): ProjectFormValue {
  return {
    title,
    guidance: [],
    atomReferences: [],
    sessionDefaults: null,
  };
}

export function projectFormValueFromDetails(
  title: string,
  details: ProjectPageDetails,
): ProjectFormValue {
  return {
    title,
    guidance: details.guidance.map((item) => ({
      blockId: item.blockId,
      text: item.text,
    })),
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
    sessionDefaults: details.sessionDefaults[0]
      ? {
          blockId: details.sessionDefaults[0].blockId,
          agentId: details.sessionDefaults[0].agentId ?? "",
          nodeId: details.sessionDefaults[0].nodeId ?? "",
          modelPreset: details.sessionDefaults[0].modelPreset ?? "",
        }
      : null,
  };
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
