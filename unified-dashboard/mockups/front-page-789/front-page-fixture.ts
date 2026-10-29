// 카드 #789 시안의 견본. 2026-10-29 14:35 KST 운영 DB에서 위임자가 고른 실제 데이터다.
// 공개 주소로 열리는 시안이라 회사 업무와 다른 사용자 카드는 이미 빠져 있다. 데이터를 더하지 않는다.
import type { FrontPageCard, FrontPageData } from "../../client/v3/front-page-model";
import raw from "./front-page-789.json";

type RawCard = {
  number: number; title: string; project: string; now: string | null; ask: string | null;
  status_changed_at: string; items: { title: string; state: FrontPageCard["items"][number]["state"] }[]; images: string[];
};

const card = (source: RawCard): FrontPageCard => ({
  number: source.number,
  title: source.title,
  project: source.project,
  now: source.now,
  ask: source.ask,
  statusChangedAt: source.status_changed_at,
  items: source.items,
  images: source.images,
});

export const frontPageData: FrontPageData = {
  review: (raw.review as RawCard[]).map(card),
  running: (raw.running as RawCard[]).map(card),
  blocked: (raw.blocked as RawCard[]).map(card),
  done: (raw.done as RawCard[]).map(card),
  queued: (raw.queued as RawCard[]).map(card),
  questions: raw.questions.map(question => ({
    number: question.number,
    cardTitle: question.card_title,
    text: question.text,
    options: question.options,
    askedAt: question.asked_at,
  })),
  nodes: raw.nodes.map(node => ({ id: node.id, label: node.label, cpu: node.cpu, mem: node.mem, disk: node.disk })),
  limits: raw.limits.map(limit => ({ name: limit.name, remaining: limit.remaining, rejected: limit.state === "limit_rejected" })),
  projectsToday: raw.projects_today,
  dailyPages: raw.daily_pages.map(page => page.replace(/\s*\(오늘\)$/, "")),
};

/** 견본을 잰 시각. 머리 날짜와 시각 표시는 이 시각과 서울 시간대로 고정한다. */
export const frontPageNow = new Date("2026-10-29T05:35:00Z");
export const frontPageTimeZone = "Asia/Seoul";

/** 운영 배경 설정(wallpaper.prefs). 사진은 리포의 readme-demo 배경과 같은 파일이다. */
export const directorGlass = raw.wallpaper.prefs.glass;

const images = import.meta.glob("./assets/*.jpg", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

export function frontPageImage(name: string): string {
  const url = images[`./assets/${name}`];
  if (!url) throw new Error(`견본 그림이 없습니다: ${name}`);
  return url;
}
