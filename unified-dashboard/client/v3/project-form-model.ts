import type { CatalogState } from "@seosoyoung/soul-ui";

import type { ProjectPageDetails } from "./project-page-details";

export interface ProjectFormGuidance {
  blockId: string | null;
  text: string;
}

export interface ProjectFormAtomReference {
  blockId: string | null;
  instance: "atom" | "atom-nl";
  nodeId: string;
  nodeTitle: string;
  depth: number;
  titlesOnly: boolean;
}

export interface ProjectFormSessionDefaults {
  blockId: string | null;
  agentId: string;
  nodeId: string;
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
    })),
    sessionDefaults: details.sessionDefaults[0]
      ? {
          blockId: details.sessionDefaults[0].blockId,
          agentId: details.sessionDefaults[0].agentId ?? "",
          nodeId: details.sessionDefaults[0].nodeId ?? "",
        }
      : null,
  };
}

export function projectHasContents(
  folderId: string,
  catalog: Pick<CatalogState, "folders" | "sessions" | "boardItems">,
): boolean {
  return catalog.folders.some((folder) => folder.parentFolderId === folderId)
    || Object.values(catalog.sessions).some((assignment) => assignment.folderId === folderId)
    || (catalog.boardItems ?? []).some((item) => item.folderId === folderId);
}
