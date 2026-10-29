// 카드 #739의 실제 운영 데이터(위임자가 고른 card-739.json). 증거 그림은 로컬에 남은 넷만 묶음에 싣고,
// 나머지 증거는 이름만 보인다. 그림을 지어내지 않는다.
import type { FrontCardDetail, FrontCardItem } from "../../client/v3/front-page-model";
import raw from "./card-739.json";

const images = import.meta.glob("./assets/*.jpg", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const localImage = (itemId: number, label: string): string | null => {
  const found = raw.local_images.find(image => image.item_id === itemId && image.evidence_label === label);
  return found ? images[`./assets/${found.file}`] ?? null : null;
};

export const card739: FrontCardDetail = {
  number: raw.number,
  title: raw.title,
  status: raw.status as FrontCardDetail["status"],
  project: raw.project,
  now: { text: raw.now.text, ask: raw.now.ask, turn: raw.now.turn as "user", sessionId: raw.now.sessionId },
  nodeId: raw.node,
  modelPreset: raw.preset,
  items: raw.items.map((item): FrontCardItem => ({
    id: item.id,
    title: item.title,
    state: item.state as FrontCardItem["state"],
    result: item.result,
    caveat: item.caveat || null,
    evidence: item.evidence.map(evidence => ({
      type: evidence.type as "image" | "link",
      label: evidence.label,
      src: evidence.type === "image" ? localImage(item.id, evidence.label) : null,
    })),
  })),
  entries: raw.comments.map(comment => ({
    kind: comment.kind as "comment" | "note",
    authorKind: comment.author_kind as "agent" | "user",
    body: comment.body,
    createdAt: comment.created_at,
  })),
  sessions: raw.sessions.map(session => ({
    id: session.agent_session_id,
    title: session.display_name,
    agentId: session.agent_id,
    nodeId: session.node_id,
    status: session.status,
    modelPreset: session.model_preset,
    updatedAt: session.updated_at,
  })),
};
