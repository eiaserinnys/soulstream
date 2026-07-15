import type {
  ProjectAtomReference,
  ProjectSessionDefault,
} from "./project-page-details";

export function ProjectAtomChip({
  reference,
  onClick,
}: {
  reference: Pick<ProjectAtomReference, "nodeTitle" | "depth" | "titlesOnly">;
  onClick?: () => void;
}) {
  const content = <>⚛ {reference.nodeTitle} · depth {reference.depth ?? 3} · titlesOnly {(reference.titlesOnly ?? false) ? "on" : "off"}</>;
  return onClick ? (
    <button type="button" className="v3-project-context-chip" onClick={onClick}>{content}</button>
  ) : (
    <span className="v3-project-context-chip">{content}</span>
  );
}

export function ProjectSessionDefaultChip({
  defaults,
  onClick,
}: {
  defaults: Pick<ProjectSessionDefault, "agentId" | "nodeId">;
  onClick?: () => void;
}) {
  const content = <>👤 {defaults.agentId ?? "agent 미지정"}@{defaults.nodeId ?? "node 미지정"}</>;
  return onClick ? (
    <button type="button" className="v3-project-context-chip" onClick={onClick}>{content}</button>
  ) : (
    <span className="v3-project-context-chip">{content}</span>
  );
}
