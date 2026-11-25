import type { CardStatus } from "@soulstream/wire-schema";
import type { RepositorySql } from "./control_plane/card_types.js";

export type CardDependency = { id: string; number: number | null; title: string; status: CardStatus; archived: boolean; met: boolean };
export function dependencyMet(status: CardStatus, reviewMeetsDependency: boolean): boolean {
  return status === "done" || (reviewMeetsDependency && status === "review");
}
export function dependencyStopped(dependency: CardDependency): boolean {
  return dependency.status === "cancelled" || (dependency.archived && !dependency.met);
}

/** One projection for REST, MCP, queue eligibility and execution prompts. */
export async function readCardDependencies(sql: RepositorySql, cardIds: readonly string[], allowedFolderIds: readonly string[] | null = null): Promise<Map<string, CardDependency[]>> {
  if (!cardIds.length) return new Map();
  const rows = await sql<{ card_id: string; id: string; number: number | null; title: string; status: CardStatus; archived: boolean }[]>`
    SELECT d.card_id,c.id,c.number,c.title,c.status,c.archived FROM card_dependencies d
    JOIN cards c ON c.id=d.depends_on_card_id WHERE d.card_id=ANY(${[...cardIds]}::text[])
    AND (${allowedFolderIds}::text[] IS NULL OR c.folder_id=ANY(${allowedFolderIds}::text[]))
    ORDER BY d.card_id,c.number NULLS LAST,c.id`;
  const result = new Map<string, CardDependency[]>();
  if (!rows.length) return result;
  const settings = (await sql<{ value: { reviewMeetsDependency?: boolean } }[]>`
    SELECT value FROM system_settings WHERE setting_key='card_dispatch'`)[0];
  const review = settings?.value?.reviewMeetsDependency === true;
  for (const { card_id, ...card } of rows) {
    const list = result.get(card_id) ?? [];
    list.push({ ...card, met: dependencyMet(card.status, review) });
    result.set(card_id, list);
  }
  return result;
}

export async function dependentCards(sql: RepositorySql, cardId: string): Promise<{ id: string; folder_id: string }[]> {
  return sql<{ id: string; folder_id: string }[]>`SELECT c.id,c.folder_id FROM card_dependencies d
    JOIN cards c ON c.id=d.card_id WHERE d.depends_on_card_id=${cardId}`;
}

const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 422, code: "INVALID_CARD_REQUEST" });
const cycle = () => Object.assign(new Error("선행 카드가 서로를 기다리고 있어 순환이 됩니다"), { statusCode: 409, code: "CARD_DEPENDENCY_CYCLE" });

export async function replaceCardDependencies(sql: RepositorySql, cardId: string, refs: readonly string[], allowedFolderIds: readonly string[] | null = null): Promise<void> {
  if (refs.length > 10) throw invalid("선행 카드는 10장까지입니다");
  const ids = new Set<string>();
  for (const ref of refs) {
    const number = /^#[1-9][0-9]{0,8}$/.test(ref) ? Number(ref.slice(1)) : null;
    const row = (await sql<{ id: string; number: number | null; status: CardStatus }[]>`
      SELECT id,number,status FROM cards WHERE (id=${ref} OR (${number}::integer IS NOT NULL AND number=${number}))
        AND (${allowedFolderIds}::text[] IS NULL OR folder_id=ANY(${allowedFolderIds}::text[]))`)[0];
    if (!row) throw invalid(`선행 카드 ${ref}을 찾을 수 없습니다`);
    if (row.id === cardId) throw invalid("카드는 자기 자신을 선행으로 둘 수 없습니다");
    if (row.status === "cancelled") throw invalid(`취소된 카드 ${row.number === null ? row.id : `#${row.number}`}는 선행으로 둘 수 없습니다`);
    ids.add(row.id);
  }
  await sql`DELETE FROM card_dependencies WHERE card_id=${cardId}`;
  for (const id of ids) {
    const loops = await sql<{ path: string[] }[]>`WITH RECURSIVE paths(id,path) AS (
      SELECT ${id}::text,ARRAY[${id}::text]
      UNION ALL SELECT d.depends_on_card_id,p.path || d.depends_on_card_id FROM card_dependencies d JOIN paths p ON d.card_id=p.id
        WHERE NOT d.depends_on_card_id=ANY(p.path)
    ) SELECT path FROM paths WHERE id=${cardId} LIMIT 1`;
    if (loops[0]) {
      const path = [cardId, ...loops[0].path];
      const cards = await sql<{ id: string; number: number | null }[]>`SELECT id,number FROM cards WHERE id=ANY(${path}::text[])`;
      const labels = new Map(cards.map(card => [card.id,card.number === null ? card.id : `#${card.number}`]));
      throw Object.assign(new Error(`${labels.get(id)}가 이미 ${labels.get(cardId)}를 기다리고 있어 순환이 됩니다: ${path.map(item => labels.get(item)).join(" → ")}`),
        { statusCode: 409, code: "CARD_DEPENDENCY_CYCLE" });
    }
    await sql`INSERT INTO card_dependencies(card_id,depends_on_card_id) VALUES(${cardId},${id})`;
  }
}

/** Rewire the whole affected edge set in the merge transaction, then validate it. */
export async function mergeCardDependencies(sql: RepositorySql, target: string, sources: readonly string[]): Promise<string[]> {
  const participants = [target, ...sources];
  const sourceSet = new Set(sources);
  const rows = await sql<{ card_id: string; depends_on_card_id: string }[]>`SELECT card_id,depends_on_card_id FROM card_dependencies
    WHERE card_id=ANY(${participants}::text[]) OR depends_on_card_id=ANY(${sources}::text[])`;
  const affected = new Set<string>();
  await sql`DELETE FROM card_dependencies WHERE card_id=ANY(${participants}::text[]) OR depends_on_card_id=ANY(${sources}::text[])`;
  for (const row of rows) {
    const card = sourceSet.has(row.card_id) ? target : row.card_id;
    const predecessor = sourceSet.has(row.depends_on_card_id) ? target : row.depends_on_card_id;
    if (card === predecessor) continue;
    affected.add(card);
    await sql`INSERT INTO card_dependencies(card_id,depends_on_card_id) VALUES(${card},${predecessor}) ON CONFLICT DO NOTHING`;
  }
  for (const card of affected) {
    const count = (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM card_dependencies WHERE card_id=${card}`)[0]!.count;
    if (count > 10) throw invalid("선행 카드는 10장까지입니다");
    const loops = await sql`WITH RECURSIVE paths(id) AS (
      SELECT depends_on_card_id FROM card_dependencies WHERE card_id=${card}
      UNION SELECT d.depends_on_card_id FROM card_dependencies d JOIN paths p ON d.card_id=p.id
    ) SELECT id FROM paths WHERE id=${card} LIMIT 1`;
    if (loops.length) throw cycle();
  }
  return [...affected];
}
